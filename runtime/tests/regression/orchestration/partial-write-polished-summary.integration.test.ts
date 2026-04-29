import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChatExecutor } from "../../../src/llm/chat-executor.js";
import type { LLMProvider, LLMResponse } from "../../../src/llm/types.js";
import type { MemoryBackend } from "../../../src/memory/types.js";
import type { Logger } from "../../../src/utils/logger.js";
import { executeTextChannelTurn } from "../../../src/gateway/daemon-text-channel-turn.js";
import {
  SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY,
  type Session,
} from "../../../src/gateway/session.js";

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

function createSequentialProvider(
  responses: readonly LLMResponse[],
): LLMProvider {
  const queue = [...responses];
  const next = async (): Promise<LLMResponse> => {
    const response = queue.shift();
    if (!response) {
      throw new Error("No queued provider response remained");
    }
    return response;
  };
  return {
    name: "phase12-regression-provider",
    chat: async () => next(),
    chatStream: async () => next(),
    healthCheck: async () => true,
  };
}

function createSession(): Session {
  return {
    id: "session:phase12-regression",
    workspaceId: "default",
    history: [],
    createdAt: 0,
    lastActiveAt: 0,
    metadata: {},
  };
}

describe("partial write polished summary regression", () => {
  it("does not let the text-channel daemon path complete after only one of two required writes", async () => {
    const workspaceRoot = await pathToTempDir();
    try {
      const provider = createSequentialProvider([
        {
          content: "",
          finishReason: "tool_calls",
          toolCalls: [
            {
              id: "tc-1",
              name: "system.writeFile",
              arguments: JSON.stringify({
                path: "src/lexer.c",
                content: "int lex(void) { return 1; }\n",
              }),
            },
          ],
          usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52 },
          model: "phase12-model",
        },
        {
          content:
            "All requested phases are fully implemented and integrated across the workspace.",
          finishReason: "stop",
          toolCalls: [],
          usage: { promptTokens: 38, completionTokens: 18, totalTokens: 56 },
          model: "phase12-model",
        },
        {
          content:
            "The implementation is already complete and no further file writes are necessary.",
          finishReason: "stop",
          toolCalls: [],
          usage: { promptTokens: 28, completionTokens: 14, totalTokens: 42 },
          model: "phase12-model",
        },
      ]);
      const toolHandler = async (name: string, args: Record<string, unknown>) => {
        if (name === "system.writeFile") {
          const relativePath =
            typeof args.path === "string" ? args.path : "missing-path";
          const content = typeof args.content === "string" ? args.content : "";
          const absolutePath = path.join(workspaceRoot, relativePath);
          await mkdir(path.dirname(absolutePath), { recursive: true });
          await writeFile(absolutePath, content, "utf8");
        }
        return JSON.stringify({ ok: true, path: args.path });
      };
      const chatExecutor = new ChatExecutor({
        providers: [provider],
        toolHandler,
        runtimeContractFlags: {
          runtimeContractV2: true,
          stopHooksEnabled: true,
          asyncTasksEnabled: false,
          persistentWorkersEnabled: false,
          mailboxEnabled: false,
          verifierRuntimeRequired: false,
          verifierProjectBootstrap: false,
          workerIsolationWorktree: false,
          workerIsolationRemote: false,
        },
      });

      const session = createSession();
      session.metadata[SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY] = {
        version: 1,
        taskLineageId: "task-phase12",
        contractFingerprint: "contract-phase12",
        turnClass: "workflow_implementation",
        ownerMode: "workflow_owner",
        workspaceRoot,
        sourceArtifacts: [path.join(workspaceRoot, "PLAN.md")],
        targetArtifacts: [
          path.join(workspaceRoot, "src/lexer.c"),
          path.join(workspaceRoot, "src/parser.c"),
        ],
      };

      const result = await executeTextChannelTurn({
        logger: createLoggerStub(),
        channelName: "telegram",
        msg: {
          sessionId: "session:phase12-regression",
          senderId: "user-1",
          channel: "telegram",
          content: "Implement both required source files without stopping early.",
        } as any,
        session,
        sessionMgr: {
          appendMessage: vi.fn(),
        } as any,
        systemPrompt: "You are a grounded implementation agent.",
        chatExecutor,
        toolHandler,
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
        turnTraceId: "trace:phase12-regression",
        memoryBackend: createMemoryBackendStub(),
        buildToolRoutingDecision: () => undefined,
        recordToolRoutingOutcome: vi.fn(),
      });

      expect(result.stopReason).toBe("validation_error");
      expect(result.completionState).toBe("partial");
      expect(result.content).toContain(path.join(workspaceRoot, "src/parser.c"));
      expect(result.toolCalls.filter((call) => call.name === "system.writeFile")).toHaveLength(1);
      expect(result.runtimeContractSnapshot).not.toHaveProperty(
        "legacyTopLevelVerifierMode",
      );
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });
});

async function pathToTempDir(): Promise<string> {
  const tempDir = path.join(
    tmpdir(),
    `agenc-phase12-regression-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  await mkdir(tempDir, { recursive: true });
  return tempDir;
}
