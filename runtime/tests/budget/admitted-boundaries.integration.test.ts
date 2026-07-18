import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { runAdmittedToolCall } from "../../src/budget/admitted-tool-call.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import type { ExecutionAdmissionClient } from "../../src/budget/admission-client.js";
import { upsertAgentRun } from "../../src/state/agent-runs.js";
import { ThreadSpawnEdgeRepository } from "../../src/state/spawn-edges.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import type {
  LLMChatOptions,
  LLMProvider,
  LLMResponse,
} from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import type { Tool } from "../../src/tools/types.js";

let agencHome = "";
let cwd = "";
let kernel: ExecutionAdmissionKernel;

beforeEach(() => {
  agencHome = mkdtempSync(join(tmpdir(), "agenc-boundary-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-boundary-cwd-"));
  mkdirSync(join(cwd, ".git"));
  kernel = new ExecutionAdmissionKernel({
    agencHome,
    ownerId: "boundary-integration",
    ownerPid: process.pid,
    limits: {
      global: 4,
      workspace: 4,
      session: 4,
      parent: 4,
      provider: 4,
    },
  });
});

afterEach(() => {
  kernel.close();
  rmSync(agencHome, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function admission(runId = "boundary-run"): ExecutionAdmissionClient {
  return kernel.bindClient({
    cwd,
    scope: {
      runId,
      sessionId: runId,
      autonomous: false,
    },
  });
}

function sessionFor(
  executionAdmission: ExecutionAdmissionClient,
  overrides: Partial<Session> = {},
): Session {
  return {
    conversationId: executionAdmission.scope.sessionId,
    services: {
      executionAdmission,
      admissionRequired: true,
      agentControl: { shutdownAgentTree: vi.fn() },
    },
    abortTerminal: vi.fn(),
    ...overrides,
  } as unknown as Session;
}

const provider = {
  name: "grok",
  getExecutionProfile: async () => ({
    provider: "grok",
    model: "grok-4.5",
    usageReporting: "authoritative" as const,
    supportsMaxOutputTokens: true,
  }),
} as unknown as LLMProvider;

function modelResponse(
  usage: Partial<LLMResponse["usage"]> = {},
): LLMResponse {
  return {
    content: "ok",
    toolCalls: [],
    model: "grok-4.5",
    finishReason: "stop",
    usage: {
      promptTokens: 8,
      completionTokens: 4,
      totalTokens: 12,
      availability: "reported",
      provenance: "provider",
      ...usage,
    },
  };
}

async function modelCall(params: {
  client: ExecutionAdmissionClient;
  stepId: string;
  invoke: (options: LLMChatOptions) => Promise<LLMResponse>;
  signal?: AbortSignal;
}): Promise<LLMResponse> {
  return runAdmittedModelCall({
    session: sessionFor(params.client),
    provider,
    messages: [{ role: "user", content: "hello" }],
    options: { maxOutputTokens: 32 },
    stepId: params.stepId,
    model: "grok-4.5",
    providerName: "grok",
    ...(params.signal !== undefined ? { signal: params.signal } : {}),
    invoke: params.invoke,
  });
}

function useSingleCapacityKernel(): void {
  kernel.close();
  kernel = new ExecutionAdmissionKernel({
    agencHome,
    ownerId: "boundary-single-capacity",
    ownerPid: process.pid,
    limits: {
      global: 1,
      workspace: 1,
      session: 1,
      parent: 1,
      provider: 1,
    },
  });
}

async function flushAdmissionScheduler(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("admitted execution boundaries with the durable kernel", () => {
  it("keeps admitted capacity while an abort-ignoring provider settles", async () => {
    useSingleCapacityKernel();
    const client = admission("abort-ignoring-model-run");
    const controller = new AbortController();
    const firstInvoked = Promise.withResolvers<void>();
    const firstResponse = Promise.withResolvers<LLMResponse>();
    const firstCall = modelCall({
      client,
      stepId: "model:abort-ignoring:first",
      signal: controller.signal,
      invoke: async () => {
        firstInvoked.resolve();
        // This provider deliberately ignores its admitted AbortSignal and
        // resolves successfully after cancellation is already durable.
        return firstResponse.promise;
      },
    });
    await firstInvoked.promise;

    controller.abort("caller_cancelled");
    let replacementInvoked = false;
    const replacementCall = modelCall({
      client,
      stepId: "model:abort-ignoring:replacement",
      invoke: async () => {
        replacementInvoked = true;
        return modelResponse();
      },
    });
    await flushAdmissionScheduler();

    expect(kernel.activeCount).toBe(1);
    expect(kernel.queuedCount).toBe(1);
    expect(replacementInvoked).toBe(false);
    expect(
      kernel
        .listJournal({ cwd, runId: client.scope.runId })
        .some((event) => event.event === "held_unknown"),
    ).toBe(true);

    firstResponse.resolve(modelResponse());
    await expect(firstCall).rejects.toThrow(/caller_cancelled/);
    await expect(replacementCall).resolves.toMatchObject({ content: "ok" });
    expect(replacementInvoked).toBe(true);
    expect(
      kernel
        .listJournal({ cwd, runId: client.scope.runId })
        .some(
          (event) =>
            event.stepId === "model:abort-ignoring:first" &&
            event.event === "reconciled",
        ),
    ).toBe(true);
    expect(kernel.activeCount).toBe(0);
    expect(kernel.queuedCount).toBe(0);
  });

  it("keeps admitted capacity while an abort-ignoring tool settles", async () => {
    useSingleCapacityKernel();
    const client = admission("abort-ignoring-tool-run");
    const session = sessionFor(client);
    const controller = new AbortController();
    const firstInvoked = Promise.withResolvers<void>();
    const firstResult = Promise.withResolvers<{ readonly content: string }>();
    const tool = {
      name: "abort-ignoring.integration",
      recoveryCategory: "side-effecting",
      admissionEstimate: () => ({
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
    } as unknown as Tool;
    const firstCall = runAdmittedToolCall({
      session,
      turnId: "turn:abort-ignoring",
      callId: "first",
      tool,
      args: {},
      signal: controller.signal,
      invoke: async () => {
        firstInvoked.resolve();
        // This tool deliberately ignores its dispatch AbortSignal and resolves
        // successfully after cancellation is already durable.
        return firstResult.promise;
      },
    });
    await firstInvoked.promise;

    controller.abort("caller_cancelled");
    let replacementInvoked = false;
    const replacementCall = runAdmittedToolCall({
      session,
      turnId: "turn:abort-ignoring",
      callId: "replacement",
      tool,
      args: {},
      invoke: async () => {
        replacementInvoked = true;
        return { content: "replacement" };
      },
    });
    await flushAdmissionScheduler();

    expect(kernel.activeCount).toBe(1);
    expect(kernel.queuedCount).toBe(1);
    expect(replacementInvoked).toBe(false);

    firstResult.resolve({ content: "first" });
    await expect(firstCall).rejects.toThrow(/caller_cancelled/);
    await expect(replacementCall).resolves.toMatchObject({
      content: "replacement",
    });
    expect(replacementInvoked).toBe(true);
    expect(
      kernel
        .listJournal({ cwd, runId: client.scope.runId })
        .some(
          (event) =>
            event.stepId === "tool:turn:abort-ignoring:first" &&
            event.event === "reconciled",
        ),
    ).toBe(true);
    expect(kernel.activeCount).toBe(0);
    expect(kernel.queuedCount).toBe(0);
  });

  it("persists one model reservation through dispatch and reconciliation", async () => {
    const client = admission();

    await expect(
      modelCall({
        client,
        stepId: "model:success",
        invoke: async () => modelResponse(),
      }),
    ).resolves.toMatchObject({ content: "ok" });

    const events = kernel.listJournal({ cwd, runId: client.scope.runId });
    expect(events.map((event) => event.event)).toEqual([
      "queued",
      "allowed",
      "dispatched",
      "reconciled",
    ]);
    expect(events.at(-1)).toMatchObject({
      actualTokens: 12,
      actualCostUsd: expect.any(Number),
    });
    expect(kernel.activeCount).toBe(0);
  });

  it("holds a failed provider attempt and still admits a later turn", async () => {
    const client = admission();

    await expect(
      modelCall({
        client,
        stepId: "model:failed",
        invoke: async () => {
          throw new Error("wire disconnected");
        },
      }),
    ).rejects.toThrow("wire disconnected");

    await expect(
      modelCall({
        client,
        stepId: "model:follow-up",
        invoke: async () => modelResponse(),
      }),
    ).resolves.toMatchObject({ content: "ok" });

    const events = kernel.listJournal({ cwd, runId: client.scope.runId });
    expect(
      events.find(
        (event) =>
          event.stepId === "model:failed" && event.event === "held_unknown",
      ),
    ).toMatchObject({ reason: "provider_call_failed_after_dispatch" });
    expect(
      events.find(
        (event) =>
          event.stepId === "model:follow-up" && event.event === "reconciled",
      ),
    ).toBeDefined();
  });

  it("persists missing and failed charged-tool usage as full unknown holds", async () => {
    const client = admission();
    const session = sessionFor(client);
    const tool = {
      name: "metered.integration",
      recoveryCategory: "side-effecting",
      admissionEstimate: () => ({
        maxInputTokens: 10,
        maxOutputTokens: 20,
        maxCostUsd: 1,
      }),
    } as unknown as Tool;

    await runAdmittedToolCall({
      session,
      turnId: "turn:1",
      callId: "missing",
      tool,
      args: {},
      invoke: async () => ({ content: "unknown" }),
    });
    await expect(
      runAdmittedToolCall({
        session,
        turnId: "turn:1",
        callId: "failed",
        tool,
        args: {},
        invoke: async () => {
          throw new Error("effect acknowledgement lost");
        },
      }),
    ).rejects.toThrow("effect acknowledgement lost");

    const held = kernel
      .listJournal({ cwd, runId: client.scope.runId })
      .filter((event) => event.event === "held_unknown");
    expect(held).toMatchObject([
      {
        stepId: "tool:turn:1:missing",
        reason: "missing_tool_usage",
      },
      {
        stepId: "tool:turn:1:failed",
        reason: "tool_failed_after_dispatch",
      },
    ]);
    expect(kernel.activeCount).toBe(0);
  });

  it("makes a provider overrun explicit and locks future descendants", async () => {
    const client = admission("overrun-parent");
    const session = sessionFor(client);

    await expect(
      runAdmittedModelCall({
        session,
        provider,
        messages: [{ role: "user", content: "hello" }],
        options: { maxOutputTokens: 1 },
        stepId: "model:overrun",
        model: "grok-4.5",
        providerName: "grok",
        invoke: async () =>
          modelResponse({
            promptTokens: 100_000,
            completionTokens: 10_000,
            totalTokens: 110_000,
          }),
      }),
    ).rejects.toMatchObject({
      name: "AdmissionDeniedError",
      reason: "provider_overrun",
    });

    const child = client.forSession({
      runId: "overrun-child",
      sessionId: "overrun-child",
    });
    await expect(
      child.acquire({
        stepId: "future-child",
        kind: "tool_exec",
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
    ).rejects.toMatchObject({ reason: "parent_cancel_locked" });
    expect(
      kernel
        .listJournal({ cwd, runId: client.scope.runId })
        .map((event) => event.event),
    ).toEqual([
      "queued",
      "allowed",
      "dispatched",
      "provider_overrun",
    ]);
    expect(session.abortTerminal).toHaveBeenCalledWith("provider_overrun");
  });

  it("atomically holds an unpriced hard-cap response and survives a crash before live shutdown", async () => {
    const parentRunId = "unpriced_parent";
    const childRunId = "unpriced_child";
    const seeded = openStateDatabases({ cwd, agencHome });
    try {
      for (const id of [parentRunId, childRunId]) {
        upsertAgentRun(seeded, {
          id,
          objective: id,
          status: "running",
          startedAt: "2026-07-18T00:00:00.000Z",
          lastActiveAt: "2026-07-18T00:00:00.000Z",
        });
      }
      new ThreadSpawnEdgeRepository(seeded).create({
        childThreadId: childRunId,
        parentThreadId: parentRunId,
        parentPath: "/root",
        metadata: {
          agentId: childRunId,
          agentPath: `/root/${childRunId}`,
          depth: 1,
        },
        status: "open",
      });
    } finally {
      seeded.close();
    }

    const client = kernel.bindClient({
      cwd,
      scope: {
        runId: parentRunId,
        sessionId: parentRunId,
        autonomous: true,
        maxCostUsd: 1,
      },
    });
    const session = sessionFor(client);
    const shutdownAgentTree = vi.mocked(
      session.services.agentControl.shutdownAgentTree!,
    );
    // Never resolve live shutdown: the durable transaction must already be
    // sufficient if the daemon dies at this exact boundary.
    shutdownAgentTree.mockImplementation(() => new Promise<void>(() => {}));

    await expect(
      runAdmittedModelCall({
        session,
        provider,
        messages: [{ role: "user", content: "hello" }],
        options: { maxOutputTokens: 32 },
        stepId: "model:unpriced-after-wire",
        model: "grok-4.5",
        providerName: "grok",
        invoke: async () => ({
          ...modelResponse(),
          model: "provider-model-without-pricing",
        }),
      }),
    ).rejects.toMatchObject({
      name: "AdmissionDeniedError",
      reason: "unpriced_provider_response",
    });
    expect(shutdownAgentTree).toHaveBeenCalledWith(parentRunId);
    expect(session.abortTerminal).toHaveBeenCalledWith("provider_overrun");

    // Simulate process loss immediately after the durable error path, before
    // the unresolved live shutdown completes, then recover the same database.
    kernel.close();
    kernel = new ExecutionAdmissionKernel({
      agencHome,
      ownerId: "boundary-integration-restarted",
      ownerPid: process.pid,
      limits: {
        global: 4,
        workspace: 4,
        session: 4,
        parent: 4,
        provider: 4,
      },
    });
    kernel.initializeExistingState();

    const inspected = openStateDatabases({ cwd, agencHome });
    try {
      const statuses = inspected
        .prepareState<
          [string, string],
          { readonly id: string; readonly status: string }
        >(
          `SELECT id, status FROM agent_runs WHERE id IN (?, ?) ORDER BY id ASC`,
        )
        .all(parentRunId, childRunId);
      expect(statuses).toEqual([
        { id: childRunId, status: "cancelled" },
        { id: parentRunId, status: "cancelled" },
      ]);
      expect(
        inspected
          .prepareState<[string], { readonly status: string }>(
            `SELECT status FROM thread_spawn_edges WHERE child_thread_id = ?`,
          )
          .get(childRunId)?.status,
      ).toBe("closed");
      expect(
        inspected
          .prepareState<[], { readonly status: string }>(
            `SELECT status FROM execution_admission_reservations LIMIT 1`,
          )
          .get()?.status,
      ).toBe("held_unknown");
      expect(
        inspected
          .prepareState<[], {
            readonly used_cost_nanos: number;
            readonly held_cost_nanos: number;
            readonly reserved_cost_nanos: number;
          }>(
            `SELECT a.used_cost_nanos, a.held_cost_nanos,
                    r.reserved_cost_nanos
             FROM execution_admission_allocations a
             JOIN execution_admission_reservation_allocations ra
               ON ra.scope_key = a.scope_key
             JOIN execution_admission_reservations r
               ON r.reservation_id = ra.reservation_id
             LIMIT 1`,
          )
          .get(),
      ).toMatchObject({
        held_cost_nanos: 0,
        used_cost_nanos: expect.any(Number),
        reserved_cost_nanos: expect.any(Number),
      });
      const charge = inspected
        .prepareState<[], {
          readonly used_cost_nanos: number;
          readonly reserved_cost_nanos: number;
        }>(
          `SELECT a.used_cost_nanos, r.reserved_cost_nanos
           FROM execution_admission_allocations a
           JOIN execution_admission_reservation_allocations ra
             ON ra.scope_key = a.scope_key
           JOIN execution_admission_reservations r
             ON r.reservation_id = ra.reservation_id
           LIMIT 1`,
        )
        .get();
      expect(charge?.used_cost_nanos).toBe(charge?.reserved_cost_nanos);
      expect(
        inspected
          .prepareState<[], { readonly count: number }>(
            `SELECT COUNT(*) AS count FROM execution_admission_cancellations
             WHERE run_id IN ('unpriced_parent', 'unpriced_child')`,
          )
          .get()?.count,
      ).toBe(2);
    } finally {
      inspected.close();
    }

    const restartedParent = kernel.bindClient({
      cwd,
      scope: {
        runId: parentRunId,
        sessionId: parentRunId,
        autonomous: true,
        maxCostUsd: 1,
      },
    });
    const restartedChild = restartedParent.forSession({
      runId: childRunId,
      sessionId: childRunId,
    });
    await expect(
      restartedChild.acquire({
        stepId: "after-restart",
        kind: "tool_exec",
        maxInputTokens: 0,
        maxOutputTokens: 0,
        maxCostUsd: 0,
      }),
    ).rejects.toMatchObject({ reason: "parent_cancel_locked" });
  });
});
