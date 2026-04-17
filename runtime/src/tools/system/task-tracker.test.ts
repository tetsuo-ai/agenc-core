import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  TASK_ACTOR_KIND_ARG,
  TASK_ACTOR_NAME_ARG,
  createRuntimeTaskHandleTools,
  createTaskTrackerTools,
  SessionTaskStore,
  TaskStore,
  type TaskTrackerToolOptions,
  TASK_LIST_ARG,
  DEFAULT_TASK_LIST_ID,
  TASK_TRACKER_TOOL_NAMES,
  isOpenTaskStatus,
  listOpenTasksForSession,
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
  let store: SessionTaskStore;
  let tools: readonly Tool[];
  let create: Tool;
  let list: Tool;
  let get: Tool;
  let update: Tool;
  let toolOptions: TaskTrackerToolOptions;

  beforeEach(() => {
    let now = 1_000;
    store = new SessionTaskStore({ now: () => now++ });
    toolOptions = {};
    tools = createTaskTrackerTools(store, toolOptions);
    create = findTool(tools, "task.create");
    list = findTool(tools, "task.list");
    get = findTool(tools, "task.get");
    update = findTool(tools, "task.update");
  });

  describe("registration metadata", () => {
    it("exposes the four public session task tools", () => {
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "task.create",
        "task.get",
        "task.list",
        "task.update",
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
      expect(result.body.task).toMatchObject({
        id: "1",
        subject: "Run the build",
      });
    });

    it("keeps metadata on the stored task without exposing runtime payloads", async () => {
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
      });
      expect(store.get(DEFAULT_TASK_LIST_ID, "1")?.metadata).toEqual({
        _runtime: {
          milestoneIds: ["phase_1"],
          verification: true,
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
      const tasks = result.body.tasks as Array<Record<string, unknown>>;
      expect(tasks.map((t) => t.subject)).toEqual(["A", "B", "C"]);
    });

    it("hides blockers that are already completed", async () => {
      await callTool(update, { taskId: "1", status: "completed" });
      await callTool(update, { taskId: "2", addBlockedBy: ["1", "3"] });

      const listed = await callTool(list, {});
      const task = (listed.body.tasks as Array<Record<string, unknown>>).find(
        (entry) => entry.id === "2",
      );
      expect(task?.blockedBy).toEqual(["3"]);
    });

    it("ignores deleted tasks", async () => {
      await callTool(update, { taskId: "2", status: "deleted" });
      const result = await callTool(list, {});
      const ids = (result.body.tasks as Array<Record<string, unknown>>).map((t) => t.id);
      expect(ids).toEqual(["1", "3"]);
    });

    it("returns empty for an unknown task list", async () => {
      const result = await callTool(list, { [TASK_LIST_ARG]: "unknown-session" });
      expect(result.body.tasks).toEqual([]);
    });
  });

  describe("runtime claim semantics", () => {
    it("claims pending worker assignments for a specific owner", async () => {
      const runtimeStore = new TaskStore();
      const task = await runtimeStore.createRuntimeTask({
        listId: DEFAULT_TASK_LIST_ID,
        kind: "worker_assignment",
        subject: "Implement parser step",
        description: "Handle the next bounded worker assignment",
        status: "pending",
        summary: "Queued for a worker.",
      });

      const claimed = await runtimeStore.claimTask({
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
      const runtimeStore = new TaskStore();
      const task = await runtimeStore.createRuntimeTask({
        listId: DEFAULT_TASK_LIST_ID,
        kind: "worker_assignment",
        subject: "Implement lexer step",
        description: "Handle the next bounded worker assignment",
        status: "pending",
      });
      await runtimeStore.claimTask({
        listId: DEFAULT_TASK_LIST_ID,
        taskId: task.id,
        owner: "worker-2",
      });

      const released = await runtimeStore.releaseTaskClaim({
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

    it("returns the lightweight public task view", async () => {
      const result = await callTool(get, { taskId: "1" });
      const task = result.body.task as Record<string, unknown>;
      expect(task.id).toBe("1");
      expect(task.description).toBe("Tail daemon log for the last hour");
      expect(task.blocks).toEqual([]);
      expect(task.blockedBy).toEqual([]);
    });

    it("returns null when the task does not exist", async () => {
      const result = await callTool(get, { taskId: "999" });
      expect(result.raw.isError).toBeUndefined();
      expect(result.body.task).toBeNull();
    });

    it("rejects empty taskId", async () => {
      const result = await callTool(get, { taskId: "" });
      expect(result.raw.isError).toBe(true);
    });

    it("treats deleted tasks as not found", async () => {
      await callTool(update, { taskId: "1", status: "deleted" });
      const result = await callTool(get, { taskId: "1" });
      expect(result.body.task).toBeNull();
    });
  });

  describe("task.update", () => {
    beforeEach(async () => {
      await callTool(create, { subject: "Initial", description: "first task" });
    });

    it("transitions through pending -> in_progress -> completed", async () => {
      const start = await callTool(update, { taskId: "1", status: "in_progress" });
      expect(start.body).toMatchObject({
        success: true,
        taskId: "1",
        statusChange: {
          from: "pending",
          to: "in_progress",
        },
      });
      const done = await callTool(update, { taskId: "1", status: "completed" });
      expect(done.body).toMatchObject({
        success: true,
        taskId: "1",
        statusChange: {
          from: "in_progress",
          to: "completed",
        },
      });
      expect(store.get(DEFAULT_TASK_LIST_ID, "1")?.status).toBe("completed");
    });

    it("auto-claims an in-progress task for a subagent actor when no owner is set", async () => {
      const start = await callTool(update, {
        taskId: "1",
        status: "in_progress",
        [TASK_ACTOR_KIND_ARG]: "subagent",
        [TASK_ACTOR_NAME_ARG]: "worker-alpha",
      });

      expect(start.body).toMatchObject({
        success: true,
        taskId: "1",
        statusChange: {
          from: "pending",
          to: "in_progress",
        },
      });
      expect(store.get(DEFAULT_TASK_LIST_ID, "1")?.owner).toBe("worker-alpha");
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

    it("preserves malformed runtime metadata on the stored task without exposing it publicly", async () => {
      await callTool(update, {
        taskId: "1",
        metadata: {
          _runtime: {
            milestoneIds: ["phase_1", "phase_1", ""],
            verification: "yes",
          },
        },
      });

      expect(store.get(DEFAULT_TASK_LIST_ID, "1")?.metadata).toEqual({
        _runtime: {
          milestoneIds: ["phase_1", "phase_1", ""],
          verification: "yes",
        },
      });
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
      expect(result.body).toMatchObject({
        success: false,
        taskId: "404",
        error: "Task not found",
      });
    });

    it("rejects updates to deleted tasks", async () => {
      await callTool(update, { taskId: "1", status: "deleted" });
      const result = await callTool(update, { taskId: "1", status: "completed" });
      expect(result.body).toMatchObject({
        success: false,
        taskId: "1",
        error: "Task not found",
      });
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
      expect(result.body).toMatchObject({
        success: true,
        taskId: "1",
        statusChange: {
          from: "pending",
          to: "completed",
        },
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
          await store.updateTask(DEFAULT_TASK_LIST_ID, "1", {
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
      expect(result.body.task).toBeUndefined();
    });

    it("appends a verification nudge when the main actor closes 3+ tasks without a verification step", async () => {
      await callTool(create, { subject: "Second", description: "second task" });
      await callTool(create, { subject: "Third", description: "third task" });

      await callTool(update, { taskId: "1", status: "completed" });
      await callTool(update, { taskId: "2", status: "completed" });
      const result = await callTool(update, { taskId: "3", status: "completed" });

      expect(result.body.verificationNudgeNeeded).toBe(true);
      expect(String(result.body.message)).toContain(
        "spawn the verifier with execute_with_agent",
      );
      expect(String(result.body.message)).toContain(
        "only the verifier issues a verdict",
      );
    });

    it("does not append the verification nudge for subagent actors", async () => {
      await callTool(create, { subject: "Second", description: "second task" });
      await callTool(create, { subject: "Third", description: "third task" });

      await callTool(update, {
        taskId: "1",
        status: "completed",
        [TASK_ACTOR_KIND_ARG]: "subagent",
        [TASK_ACTOR_NAME_ARG]: "worker-alpha",
      });
      await callTool(update, {
        taskId: "2",
        status: "completed",
        [TASK_ACTOR_KIND_ARG]: "subagent",
        [TASK_ACTOR_NAME_ARG]: "worker-alpha",
      });
      const result = await callTool(update, {
        taskId: "3",
        status: "completed",
        [TASK_ACTOR_KIND_ARG]: "subagent",
        [TASK_ACTOR_NAME_ARG]: "worker-alpha",
      });

      expect(result.body.verificationNudgeNeeded).toBeUndefined();
      expect(String(result.body.message)).not.toContain(
        "spawn the verifier with execute_with_agent",
      );
    });
  });

  describe("task.wait and task.output", () => {
    it("returns terminal state and persisted output for runtime-managed tasks", async () => {
      const runtimeStore = new TaskStore();
      const runtimeTools = createRuntimeTaskHandleTools(runtimeStore);
      const wait = findTool(runtimeTools, "task.wait");
      const output = findTool(runtimeTools, "task.output");
      const runtimeTask = await runtimeStore.createRuntimeTask({
        listId: DEFAULT_TASK_LIST_ID,
        kind: "subagent",
        subject: "Implement phase",
        description: "Finish the delegated phase",
        summary: "Delegated worker started.",
      });

      await runtimeStore.finalizeRuntimeTask({
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

    it("persists session task lists to a dedicated file-backed store", async () => {
      const persistenceRootDir = mkdtempSync(join(tmpdir(), "agenc-session-tasks-"));
      try {
        const persistedStore = new SessionTaskStore({
          persistenceRootDir,
          now: (() => {
            let now = 2_000;
            return () => now++;
          })(),
        });
        const persistedTools = createTaskTrackerTools(persistedStore);
        const persistedCreate = findTool(persistedTools, "task.create");
        await callTool(persistedCreate, {
          [TASK_LIST_ARG]: "session-persisted",
          subject: "Ship shell",
          description: "Finish the shell milestone",
        });

        const reloadedStore = new SessionTaskStore({ persistenceRootDir });
        const tasks = await reloadedStore.listTasks("session-persisted");
        expect(tasks).toEqual([
          expect.objectContaining({
            id: "1",
            subject: "Ship shell",
            description: "Finish the shell milestone",
          }),
        ]);
      } finally {
        rmSync(persistenceRootDir, { recursive: true, force: true });
      }
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
      const tracedTools = [
        ...createTaskTrackerTools(tracedStore),
        ...createRuntimeTaskHandleTools(tracedStore, {
          onTaskAccessEvent: async (event) => {
            accessEvents.push({
              type: event.type,
              taskId: event.taskId,
              ready: event.ready,
              until: event.until,
            });
          },
        }),
      ];
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

  describe("listOpenTasksForSession", () => {
    it("returns only pending and in_progress tasks", async () => {
      const store = new SessionTaskStore();
      const sessionId = "session-open-tasks";
      await store.createTask(sessionId, {
        subject: "pending one",
        description: "",
      });
      const inProgress = await store.createTask(sessionId, {
        subject: "in progress",
        description: "",
      });
      await store.updateTask(sessionId, inProgress.id, {
        status: "in_progress",
      });
      const completed = await store.createTask(sessionId, {
        subject: "already done",
        description: "",
      });
      await store.updateTask(sessionId, completed.id, { status: "completed" });
      const deleted = await store.createTask(sessionId, {
        subject: "removed",
        description: "",
      });
      await store.updateTask(sessionId, deleted.id, { status: "deleted" });

      const open = await listOpenTasksForSession(store, sessionId);
      expect(open).toHaveLength(2);
      expect(open.map((task) => task.status).sort()).toEqual([
        "in_progress",
        "pending",
      ]);
      expect(open.map((task) => task.subject).sort()).toEqual([
        "in progress",
        "pending one",
      ]);
    });

    it("respects the limit parameter", async () => {
      const store = new SessionTaskStore();
      const sessionId = "session-limit";
      for (let i = 0; i < 5; i += 1) {
        await store.createTask(sessionId, {
          subject: `task ${i}`,
          description: "",
        });
      }
      const open = await listOpenTasksForSession(store, sessionId, 3);
      expect(open).toHaveLength(3);
    });

    it("returns an empty array when the session has no tasks", async () => {
      const store = new SessionTaskStore();
      const open = await listOpenTasksForSession(store, "session-empty");
      expect(open).toEqual([]);
    });

    it("returns OpenTaskSummary shape (id, status, subject only)", async () => {
      const store = new SessionTaskStore();
      const sessionId = "session-shape";
      await store.createTask(sessionId, {
        subject: "subject only",
        description: "full description",
        activeForm: "working on it",
      });
      const [task] = await listOpenTasksForSession(store, sessionId);
      expect(task).toBeDefined();
      expect(Object.keys(task!).sort()).toEqual(["id", "status", "subject"]);
    });
  });

  describe("isOpenTaskStatus", () => {
    it("treats pending and in_progress as open", () => {
      expect(isOpenTaskStatus("pending")).toBe(true);
      expect(isOpenTaskStatus("in_progress")).toBe(true);
    });

    it("treats terminal statuses as closed", () => {
      expect(isOpenTaskStatus("completed")).toBe(false);
      expect(isOpenTaskStatus("deleted")).toBe(false);
    });
  });
});
