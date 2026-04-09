import { describe, it, expect, beforeEach } from "vitest";
import {
  createTaskTrackerTools,
  TaskStore,
  TASK_LIST_ARG,
  DEFAULT_TASK_LIST_ID,
  TASK_TRACKER_TOOL_NAMES,
} from "./task-tracker.js";
import type { Tool, ToolResult } from "../types.js";

interface ParsedResult {
  readonly raw: ToolResult;
  readonly body: Record<string, unknown>;
}

function findTool(tools: readonly Tool[], name: string): Tool {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not found: ${name}`);
  return tool;
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

  beforeEach(() => {
    let now = 1_000;
    store = new TaskStore({ now: () => now++ });
    tools = createTaskTrackerTools(store);
    create = findTool(tools, "task.create");
    list = findTool(tools, "task.list");
    get = findTool(tools, "task.get");
    update = findTool(tools, "task.update");
  });

  describe("registration metadata", () => {
    it("exposes the four task tracker tools", () => {
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual(["task.create", "task.get", "task.list", "task.update"]);
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

    it("rejects empty description", async () => {
      const result = await callTool(create, { subject: "x", description: "" });
      expect(result.raw.isError).toBe(true);
      expect(result.body.error).toMatch(/description/);
    });

    it("preserves activeForm and metadata when provided", async () => {
      await callTool(create, {
        subject: "Run the build",
        description: "npm run build",
        activeForm: "Running the build",
        metadata: { priority: "high", tags: ["ci"] },
      });
      const stored = store.list(DEFAULT_TASK_LIST_ID)[0];
      expect(stored.activeForm).toBe("Running the build");
      expect(stored.metadata).toEqual({ priority: "high", tags: ["ci"] });
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
});
