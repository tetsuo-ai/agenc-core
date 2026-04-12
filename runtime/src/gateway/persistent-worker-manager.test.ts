import { describe, expect, it, vi } from "vitest";
import type { MemoryBackend } from "../memory/types.js";
import { TaskStore } from "../tools/system/task-tracker.js";
import { ToolRegistry } from "../tools/registry.js";
import type { Tool, ToolResult } from "../tools/types.js";
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
import { SubAgentManager, type SubAgentManagerConfig } from "./sub-agent.js";
import { PersistentWorkerMailbox } from "./persistent-worker-mailbox.js";
import {
  PersistentWorkerManager,
  WORKER_ASSIGNMENT_METADATA_KEY,
  buildWorkerAssignmentMetadata,
  type PreparedPersistentWorkerAssignment,
} from "./persistent-worker-manager.js";

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

function makeMockLLMProvider(
  outputs: readonly string[] = ["worker output"],
): LLMProvider {
  const queue = [...outputs];
  const nextResponse = async (
    _messages: LLMMessage[],
  ): Promise<LLMResponse> => ({
    content: queue.shift() ?? "worker output",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "mock",
    finishReason: "stop",
  });

  return {
    name: "mock-llm",
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
    memoryBackend: createMemoryBackendStub() as any,
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

function buildPreparedAssignment(
  task = "Implement the next bounded step",
): PreparedPersistentWorkerAssignment {
  return {
    request: {
      task,
      tools: ["system.readFile"],
      executionContext: {
        allowedTools: ["system.readFile"],
        allowedReadRoots: ["/tmp/project"],
        allowedWriteRoots: ["/tmp/project"],
      },
    },
    objective: task,
    admittedInput: {
      task,
      tools: ["system.readFile"],
      executionContext: {
        allowedTools: ["system.readFile"],
        allowedReadRoots: ["/tmp/project"],
        allowedWriteRoots: ["/tmp/project"],
      },
      delegationAdmission: {
        isolationReason: "bounded phase ownership",
        ownedArtifacts: ["src/parser.ts"],
      },
    },
    allowedTools: ["system.readFile"],
    shellProfile: "coding",
    workingDirectory: "/tmp/project",
    executionContextFingerprint:
      '{"allowedReadRoots":["/tmp/project"],"allowedTools":["system.readFile"],"allowedWriteRoots":["/tmp/project"]}',
    executionEnvelopeFingerprint: "env-fingerprint-1",
  };
}

describe("PersistentWorkerManager", () => {
  it("emits worker lifecycle trace events for spawn, queue, claim, and idle", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const subAgentManager = new SubAgentManager(makeManagerConfig());
    const traceEvents: string[] = [];
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager,
      onTraceEvent: async (event) => {
        traceEvents.push(event.type);
      },
    });

    const worker = await workerManager.createWorker({
      parentSessionId: "session-a",
      workerName: "builder",
    });
    const queued = await workerManager.assignToWorker({
      parentSessionId: "session-a",
      workerId: worker.workerId,
      assignment: buildPreparedAssignment(),
    });

    await waitForTaskTerminal(taskStore, "session-a", queued.task.id);

    expect(traceEvents).toContain("spawned");
    expect(traceEvents).toContain("assignment_queued");
    expect(traceEvents).toContain("assignment_claimed");
    expect(traceEvents).toContain("idle");
  });

  it("creates named workers and runs queued worker_assignment tasks", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const subAgentManager = new SubAgentManager(makeManagerConfig());
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager,
    });

    const worker = await workerManager.createWorker({
      parentSessionId: "session-a",
      workerName: "builder",
    });
    const queued = await workerManager.assignToWorker({
      parentSessionId: "session-a",
      workerId: worker.workerId,
      assignment: buildPreparedAssignment(),
    });

    await waitForTaskTerminal(taskStore, "session-a", queued.task.id);

    const task = await taskStore.getTask("session-a", queued.task.id);
    const workers = await workerManager.listWorkers("session-a");
    expect(task).toMatchObject({
      id: queued.task.id,
      kind: "worker_assignment",
      status: "completed",
    });
    expect(workers).toEqual([
      expect.objectContaining({
        workerId: worker.workerId,
        workerName: "builder",
        shellProfile: "coding",
        state: "idle",
        lastTaskId: queued.task.id,
      }),
    ]);
    expect(workers[0]?.continuationSessionId).toMatch(/^subagent:/);
  });

  it("stops idle workers and releases queued targeted assignments", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const subAgentManager = new SubAgentManager(makeManagerConfig());
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager,
    });
    const worker = await workerManager.createWorker({
      parentSessionId: "session-a",
      workerName: "reviewer",
    });
    const assignment = buildPreparedAssignment("Review the current diff");
    const queuedTask = await taskStore.createRuntimeTask({
      listId: "session-a",
      kind: "worker_assignment",
      subject: assignment.objective,
      description: assignment.objective,
      status: "pending",
      metadata: {
        [WORKER_ASSIGNMENT_METADATA_KEY]: buildWorkerAssignmentMetadata({
          assignment,
          targetWorkerId: worker.workerId,
          targetWorkerName: worker.workerName,
        }),
      },
    });

    const stopped = await workerManager.stopWorker({
      parentSessionId: "session-a",
      workerIdOrSessionId: worker.workerId,
    });
    const releasedTask = await taskStore.getTask("session-a", queuedTask.id);

    expect(stopped).toMatchObject({
      workerId: worker.workerId,
      state: "cancelled",
    });
    expect(releasedTask?.status).toBe("pending");
    expect(releasedTask?.owner).toBeUndefined();
    expect(
      (releasedTask?.metadata?.[WORKER_ASSIGNMENT_METADATA_KEY] as Record<string, unknown>)
        ?.targetWorkerId,
    ).toBeUndefined();
  });

  it("fails nonterminal workers and requeues claimed assignments during repair", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const subAgentManager = new SubAgentManager(makeManagerConfig());
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager,
    });
    const worker = await workerManager.createWorker({
      parentSessionId: "session-a",
      workerName: "executor",
    });
    const assignment = buildPreparedAssignment("Handle a recovered task");
    const queuedTask = await taskStore.createRuntimeTask({
      listId: "session-a",
      kind: "worker_assignment",
      subject: assignment.objective,
      description: assignment.objective,
      status: "in_progress",
      owner: worker.workerId,
      metadata: {
        [WORKER_ASSIGNMENT_METADATA_KEY]: buildWorkerAssignmentMetadata({
          assignment,
          targetWorkerId: worker.workerId,
          targetWorkerName: worker.workerName,
        }),
      },
    });

    await workerManager.repairRuntimeState();

    const repairedTask = await taskStore.getTask("session-a", queuedTask.id);
    const workers = await workerManager.listWorkers("session-a");
    expect(repairedTask).toMatchObject({
      id: queuedTask.id,
      status: "pending",
    });
    expect(repairedTask?.owner).toBeUndefined();
    expect(workers).toEqual([
      expect.objectContaining({
        workerId: worker.workerId,
        state: "failed",
      }),
    ]);
  });

  it("routes worker assignment lifecycle through mailbox messages when enabled", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const subAgentManager = new SubAgentManager(makeManagerConfig());
    const mailbox = new PersistentWorkerMailbox({ memoryBackend });
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager,
      mailbox,
    });

    const worker = await workerManager.createWorker({
      parentSessionId: "session-a",
      workerName: "builder",
    });
    const queued = await workerManager.assignToWorker({
      parentSessionId: "session-a",
      workerId: worker.workerId,
      assignment: buildPreparedAssignment("Inspect parser.c"),
    });

    await waitForTaskTerminal(taskStore, "session-a", queued.task.id);

    const messages = await workerManager.listMailboxMessages({
      parentSessionId: "session-a",
      workerIdOrSessionId: worker.workerId,
    });

    expect(messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "task_assignment",
          taskId: queued.task.id,
          status: "handled",
        }),
        expect.objectContaining({
          type: "worker_summary",
          taskId: queued.task.id,
          state: "idle",
        }),
        expect.objectContaining({
          type: "idle_notification",
        }),
      ]),
    );
    expect(
      await workerManager.describeRuntimeMailboxLayer("session-a", true),
    ).toEqual(
      expect.objectContaining({
        configured: true,
        effective: true,
        pendingParentToWorker: 0,
      }),
    );
  });

  it("persists remote-session execution metadata when remote isolation is enabled", async () => {
    const memoryBackend = createMemoryBackendStub();
    const taskStore = new TaskStore({ memoryBackend });
    const subAgentManager = new SubAgentManager(makeManagerConfig());
    const remoteSessionManager = {
      start: vi.fn(async () => ({
        content: JSON.stringify({
          sessionHandleId: "rsess_123",
          remoteSessionId: "session-a:worker-1",
          serverName: "runtime",
          callback: {
            authToken: "remote-token",
          },
        }),
      })),
      handleWebhook: vi.fn(async () => ({
        status: 202,
        body: { accepted: true },
      })),
    };
    const workerManager = new PersistentWorkerManager({
      memoryBackend,
      taskStore,
      subAgentManager,
      remoteIsolationEnabled: true,
      remoteSessionManager,
    });

    const worker = await workerManager.createWorker({
      parentSessionId: "session-a",
      workerName: "isolated",
    });
    const queued = await workerManager.assignToWorker({
      parentSessionId: "session-a",
      workerId: worker.workerId,
      assignment: buildPreparedAssignment("Run isolated task"),
    });

    await waitForTaskTerminal(taskStore, "session-a", queued.task.id);

    const task = await taskStore.getTask("session-a", queued.task.id);
    const workers = await workerManager.listWorkers("session-a");
    expect(task?.externalRef).toEqual({
      kind: "remote_session",
      id: "rsess_123",
    });
    expect(task?.executionLocation).toMatchObject({
      mode: "remote_session",
      handleId: "rsess_123",
      remoteSessionId: "session-a:worker-1",
    });
    expect(workers[0]?.executionLocation).toMatchObject({
      mode: "remote_session",
      handleId: "rsess_123",
    });
    expect(workers[0]?.shellProfile).toBe("coding");
    expect(remoteSessionManager.start).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          parentSessionId: "session-a",
          workerId: "worker-1",
          shellProfile: "coding",
        }),
      }),
    );
    expect(remoteSessionManager.handleWebhook).toHaveBeenCalled();
  });
});
