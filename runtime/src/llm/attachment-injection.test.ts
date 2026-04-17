import { describe, expect, it } from "vitest";
import type { LLMMessage } from "./types.js";
import type { TodoItem } from "../tools/system/todo-store.js";
import { TODO_WRITE_TOOL_NAME } from "../tools/system/todo-write.js";
import { collectAttachments } from "./attachment-injection.js";
import { TODO_REMINDER_TURNS_SINCE_WRITE } from "./todo-reminder.js";

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

describe("collectAttachments", () => {
  it("returns an empty message list when TodoWrite is not in the active toolset", () => {
    const result = collectAttachments({
      history: [],
      activeToolNames: new Set<string>(),
      todos: [],
    });
    expect(result.messages).toEqual([]);
  });

  it("fires the reminder on empty history when TodoWrite is available (matches upstream)", () => {
    // With no history: turnsSinceTodoWrite = Infinity,
    // turnsSinceLastReminder = Infinity, turnsSinceRecentTaskToolUse
    // = Infinity. All suppression checks pass. Upstream behaves the
    // same: the reminder exists to nudge the model toward using the
    // tool at all, not only to surface a stale list.
    const result = collectAttachments({
      history: [],
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME]),
      todos: [],
    });
    expect(result.messages).toHaveLength(1);
  });

  it("returns the TodoWrite reminder when its trigger conditions hold", () => {
    const result = collectAttachments({
      history: buildStaleHistory(),
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME]),
      todos: SAMPLE_TODOS,
    });
    expect(result.messages).toHaveLength(1);
    const message = result.messages[0]!;
    expect(message.role).toBe("user");
    expect(typeof message.content).toBe("string");
    expect(message.content as string).toContain(
      "The TodoWrite tool hasn't been used recently",
    );
  });

  it("suppresses the reminder when TodoWrite is not in the active toolset", () => {
    const result = collectAttachments({
      history: buildStaleHistory(),
      activeToolNames: new Set<string>(),
      todos: SAMPLE_TODOS,
    });
    expect(result.messages).toEqual([]);
  });

  it("suppresses the reminder when task.* was used recently", () => {
    const history: LLMMessage[] = [
      userText("go"),
      assistantToolCall("task.create"),
      assistantText("a1"),
    ];
    const result = collectAttachments({
      history,
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME]),
      todos: SAMPLE_TODOS,
    });
    expect(result.messages).toEqual([]);
  });

  it("returns the same result for identical inputs regardless of caller", () => {
    // This property is what lets both webchat and background paths
    // share the hook without drifting.
    const ctx = {
      history: buildStaleHistory(),
      activeToolNames: new Set([TODO_WRITE_TOOL_NAME]),
      todos: SAMPLE_TODOS,
    };
    const first = collectAttachments(ctx);
    const second = collectAttachments(ctx);
    expect(first.messages).toEqual(second.messages);
  });
});
