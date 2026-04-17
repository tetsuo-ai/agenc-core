import { describe, expect, it } from "vitest";
import { TodoStore, type TodoItem } from "./todo-store.js";
import {
  TODO_WRITE_SESSION_ARG,
  TODO_WRITE_TOOL_NAME,
  createTodoWriteTool,
} from "./todo-write.js";

const VERBATIM_SUCCESS_TEXT =
  "Todos have been modified successfully. Ensure that you continue to " +
  "use the todo list to track your progress. Please proceed with the " +
  "current tasks if applicable";

function parseResult(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

function makeTodo(content: string, overrides: Partial<TodoItem> = {}): TodoItem {
  return {
    content,
    status: "pending",
    activeForm: `Working on ${content}`,
    ...overrides,
  };
}

describe("TodoWrite tool", () => {
  it("exposes the expected name and schema", () => {
    const tool = createTodoWriteTool(new TodoStore());
    expect(tool.name).toBe(TODO_WRITE_TOOL_NAME);
    expect(tool.description).toMatch(/## When to Use This Tool/);
    expect(tool.description).toMatch(/Task Completion Requirements/);
    expect(tool.description).toMatch(/Never mark a task as completed if/);
    const schema = tool.inputSchema as {
      required?: readonly string[];
      additionalProperties?: boolean;
    };
    expect(schema.required).toEqual(["todos"]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("returns the verbatim upstream success text on a valid write", async () => {
    const tool = createTodoWriteTool(new TodoStore());
    const result = await tool.execute({
      [TODO_WRITE_SESSION_ARG]: "session-a",
      todos: [makeTodo("first")],
    });
    expect(result.isError).toBeUndefined();
    const payload = parseResult(result.content);
    expect(payload.message).toBe(VERBATIM_SUCCESS_TEXT);
    expect(payload.oldTodos).toEqual([]);
    expect(payload.newTodos).toEqual([makeTodo("first")]);
  });

  it("replaces the full list atomically on subsequent writes", async () => {
    const store = new TodoStore();
    const tool = createTodoWriteTool(store);
    await tool.execute({
      [TODO_WRITE_SESSION_ARG]: "session-a",
      todos: [makeTodo("one"), makeTodo("two")],
    });
    const result = await tool.execute({
      [TODO_WRITE_SESSION_ARG]: "session-a",
      todos: [makeTodo("only", { status: "in_progress" })],
    });
    const payload = parseResult(result.content);
    expect(payload.newTodos).toEqual([
      makeTodo("only", { status: "in_progress" }),
    ]);
  });

  it("clears the list when every item is completed", async () => {
    const store = new TodoStore();
    const tool = createTodoWriteTool(store);
    await tool.execute({
      [TODO_WRITE_SESSION_ARG]: "session-a",
      todos: [
        makeTodo("one", { status: "in_progress" }),
        makeTodo("two"),
      ],
    });
    const result = await tool.execute({
      [TODO_WRITE_SESSION_ARG]: "session-a",
      todos: [
        makeTodo("one", { status: "completed" }),
        makeTodo("two", { status: "completed" }),
      ],
    });
    const payload = parseResult(result.content);
    expect(payload.newTodos).toEqual([]);
  });

  it("rejects an invalid status", async () => {
    const tool = createTodoWriteTool(new TodoStore());
    const result = await tool.execute({
      [TODO_WRITE_SESSION_ARG]: "session-a",
      todos: [{ content: "bad", status: "blocked", activeForm: "Ignored" }],
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result.content).error).toMatch(/status must be one of/);
  });

  it("rejects extra keys on a todo item", async () => {
    const tool = createTodoWriteTool(new TodoStore());
    const result = await tool.execute({
      [TODO_WRITE_SESSION_ARG]: "session-a",
      todos: [
        {
          content: "ok",
          status: "pending",
          activeForm: "Working on ok",
          priority: "high",
        },
      ],
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result.content).error).toMatch(/unexpected key/);
  });

  it("rejects a missing session context", async () => {
    const tool = createTodoWriteTool(new TodoStore());
    const result = await tool.execute({
      todos: [makeTodo("solo")],
    });
    expect(result.isError).toBe(true);
    expect(parseResult(result.content).error).toMatch(/requires a session scope/);
  });

  it("accepts an empty list (matches upstream allow-empty semantic)", async () => {
    const tool = createTodoWriteTool(new TodoStore());
    const result = await tool.execute({
      [TODO_WRITE_SESSION_ARG]: "session-a",
      todos: [],
    });
    expect(result.isError).toBeUndefined();
    const payload = parseResult(result.content);
    expect(payload.newTodos).toEqual([]);
  });

  describe("verification nudge", () => {
    const NUDGE_ANCHOR = "spawn the verifier with execute_with_agent";

    it("appends the nudge when 3+ completed todos have no verif item", async () => {
      const tool = createTodoWriteTool(new TodoStore());
      const result = await tool.execute({
        [TODO_WRITE_SESSION_ARG]: "session-a",
        todos: [
          makeTodo("build the lexer", { status: "completed" }),
          makeTodo("build the parser", { status: "completed" }),
          makeTodo("wire the executor", { status: "completed" }),
        ],
      });
      const payload = parseResult(result.content);
      expect(String(payload.message)).toContain(NUDGE_ANCHOR);
      expect(String(payload.message)).toContain(
        "only the verifier issues a verdict",
      );
    });

    it("omits the nudge when a todo content mentions verification", async () => {
      const tool = createTodoWriteTool(new TodoStore());
      const result = await tool.execute({
        [TODO_WRITE_SESSION_ARG]: "session-a",
        todos: [
          makeTodo("build the lexer", { status: "completed" }),
          makeTodo("build the parser", { status: "completed" }),
          makeTodo("run end-to-end verification smoke", {
            status: "completed",
          }),
        ],
      });
      const payload = parseResult(result.content);
      expect(String(payload.message)).not.toContain(NUDGE_ANCHOR);
    });

    it("omits the nudge when fewer than 3 todos closed", async () => {
      const tool = createTodoWriteTool(new TodoStore());
      const result = await tool.execute({
        [TODO_WRITE_SESSION_ARG]: "session-a",
        todos: [
          makeTodo("a", { status: "completed" }),
          makeTodo("b", { status: "completed" }),
        ],
      });
      const payload = parseResult(result.content);
      expect(String(payload.message)).not.toContain(NUDGE_ANCHOR);
    });

    it("omits the nudge when any item is still pending or in_progress", async () => {
      const tool = createTodoWriteTool(new TodoStore());
      const result = await tool.execute({
        [TODO_WRITE_SESSION_ARG]: "session-a",
        todos: [
          makeTodo("a", { status: "completed" }),
          makeTodo("b", { status: "completed" }),
          makeTodo("c", { status: "pending" }),
        ],
      });
      const payload = parseResult(result.content);
      expect(String(payload.message)).not.toContain(NUDGE_ANCHOR);
    });
  });
});
