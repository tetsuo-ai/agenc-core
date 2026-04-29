import { describe, expect, it } from "vitest";
import { InMemoryBackend } from "../../memory/in-memory/backend.js";
import { TodoStore, type TodoItem } from "./todo-store.js";

function makeTodo(
  overrides: Partial<TodoItem> & { content: string },
): TodoItem {
  return {
    status: "pending",
    activeForm: `Working on ${overrides.content}`,
    ...overrides,
  };
}

describe("TodoStore", () => {
  it("returns an empty list for an unknown session", async () => {
    const store = new TodoStore();
    const todos = await store.getTodos("session-a");
    expect(todos).toEqual([]);
  });

  it("replaces the whole list on setTodos", async () => {
    const store = new TodoStore();
    const first: TodoItem[] = [
      makeTodo({ content: "first" }),
      makeTodo({ content: "second" }),
    ];
    const firstResult = await store.setTodos("session-a", first);
    expect(firstResult.oldTodos).toEqual([]);
    expect(firstResult.newTodos).toEqual(first);

    const second: TodoItem[] = [
      makeTodo({ content: "only", status: "in_progress" }),
    ];
    const secondResult = await store.setTodos("session-a", second);
    expect(secondResult.oldTodos).toEqual(first);
    expect(secondResult.newTodos).toEqual(second);
  });

  it("clears the list when every item is marked completed", async () => {
    const store = new TodoStore();
    await store.setTodos("session-a", [
      makeTodo({ content: "one", status: "in_progress" }),
      makeTodo({ content: "two" }),
    ]);
    const result = await store.setTodos("session-a", [
      makeTodo({ content: "one", status: "completed" }),
      makeTodo({ content: "two", status: "completed" }),
    ]);
    expect(result.newTodos).toEqual([]);
    expect(await store.getTodos("session-a")).toEqual([]);
  });

  it("keeps an all-completed list intact only when it is empty", async () => {
    const store = new TodoStore();
    const result = await store.setTodos("session-a", []);
    expect(result.newTodos).toEqual([]);
  });

  it("isolates todos per session", async () => {
    const store = new TodoStore();
    await store.setTodos("session-a", [makeTodo({ content: "a-only" })]);
    await store.setTodos("session-b", [makeTodo({ content: "b-only" })]);
    expect((await store.getTodos("session-a"))[0]?.content).toBe("a-only");
    expect((await store.getTodos("session-b"))[0]?.content).toBe("b-only");
  });

  it("round-trips through a memory backend", async () => {
    const backend = new InMemoryBackend();
    const first = new TodoStore({ memoryBackend: backend });
    await first.setTodos("session-a", [
      makeTodo({ content: "persist me", status: "in_progress" }),
    ]);
    const second = new TodoStore({ memoryBackend: backend });
    const reloaded = await second.getTodos("session-a");
    expect(reloaded).toEqual([
      makeTodo({ content: "persist me", status: "in_progress" }),
    ]);
  });

  it("deletes the backend entry when clearing", async () => {
    const backend = new InMemoryBackend();
    const store = new TodoStore({ memoryBackend: backend });
    await store.setTodos("session-a", [makeTodo({ content: "gone soon" })]);
    await store.clearTodos("session-a");
    expect(await backend.get("todo:list:session-a")).toBeUndefined();
    expect(await store.getTodos("session-a")).toEqual([]);
  });

  it("discards malformed persisted entries on load", async () => {
    const backend = new InMemoryBackend();
    await backend.set("todo:list:session-a", [
      { content: "valid", status: "pending", activeForm: "Working on valid" },
      { content: "bad-status", status: "blocked", activeForm: "Ignored" },
      { content: 42, status: "pending", activeForm: "Ignored" },
      null,
    ]);
    const store = new TodoStore({ memoryBackend: backend });
    expect(await store.getTodos("session-a")).toEqual([
      makeTodo({ content: "valid" }),
    ]);
  });
});
