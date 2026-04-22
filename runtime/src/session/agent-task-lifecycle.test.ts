import { describe, expect, it, vi } from "vitest";

import { AsyncQueue } from "../utils/async-queue.js";
import {
  ensureAgentTaskRegistered,
  lastTokenInfoFromRollout,
  latestPersistedAgentTask,
  maybePrewarmAgentTaskRegistration,
  recordInitialHistoryOnResume,
  restorePersistedAgentTask,
  type RegisteredAgentTask,
  type SessionAgentTask,
} from "./agent-task-lifecycle.js";
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
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
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
});
