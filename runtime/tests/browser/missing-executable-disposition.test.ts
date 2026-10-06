/**
 * A browser executable that cannot be resolved means no browser ever launched. The Browser tool must say so
 * authoritatively, or the side-effecting call is journaled as an unknown outcome and fences every later tool in
 * the session (Terminal-Bench 4.0, DeepSeek nextjs-performance, 2026-09-14). Adapted from Codex's review fixture.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  launches: vi.fn(),
  starts: vi.fn(async () => 4321),
  stops: vi.fn(async () => {}),
}));

vi.mock("../../src/browser/cdp.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/browser/cdp.js")>(),
  launchBrowser: seam.launches,
}));
vi.mock("../../src/browser/proxy.js", () => ({
  BrowserProxy: class {
    start = seam.starts;
    stop = seam.stops;
    takeBlockReason() { return undefined; }
  },
}));

import { BrowserManager } from "../../src/browser/manager.js";
import { createBrowserTool } from "../../src/tools/BrowserTool/tool.js";
import { attachSandboxExecutionBroker, SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { disposeSandboxExecutionBroker } from "../../src/sandbox/execution-lifecycle.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import type { AdmissionAcquireInput, ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import type { Session } from "../../src/session/session.js";
import type { Tool } from "../../src/tools/types.js";

afterEach(() => vi.clearAllMocks());

const MISSING_EXECUTABLE = "/agenc-test-no-browser-installed/chromium";

function managerFor(executablePath: string): BrowserManager {
  return new BrowserManager({
    policy: { executablePath, headless: true, noSandbox: false, allowPrivateNetwork: false, navigationTimeoutMs: 1000 },
  });
}

async function navigateWith(manager: BrowserManager) {
  const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: process.cwd() });
  const tool = createBrowserTool({ manager });
  const args: Record<string, unknown> = { action: "navigate", url: "http://127.0.0.1:3000/" };
  attachSandboxExecutionBroker(args, broker, "browser");
  try {
    return await tool.execute(args);
  } finally {
    await disposeSandboxExecutionBroker(broker);
  }
}

describe("Browser tool when no browser executable can be resolved", () => {
  it("reports an authoritative no-effect failure once the attempt's proxy is stopped", async () => {
    const result = await navigateWith(managerFor(MISSING_EXECUTABLE));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("configured browser executable not found");
    expect(seam.launches).not.toHaveBeenCalled();
    expect(seam.stops).toHaveBeenCalledOnce();
    expect(result.effectDisposition).toMatchObject({
      disposition: "confirmed_no_effect",
      evidenceKind: "boundary_not_crossed",
      evidenceRef: "tool:Browser:launch-executable-not-found",
    });
  });

  it("does not claim no effect when stopping the proxy failed", async () => {
    seam.stops.mockRejectedValueOnce(new Error("injected proxy cleanup failure"));

    const result = await navigateWith(managerFor(MISSING_EXECUTABLE));

    expect(result.isError).toBe(true);
    expect(result.content).toContain("browser launch cleanup failed");
    expect(result.effectDisposition?.disposition).not.toBe("confirmed_no_effect");
  });

  it("does not claim no effect when the browser launch itself failed", async () => {
    seam.launches.mockRejectedValueOnce(new Error("injected launch failure"));

    const result = await navigateWith(managerFor(process.execPath));

    expect(result.isError).toBe(true);
    expect(seam.launches).toHaveBeenCalledOnce();
    expect(result.effectDisposition?.disposition).not.toBe("confirmed_no_effect");
  });

  it("does not trust an unbranded error that only looks like a missing executable", async () => {
    const forged = new Error("configured browser executable not found: forged");
    forged.name = "BrowserExecutableError";
    const manager = {
      navigate: vi.fn(async () => { throw forged; }),
      closeAll: vi.fn(async () => {}),
    } as unknown as BrowserManager;

    const result = await navigateWith(manager);

    expect(result.isError).toBe(true);
    expect(result.effectDisposition?.disposition).not.toBe("confirmed_no_effect");
  });

  it("keeps a later admitted side-effecting command usable after the refusal", async () => {
    const events: Event[] = [];
    const eventLog = new EventLog();
    eventLog.subscribe((event) => events.push(event));
    const admission = {
      scope: { runId: "browser-missing-executable", workspaceId: "test", sessionId: "browser-missing-executable", autonomous: false },
      acquire: vi.fn(async (input: AdmissionAcquireInput) => ({
        decision: "allow",
        reservation: {
          reservationId: `reservation-${input.stepId}`,
          step: { runId: "browser-missing-executable", stepId: input.stepId },
          reservedCostUsd: 0, reservedTokens: 0, reservedAt: "2026-09-14T00:00:00.000Z",
        },
        request: {
          step: { runId: "browser-missing-executable", stepId: input.stepId }, kind: input.kind,
          estimate: { maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 },
          workspaceId: "test", sessionId: "browser-missing-executable", parentScopeId: "turn", autonomous: false,
        },
        signal: new AbortController().signal,
      })),
      markDispatched: vi.fn(), reconcile: vi.fn(() => ({ applied: true, outcome: "reconciled" })),
      holdUnknown: vi.fn(), void: vi.fn(), acknowledgeCompletion: vi.fn(),
      recordFallback: vi.fn(), forSession: vi.fn(), subscribe: vi.fn(() => () => {}),
    } as unknown as ExecutionAdmissionClient;
    const session = {
      conversationId: "browser-missing-executable", eventLog,
      rolloutStore: { assertToolAdmissionAllowed: vi.fn() },
      emit: (event: Event) => eventLog.emit(event),
      services: { executionAdmission: admission, admissionRequired: true, agentControl: { shutdownAgentTree: vi.fn() } },
      abortTerminal: vi.fn(),
    } as unknown as Session;
    const broker = new SandboxExecutionBroker({ mode: "danger_full_access", cwd: process.cwd() });
    const tool = createBrowserTool({ manager: managerFor(MISSING_EXECUTABLE) });
    const args: Record<string, unknown> = { action: "navigate", url: "http://127.0.0.1:3000/" };
    attachSandboxExecutionBroker(args, broker, "browser");
    const estimate = () => ({ maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 });
    try {
      const refused = await runAdmittedToolCall({
        session, turnId: "turn", callId: "missing-browser",
        tool: { ...tool, admissionEstimate: estimate }, args,
        invoke: async ({ crossEffectBoundary }) => { crossEffectBoundary(); return tool.execute(args); },
      });
      expect(refused.isError).toBe(true);

      const followUp = vi.fn(async () => ({ content: "follow-up dispatched" }));
      await expect(runAdmittedToolCall({
        session, turnId: "turn", callId: "follow-up",
        tool: { name: "exec_command", recoveryCategory: "side-effecting", admissionEstimate: estimate } as unknown as Tool,
        args: {},
        invoke: async ({ crossEffectBoundary }) => { crossEffectBoundary(); return followUp(); },
      })).resolves.toMatchObject({ content: "follow-up dispatched" });
      expect(followUp).toHaveBeenCalledOnce();
      expect(events.some((event) => event.msg.type === "effect_unknown_outcome")).toBe(false);
    } finally {
      await disposeSandboxExecutionBroker(broker);
    }
  });
});
