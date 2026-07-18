import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  AdmissionAcquireInput,
  ExecutionAdmissionClient,
} from "../../src/budget/admission-client.js";
import { AdmissionDeniedError } from "../../src/budget/admission-client.js";
import type { AdmissionLease } from "../../src/budget/admission-types.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import {
  clearCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
} from "../../src/session/current-session.js";
import type { Session } from "../../src/session/session.js";
import { getEmptyToolPermissionContext } from "../../src/tools/Tool.js";

const shellProbe = vi.hoisted(() => ({
  signals: [] as AbortSignal[],
  onExec: undefined as (() => void) | undefined,
}));

vi.mock("bun:bundle", () => ({ feature: () => false }));
vi.mock("../../src/utils/Shell.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/utils/Shell.js")>();
  return {
    ...actual,
    exec: async (...args: Parameters<typeof actual.exec>) => {
      shellProbe.signals.push(args[1]);
      shellProbe.onExec?.();
      return actual.exec(...args);
    },
  };
});

import { PowerShellTool } from "../../src/tools/PowerShellTool/PowerShellTool.js";

function findPowerShell(): string | null {
  for (const candidate of ["pwsh", "powershell"]) {
    const result = spawnSync(candidate, ["-NoProfile", "-Command", "exit 0"], {
      timeout: 2_000,
    });
    if (result.status === 0) return candidate;
  }
  return null;
}

function admissionHarness(signal = new AbortController().signal) {
  const acquire = vi.fn(
    async (input: AdmissionAcquireInput): Promise<AdmissionLease> => ({
      decision: "allow",
      reservation: {
        reservationId: `reservation:${input.stepId}`,
        step: { runId: "run-powershell", stepId: input.stepId },
        reservedCostUsd: input.maxCostUsd ?? 0,
        reservedTokens: input.maxInputTokens + input.maxOutputTokens,
        reservedAt: "2026-07-18T00:00:00.000Z",
      },
      request: {
        step: { runId: "run-powershell", stepId: input.stepId },
        kind: input.kind,
        estimate: {
          maxInputTokens: input.maxInputTokens,
          maxOutputTokens: input.maxOutputTokens,
          maxCostUsd: input.maxCostUsd,
        },
        workspaceId: "workspace-powershell",
        sessionId: "session-powershell",
        parentScopeId: input.parentScopeId,
        autonomous: false,
      },
      signal,
    }),
  );
  const admission = {
    scope: {
      runId: "run-powershell",
      workspaceId: "workspace-powershell",
      sessionId: "session-powershell",
      autonomous: false,
    },
    acquire,
    markDispatched: vi.fn(),
    reconcile: vi.fn(() => ({ applied: true, outcome: "reconciled" })),
    holdUnknown: vi.fn(),
    void: vi.fn(),
    acknowledgeCompletion: vi.fn(),
    recordFallback: vi.fn(),
    forSession: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ExecutionAdmissionClient;
  const session = {
    conversationId: "session-powershell",
    activeTurn: { unsafePeek: () => ({ turnId: "turn-powershell" }) },
    rolloutStore: { assertToolAdmissionAllowed: vi.fn() },
    services: {
      executionAdmission: admission,
      admissionRequired: true,
    },
  } as unknown as Session;
  return { admission, acquire, session };
}

function toolContext(broker: SandboxExecutionBroker) {
  const appState = { toolPermissionContext: getEmptyToolPermissionContext() };
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    setToolJSX: () => {},
    services: { sandboxExecutionBroker: broker },
  } as never;
}

afterEach(() => {
  clearCurrentRuntimeSession();
  shellProbe.signals.length = 0;
  shellProbe.onExec = undefined;
});

describe("direct PowerShell admission", () => {
  it("admits and settles before a direct TUI/prompt PowerShell effect", async () => {
    const state = admissionHarness();
    const broker = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: process.cwd(),
      platform: "linux",
      probe: () => ({
        kind: "unavailable",
        mode: "workspace_write",
        platform: "linux",
        reason: "probe: unavailable in admission test",
      }),
    });

    await expect(
      runWithCurrentRuntimeSession(state.session, () =>
        PowerShellTool.call(
          { command: "Write-Output 'must-not-run'" },
          toolContext(broker),
          undefined as never,
          undefined as never,
        ),
      ),
    ).rejects.toMatchObject({ code: "sandbox_probe_failed" });

    expect(state.acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "tool_exec",
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
      expect.any(AbortSignal),
    );
    expect(state.admission.markDispatched).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        details: expect.objectContaining({
          toolName: "PowerShell",
          recoveryCategory: "side-effecting",
        }),
      }),
    );
    expect(state.admission.reconcile).toHaveBeenCalledWith(expect.any(String), {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it.skipIf(findPowerShell() === null)(
    "forwards lease cancellation into the running PowerShell process",
    async () => {
      const leaseController = new AbortController();
      const state = admissionHarness(leaseController.signal);
      const broker = new SandboxExecutionBroker({
        mode: "danger_full_access",
        cwd: process.cwd(),
      });
      const started = Promise.withResolvers<void>();
      shellProbe.onExec = () => started.resolve();

      const call = runWithCurrentRuntimeSession(state.session, () =>
        PowerShellTool.call(
          { command: "Start-Sleep -Seconds 30", timeout: 35_000 },
          toolContext(broker),
          undefined as never,
          undefined as never,
        ),
      );
      await started.promise;
      const effectSignal = shellProbe.signals.at(-1)!;
      const cancellation = new AdmissionDeniedError(
        "parent_cancelled",
        "cancelled",
      );
      leaseController.abort(cancellation);

      await expect(call).rejects.toBeDefined();
      expect(effectSignal.aborted).toBe(true);
      expect(effectSignal.reason).toBe(cancellation);
      expect(state.admission.holdUnknown).toHaveBeenCalledWith(
        expect.any(String),
        "tool_cancelled_after_dispatch",
      );
    },
    10_000,
  );
});
