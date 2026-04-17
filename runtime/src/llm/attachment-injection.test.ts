import { describe, expect, it } from "vitest";
import type { LLMMessage } from "./types.js";
import type { TodoItem } from "../tools/system/todo-store.js";
import { TODO_WRITE_TOOL_NAME } from "../tools/system/todo-write.js";
import { collectAttachments } from "./attachment-injection.js";
import { TODO_REMINDER_TURNS_SINCE_WRITE } from "./todo-reminder.js";
import type { ReminderTaskView } from "./task-reminder.js";

function userText(content: string): LLMMessage {
  return { role: "user", content };
}

function assistantText(content: string): LLMMessage {
  return { role: "assistant", content };
}

function assistantToolCall(toolName: string): LLMMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      {
        id: `call-${toolName}`,
        name: toolName,
        arguments: "{}",
      },
    ],
  };
}

function buildStaleHistory(): LLMMessage[] {
  const history: LLMMessage[] = [];
  for (let index = 0; index < TODO_REMINDER_TURNS_SINCE_WRITE + 1; index += 1) {
    history.push(userText(`u${index}`));
    history.push(assistantText(`a${index}`));
  }
  return history;
}

const SAMPLE_TODOS: TodoItem[] = [
  { content: "one", status: "pending", activeForm: "Working on one" },
];

const SAMPLE_TASKS: ReminderTaskView[] = [
  { id: "t-1", subject: "Example task", status: "pending" },
];

describe("collectAttachments", () => {
  it("returns an empty message list when TodoWrite is not in the active toolset", () => {
    const result = collectAttachments({
      history: [],
      activeToolNames: new Set<string>(),
      todos: [],
      tasks: [],
    });
    expect(result.messages).toEqual([]);
  });

  it("fires the reminder on empty history when TodoWrite is available (matches upstream)", () => {
    const result = collectAttachments({
      history: [],
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME]),
      todos: [],
      tasks: [],
    });
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(
      (result.messages[0]!.content as string).includes("TodoWrite tool"),
    ).toBe(true);
  });

  it("returns the TodoWrite reminder when its trigger conditions hold", () => {
    const result = collectAttachments({
      history: buildStaleHistory(),
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME]),
      todos: SAMPLE_TODOS,
      tasks: [],
    });
    const todoMsg = result.messages.find((m) =>
      (m.content as string).includes("The TodoWrite tool hasn't been used"),
    );
    expect(todoMsg).toBeDefined();
  });

  it("suppresses the TodoWrite reminder when TodoWrite is not in the active toolset", () => {
    const result = collectAttachments({
      history: buildStaleHistory(),
      activeToolNames: new Set<string>(),
      todos: SAMPLE_TODOS,
      tasks: [],
    });
    expect(
      result.messages.some((m) =>
        (m.content as string).includes("TodoWrite tool hasn't been used"),
      ),
    ).toBe(false);
  });

  it("does NOT suppress the TodoWrite reminder based on recent task.* use (independent sibling reminder)", () => {
    const history: LLMMessage[] = [
      userText("go"),
      assistantToolCall("task.create"),
      ...Array.from({ length: TODO_REMINDER_TURNS_SINCE_WRITE + 1 }, (_, i) =>
        assistantText(`a${i}`),
      ),
    ];
    const result = collectAttachments({
      history,
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME]),
      todos: SAMPLE_TODOS,
      tasks: [],
    });
    expect(
      result.messages.some((m) =>
        (m.content as string).includes("TodoWrite tool hasn't been used"),
      ),
    ).toBe(true);
  });

  it("emits the task_reminder when task.update is available and task.* has been stale for 10+ turns", () => {
    const result = collectAttachments({
      history: buildStaleHistory(),
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME, "task.update"]),
      todos: [],
      tasks: SAMPLE_TASKS,
    });
    const taskMsg = result.messages.find((m) =>
      (m.content as string).includes("The task tools haven't been used"),
    );
    expect(taskMsg).toBeDefined();
    expect((taskMsg!.content as string)).toContain("#t-1. [pending] Example task");
  });

  it("emits both reminders on the same turn when both triggers fire", () => {
    const result = collectAttachments({
      history: buildStaleHistory(),
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME, "task.update"]),
      todos: SAMPLE_TODOS,
      tasks: SAMPLE_TASKS,
    });
    const kinds = result.messages.map((m) => m.content as string);
    expect(
      kinds.some((c) => c.includes("TodoWrite tool hasn't been used")),
    ).toBe(true);
    expect(
      kinds.some((c) => c.includes("task tools haven't been used")),
    ).toBe(true);
  });

  it("preserves upstream priority: todo_reminder before task_reminder", () => {
    const result = collectAttachments({
      history: buildStaleHistory(),
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME, "task.update"]),
      todos: SAMPLE_TODOS,
      tasks: SAMPLE_TASKS,
    });
    const todoIdx = result.messages.findIndex((m) =>
      (m.content as string).includes("TodoWrite"),
    );
    const taskIdx = result.messages.findIndex((m) =>
      (m.content as string).includes("task tools haven't been used"),
    );
    expect(todoIdx).toBeGreaterThanOrEqual(0);
    expect(taskIdx).toBeGreaterThanOrEqual(0);
    expect(todoIdx).toBeLessThan(taskIdx);
  });

  it("returns the same result for identical inputs regardless of caller", () => {
    const ctx = {
      history: buildStaleHistory(),
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME]),
      todos: SAMPLE_TODOS,
      tasks: [],
    };
    const first = collectAttachments(ctx);
    const second = collectAttachments(ctx);
    expect(first.messages).toEqual(second.messages);
  });
});
