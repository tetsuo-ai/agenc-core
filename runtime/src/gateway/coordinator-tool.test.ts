import { describe, expect, it, vi } from "vitest";
import { ChatExecutor } from "../llm/chat-executor.js";
import type {
  IsolatedSessionContext,
  SubAgentSessionIdentity,
} from "./session-isolation.js";
import type {
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../llm/types.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { ToolRegistry } from "../tools/registry.js";
import { SubAgentManager, type SubAgentManagerConfig } from "./sub-agent.js";
import {
  COORDINATOR_MODE_TOOL_NAME,
  createCoordinatorModeTool,
  parseCoordinatorModeInput,
} from "./coordinator-tool.js";
import { executeCoordinatorModeTool } from "./tool-handler-factory-coordinator.js";

function makeMockLLMProvider(
  outputs: readonly string[] = ["sub-agent output"],
  name = "mock-llm",
): LLMProvider {
  const queue = [...outputs];
  const nextResponse = async (
    _messages: LLMMessage[],
  ): Promise<LLMResponse> => ({
    content: queue.shift() ?? "sub-agent output",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "mock",
    finishReason: "stop",
  });

  return {
    name,
    chat: vi.fn(nextResponse),
    chatStream: vi.fn(
      async (
        messages: LLMMessage[],
        _cb: StreamProgressCallback,
      ): Promise<LLMResponse> => nextResponse(messages),
    ),
    healthCheck: vi.fn(async () => true),
  };
}

function makeMockTool(name: string): Tool {
  return {
    name,
    description: `Mock tool ${name}`,
    inputSchema: { type: "object", properties: {} },
    execute: vi.fn(
      async (): Promise<ToolResult> => ({ content: "ok", isError: false }),
    ),
  };
}

function makeMockContext(workspaceId = "default"): IsolatedSessionContext {
  const toolRegistry = new ToolRegistry({});
  toolRegistry.register(makeMockTool("system.readFile"));
  toolRegistry.register(makeMockTool("system.writeFile"));

  return {
    workspaceId,
    memoryBackend: {
      addEntry: vi.fn(),
      getEntries: vi.fn(async () => []),
      getSessionCount: vi.fn(async () => 0),
      deleteSession: vi.fn(),
      set: vi.fn(),
      get: vi.fn(async () => undefined),
      delete: vi.fn(),
      close: vi.fn(),
    } as any,
    policyEngine: {} as any,
    toolRegistry,
    llmProvider: makeMockLLMProvider(),
    skills: [],
    authState: { authenticated: false, permissions: new Set() },
  };
}

function makeManagerConfig(
  overrides?: Partial<SubAgentManagerConfig>,
): SubAgentManagerConfig {
  return {
    createContext: vi.fn(async () => makeMockContext()),
    destroyContext: vi.fn(async () => {}),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

async function waitForWorkerResult(
  manager: SubAgentManager,
  sessionId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await settle();
    if (manager.getResult(sessionId)) {
      return;
    }
  }
  throw new Error(`Timed out waiting for worker ${sessionId} to finish`);
}

describe("coordinator_mode", () => {
  it("parses list/stop/delegation actions", () => {
    expect(parseCoordinatorModeInput({ action: "list" })).toEqual({
      ok: true,
      value: { action: "list" },
    });

    expect(
      parseCoordinatorModeInput({
        action: "stop",
        workerSessionId: "subagent:123",
      }),
    ).toEqual({
      ok: true,
      value: {
        action: "stop",
        workerSessionId: "subagent:123",
      },
    });

    const parsed = parseCoordinatorModeInput({
      action: "follow-up",
      workerSessionId: "subagent:123",
      task: "Continue with the next fix",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      expect.unreachable("expected follow-up action to parse");
    }
    expect(parsed.value.action).toBe("follow_up");
    expect(parsed.value.workerSessionId).toBe("subagent:123");
    expect(parsed.value.request?.task).toBe("Continue with the next fix");
  });

  it("rejects invalid coordinator inputs", () => {
    expect(parseCoordinatorModeInput({})).toEqual({
      ok: false,
      error:
        'coordinator_mode requires an "action" of "list", "spawn", "reuse", "follow_up", or "stop"',
    });

    expect(
      parseCoordinatorModeInput({
        action: "stop",
      }),
    ).toEqual({
      ok: false,
      error:
        'coordinator_mode action "stop" requires a non-empty "workerSessionId"',
    });

    expect(
      parseCoordinatorModeInput({
        action: "spawn",
        workerSessionId: "subagent:123",
        task: "Do the work",
      }),
    ).toEqual({
      ok: false,
      error:
        'coordinator_mode action "spawn" does not accept "workerSessionId"; use "reuse" or "follow_up" instead',
    });
  });

  it("returns a direct execution error when invoked outside a session handler", async () => {
    const tool = createCoordinatorModeTool();
    expect(tool.name).toBe(COORDINATOR_MODE_TOOL_NAME);

    const result = await tool.execute?.({
      action: "list",
    });
    expect(result).toEqual({
      content: '{"error":"coordinator_mode must run through a session-scoped tool handler"}',
      isError: true,
    });
  });

  it("lists only workers for the current parent session and reports the latest successful worker", async () => {
    const manager = new SubAgentManager(makeManagerConfig());

    const reusableWorker = await manager.spawn({
      parentSessionId: "session-a",
      task: "Inspect logs",
    });
    await settle();

    await manager.spawn({
      parentSessionId: "session-b",
      task: "Other session work",
    });
    await settle();

    const result = await executeCoordinatorModeTool({
      toolArgs: { action: "list" },
      name: COORDINATOR_MODE_TOOL_NAME,
      sessionId: "session-a",
      toolCallId: "tool-call-1",
      subAgentManager: manager,
      lifecycleEmitter: null,
      verifier: null as any,
      availableToolNames: ["system.readFile"],
    });

    const parsed = JSON.parse(result) as {
      success?: boolean;
      workers?: Array<{ workerSessionId?: string }>;
      activeWorkerSessionIds?: string[];
      latestSuccessfulWorkerSessionId?: string;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.workers).toEqual([
      expect.objectContaining({
        workerSessionId: reusableWorker,
      }),
    ]);
    expect(parsed.activeWorkerSessionIds).toEqual([]);
    expect(parsed.latestSuccessfulWorkerSessionId).toBe(reusableWorker);
  });

  it("reuses the latest successful worker when no workerSessionId is provided", async () => {
    const executeSpy = vi
      .spyOn(ChatExecutor.prototype, "execute")
      .mockResolvedValue({
        content: "continued output",
        toolCalls: [],
        providerEvidence: undefined,
        tokenUsage: undefined,
        stopReason: "completed",
        stopReasonDetail: undefined,
        callUsage: [],
        finalPromptShape: undefined,
        statefulSummary: undefined,
        toolRoutingSummary: undefined,
        plannerSummary: undefined,
        model: "mock",
        completionState: "completed",
      } as any);

    const createContext = vi.fn(
      async (_identity: SubAgentSessionIdentity) => makeMockContext(),
    );
    const manager = new SubAgentManager(
      makeManagerConfig({
        createContext,
      }),
    );

    try {
      const initialWorker = await manager.spawn({
        parentSessionId: "session-a",
        task: "Initial worker pass",
      });
      await waitForWorkerResult(manager, initialWorker);

      const result = await executeCoordinatorModeTool({
        toolArgs: {
          action: "reuse",
          task: "Continue the worker with the next step",
          tools: ["system.readFile"],
        },
        name: COORDINATOR_MODE_TOOL_NAME,
        sessionId: "session-a",
        toolCallId: "tool-call-2",
        subAgentManager: manager,
        lifecycleEmitter: null,
        verifier: null as any,
        availableToolNames: ["system.readFile"],
        defaultWorkingDirectory: "/tmp/agenc-coordinator",
        parentAllowedReadRoots: ["/tmp/agenc-coordinator"],
        parentAllowedWriteRoots: ["/tmp/agenc-coordinator"],
      });

      const parsed = JSON.parse(result) as {
        success?: boolean;
        subagentSessionId?: string;
        status?: string;
      };

      expect(parsed.success).toBe(true);
      expect(parsed.subagentSessionId).toBe(initialWorker);
      expect(parsed.status).toBe("completed");
    } finally {
      executeSpy.mockRestore();
    }
  });
});
