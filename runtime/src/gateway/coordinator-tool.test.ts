import { describe, expect, it, vi } from "vitest";
import { ChatExecutor } from "../llm/chat-executor.js";
import type { MemoryBackend } from "../memory/types.js";
import { TaskStore } from "../tools/system/task-tracker.js";
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
import { PersistentWorkerMailbox } from "./persistent-worker-mailbox.js";
import { PersistentWorkerManager } from "./persistent-worker-manager.js";

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

function createMemoryBackendStub(): MemoryBackend {
  const kv = new Map<string, unknown>();
  return {
    name: "stub",
    addEntry: async () => {
      throw new Error("not implemented");
    },
    getThread: async () => [],
    query: async () => [],
    deleteThread: async () => 0,
    listSessions: async () => [],
    set: async (key: string, value: unknown) => {
      kv.set(key, JSON.parse(JSON.stringify(value)));
    },
    get: async <T = unknown>(key: string) => {
      const value = kv.get(key);
      return value === undefined
        ? undefined
        : (JSON.parse(JSON.stringify(value)) as T);
    },
    delete: async (key: string) => kv.delete(key),
    has: async (key: string) => kv.has(key),
    listKeys: async (prefix?: string) =>
      [...kv.keys()].filter((key) => !prefix || key.startsWith(prefix)),
    getDurability: () => ({
      level: "sync",
      supportsFlush: true,
      description: "test",
    }),
    flush: async () => {},
    clear: async () => {
      kv.clear();
    },
    close: async () => {},
    healthCheck: async () => true,
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

async function waitForTaskTerminal(
  store: TaskStore,
  listId: string,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const task = await store.getTask(listId, taskId);
    if (
      task?.status === "completed" ||
      task?.status === "failed" ||
      task?.status === "cancelled"
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for task ${taskId} to finish`);
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
        workerId: "subagent:123",
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
    expect(parsed.value.workerId).toBe("subagent:123");
    expect(parsed.value.request?.task).toBe("Continue with the next fix");

    expect(
      parseCoordinatorModeInput({
        action: "spawn",
        workerName: "builder",
      }),
    ).toEqual({
      ok: true,
      value: {
        action: "spawn",
        workerName: "builder",
      },
    });

    expect(
      parseCoordinatorModeInput({
        action: "messages",
        workerId: "worker-1",
        direction: "worker_to_parent",
        status: "pending",
        limit: 5,
      }),
    ).toEqual({
      ok: true,
      value: {
        action: "messages",
        workerId: "worker-1",
        direction: "worker_to_parent",
        status: "pending",
        limit: 5,
      },
    });

    expect(
      parseCoordinatorModeInput({
        action: "ack",
        messageId: "mail-1",
      }),
    ).toEqual({
      ok: true,
      value: {
        action: "ack",
        messageId: "mail-1",
      },
    });

    expect(
      parseCoordinatorModeInput({
        action: "respond_permission",
        messageId: "mail-2",
        disposition: "yes",
      }),
    ).toEqual({
      ok: true,
      value: {
        action: "respond_permission",
        messageId: "mail-2",
        disposition: "yes",
      },
    });

    expect(
      parseCoordinatorModeInput({
        action: "message",
        workerId: "worker-1",
        subject: "Mode",
        body: "Switch to parser follow-up",
      }),
    ).toEqual({
      ok: true,
      value: {
        action: "message",
        workerId: "worker-1",
        subject: "Mode",
        body: "Switch to parser follow-up",
      },
    });
  });

  it("rejects invalid coordinator inputs", () => {
    expect(parseCoordinatorModeInput({})).toEqual({
      ok: false,
      error:
        'coordinator_mode requires an "action" of "list", "spawn", "reuse", "follow_up", "stop", "messages", "ack", "respond_permission", or "message"',
    });

    expect(
      parseCoordinatorModeInput({
        action: "stop",
      }),
    ).toEqual({
      ok: false,
      error:
        'coordinator_mode action "stop" requires a non-empty "workerId"',
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
        'coordinator_mode action "spawn" does not accept "workerId"; use "reuse" or "follow_up" instead',
    });

    expect(
      parseCoordinatorModeInput({
        action: "respond_permission",
        messageId: "mail-2",
      }),
    ).toEqual({
      ok: false,
      error:
        'coordinator_mode action "respond_permission" requires a "disposition" of "yes", "no", or "always"',
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
    await waitForWorkerResult(manager, reusableWorker);

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
        tools: ["system.readFile"],
        workingDirectory: "/tmp/agenc-coordinator",
        workingDirectorySource: "execution_envelope",
        delegationSpec: {
          task: "Initial worker pass",
          tools: ["system.readFile"],
          executionContext: {
            workspaceRoot: "/tmp/agenc-coordinator",
            allowedReadRoots: ["/tmp/agenc-coordinator"],
            allowedWriteRoots: ["/tmp/agenc-coordinator"],
          },
        },
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

  it("lists persistent workers and reports the latest reusable worker id", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const manager = new SubAgentManager(makeManagerConfig());
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager: manager,
    });

    const spawned = JSON.parse(
      await executeCoordinatorModeTool({
        toolArgs: {
          action: "spawn",
          workerName: "builder",
          task: "Inspect the parser module",
          tools: ["system.readFile"],
        },
        name: COORDINATOR_MODE_TOOL_NAME,
        sessionId: "session-a",
        toolCallId: "tool-call-persistent-spawn",
        subAgentManager: manager,
        workerManager,
        taskStore,
        lifecycleEmitter: null,
        verifier: null as any,
        runtimeContractFlags: {
          persistentWorkersEnabled: true,
        } as any,
        availableToolNames: ["system.readFile"],
        defaultWorkingDirectory: "/tmp/agenc-coordinator",
        parentAllowedReadRoots: ["/tmp/agenc-coordinator"],
        parentAllowedWriteRoots: ["/tmp/agenc-coordinator"],
      }),
    ) as {
      success?: boolean;
      workerId?: string;
      taskId?: string;
      outputPath?: string;
      backgroundHandle?: { id?: string };
    };

    expect(spawned.success).toBe(true);
    expect(spawned.workerId).toBeTruthy();
    expect(spawned.taskId).toBeTruthy();
    expect(spawned.outputPath).toMatch(/output\.json$/);
    expect(spawned.backgroundHandle?.id).toBe(spawned.taskId);

    await waitForTaskTerminal(taskStore, "session-a", String(spawned.taskId));

    const listed = JSON.parse(
      await executeCoordinatorModeTool({
        toolArgs: { action: "list" },
        name: COORDINATOR_MODE_TOOL_NAME,
        sessionId: "session-a",
        toolCallId: "tool-call-persistent-list",
        subAgentManager: manager,
        workerManager,
        taskStore,
        lifecycleEmitter: null,
        verifier: null as any,
        runtimeContractFlags: {
          persistentWorkersEnabled: true,
        } as any,
        availableToolNames: ["system.readFile"],
      }),
    ) as {
      success?: boolean;
      workers?: Array<{
        workerId?: string;
        workerName?: string;
        state?: string;
        continuationSessionId?: string;
      }>;
      latestReusableWorkerId?: string;
    };

    expect(listed.success).toBe(true);
    expect(listed.workers).toEqual([
      expect.objectContaining({
        workerId: spawned.workerId,
        workerName: "builder",
        state: "idle",
        continuationSessionId: expect.stringMatching(/^subagent:/),
      }),
    ]);
    expect(listed.latestReusableWorkerId).toBe(spawned.workerId);
  });

  it("queues follow-up work onto the latest compatible persistent worker", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const manager = new SubAgentManager(makeManagerConfig());
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager: manager,
    });

    const initial = JSON.parse(
      await executeCoordinatorModeTool({
        toolArgs: {
          action: "spawn",
          workerName: "builder",
          task: "Inspect the parser module",
          tools: ["system.readFile"],
        },
        name: COORDINATOR_MODE_TOOL_NAME,
        sessionId: "session-a",
        toolCallId: "tool-call-persistent-seed",
        subAgentManager: manager,
        workerManager,
        taskStore,
        lifecycleEmitter: null,
        verifier: null as any,
        runtimeContractFlags: {
          persistentWorkersEnabled: true,
        } as any,
        availableToolNames: ["system.readFile"],
        defaultWorkingDirectory: "/tmp/agenc-coordinator",
        parentAllowedReadRoots: ["/tmp/agenc-coordinator"],
        parentAllowedWriteRoots: ["/tmp/agenc-coordinator"],
      }),
    ) as {
      workerId?: string;
      taskId?: string;
    };

    await waitForTaskTerminal(taskStore, "session-a", String(initial.taskId));

    const followUp = JSON.parse(
      await executeCoordinatorModeTool({
        toolArgs: {
          action: "reuse",
          task: "Inspect the lexer module",
          tools: ["system.readFile"],
        },
        name: COORDINATOR_MODE_TOOL_NAME,
        sessionId: "session-a",
        toolCallId: "tool-call-persistent-reuse",
        subAgentManager: manager,
        workerManager,
        taskStore,
        lifecycleEmitter: null,
        verifier: null as any,
        runtimeContractFlags: {
          persistentWorkersEnabled: true,
        } as any,
        availableToolNames: ["system.readFile"],
        defaultWorkingDirectory: "/tmp/agenc-coordinator",
        parentAllowedReadRoots: ["/tmp/agenc-coordinator"],
        parentAllowedWriteRoots: ["/tmp/agenc-coordinator"],
      }),
    ) as {
      success?: boolean;
      workerId?: string;
      taskId?: string;
      outputPath?: string;
      backgroundHandle?: {
        id?: string;
        kind?: string;
        status?: string;
        outputPath?: string;
        outputReady?: boolean;
      };
    };

    expect(followUp.success).toBe(true);
    expect(followUp.workerId).toBe(initial.workerId);
    expect(followUp.outputPath).toMatch(/output\.json$/);
    expect(followUp.backgroundHandle).toEqual(
      expect.objectContaining({
        id: followUp.taskId,
        kind: "worker_assignment",
        status: "pending",
        outputPath: followUp.outputPath,
        outputReady: false,
      }),
    );

    await waitForTaskTerminal(taskStore, "session-a", String(followUp.taskId));

    const completed = await taskStore.getTask(
      "session-a",
      String(followUp.taskId),
    );
    expect(completed).toMatchObject({
      status: "completed",
      kind: "worker_assignment",
    });
  });

  it("supports mailbox listing, ack, permission response, and coordinator messages", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const manager = new SubAgentManager(makeManagerConfig());
    const mailbox = new PersistentWorkerMailbox({ memoryBackend });
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager: manager,
      mailbox,
    });

    const worker = await workerManager.createWorker({
      parentSessionId: "session-a",
      workerName: "builder",
    });
    const summary = await mailbox.sendToParent({
      type: "worker_summary",
      parentSessionId: "session-a",
      workerId: worker.workerId,
      state: "idle",
      summary: "Worker ready for assignments.",
    });
    const permission = await mailbox.sendToParent({
      type: "permission_request",
      parentSessionId: "session-a",
      workerId: worker.workerId,
      approvalRequestId: "approval-1",
      message: "Approve system.writeFile",
      subagentSessionId: "subagent:1",
    });

    const listed = JSON.parse(
      await executeCoordinatorModeTool({
        toolArgs: {
          action: "messages",
          workerId: worker.workerId,
        },
        name: COORDINATOR_MODE_TOOL_NAME,
        sessionId: "session-a",
        toolCallId: "tool-call-mailbox-list",
        subAgentManager: manager,
        workerManager,
        taskStore,
        lifecycleEmitter: null,
        verifier: null as any,
        runtimeContractFlags: {
          persistentWorkersEnabled: true,
        } as any,
        availableToolNames: ["system.readFile"],
      }),
    ) as {
      success?: boolean;
      messages?: Array<{ messageId?: string; type?: string }>;
    };

    expect(listed.success).toBe(true);
    expect(listed.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: summary.messageId, type: "worker_summary" }),
        expect.objectContaining({ messageId: permission.messageId, type: "permission_request" }),
      ]),
    );

    const acked = JSON.parse(
      await executeCoordinatorModeTool({
        toolArgs: {
          action: "ack",
          messageId: summary.messageId,
        },
        name: COORDINATOR_MODE_TOOL_NAME,
        sessionId: "session-a",
        toolCallId: "tool-call-mailbox-ack",
        subAgentManager: manager,
        workerManager,
        taskStore,
        lifecycleEmitter: null,
        verifier: null as any,
        runtimeContractFlags: {
          persistentWorkersEnabled: true,
        } as any,
        availableToolNames: ["system.readFile"],
      }),
    ) as {
      message?: { status?: string };
    };
    expect(acked.message?.status).toBe("handled");

    const responded = JSON.parse(
      await executeCoordinatorModeTool({
        toolArgs: {
          action: "respond_permission",
          messageId: permission.messageId,
          disposition: "yes",
        },
        name: COORDINATOR_MODE_TOOL_NAME,
        sessionId: "session-a",
        toolCallId: "tool-call-mailbox-response",
        subAgentManager: manager,
        workerManager,
        taskStore,
        lifecycleEmitter: null,
        verifier: null as any,
        runtimeContractFlags: {
          persistentWorkersEnabled: true,
        } as any,
        availableToolNames: ["system.readFile"],
      }),
    ) as {
      success?: boolean;
      message?: { type?: string; correlationId?: string };
    };
    expect(responded.success).toBe(true);
    expect(responded.message).toEqual(
      expect.objectContaining({
        type: "permission_response",
        correlationId: permission.messageId,
      }),
    );

    const note = JSON.parse(
      await executeCoordinatorModeTool({
        toolArgs: {
          action: "message",
          workerId: worker.workerId,
          subject: "Follow-up",
          body: "Resume on parser cleanup.",
        },
        name: COORDINATOR_MODE_TOOL_NAME,
        sessionId: "session-a",
        toolCallId: "tool-call-mailbox-message",
        subAgentManager: manager,
        workerManager,
        taskStore,
        lifecycleEmitter: null,
        verifier: null as any,
        runtimeContractFlags: {
          persistentWorkersEnabled: true,
        } as any,
        availableToolNames: ["system.readFile"],
      }),
    ) as {
      success?: boolean;
      message?: { type?: string; body?: string };
    };
    expect(note.success).toBe(true);
    expect(note.message).toEqual(
      expect.objectContaining({
        type: "mode_change",
        body: "Resume on parser cleanup.",
      }),
    );
  });
});
