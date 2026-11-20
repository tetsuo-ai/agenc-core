import { describe, expect, it, vi } from "vitest";

import { AsyncQueue } from "../utils/async-queue.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import {
  ensureAgentTaskRegistered,
  lastTokenInfoFromRollout,
  latestPersistedAgentTask,
  maybePrewarmAgentTaskRegistration,
  recordInitialHistoryOnResume,
  recordedTokenUsageFromRollout,
  restorePersistedAgentTask,
  type RegisteredAgentTask,
  type SessionAgentTask,
} from "./agent-task-lifecycle.js";
import { readMemoryExtractionState } from "./memory-extraction-state.js";
import type { RolloutItem } from "./rollout-item.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "./session.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
} from "./turn-context.js";
import type { LLMProvider } from "../llm/types.js";

function mkFeatures(): ManagedFeatures {
  return {
  };
}

function mkConfig(): Config {
  return {
    model: "test-model",
    cwd: "/tmp",
    features: mkFeatures(),
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

function mkModelInfo(): ModelInfo {
  return {
    slug: "test-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function mkSessionConfiguration(): SessionConfiguration {
  return {
    cwd: "/tmp",
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    windowsSandboxLevel: "none",
    collaborationMode: { model: "test-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
}

function mkProvider(): LLMProvider {
  return {
    name: "stub-provider",
    chat: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
    chatStream: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
  } as unknown as LLMProvider;
}

function buildSession(
  overrides: { services?: Partial<SessionServices> } = {},
): Session {
  const services = {
    permissionModeRegistry: new PermissionModeRegistry(
      createEmptyToolPermissionContext(),
    ),
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider: mkProvider(),
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
    agentIdentityManager: {
      ensureRegistered: async () => {},
      registerTask: async () => null,
      taskMatchesCurrentIdentity: async () => false,
    },
    ...(overrides.services ?? {}),
  } as unknown as SessionServices;

  const opts: SessionOpts = {
    conversationId: "conv-agent-task",
    initialState: {
      sessionConfiguration: mkSessionConfiguration(),
      history: [],
    },
    features: mkFeatures(),
    services,
    jsRepl: { id: "repl-test" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  };
  return new Session(opts);
}

async function readStoredAgentTask(
  session: Session,
): Promise<SessionAgentTask | undefined> {
  return session.state.with(
    (state) => (state as { agentTask?: SessionAgentTask }).agentTask,
  );
}

describe("agent task lifecycle", () => {
  it("prewarm caches a registered task without emitting session events", async () => {
    const registeredTask: RegisteredAgentTask = {
      agentRuntimeId: "agent-1",
      taskId: "task-1",
      registeredAt: "2026-04-21T00:00:00Z",
    };
    const session = buildSession({
      services: {
        agentIdentityManager: {
          ensureRegistered: async () => {},
          registerTask: vi.fn(async () => registeredTask),
          taskMatchesCurrentIdentity: vi.fn(async () => true),
        } as SessionServices["agentIdentityManager"],
      },
    });

    await maybePrewarmAgentTaskRegistration(session);

    expect(await readStoredAgentTask(session)).toEqual({
      agentRuntimeId: "agent-1",
      taskId: "task-1",
      registeredAt: "2026-04-21T00:00:00Z",
    });
    expect(session.txEvent.tryRecv()).toBeUndefined();
  });

  it("prewarm swallows registration failures without emitting session events", async () => {
    const session = buildSession({
      services: {
        agentIdentityManager: {
          ensureRegistered: async () => {},
          registerTask: vi.fn(async () => {
            throw new Error("registration exploded");
          }),
          taskMatchesCurrentIdentity: vi.fn(async () => true),
        } as SessionServices["agentIdentityManager"],
      },
    });

    await maybePrewarmAgentTaskRegistration(session);

    expect(await readStoredAgentTask(session)).toBeUndefined();
    expect(session.txEvent.tryRecv()).toBeUndefined();
  });

  it("persists canonical session_state rollout items when registration succeeds", async () => {
    const registeredTask: RegisteredAgentTask = {
      agentRuntimeId: "agent-2",
      taskId: "task-2",
      registeredAt: "2026-04-21T00:00:01Z",
    };
    const record = vi.fn(async () => {});
    const session = buildSession({
      services: {
        rollout: { record } as SessionServices["rollout"],
        agentIdentityManager: {
          ensureRegistered: async () => {},
          registerTask: vi.fn(async () => registeredTask),
          taskMatchesCurrentIdentity: vi.fn(async () => true),
        } as SessionServices["agentIdentityManager"],
      },
    });

    await expect(ensureAgentTaskRegistered(session)).resolves.toEqual(
      registeredTask,
    );

    expect(record).toHaveBeenCalledWith({
      type: "session_state",
      payload: {
        agentTask: {
          agentRuntimeId: "agent-2",
          taskId: "task-2",
          registeredAt: "2026-04-21T00:00:01Z",
        },
      },
    });
    expect(session.txEvent.tryRecv()).toBeUndefined();
  });

  it("restores persisted tasks from canonical rollout items", async () => {
    const session = buildSession({
      services: {
        agentIdentityManager: {
          ensureRegistered: async () => {},
          registerTask: vi.fn(async () => null),
          taskMatchesCurrentIdentity: vi.fn(async () => true),
        } as SessionServices["agentIdentityManager"],
      },
    });

    const found = latestPersistedAgentTask([
      {
        type: "session_state",
        payload: {
          agentTask: {
            agentRuntimeId: "agent-3",
            taskId: "task-3",
            registeredAt: "2026-04-21T00:00:02Z",
          },
        },
      },
    ]);

    expect(found).toEqual({
      value: {
        agentRuntimeId: "agent-3",
        taskId: "task-3",
        registeredAt: "2026-04-21T00:00:02Z",
      },
    });

    await restorePersistedAgentTask(session, [
      {
        type: "session_state",
        payload: {
          agentTask: {
            agentRuntimeId: "agent-3",
            taskId: "task-3",
            registeredAt: "2026-04-21T00:00:02Z",
          },
        },
      },
    ]);

    expect(await readStoredAgentTask(session)).toEqual({
      agentRuntimeId: "agent-3",
      taskId: "task-3",
      registeredAt: "2026-04-21T00:00:02Z",
    });
  });

  it("lastTokenInfoFromRollout returns the newest token_count payload", () => {
    const items: RolloutItem[] = [
      {
        type: "event_msg",
        payload: {
          id: "a",
          seq: 1,
          msg: {
            type: "token_count",
            payload: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          },
        },
      },
      { type: "response_item", payload: { role: "user", content: "ok" } },
      {
        type: "event_msg",
        payload: {
          id: "b",
          seq: 2,
          msg: {
            type: "token_count",
            payload: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
            },
          },
        },
      },
    ];
    expect(lastTokenInfoFromRollout(items)).toEqual({
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    });
  });

  it("lastTokenInfoFromRollout returns undefined when no token_count ever emitted", () => {
    const items: RolloutItem[] = [
      { type: "response_item", payload: { role: "user", content: "ok" } },
    ];
    expect(lastTokenInfoFromRollout(items)).toBeUndefined();
  });

  it("recordInitialHistoryOnResume restores task, emits model-change warning, seeds token usage", async () => {
    const registeredTask: RegisteredAgentTask = {
      agentRuntimeId: "agent-resume",
      taskId: "task-resume",
      registeredAt: "2026-04-21T00:00:00Z",
    };
    const session = buildSession({
      services: {
        agentIdentityManager: {
          ensureRegistered: async () => {},
          registerTask: vi.fn(async () => null),
          taskMatchesCurrentIdentity: vi.fn(async () => true),
        } as SessionServices["agentIdentityManager"],
      },
    });

    const rollout: RolloutItem[] = [
      {
        type: "session_state",
        payload: { agentTask: registeredTask },
      },
      {
        type: "event_msg",
        payload: {
          id: "tok",
          seq: 1,
          msg: {
            type: "token_count",
            payload: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
          },
        },
      },
    ];

    await recordInitialHistoryOnResume(session, rollout, {
      previousModel: "grok-3",
      currentModel: "grok-4-fast",
    });

    // 1. Agent task restored.
    expect(await readStoredAgentTask(session)).toEqual(registeredTask);

    // 2. Initial token usage seeded on session state.
    const seededUsage = await session.state.with(
      (state) =>
        (state as { initialTokenUsage?: { totalTokens?: number } })
          .initialTokenUsage,
    );
    expect(seededUsage).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });

    // 3. Model-change warning emitted onto the session event stream.
    const warnings: Array<{ type: string; cause?: string; message?: string }> =
      [];
    while (true) {
      const next = session.txEvent.tryRecv();
      if (!next) break;
      const payload = next.msg.payload as {
        cause?: string;
        message?: string;
      };
      warnings.push({
        type: next.msg.type,
        cause: payload?.cause,
        message: payload?.message,
      });
    }
    expect(
      warnings.some(
        (w) =>
          w.type === "warning" &&
          w.cause === "resumed_with_different_model" &&
          (w.message ?? "").includes("grok-3") &&
          (w.message ?? "").includes("grok-4-fast"),
      ),
    ).toBe(true);
  });

  it("recordedTokenUsageFromRollout sums every token_count and resume seeds the sum", async () => {
    const usage = (seq: number, promptTokens: number, completionTokens: number): RolloutItem => ({
      type: "event_msg",
      payload: {
        id: `usage-${seq}`,
        seq,
        msg: {
          type: "token_count",
          payload: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
        },
      },
    });
    const rollout: RolloutItem[] = [
      usage(1, 1_200, 30),
      { type: "response_item", payload: { role: "user", content: "next" } },
      usage(2, 1_400, 20),
    ];
    const recorded = { promptTokens: 2_600, completionTokens: 50, totalTokens: 2_650 };
    expect(recordedTokenUsageFromRollout(rollout)).toEqual(recorded);
    expect(recordedTokenUsageFromRollout([])).toBeUndefined();

    const session = buildSession();
    await recordInitialHistoryOnResume(session, rollout, { currentModel: "grok-4-fast" });
    const seeded = await session.state.with((state) => ({
      last: state.initialTokenUsage,
      recorded: state.resumedHistoryTokenUsage,
    }));
    expect(seeded).toEqual({
      last: { promptTokens: 1_400, completionTokens: 20, totalTokens: 1_420 },
      recorded,
    });
  });

  it("resume seeds what the admission ledger holds of the run next to the recorded sum", async () => {
    const rollout: RolloutItem[] = [{
      type: "event_msg",
      payload: {
        id: "usage-1",
        seq: 1,
        msg: { type: "token_count", payload: { promptTokens: 1_200, completionTokens: 30, totalTokens: 1_230 } },
      },
    }];
    const ledgerOf = (getDirectUsageSummary: () => unknown) => buildSession({
      services: { executionAdmission: { getDirectUsageSummary } } as unknown as Partial<SessionServices>,
    });
    const seeded = async (session: Session) => session.state.with((state) => state.resumedLedgerUsage);
    const summary = vi.fn(() => ({
      runId: "conv-agent-task", sequence: 4, inputTokens: 1_250, outputTokens: 30, totalTokens: 1_280,
      costUsd: 0.0004, modelCalls: 2, hasUnknownCost: false, heldCostUsd: 0, models: [], agents: [],
    }));

    const session = ledgerOf(summary);
    await recordInitialHistoryOnResume(session, rollout, { currentModel: "grok-4-fast" });
    expect(await seeded(session)).toEqual({ inputTokens: 1_250, outputTokens: 30, totalTokens: 1_280 });

    // Nothing to check without recorded usage, and nothing seeded when the
    // ledger cannot be read.
    summary.mockClear();
    const fresh = ledgerOf(summary);
    await recordInitialHistoryOnResume(fresh, [], { currentModel: "grok-4-fast" });
    expect(summary).not.toHaveBeenCalled();
    expect(await seeded(fresh)).toBeUndefined();
    const closed = ledgerOf(() => { throw new Error("kernel closed"); });
    await recordInitialHistoryOnResume(closed, rollout, { currentModel: "grok-4-fast" });
    expect(await seeded(closed)).toBeUndefined();
    expect(await closed.state.with((state) => state.resumedHistoryTokenUsage))
      .toEqual({ promptTokens: 1_200, completionTokens: 30, totalTokens: 1_230 });
  });

  it("recordInitialHistoryOnResume is quiet when model matches", async () => {
    const session = buildSession({
      services: {
        agentIdentityManager: {
          ensureRegistered: async () => {},
          registerTask: vi.fn(async () => null),
          taskMatchesCurrentIdentity: vi.fn(async () => true),
        } as SessionServices["agentIdentityManager"],
      },
    });

    await recordInitialHistoryOnResume(session, [], {
      previousModel: "grok-4-fast",
      currentModel: "grok-4-fast",
    });

    // No events emitted, no state mutations.
    expect(session.txEvent.tryRecv()).toBeUndefined();
  });

  it("keeps a persisted agent task when a later session_state item carries only the memory-extraction cadence", async () => {
    const task: SessionAgentTask = {
      agentRuntimeId: "agent-5",
      taskId: "task-5",
      registeredAt: "2026-04-21T00:00:05Z",
    };
    const cadence = {
      memoryRoot: "/memory",
      processedVisibleCount: 4,
      turnsSinceLastExtraction: 2,
    };
    // The JSONL round trip drops undefined keys, so the cadence item carries
    // no agentTask key at all; it must not read as an explicit clear.
    const replayed = (
      [
        { type: "session_state", payload: { agentTask: task } },
        { type: "session_state", payload: { memoryExtraction: cadence } },
      ] satisfies RolloutItem[]
    ).map((item) => JSON.parse(JSON.stringify(item)) as RolloutItem);

    expect(latestPersistedAgentTask(replayed)).toEqual({ value: task });

    const session = buildSession({
      services: {
        agentIdentityManager: {
          ensureRegistered: async () => {},
          registerTask: vi.fn(async () => null),
          taskMatchesCurrentIdentity: vi.fn(async () => true),
        } as SessionServices["agentIdentityManager"],
      },
    });
    await recordInitialHistoryOnResume(session, replayed, {
      currentModel: "test-model",
    });

    expect(await readStoredAgentTask(session)).toEqual(task);
    await expect(readMemoryExtractionState(session, "/memory")).resolves.toEqual(
      cadence,
    );
  });

  it("still reads an empty session_state payload as the legacy explicit clear of the agent task", () => {
    const task: SessionAgentTask = {
      agentRuntimeId: "agent-6",
      taskId: "task-6",
      registeredAt: "2026-04-21T00:00:06Z",
    };
    const replayed = (
      [
        { type: "session_state", payload: { agentTask: task } },
        { type: "session_state", payload: { agentTask: undefined } },
      ] satisfies RolloutItem[]
    ).map((item) => JSON.parse(JSON.stringify(item)) as RolloutItem);

    expect(latestPersistedAgentTask(replayed)).toEqual({ value: undefined });
  });

});
