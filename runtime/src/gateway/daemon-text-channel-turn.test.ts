import { describe, expect, it, vi } from "vitest";

import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { MemoryBackend } from "../memory/types.js";
import { createRuntimeContractSnapshot } from "../runtime-contract/types.js";
import type { Logger } from "../utils/logger.js";
import { executeTextChannelTurn } from "./daemon-text-channel-turn.js";
import {
  SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY,
  SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  type Session,
} from "./session.js";

function createLoggerStub(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
  };
}

function createMemoryBackendStub(): MemoryBackend {
  return {
    name: "stub",
    addEntry: vi.fn(async () => undefined),
    getThread: vi.fn(async () => []),
    query: vi.fn(async () => []),
    deleteThread: vi.fn(async () => 0),
    listSessions: vi.fn(async () => []),
    set: vi.fn(async () => undefined),
    get: vi.fn(async () => undefined),
    delete: vi.fn(async () => true),
    has: vi.fn(async () => false),
    listKeys: vi.fn(async () => []),
    getDurability: vi.fn(() => ({
      level: "sync",
      supportsFlush: true,
      description: "test",
    })),
    flush: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => true),
  };
}

function createSession(): Session {
  return {
    id: "session:test",
    workspaceId: "default",
    history: [],
    createdAt: 0,
    lastActiveAt: 0,
    metadata: {},
  };
}

function createSyntheticDialogueTurnExecutionContract() {
  return {
    version: 1 as const,
    turnClass: "dialogue" as const,
    ownerMode: "none" as const,
    sourceArtifacts: [],
    targetArtifacts: [],
    delegationPolicy: "forbid" as const,
    contractFingerprint: "synthetic-dialogue-contract",
    taskLineageId: "synthetic-dialogue-task",
  };
}

function createResult(
  overrides: Partial<ChatExecutorResult> = {},
): ChatExecutorResult {
  return {
    content: "ok",
    provider: "grok",
    usedFallback: false,
    toolCalls: [],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    callUsage: [],
    durationMs: 10,
    compacted: false,
    stopReason: "completed",
    completionState: "completed",
    runtimeContractSnapshot: createRuntimeContractSnapshot({
      runtimeContractV2: false,
      stopHooksEnabled: false,
      asyncTasksEnabled: false,
      persistentWorkersEnabled: false,
      mailboxEnabled: false,
      verifierRuntimeRequired: false,
      verifierProjectBootstrap: false,
      workerIsolationWorktree: false,
      workerIsolationRemote: false,
    }),
    turnExecutionContract: createSyntheticDialogueTurnExecutionContract(),
    ...overrides,
  };
}

describe("executeTextChannelTurn", () => {
  it("warns when stateful continuation falls back for an actionable reason", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      appendMessage: vi.fn(),
    } as any;
    const execute = vi.fn(async () =>
      createResult({
        statefulSummary: {
          enabled: true,
          attemptedCalls: 1,
          continuedCalls: 0,
          fallbackCalls: 1,
          fallbackReasons: {
            missing_previous_response_id: 0,
            store_disabled: 0,
            provider_retrieval_failure: 0,
            state_reconciliation_mismatch: 1,
            unsupported: 0,
          },
        },
      })
    );

    await executeTextChannelTurn({
      logger,
      channelName: "telegram",
      msg: {
        sessionId: "session:test",
        senderId: "user-1",
        channel: "telegram",
        content: "hello",
      },
      session,
      sessionMgr,
      systemPrompt: "system",
      chatExecutor: { execute } as any,
      toolHandler: vi.fn() as any,
      defaultMaxToolRounds: 3,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-1",
      memoryBackend,
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      "[stateful] telegram fallback_to_stateless",
      expect.objectContaining({
        sessionId: "session:test",
      }),
    );
  });

  it("runs the shared text-channel turn path and persists session continuity", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      appendMessage: vi.fn(),
    } as any;
    const result = createResult({
      content: "reply",
      callUsage: [
        {
          callIndex: 1,
          phase: "initial",
          provider: "grok",
          finishReason: "stop",
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          beforeBudget: {
            messageCount: 2,
            systemMessages: 1,
            userMessages: 1,
            assistantMessages: 0,
            toolMessages: 0,
            estimatedChars: 100,
            systemPromptChars: 50,
          },
          afterBudget: {
            messageCount: 2,
            systemMessages: 1,
            userMessages: 1,
            assistantMessages: 0,
            toolMessages: 0,
            estimatedChars: 100,
            systemPromptChars: 50,
          },
          statefulDiagnostics: {
            enabled: true,
            attempted: true,
            continued: true,
            store: true,
            fallbackToStateless: true,
            responseId: "resp-next",
            reconciliationHash: "hash-next",
            events: [],
          },
        },
      ],
    });
    const execute = vi.fn(async () => result);
    const recordToolRoutingOutcome = vi.fn();

    const returned = await executeTextChannelTurn({
      logger,
      channelName: "telegram",
      msg: {
        sessionId: "session:test",
        senderId: "user-1",
        channel: "telegram",
        content: "hello",
      },
      session,
      sessionMgr,
      systemPrompt: "system",
      chatExecutor: { execute } as any,
      toolHandler: vi.fn() as any,
      defaultMaxToolRounds: 3,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-1",
      memoryBackend,
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome,
    });

    expect(returned).not.toBe(result);
    expect(returned).toMatchObject(result);
    expect(returned.runtimeContractSnapshot).not.toHaveProperty(
      "legacyTopLevelVerifierMode",
    );
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        maxToolRounds: 3,
        promptEnvelope: expect.objectContaining({
          kind: "prompt_envelope_v1",
          baseSystemPrompt: expect.stringContaining("system"),
        }),
      }),
    );
    expect(recordToolRoutingOutcome).toHaveBeenCalledWith(
      "session:test",
      undefined,
    );
    expect(sessionMgr.appendMessage).toHaveBeenNthCalledWith(1, "session:test", {
      role: "user",
      content: "hello",
    });
    expect(sessionMgr.appendMessage).toHaveBeenNthCalledWith(2, "session:test", {
      role: "assistant",
      content: "reply",
    });
    expect(memoryBackend.addEntry).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sessionId: "session:test",
        role: "user",
        content: "hello",
        channel: "telegram",
        workspaceId: "default",
      }),
    );
    expect(memoryBackend.addEntry).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: "session:test",
        role: "assistant",
        content: "reply",
        channel: "telegram",
        workspaceId: "default",
      }),
    );
    expect(
      session.metadata[SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY],
    ).toEqual({
      previousResponseId: "resp-next",
      reconciliationHash: "hash-next",
    });
  });

  it("does not rerun top-level verification after the executor returns", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      appendMessage: vi.fn(),
    } as any;
    const result = createResult({
      content: "reply",
      runtimeContractSnapshot: createRuntimeContractSnapshot({
        runtimeContractV2: true,
        stopHooksEnabled: false,
        asyncTasksEnabled: false,
        persistentWorkersEnabled: false,
        mailboxEnabled: false,
        verifierRuntimeRequired: true,
        verifierProjectBootstrap: false,
        workerIsolationWorktree: false,
        workerIsolationRemote: false,
      }),
      turnExecutionContract: {
        version: 1,
        turnClass: "workflow_implementation",
        ownerMode: "workflow_owner",
        workspaceRoot: "/workspace",
        sourceArtifacts: ["/workspace/PLAN.md"],
        targetArtifacts: ["/workspace/src/main.c"],
        delegationPolicy: "direct_owner",
        contractFingerprint: "contract-1",
        taskLineageId: "task-1",
      },
    });
    const execute = vi.fn(async () => result);
    const spawn = vi.fn(async () => "subagent:verify");

    const returned = await executeTextChannelTurn({
      logger,
      channelName: "telegram",
      msg: {
        sessionId: "session:test",
        senderId: "user-1",
        channel: "telegram",
        content: "hello",
      },
      session,
      sessionMgr,
      systemPrompt: "system",
      chatExecutor: { execute } as any,
      toolHandler: vi.fn() as any,
      defaultMaxToolRounds: 3,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-1",
      memoryBackend,
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      subAgentManager: {
        spawn,
        waitForResult: vi.fn(async () => ({
          sessionId: "subagent:verify",
          output: "VERDICT: FAIL",
          success: false,
          durationMs: 1,
          toolCalls: [],
          completionState: "completed",
          stopReason: "completed",
        })),
      },
      verifierService: {
        resolveVerifierRequirement: vi.fn(() => ({
          required: true,
          profiles: ["generic"],
          probeCategories: ["build"],
          mutationPolicy: "read_only_workspace",
          allowTempArtifacts: false,
          bootstrapSource: "disabled",
          rationale: ["test"],
        })),
        shouldVerifySubAgentResult: vi.fn(() => true),
      },
    });

    expect(returned).toMatchObject(result);
    expect(returned.completionState).toBe("completed");
    expect(returned.content).toBe("reply");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes persisted active task context into the executor and stores the updated lineage", async () => {
    const logger = createLoggerStub();
    const session = createSession();
    session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY] = {
      version: 1,
      taskLineageId: "task-phase-0",
      contractFingerprint: "phase-0-contract",
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
    };
    const sessionMgr = {
      appendMessage: vi.fn(),
    } as any;
    const nextActiveTaskContext = {
      version: 1 as const,
      taskLineageId: "task-phase-0",
      contractFingerprint: "phase-1-contract",
      turnClass: "workflow_implementation" as const,
      ownerMode: "workflow_owner" as const,
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
    };
    const execute = vi.fn(async () =>
      createResult({
        activeTaskContext: nextActiveTaskContext,
      }),
    );

    await executeTextChannelTurn({
      logger,
      channelName: "telegram",
      msg: {
        sessionId: "session:test",
        senderId: "user-1",
        channel: "telegram",
        content: "implement phase 0",
      },
      session,
      sessionMgr,
      systemPrompt: "system",
      chatExecutor: { execute } as any,
      toolHandler: vi.fn() as any,
      defaultMaxToolRounds: 3,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-active-task",
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        promptEnvelope: expect.objectContaining({
          kind: "prompt_envelope_v1",
          baseSystemPrompt: expect.stringContaining("system"),
        }),
        runtimeContext: expect.objectContaining({
          activeTaskContext: expect.objectContaining({
            contractFingerprint: "phase-0-contract",
            taskLineageId: "task-phase-0",
          }),
        }),
      }),
    );
    expect(session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY]).toEqual(
      nextActiveTaskContext,
    );
  });

  it("passes a strict structured-output contract for Concordia agent generation turns", async () => {
    const logger = createLoggerStub();
    const session = createSession();
    const sessionMgr = { appendMessage: vi.fn() } as any;
    const execute = vi.fn(async () => createResult({ content: JSON.stringify([
      { id: "dockmaster-rhea", name: "Dockmaster Rhea", personality: "Decisive", goal: "Secure the pier." },
      { id: "broker-ives", name: "Broker Ives", personality: "Calculating", goal: "Win the contract." },
      { id: "runner-tamsin", name: "Runner Tamsin", personality: "Restless", goal: "Carry the message." },
      { id: "clerk-milo", name: "Clerk Milo", personality: "Methodical", goal: "Protect the ledger." },
    ]) }));

    await executeTextChannelTurn({
      logger,
      channelName: "concordia",
      msg: {
        sessionId: "concordia:generator:test",
        senderId: "concordia-agent-generator",
        channel: "concordia",
        content:
          "Generate exactly 4 diverse characters for this simulation scenario. Respond exactly with ONLY a JSON array.",
      },
      session,
      sessionMgr,
      systemPrompt: "system",
      chatExecutor: { execute } as any,
      toolHandler: vi.fn() as any,
      defaultMaxToolRounds: 3,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-generate",
      memoryBackend: createMemoryBackendStub(),
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      persistToDaemonMemory: false,
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        structuredOutput: expect.objectContaining({
          enabled: true,
          schema: expect.objectContaining({
            name: "concordia_generated_agents",
            strict: true,
            schema: expect.objectContaining({
              type: "array",
              minItems: 4,
              maxItems: 4,
            }),
          }),
        }),
        contextInjection: { memory: false },
        promptEnvelope: expect.objectContaining({
          kind: "prompt_envelope_v1",
          baseSystemPrompt: expect.stringContaining("system"),
        }),
      }),
    );
  });

  it("rethrows executor failures without mutating session history", async () => {
    const session = createSession();
    const sessionMgr = {
      appendMessage: vi.fn(),
    } as any;
    const memoryBackend = createMemoryBackendStub();

    await expect(
      executeTextChannelTurn({
        logger: createLoggerStub(),
        channelName: "telegram",
        msg: {
          sessionId: "session:test",
          senderId: "user-1",
          channel: "telegram",
          content: "hello",
        },
        session,
        sessionMgr,
        systemPrompt: "system",
        chatExecutor: {
          execute: vi.fn(async () => {
            throw new Error("provider failed");
          }),
        } as any,
        toolHandler: vi.fn() as any,
        defaultMaxToolRounds: 3,
        traceConfig: {
          enabled: false,
          includeHistory: true,
          includeSystemPrompt: true,
          includeToolArgs: true,
          includeToolResults: true,
          includeProviderPayloads: false,
          maxChars: 20_000,
        },
        turnTraceId: "trace-1",
        memoryBackend,
        buildToolRoutingDecision: () => undefined,
        recordToolRoutingOutcome: vi.fn(),
      }),
    ).rejects.toThrow("provider failed");

    expect(sessionMgr.appendMessage).not.toHaveBeenCalled();
    expect(memoryBackend.addEntry).not.toHaveBeenCalled();
  });

  it("persists a bounded runtime contract status snapshot on successful turns", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      appendMessage: vi.fn(),
    } as any;

    await executeTextChannelTurn({
      logger,
      channelName: "telegram",
      msg: {
        sessionId: "session:test",
        senderId: "user-1",
        channel: "telegram",
        content: "hello",
      },
      session,
      sessionMgr,
      systemPrompt: "system",
      chatExecutor: {
        execute: vi.fn(async () =>
          createResult({
            runtimeContractSnapshot: createRuntimeContractSnapshot({
              runtimeContractV2: true,
              stopHooksEnabled: true,
              asyncTasksEnabled: true,
              persistentWorkersEnabled: false,
              mailboxEnabled: false,
              verifierRuntimeRequired: false,
              verifierProjectBootstrap: false,
              workerIsolationWorktree: false,
              workerIsolationRemote: false,
            }),
            completionState: "partial",
            stopReasonDetail: "more work remains",
            completionProgress: {
              remainingMilestones: [
                { id: "phase-1", description: "finish phase 1" },
              ],
            } as any,
          })),
      } as any,
      toolHandler: vi.fn() as any,
      defaultMaxToolRounds: 3,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-status",
      memoryBackend,
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      taskStore: {
        describeRuntimeTaskLayer: vi.fn(async () => ({
          configured: true,
          effective: true,
          backend: "stub",
          durability: "sync",
          totalTasks: 0,
          activeCount: 0,
          publicHandleCount: 0,
        })),
        list: vi.fn(() => []),
        listTasks: vi.fn(async () => []),
      } as any,
    });

    expect(
      session.metadata[SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY],
    ).toMatchObject({
      version: 1,
      lastTurnTraceId: "trace-status",
      completionState: "partial",
      remainingMilestones: [
        expect.objectContaining({ id: "phase-1" }),
      ],
    });
  });
});
