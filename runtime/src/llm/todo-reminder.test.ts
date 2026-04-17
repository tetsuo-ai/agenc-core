import { describe, expect, it } from "vitest";
import type { LLMMessage } from "./types.js";
import type { TodoItem } from "../tools/system/todo-store.js";
import { TODO_WRITE_TOOL_NAME } from "../tools/system/todo-write.js";
import {
  TODO_REMINDER_HEADER_PREFIX,
  TODO_REMINDER_TURNS_BETWEEN_REMINDERS,
  TODO_REMINDER_TURNS_SINCE_WRITE,
  buildTodoReminderMessage,
  getTurnsSinceLastTodoReminder,
  getTurnsSinceRecentTaskToolUse,
  getTurnsSinceTodoWrite,
  shouldInjectTodoReminder,
} from "./todo-reminder.js";

function assistantText(content: string): LLMMessage {
  return { role: "assistant", content };
}

function userText(content: string): LLMMessage {
  return { role: "user", content };
}

function assistantToolCall(
  toolName: string,
  overrides: Partial<LLMMessage> = {},
): LLMMessage {
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
    ...overrides,
  };
}

function toolResult(toolCallId: string, output: string): LLMMessage {
  return { role: "tool", content: output, toolCallId };
}

function buildHistoryWithAssistantTurns(count: number): LLMMessage[] {
  const out: LLMMessage[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(userText(`user turn ${index + 1}`));
    out.push(assistantText(`assistant turn ${index + 1}`));
  }
  return out;
}

const DEFAULT_ACTIVE_TOOLS = new Set<string>([TODO_WRITE_TOOL_NAME]);

const TODOS_SAMPLE: TodoItem[] = [
  { content: "first", status: "pending", activeForm: "Working on first" },
  {
    content: "second",
    status: "in_progress",
    activeForm: "Working on second",
  },
];

describe("getTurnsSinceTodoWrite", () => {
  it("returns Infinity when no history contains a TodoWrite call", () => {
    expect(getTurnsSinceTodoWrite([])).toBe(Number.POSITIVE_INFINITY);
    expect(
      getTurnsSinceTodoWrite(buildHistoryWithAssistantTurns(5)),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns 0 when the most recent assistant turn called TodoWrite", () => {
    const history: LLMMessage[] = [
      userText("go"),
      assistantToolCall(TODO_WRITE_TOOL_NAME),
      toolResult("call-TodoWrite", "{}"),
    ];
    expect(getTurnsSinceTodoWrite(history)).toBe(0);
  });

  it("counts only assistant turns that intervene after the last call", () => {
    const history: LLMMessage[] = [
      userText("go"),
      assistantToolCall(TODO_WRITE_TOOL_NAME),
      toolResult("call-TodoWrite", "{}"),
      userText("next"),
      assistantText("replied"),
      userText("next"),
      assistantText("replied"),
      userText("next"),
      assistantText("replied"),
    ];
    expect(getTurnsSinceTodoWrite(history)).toBe(3);
  });
});

describe("getTurnsSinceLastTodoReminder", () => {
  it("returns Infinity when no reminder has been emitted", () => {
    expect(
      getTurnsSinceLastTodoReminder(buildHistoryWithAssistantTurns(5)),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("finds a reminder by its stable header prefix", () => {
    const reminder = buildTodoReminderMessage(TODOS_SAMPLE);
    const history: LLMMessage[] = [
      userText("go"),
      assistantText("ack"),
      reminder,
      assistantText("adjusted"),
      userText("next"),
      assistantText("replied"),
    ];
    expect(getTurnsSinceLastTodoReminder(history)).toBe(2);
  });

  it("uses only the header-prefix sentinel, not arbitrary content", () => {
    expect(TODO_REMINDER_HEADER_PREFIX).toBe(
      "The TodoWrite tool hasn't been used recently.",
    );
  });
});

describe("getTurnsSinceRecentTaskToolUse", () => {
  it("returns Infinity when no task.* tool has been called", () => {
    expect(
      getTurnsSinceRecentTaskToolUse(buildHistoryWithAssistantTurns(3)),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("detects task.create and task.update calls", () => {
    const history: LLMMessage[] = [
      userText("go"),
      assistantToolCall("task.create"),
      toolResult("call-task.create", "{}"),
      userText("next"),
      assistantText("replied"),
    ];
    expect(getTurnsSinceRecentTaskToolUse(history)).toBe(1);
  });
});

describe("shouldInjectTodoReminder", () => {
  it("returns false when TodoWrite is not in the active toolset", () => {
    const history = buildHistoryWithAssistantTurns(
      TODO_REMINDER_TURNS_SINCE_WRITE + 2,
    );
    expect(
      shouldInjectTodoReminder({
        history,
        activeToolNames: new Set<string>(),
      }),
    ).toBe(false);
  });

  it("returns false when turnsSinceTodoWrite is below the threshold", () => {
    const history: LLMMessage[] = [
      userText("go"),
      assistantToolCall(TODO_WRITE_TOOL_NAME),
      toolResult("call-TodoWrite", "{}"),
      ...buildHistoryWithAssistantTurns(
        TODO_REMINDER_TURNS_SINCE_WRITE - 1,
      ),
    ];
    expect(
      shouldInjectTodoReminder({
        history,
        activeToolNames: DEFAULT_ACTIVE_TOOLS,
      }),
    ).toBe(false);
  });

  it("returns true when both thresholds are met and no task.* recently used", () => {
    const history = buildHistoryWithAssistantTurns(
      TODO_REMINDER_TURNS_SINCE_WRITE + 1,
    );
    expect(
      shouldInjectTodoReminder({
        history,
        activeToolNames: DEFAULT_ACTIVE_TOOLS,
      }),
    ).toBe(true);
  });

  it("suppresses when task.* was used within the last 10 assistant turns", () => {
    const history: LLMMessage[] = [
      userText("go"),
      assistantToolCall("task.create"),
      toolResult("call-task.create", "{}"),
      ...buildHistoryWithAssistantTurns(5),
    ];
    expect(
      shouldInjectTodoReminder({
        history,
        activeToolNames: DEFAULT_ACTIVE_TOOLS,
      }),
    ).toBe(false);
  });

  it("stops suppressing once task.* is past the 10-turn window", () => {
    const history: LLMMessage[] = [
      userText("go"),
      assistantToolCall("task.create"),
      toolResult("call-task.create", "{}"),
      ...buildHistoryWithAssistantTurns(
        TODO_REMINDER_TURNS_SINCE_WRITE + 1,
      ),
    ];
    expect(
      shouldInjectTodoReminder({
        history,
        activeToolNames: DEFAULT_ACTIVE_TOOLS,
      }),
    ).toBe(true);
  });

  it("returns false when another reminder was emitted within the window", () => {
    const reminder = buildTodoReminderMessage(TODOS_SAMPLE);
    const historyWithPriorReminder: LLMMessage[] = [
      reminder,
      ...buildHistoryWithAssistantTurns(
        TODO_REMINDER_TURNS_BETWEEN_REMINDERS - 2,
      ),
    ];
    expect(
      shouldInjectTodoReminder({
        history: historyWithPriorReminder,
        activeToolNames: DEFAULT_ACTIVE_TOOLS,
      }),
    ).toBe(false);
  });
});

describe("buildTodoReminderMessage", () => {
  it("emits the verbatim upstream header wrapped in <system-reminder> tags", () => {
    const message = buildTodoReminderMessage([]);
    expect(message.role).toBe("user");
    expect(typeof message.content).toBe("string");
    const content = message.content as string;
    expect(content.startsWith("<system-reminder>\n")).toBe(true);
    expect(content.endsWith("\n</system-reminder>")).toBe(true);
    expect(content).toContain(
      "The TodoWrite tool hasn't been used recently. If you're working " +
        "on tasks that would benefit from tracking progress",
    );
    expect(content).toContain(
      "NEVER mention this reminder to the user",
    );
  });

  it("renders the todo list joined by newlines inside square brackets", () => {
    const message = buildTodoReminderMessage(TODOS_SAMPLE);
    const content = message.content as string;
    expect(content).toContain(
      "Here are the existing contents of your todo list:\n\n[1. [pending] first\n2. [in_progress] second]",
    );
  });

  it("omits the list section entirely when there are no todos", () => {
    const message = buildTodoReminderMessage([]);
    const content = message.content as string;
    expect(content).not.toContain("Here are the existing contents");
  });

  it("marks the runtime-only merge boundary so downstream surfaces filter it", () => {
    const message = buildTodoReminderMessage([]);
    expect(message.runtimeOnly?.mergeBoundary).toBe("user_context");
  });
});
