import { describe, it, expect, beforeEach } from "vitest";
import {
  createTaskTrackerTools,
  TaskStore,
  type TaskTrackerToolOptions,
  TASK_LIST_ARG,
  DEFAULT_TASK_LIST_ID,
  TASK_TRACKER_TOOL_NAMES,
} from "./task-tracker.js";
import type { Tool, ToolResult } from "../types.js";
import type { MemoryBackend } from "../../memory/types.js";

interface ParsedResult {
  readonly raw: ToolResult;
  readonly body: Record<string, unknown>;
}

function findTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
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

async function callTool(
  tool: Tool,
  args: Record<string, unknown>,
): Promise<ParsedResult> {
  const result = await tool.execute(args);
  return {
    raw: result,
    body: JSON.parse(result.content) as Record<string, unknown>,
  };
}

describe("task-tracker", () => {
  let store: TaskStore;
  let tools: readonly Tool[];
  let create: Tool;
  let list: Tool;
  let get: Tool;
  let update: Tool;
  let wait: Tool;
  let output: Tool;
  let toolOptions: TaskTrackerToolOptions;

  beforeEach(() => {
    let now = 1_000;
    store = new TaskStore({ now: () => now++ });
    toolOptions = {};
    tools = createTaskTrackerTools(store, toolOptions);
    create = findTool(tools, "task.create");
    list = findTool(tools, "task.list");
    get = findTool(tools, "task.get");
    update = findTool(tools, "task.update");
    wait = findTool(tools, "task.wait");
    output = findTool(tools, "task.output");
  });

  describe("registration metadata", () => {
    it("exposes the six task tracker tools", () => {
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "task.create",
        "task.get",
        "task.list",
        "task.output",
        "task.update",
        "task.wait",
      ]);
    });

    it("each tool has a non-trivial description and an inputSchema", () => {
      for (const tool of tools) {
        expect(tool.description.length).toBeGreaterThan(20);
        expect(tool.inputSchema).toMatchObject({ type: "object" });
      }
    });

    it("TASK_TRACKER_TOOL_NAMES matches the registered tool names", () => {
      const registered = new Set(tools.map((t) => t.name));
      for (const name of TASK_TRACKER_TOOL_NAMES) {
        expect(registered.has(name)).toBe(true);
      }
      expect(registered.size).toBe(TASK_TRACKER_TOOL_NAMES.size);
    });
  });

  describe("task.create", () => {
    it("creates a task with id #1, persists to the store", async () => {
      const result = await callTool(create, {
        subject: "Write the spec",
        description: "Draft the v1 spec doc",
      });
      expect(result.raw.isError).toBeUndefined();
      const task = (result.body.task as Record<string, unknown>);
      expect(task.id).toBe("1");
      expect(task.subject).toBe("Write the spec");
      expect(task.status).toBe("pending");
      expect(store.list(DEFAULT_TASK_LIST_ID)).toHaveLength(1);
    });

    it("auto-increments task ids per list", async () => {
      await callTool(create, { subject: "A", description: "first" });
      await callTool(create, { subject: "B", description: "second" });
      const r = await callTool(create, { subject: "C", description: "third" });
      expect((r.body.task as Record<string, unknown>).id).toBe("3");
    });

    it("rejects empty subject", async () => {
      const result = await callTool(create, { subject: "", description: "x" });
      expect(result.raw.isError).toBe(true);
      expect(result.body.error).toMatch(/subject/);
    });

    it("falls back to the subject when description is omitted", async () => {
      const result = await callTool(create, { subject: "x" });
      expect(result.raw.isError).toBeUndefined();
      expect(result.body.task).toMatchObject({
        subject: "x",
      });
      expect(store.list(DEFAULT_TASK_LIST_ID)[0]?.description).toBe("x");
    });

    it("falls back to the subject when description is empty", async () => {
      const result = await callTool(create, { subject: "x", description: "" });
      expect(result.raw.isError).toBeUndefined();
      expect(store.list(DEFAULT_TASK_LIST_ID)[0]?.description).toBe("x");
    });

    it("preserves activeForm and metadata when provided", async () => {
      const result = await callTool(create, {
        subject: "Run the build",
        description: "npm run build",
        activeForm: "Running the build",
        metadata: { priority: "high", tags: ["ci"] },
      });
      const stored = store.list(DEFAULT_TASK_LIST_ID)[0];
      expect(stored.activeForm).toBe("Running the build");
      expect(stored.metadata).toEqual({ priority: "high", tags: ["ci"] });
      expect(result.body.taskRuntime).toMatchObject({
        fullTask: expect.objectContaining({
          subject: "Run the build",
        }),
        runtimeMetadata: {
          hasRuntimeMetadata: false,
          milestoneIds: [],
          verification: false,
          malformed: false,
          errors: [],
        },
      });
    });

    it("returns normalized runtime metadata alongside the compact task summary", async () => {
      const result = await callTool(create, {
        subject: "Implement phase 1",
        description: "Ship the first milestone",
        metadata: {
          _runtime: {
            milestoneIds: ["phase_1"],
            verification: true,
          },
        },
      });

      expect(result.body.task).toMatchObject({
        id: "1",
        subject: "Implement phase 1",
        status: "pending",
      });
      expect(result.body.taskRuntime).toMatchObject({
        fullTask: expect.objectContaining({
          id: "1",
          metadata: {
            _runtime: {
              milestoneIds: ["phase_1"],
              verification: true,
            },
          },
        }),
        runtimeMetadata: {
          hasRuntimeMetadata: true,
          milestoneIds: ["phase_1"],
          verification: true,
          malformed: false,
          errors: [],
        },
      });
    });
  });

  describe("task.list", () => {
    beforeEach(async () => {
      await callTool(create, { subject: "A", description: "alpha" });
      await callTool(create, { subject: "B", description: "beta" });
      await callTool(create, { subject: "C", description: "gamma" });
    });

    it("returns all visible tasks by default", async () => {
      const result = await callTool(list, {});
      expect(result.body.count).toBe(3);
      const tasks = result.body.tasks as Array<Record<string, unknown>>;
      expect(tasks.map((t) => t.subject)).toEqual(["A", "B", "C"]);
    });

    it("filters by status", async () => {
      await callTool(update, { taskId: "1", status: "in_progress" });
      await callTool(update, { taskId: "2", status: "completed" });
      const inProgress = await callTool(list, { status: "in_progress" });
      expect(inProgress.body.count).toBe(1);
      expect((inProgress.body.tasks as Array<Record<string, unknown>>)[0].id).toBe("1");
      const completed = await callTool(list, { status: "completed" });
      expect(completed.body.count).toBe(1);
      const pending = await callTool(list, { status: "pending" });
      expect(pending.body.count).toBe(1);
    });

    it("ignores deleted tasks", async () => {
      await callTool(update, { taskId: "2", status: "deleted" });
      const result = await callTool(list, {});
      expect(result.body.count).toBe(2);
      const ids = (result.body.tasks as Array<Record<string, unknown>>).map((t) => t.id);
      expect(ids).toEqual(["1", "3"]);
    });

    it("ignores invalid status filter values", async () => {
      const result = await callTool(list, { status: "garbage" });
      expect(result.body.count).toBe(3);
    });

    it("returns empty for an unknown task list", async () => {
      const result = await callTool(list, { [TASK_LIST_ARG]: "unknown-session" });
      expect(result.body.count).toBe(0);
    });
  });

  describe("runtime claim semantics", () => {
    it("claims pending worker assignments for a specific owner", async () => {
      const task = await store.createRuntimeTask({
        listId: DEFAULT_TASK_LIST_ID,
        kind: "worker_assignment",
        subject: "Implement parser step",
        description: "Handle the next bounded worker assignment",
        status: "pending",
        summary: "Queued for a worker.",
      });

      const claimed = await store.claimTask({
        listId: DEFAULT_TASK_LIST_ID,
        taskId: task.id,
        owner: "worker-1",
        summary: "Claimed by worker-1.",
      });

      expect(claimed).toMatchObject({
        id: task.id,
        kind: "worker_assignment",
        status: "in_progress",
        owner: "worker-1",
        summary: "Claimed by worker-1.",
      });
    });

    it("releases claimed worker assignments back to pending", async () => {
      const task = await store.createRuntimeTask({
        listId: DEFAULT_TASK_LIST_ID,
        kind: "worker_assignment",
        subject: "Implement lexer step",
        description: "Handle the next bounded worker assignment",
        status: "pending",
      });
      await store.claimTask({
        listId: DEFAULT_TASK_LIST_ID,
        taskId: task.id,
        owner: "worker-2",
      });

      const released = await store.releaseTaskClaim({
        listId: DEFAULT_TASK_LIST_ID,
        taskId: task.id,
        owner: "worker-2",
        summary: "Returned to the queue.",
      });

      expect(released).toMatchObject({
        id: task.id,
        status: "pending",
        summary: "Returned to the queue.",
      });
      expect(released?.owner).toBeUndefined();
    });

    it("requeues in-flight worker assignments during runtime repair", async () => {
      const repairStore = new TaskStore({
        memoryBackend: createMemoryBackendStub(),
      });

      const task = await repairStore.createRuntimeTask({
        listId: DEFAULT_TASK_LIST_ID,
        kind: "worker_assignment",
        subject: "Implement expansion step",
        description: "Handle the next bounded worker assignment",
        status: "in_progress",
        owner: "worker-3",
        summary: "Running worker assignment.",
      });

      await repairStore.repairRuntimeState();

      const repaired = await repairStore.getTask(DEFAULT_TASK_LIST_ID, task.id);
      expect(repaired).toMatchObject({
        id: task.id,
        status: "pending",
      });
      expect(repaired?.owner).toBeUndefined();
      expect(repaired?.summary).toMatch(/returned to the queue|worker assignment/i);
    });
  });

  describe("task.get", () => {
    beforeEach(async () => {
      await callTool(create, {
        subject: "Inspect logs",
        description: "Tail daemon log for the last hour",
        activeForm: "Inspecting logs",
        metadata: { severity: "warn" },
      });
    });

    it("returns the full task with description, metadata, timestamps", async () => {
      const result = await callTool(get, { taskId: "1" });
      const task = result.body.task as Record<string, unknown>;
      expect(task.id).toBe("1");
      expect(task.description).toBe("Tail daemon log for the last hour");
      expect(task.activeForm).toBe("Inspecting logs");
      expect(task.metadata).toEqual({ severity: "warn" });
      expect(task.blocks).toEqual([]);
      expect(task.blockedBy).toEqual([]);
      expect(typeof task.createdAt).toBe("number");
      expect(typeof task.updatedAt).toBe("number");
      expect(result.body.taskRuntime).toMatchObject({
        fullTask: expect.objectContaining({
          id: "1",
          description: "Tail daemon log for the last hour",
        }),
        runtimeMetadata: {
          hasRuntimeMetadata: false,
          milestoneIds: [],
          verification: false,
          malformed: false,
          errors: [],
        },
      });
    });

    it("returns an error when the task does not exist", async () => {
      const result = await callTool(get, { taskId: "999" });
      expect(result.raw.isError).toBe(true);
      expect(result.body.error).toMatch(/not found/);
    });

    it("rejects empty taskId", async () => {
      const result = await callTool(get, { taskId: "" });
      expect(result.raw.isError).toBe(true);
    });

    it("treats deleted tasks as not found", async () => {
      await callTool(update, { taskId: "1", status: "deleted" });
      const result = await callTool(get, { taskId: "1" });
      expect(result.raw.isError).toBe(true);
    });
  });

  describe("task.update", () => {
    beforeEach(async () => {
      await callTool(create, { subject: "Initial", description: "first task" });
    });

    it("transitions through pending -> in_progress -> completed", async () => {
      const start = await callTool(update, { taskId: "1", status: "in_progress" });
      expect((start.body.task as Record<string, unknown>).status).toBe("in_progress");
      const done = await callTool(update, { taskId: "1", status: "completed" });
      expect((done.body.task as Record<string, unknown>).status).toBe("completed");
    });

    it("merges metadata shallowly and deletes keys set to null", async () => {
      await callTool(update, {
        taskId: "1",
        metadata: { priority: "high", retries: 0 },
      });
      const after = store.get(DEFAULT_TASK_LIST_ID, "1");
      expect(after?.metadata).toEqual({ priority: "high", retries: 0 });

      await callTool(update, {
        taskId: "1",
        metadata: { retries: 3, priority: null },
      });
      const merged = store.get(DEFAULT_TASK_LIST_ID, "1");
      expect(merged?.metadata).toEqual({ retries: 3 });
    });

    it("surfaces malformed runtime metadata in the additive taskRuntime payload", async () => {
      const result = await callTool(update, {
        taskId: "1",
        metadata: {
          _runtime: {
            milestoneIds: ["phase_1", "phase_1", ""],
            verification: "yes",
          },
        },
      });

      expect(result.body.task).toMatchObject({
        id: "1",
        status: "pending",
      });
      expect(result.body.taskRuntime).toMatchObject({
        fullTask: expect.objectContaining({
          id: "1",
        }),
      });
      expect(result.body.taskRuntime).toMatchObject({
        runtimeMetadata: expect.objectContaining({
          hasRuntimeMetadata: true,
          malformed: true,
          milestoneIds: ["phase_1"],
          verification: false,
        }),
      });
      expect(
        ((result.body.taskRuntime as Record<string, unknown>).runtimeMetadata as Record<string, unknown>)
          .errors,
      ).toEqual(
        expect.arrayContaining([
          expect.stringContaining("verification must be a boolean"),
          expect.stringContaining("cannot contain duplicates"),
          expect.stringContaining("cannot contain empty strings"),
        ]),
      );
    });

    it("appends unique blockedBy ids", async () => {
      await callTool(update, { taskId: "1", addBlockedBy: ["2", "3"] });
      await callTool(update, { taskId: "1", addBlockedBy: ["3", "4"] });
      const after = store.get(DEFAULT_TASK_LIST_ID, "1");
      expect(after?.blockedBy).toEqual(["2", "3", "4"]);
    });

    it("rejects invalid status", async () => {
      const result = await callTool(update, { taskId: "1", status: "wat" });
      expect(result.raw.isError).toBe(true);
    });

    it("rejects updates to non-existent task", async () => {
      const result = await callTool(update, { taskId: "404", status: "completed" });
      expect(result.raw.isError).toBe(true);
      expect(result.body.error).toMatch(/not found/);
    });

    it("rejects updates to deleted tasks", async () => {
      await callTool(update, { taskId: "1", status: "deleted" });
      const result = await callTool(update, { taskId: "1", status: "completed" });
      expect(result.raw.isError).toBe(true);
    });

    it("rejects non-array addBlocks", async () => {
      const result = await callTool(update, {
        taskId: "1",
        addBlocks: "not-an-array",
      });
      expect(result.raw.isError).toBe(true);
    });

    it("rejects metadata that is not a plain object", async () => {
      const result = await callTool(update, { taskId: "1", metadata: "wat" });
      expect(result.raw.isError).toBe(true);
    });

    it("allows ordinary task completion even when a completion guard is configured", async () => {
      let guardCalled = false;
      tools = createTaskTrackerTools(store, {
        onBeforeTaskComplete: async () => {
          guardCalled = true;
          return {
            outcome: "block",
            message: "completion blocked",
          };
        },
      });
      update = findTool(tools, "task.update");

      const result = await callTool(update, { taskId: "1", status: "completed" });

      expect(result.raw.isError).toBeUndefined();
      expect(result.body.task).toMatchObject({
        id: "1",
        status: "completed",
      });
      expect(store.get(DEFAULT_TASK_LIST_ID, "1")?.status).toBe("completed");
      expect(guardCalled).toBe(false);
    });

    it("still blocks explicit verification tasks when the completion guard rejects them", async () => {
      let guardCalled = false;
      tools = createTaskTrackerTools(store, {
        onBeforeTaskComplete: async () => {
          guardCalled = true;
          return {
            outcome: "block",
            message: "completion blocked",
          };
        },
      });
      update = findTool(tools, "task.update");

      const result = await callTool(update, {
        taskId: "1",
        status: "completed",
        metadata: {
          _runtime: {
            verification: true,
          },
        },
      });

      expect(result.raw.isError).toBe(true);
      expect(result.body.error).toContain("completion blocked");
      expect(store.get(DEFAULT_TASK_LIST_ID, "1")?.status).toBe("pending");
      expect(guardCalled).toBe(true);
    });

    it("rejects stale completion when an explicit verification task changes during the guard", async () => {
      tools = createTaskTrackerTools(store, {
        onBeforeTaskComplete: async () => {
          store.update(DEFAULT_TASK_LIST_ID, "1", {
            metadata: { changedBy: "guard" },
          });
          return { outcome: "allow" };
        },
      });
      update = findTool(tools, "task.update");

      const result = await callTool(update, {
        taskId: "1",
        status: "completed",
        metadata: {
          ready: true,
          _runtime: {
            verification: true,
          },
        },
      });

      expect(result.raw.isError).toBe(true);
      expect(result.body.error).toContain("changed while completion hook was running");
      const stored = store.get(DEFAULT_TASK_LIST_ID, "1");
      expect(stored?.status).toBe("pending");
      expect(stored?.metadata).toEqual({ changedBy: "guard" });
      expect((result.body.task as Record<string, unknown> | undefined)?.revision).toBeUndefined();
    });
  });

  describe("task.wait and task.output", () => {
    it("returns terminal state and persisted output for runtime-managed tasks", async () => {
      const runtimeTask = await store.createRuntimeTask({
        listId: DEFAULT_TASK_LIST_ID,
        kind: "subagent",
        subject: "Implement phase",
        description: "Finish the delegated phase",
        summary: "Delegated worker started.",
      });

      await store.finalizeRuntimeTask({
        listId: DEFAULT_TASK_LIST_ID,
        taskId: runtimeTask.id,
        status: "completed",
        summary: "Delegated worker completed successfully.",
        output: "{\"ok\":true}",
        structuredOutput: { ok: true },
        usage: { outputTokens: 12 },
        externalRef: {
          kind: "subagent",
          id: "subagent:1",
          sessionId: "subagent:1",
        },
        executionLocation: {
          mode: "worktree",
          workspaceRoot: "/workspace",
          workingDirectory: "/tmp/worktree-1",
          gitRoot: "/workspace",
          worktreePath: "/tmp/worktree-1",
          lifecycle: "active",
        },
      });

      const waited = await callTool(wait, {
        taskId: runtimeTask.id,
        until: "terminal",
      });
      expect(waited.body.ready).toBe(true);
      expect(waited.body.task).toMatchObject({
        id: runtimeTask.id,
        status: "completed",
        outputReady: true,
        executionLocation: {
          mode: "worktree",
          worktreePath: "/tmp/worktree-1",
        },
      });

      const persistedOutput = await callTool(output, {
        taskId: runtimeTask.id,
        includeEvents: true,
      });
      expect(persistedOutput.body.ready).toBe(true);
      expect(persistedOutput.body.summary).toBe(
        "Delegated worker completed successfully.",
      );
      expect(persistedOutput.body.output).toBe("{\"ok\":true}");
      expect(persistedOutput.body.structuredOutput).toEqual({ ok: true });
      expect(persistedOutput.body.usage).toEqual({ outputTokens: 12 });
      expect(persistedOutput.body.externalRef).toMatchObject({
        kind: "subagent",
        id: "subagent:1",
      });
      expect(persistedOutput.body.executionLocation).toMatchObject({
        mode: "worktree",
        worktreePath: "/tmp/worktree-1",
      });
      expect(persistedOutput.body.events).toBeInstanceOf(Array);
    });
  });

  describe("session isolation via TASK_LIST_ARG", () => {
    it("scopes tasks by task list id", async () => {
      await callTool(create, {
        [TASK_LIST_ARG]: "session-a",
        subject: "A1",
        description: "from session a",
      });
      await callTool(create, {
        [TASK_LIST_ARG]: "session-b",
        subject: "B1",
        description: "from session b",
      });
      await callTool(create, {
        [TASK_LIST_ARG]: "session-a",
        subject: "A2",
        description: "from session a",
      });

      const a = await callTool(list, { [TASK_LIST_ARG]: "session-a" });
      const b = await callTool(list, { [TASK_LIST_ARG]: "session-b" });
      expect(a.body.count).toBe(2);
      expect(b.body.count).toBe(1);

      const aIds = (a.body.tasks as Array<Record<string, unknown>>).map((t) => t.id);
      const bIds = (b.body.tasks as Array<Record<string, unknown>>).map((t) => t.id);
      expect(aIds).toEqual(["1", "2"]);
      expect(bIds).toEqual(["1"]);
    });

    it("uses DEFAULT_TASK_LIST_ID when no list id is provided", async () => {
      await callTool(create, { subject: "default", description: "no scope" });
      expect(store.list(DEFAULT_TASK_LIST_ID)).toHaveLength(1);
    });

    it("dropList removes all tasks for a session id", async () => {
      await callTool(create, {
        [TASK_LIST_ARG]: "ephemeral",
        subject: "tmp",
        description: "throwaway",
      });
      expect(store.list("ephemeral")).toHaveLength(1);
      expect(store.dropList("ephemeral")).toBe(true);
      expect(store.list("ephemeral")).toHaveLength(0);
    });
  });

  describe("runtime tracing hooks", () => {
    it("emits lifecycle notifications including task_created for runtime tasks", async () => {
      const events: string[] = [];
      const tracedStore = new TaskStore({
        now: (() => {
          let now = 10;
          return () => now++;
        })(),
        onTaskEvent: async (event) => {
          events.push(event.type);
        },
      });

      await tracedStore.createRuntimeTask({
        listId: "session-trace",
        kind: "subagent",
        subject: "Run verifier",
        description: "Run verifier",
        status: "in_progress",
      });

      expect(events).toEqual(["task_created", "task_started"]);
    });

    it("emits bounded task.wait and task.output access events once per tool call", async () => {
      const accessEvents: Array<Record<string, unknown>> = [];
      const tracedStore = new TaskStore({
        now: (() => {
          let now = 100;
          return () => now++;
        })(),
      });
      const tracedTools = createTaskTrackerTools(tracedStore, {
        onTaskAccessEvent: async (event) => {
          accessEvents.push({
            type: event.type,
            taskId: event.taskId,
            ready: event.ready,
            until: event.until,
          });
        },
      });
      const tracedCreate = findTool(tracedTools, "task.create");
      const tracedWait = findTool(tracedTools, "task.wait");
      const tracedOutput = findTool(tracedTools, "task.output");

      const created = await callTool(tracedCreate, {
        subject: "Build",
        description: "Run build",
      });
      await callTool(tracedWait, {
        taskId: (created.body.task as Record<string, unknown>).id,
        timeoutMs: 1,
      });
      await callTool(tracedOutput, {
        taskId: (created.body.task as Record<string, unknown>).id,
      });

      expect(accessEvents).toEqual([
        expect.objectContaining({
          type: "task_wait_started",
          taskId: "1",
        }),
        expect.objectContaining({
          type: "task_wait_finished",
          taskId: "1",
          ready: false,
          until: "terminal",
        }),
        expect.objectContaining({
          type: "task_output_read",
          taskId: "1",
          ready: false,
        }),
      ]);
    });
  });
});
