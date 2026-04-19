import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { ChatExecutorResult } from "../llm/chat-executor.js";
import type { MemoryBackend } from "../memory/types.js";
import { getSessionReadSnapshot } from "../tools/system/filesystem.js";
import type { Logger } from "../utils/logger.js";
import { hydrateWebSessionRuntimeState } from "./daemon-session-state.js";
import { executeWebChatConversationTurn } from "./daemon-webchat-turn.js";
import {
  SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY,
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
  const kv = new Map<string, unknown>();
  return {
    name: "stub",
    addEntry: vi.fn(async () => undefined),
    getThread: vi.fn(async () => []),
    query: vi.fn(async () => []),
    deleteThread: vi.fn(async () => 0),
    listSessions: vi.fn(async () => []),
    set: vi.fn(async (key: string, value: unknown) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    }),
    get: vi.fn(async <T = unknown>(key: string) => {
      const value = kv.get(key);
      return value === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(value)) as T);
    }),
    delete: vi.fn(async (key: string) => kv.delete(key)),
    has: vi.fn(async (key: string) => kv.has(key)),
    listKeys: vi.fn(async (prefix?: string) =>
      [...kv.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    ),
    getDurability: vi.fn(() => ({
      level: "sync",
      supportsFlush: true,
      description: "test",
    })),
    flush: vi.fn(async () => undefined),
    clear: vi.fn(async () => {
      kv.clear();
    }),
    close: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => true),
  };
}

function createSession(metadata: Record<string, unknown> = {}): Session {
  return {
    id: "session:test",
    workspaceId: "default",
    history: [],
    createdAt: 0,
    lastActiveAt: 0,
    metadata,
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
    content: "reply",
    provider: "grok",
    model: "grok-4.1",
    usedFallback: false,
    toolCalls: [],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    callUsage: [],
    durationMs: 10,
    compacted: false,
    stopReason: "completed",
    completionState: "completed",
    turnExecutionContract: createSyntheticDialogueTurnExecutionContract(),
    ...overrides,
  };
}

describe("executeWebChatConversationTurn", () => {
  it("filters protocol prompt sections for generic routed webchat turns", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      getOrCreate: vi.fn(() => session),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };
    const execute = vi.fn(async () => createResult());

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:test",
        senderId: "operator-1",
        channel: "webchat",
        content: "build a local typescript workspace with packages/core, packages/cli, and packages/web",
      },
      webChat,
      chatExecutor: {
        execute,
      } as any,
      sessionMgr,
      getSystemPrompt: () => `# Agent Configuration

## Role
A privacy-preserving AI agent on the AgenC protocol.

# Identity

## Addresses
- Solana: test

# Tool Guidelines

## Available Tools
- Task operations (list, get, create, claim, complete)

You have broad access to this machine via the system.bash tool.`,
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 16_000,
      defaultMaxToolRounds: 3,
      contextWindowTokens: 64_000,
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
      buildToolRoutingDecision: () => ({
        routedToolNames: ["system.bash", "system.writeFile", "execute_with_agent"],
        expandedToolNames: ["system.bash", "system.writeFile", "execute_with_agent"],
        diagnostics: {
          cacheHit: false,
          clusterKey: "generic",
          confidence: 1,
          totalToolCount: 3,
          routedToolCount: 3,
          expandedToolCount: 3,
          schemaCharsFull: 100,
          schemaCharsRouted: 30,
          schemaCharsExpanded: 30,
          schemaCharsSaved: 70,
        },
      }),
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 0,
      onModelInfo: vi.fn(),
      onSubagentSynthesis: vi.fn(),
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        promptEnvelope: expect.objectContaining({
          kind: "prompt_envelope_v1",
          baseSystemPrompt: expect.stringContaining(
            "You have broad access to this machine via the system.bash tool.",
          ),
        }),
      }),
    );
  });

  it("does not warn for store-disabled stateful continuation summaries", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      getOrCreate: vi.fn(() => session),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };
    const execute = vi.fn(async () =>
      createResult({
        statefulSummary: {
          enabled: true,
          attemptedCalls: 0,
          continuedCalls: 0,
          fallbackCalls: 1,
          fallbackReasons: {
            missing_previous_response_id: 0,
            store_disabled: 1,
            provider_retrieval_failure: 0,
            state_reconciliation_mismatch: 0,
            unsupported: 0,
          },
        },
      })
    );

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:test",
        senderId: "operator-1",
        channel: "webchat",
        content: "hello",
      },
      turnTraceId: "trace-store-disabled",
      webChat,
      chatExecutor: { execute } as any,
      sessionMgr,
      getSystemPrompt: () => "system",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      memoryBackend,
      sessionTokenBudget: 4000,
      defaultMaxToolRounds: 3,
      contextWindowTokens: 128000,
      traceConfig: {
        enabled: false,
        includeHistory: false,
        includeSystemPrompt: false,
        includeToolArgs: false,
        includeToolResults: false,
        includeProviderPayloads: false,
        maxChars: 20000,
      },
      hooks,
      signals,
      getSessionTokenUsage: () => 0,
      onModelInfo: vi.fn(),
      onSubagentSynthesis: vi.fn(),
    });

    expect(logger.warn).not.toHaveBeenCalledWith(
      "[stateful] webchat fallback_to_stateless",
      expect.anything(),
    );
  });

  it("runs the shared webchat turn flow and persists stateful continuity", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      getOrCreate: vi.fn(() => session),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };
    const onModelInfo = vi.fn();
    const onSubagentSynthesis = vi.fn();
    const execute = vi.fn(async () => result);
    const result = createResult({
      compacted: true,
      toolCalls: [
        {
          name: "system.serverStatus",
          args: { handleId: "srv-1" },
          result: JSON.stringify({ status: "ready" }),
          isError: false,
          durationMs: 12,
        },
      ],
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

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:test",
        senderId: "operator-1",
        channel: "webchat",
        content: "hello",
      },
      webChat,
      chatExecutor: {
        execute,
      } as any,
      sessionMgr,
      getSystemPrompt: () => "system",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 16_000,
      defaultMaxToolRounds: 3,
      contextWindowTokens: 64_000,
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
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 42,
      onModelInfo,
      onSubagentSynthesis,
    });

    expect(signals.signalThinking).toHaveBeenCalledWith("session:test");
    expect(signals.signalIdle).toHaveBeenCalledWith("session:test");
    expect(webChat.clearAbortController).toHaveBeenCalledWith("session:test");
    expect(sessionMgr.compact).toHaveBeenCalledWith("session:test");
    expect(sessionMgr.appendMessage).toHaveBeenNthCalledWith(1, "session:test", {
      role: "user",
      content: "hello",
    });
    expect(sessionMgr.appendMessage).toHaveBeenNthCalledWith(2, "session:test", {
      role: "assistant",
      content: "reply",
    });
    expect(webChat.send).toHaveBeenCalledWith({
      sessionId: "session:test",
      content: "reply",
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ maxToolRounds: 3 }),
    );
    expect(webChat.pushToSession).toHaveBeenCalledWith(
      "session:test",
      expect.objectContaining({
        type: "chat.usage",
        payload: expect.objectContaining({ sessionId: "session:test" }),
      }),
    );
    expect(webChat.broadcastEvent).toHaveBeenCalledWith("chat.response", {
      sessionId: "session:test",
      completionState: "completed",
      stopReason: "completed",
      stopReasonDetail: undefined,
    });
    expect(hooks.dispatch).toHaveBeenCalledWith("message:outbound", {
      sessionId: "session:test",
      content: "reply",
      provider: "grok",
      userMessage: "hello",
      agentResponse: "reply",
    });
    expect(memoryBackend.addEntry).toHaveBeenNthCalledWith(1, {
      sessionId: "session:test",
      role: "user",
      content: "hello",
    });
    expect(memoryBackend.addEntry).toHaveBeenNthCalledWith(2, {
      sessionId: "session:test",
      role: "assistant",
      content: "reply",
    });
    expect(onModelInfo).toHaveBeenCalledWith(result);
    expect(onSubagentSynthesis).toHaveBeenCalledWith(result);
    expect(logger.info).toHaveBeenCalledWith("Chat used 1 tool call(s)", {
      traceId: "trace-1",
      tools: ["system.serverStatus"],
      provider: "grok",
      failedToolCalls: 0,
    });

  });

  it("persists delegated scope trust metadata for poisoned child cwd summaries", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      getOrCreate: vi.fn(() => session),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };
    const result = createResult({
      content: "Subagent cwd: /",
      toolCalls: [
        {
          name: "execute_with_agent",
          args: { task: "Run pwd in the child and report it." },
          result: JSON.stringify({
            success: true,
            output: "Subagent cwd: /",
          }),
          isError: false,
          durationMs: 11,
        },
      ],
    });
    const execute = vi.fn(async () => result);

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:test",
        senderId: "operator-1",
        channel: "webchat",
        content: "what did the child cwd say?",
      },
      webChat,
      chatExecutor: { execute } as any,
      sessionMgr,
      getSystemPrompt: () => "sys",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 16_000,
      defaultMaxToolRounds: 3,
      contextWindowTokens: 64_000,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-2",
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 42,
    });

    expect(hooks.dispatch).toHaveBeenCalledWith("message:outbound", {
      sessionId: "session:test",
      content: "Subagent cwd: /",
      provider: "grok",
      userMessage: "what did the child cwd say?",
      agentResponse: "Subagent cwd: /",
      agentResponseMetadata: {
        delegatedScopeTrust: "informational_untrusted",
        delegatedScopeTrustReason: "assistant_delegated_environment_summary",
        delegatedScopeContainsEnvironmentFact: true,
        memoryRole: "working",
      },
    });
    expect(memoryBackend.addEntry).toHaveBeenNthCalledWith(2, {
      sessionId: "session:test",
      role: "assistant",
      content: "Subagent cwd: /",
      metadata: {
        delegatedScopeTrust: "informational_untrusted",
        delegatedScopeTrustReason: "assistant_delegated_environment_summary",
        delegatedScopeContainsEnvironmentFact: true,
        memoryRole: "working",
      },
    });
  });

  it("surfaces failures to webchat and skips outbound persistence side effects", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const sessionMgr = {
      getOrCreate: vi.fn(() => createSession()),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:test",
        senderId: "operator-1",
        channel: "webchat",
        content: "hello",
      },
      webChat,
      chatExecutor: {
        execute: vi.fn(async () => {
          throw Object.assign(new Error("provider failed"), {
            stopReason: "timeout",
            stopReasonDetail: "tool follow-up timed out",
          });
        }),
      } as any,
      sessionMgr,
      getSystemPrompt: () => "system",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 16_000,
      defaultMaxToolRounds: 3,
      contextWindowTokens: 64_000,
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
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 0,
      onModelInfo: vi.fn(),
      onSubagentSynthesis: vi.fn(),
    });

    expect(webChat.clearAbortController).toHaveBeenCalledWith("session:test");
    expect(signals.signalIdle).toHaveBeenCalledWith("session:test");
    expect(webChat.send).toHaveBeenCalledWith({
      sessionId: "session:test",
      content: "Error (timeout): tool follow-up timed out",
    });
    expect(sessionMgr.appendMessage).not.toHaveBeenCalled();
    expect(hooks.dispatch).not.toHaveBeenCalled();
    expect(memoryBackend.addEntry).not.toHaveBeenCalled();
  });

  it("surfaces returned non-success results to webchat and skips outbound persistence side effects", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const sessionMgr = {
      getOrCreate: vi.fn(() => createSession()),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:test",
        senderId: "operator-1",
        channel: "webchat",
        content: "hello",
      },
      webChat,
      chatExecutor: {
        execute: vi.fn(async () =>
          createResult({
            content: "Operation completed. Result:\n```json\n{\"entries\":[\"src\"]}\n```",
            stopReason: "timeout",
            stopReasonDetail: "tool follow-up timed out",
            completionState: "blocked",
          })
        ),
      } as any,
      sessionMgr,
      getSystemPrompt: () => "system",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 16_000,
      defaultMaxToolRounds: 3,
      contextWindowTokens: 64_000,
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
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 0,
      onModelInfo: vi.fn(),
      onSubagentSynthesis: vi.fn(),
    });

    expect(webChat.clearAbortController).toHaveBeenCalledWith("session:test");
    expect(signals.signalIdle).toHaveBeenCalledWith("session:test");
    expect(webChat.send).toHaveBeenCalledWith({
      sessionId: "session:test",
      content: "Error (timeout): tool follow-up timed out",
    });
    expect(sessionMgr.appendMessage).not.toHaveBeenCalled();
    expect(hooks.dispatch).not.toHaveBeenCalled();
    expect(memoryBackend.addEntry).not.toHaveBeenCalled();
  });

  it("passes the session workspace root into planner/runtime execution instead of a conflicting message root", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      getOrCreate: vi.fn(() => session),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
      loadSessionWorkspaceRoot: vi
        .fn(async () => "/home/tetsuo/git/stream-test/agenc-shell"),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };
    const execute = vi.fn(async () => createResult());

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:test",
        senderId: "operator-1",
        channel: "webchat",
        content: "Read PLAN.md and execute the implementation plan.",
        metadata: { workspaceRoot: "/home/tetsuo/git/AgenC" },
      },
      webChat,
      chatExecutor: {
        execute,
      } as any,
      sessionMgr,
      getSystemPrompt: () => "system",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 16_000,
      defaultMaxToolRounds: 3,
      contextWindowTokens: 64_000,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-2",
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 0,
    });

    expect(webChat.loadSessionWorkspaceRoot).toHaveBeenCalledWith("session:test");
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: {
          workspaceRoot: "/home/tetsuo/git/stream-test/agenc-shell",
          // workflowStage is plumbed through so the chat-executor stop-gate
          // knows whether the session is in plan mode and so the live
          // session stage is available where needed.
          workflowStage: "idle",
        },
        message: expect.objectContaining({
          metadata: expect.objectContaining({
            workspaceRoot: "/home/tetsuo/git/stream-test/agenc-shell",
          }),
        }),
      }),
    );
  });
  it("passes persisted active task context into the executor and stores the updated lineage", async () => {
    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession({
      [SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY]: {
        version: 1,
        taskLineageId: "task-phase-0",
        contractFingerprint: "phase-0-contract",
        turnClass: "workflow_implementation",
        ownerMode: "workflow_owner",
        workspaceRoot: "/workspace",
        sourceArtifacts: ["/workspace/PLAN.md"],
        targetArtifacts: ["/workspace/src/main.c"],
        displayArtifact: "PLAN.md",
      },
    });
    const sessionMgr = {
      getOrCreate: vi.fn(() => session),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };
    const nextActiveTaskContext = {
      version: 1 as const,
      taskLineageId: "task-phase-0",
      contractFingerprint: "phase-1-contract",
      turnClass: "workflow_implementation" as const,
      ownerMode: "workflow_owner" as const,
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
      displayArtifact: "PLAN.md",
    };
    const execute = vi.fn(async () => createResult({ activeTaskContext: nextActiveTaskContext }));

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:test",
        senderId: "operator-1",
        channel: "webchat",
        content: "Implement phase 0",
      },
      webChat,
      chatExecutor: { execute } as any,
      sessionMgr,
      getSystemPrompt: () => "system",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 4000,
      defaultMaxToolRounds: 3,
      contextWindowTokens: 128000,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20000,
      },
      turnTraceId: "trace-active-task",
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 0,
      onModelInfo: vi.fn(),
      onSubagentSynthesis: vi.fn(),
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
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

  it("expands @-mentioned files into source-artifact context before execution", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-webchat-at-"));
    const planPath = join(workspaceRoot, "PLAN.md");
    writeFileSync(planPath, "# Plan\nBuild the shell in C.\n", "utf8");

    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      getOrCreate: vi.fn(() => session),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
      loadSessionWorkspaceRoot: vi.fn(async () => workspaceRoot),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };
    const execute = vi.fn(async () => createResult());

    await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:at-mention-webchat",
        senderId: "operator-1",
        channel: "webchat",
        content: "Read @PLAN.md and implement it in full.",
      },
      webChat,
      chatExecutor: { execute } as any,
      sessionMgr,
      getSystemPrompt: () => "system",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 16_000,
      defaultMaxToolRounds: 3,
      contextWindowTokens: 64_000,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-at-mention-webchat",
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 0,
      onModelInfo: vi.fn(),
      onSubagentSynthesis: vi.fn(),
    });

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        history: expect.arrayContaining([
          expect.objectContaining({
            role: "assistant",
            toolCalls: [
              expect.objectContaining({
                name: "system.readFile",
              }),
            ],
          }),
          expect.objectContaining({
            role: "tool",
            toolName: "system.readFile",
          }),
        ]),
        requiredToolEvidence: expect.objectContaining({
          executionEnvelope: expect.objectContaining({
            requiredSourceArtifacts: [planPath],
          }),
        }),
      }),
    );
    expect(
      getSessionReadSnapshot("session:at-mention-webchat", planPath),
    ).toEqual(
      expect.objectContaining({
        content: "# Plan\nBuild the shell in C.\n",
        viewKind: "full",
      }),
    );
  });

  it("promotes explicit full-plan implementation requests into durable workflow execution", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-webchat-bg-"));
    const planPath = join(workspaceRoot, "PLAN.md");
    writeFileSync(
      planPath,
      ["# PLAN", "## M0 Bootstrap", "## M1 Lexer", "## M2 Parser"].join("\n"),
      "utf8",
    );

    const logger = createLoggerStub();
    const memoryBackend = createMemoryBackendStub();
    const session = createSession();
    const sessionMgr = {
      getOrCreate: vi.fn(() => session),
      appendMessage: vi.fn(),
      compact: vi.fn(async () => undefined),
    } as any;
    const webChat = {
      createAbortController: vi.fn(() => new AbortController()),
      clearAbortController: vi.fn(),
      send: vi.fn(async () => undefined),
      pushToSession: vi.fn(),
      broadcastEvent: vi.fn(),
      loadSessionWorkspaceRoot: vi.fn(async () => workspaceRoot),
    } as any;
    const hooks = {
      dispatch: vi.fn(async () => ({ completed: true, payload: {} })),
    } as any;
    const signals = {
      signalThinking: vi.fn(),
      signalIdle: vi.fn(),
    };
    const execute = vi.fn(async () => createResult());
    const maybeStartBackgroundRun = vi.fn(async (params) => {
      expect(params.runtimeWorkspaceRoot).toBe(workspaceRoot);
      expect(params.effectiveHistory).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "tool",
            toolName: "system.readFile",
          }),
        ]),
      );
      return true;
    });

    const result = await executeWebChatConversationTurn({
      logger,
      msg: {
        sessionId: "session:durable-webchat",
        senderId: "operator-1",
        channel: "webchat",
        content: "Read @PLAN.md and implement all phases in full without stopping.",
      },
      webChat,
      chatExecutor: { execute } as any,
      sessionMgr,
      getSystemPrompt: () => "system",
      sessionToolHandler: vi.fn() as any,
      sessionStreamCallback: vi.fn(),
      signals,
      hooks,
      memoryBackend,
      sessionTokenBudget: 16_000,
      defaultMaxToolRounds: 3,
      contextWindowTokens: 64_000,
      traceConfig: {
        enabled: false,
        includeHistory: true,
        includeSystemPrompt: true,
        includeToolArgs: true,
        includeToolResults: true,
        includeProviderPayloads: false,
        maxChars: 20_000,
      },
      turnTraceId: "trace-durable-webchat",
      buildToolRoutingDecision: () => undefined,
      recordToolRoutingOutcome: vi.fn(),
      getSessionTokenUsage: () => 0,
      onModelInfo: vi.fn(),
      onSubagentSynthesis: vi.fn(),
      maybeStartBackgroundRun,
    });

    expect(result).toBeUndefined();
    expect(maybeStartBackgroundRun).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(webChat.clearAbortController).toHaveBeenCalledWith(
      "session:durable-webchat",
    );
  });

});
