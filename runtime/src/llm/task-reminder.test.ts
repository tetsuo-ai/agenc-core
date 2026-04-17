import { describe, expect, it } from "vitest";
import type { LLMMessage } from "./types.js";
import {
  TASK_REMINDER_HEADER_PREFIX,
  TASK_REMINDER_TURNS_BETWEEN_REMINDERS,
  TASK_REMINDER_TURNS_SINCE_UPDATE,
  buildTaskReminderMessage,
  getTurnsSinceLastTaskReminder,
  getTurnsSinceTaskManagement,
  shouldInjectTaskReminder,
  type ReminderTaskView,
} from "./task-reminder.js";

function assistantText(content: string): LLMMessage {
  return { role: "assistant", content };
}

function userText(content: string): LLMMessage {
  return { role: "user", content };
}

function assistantToolCall(toolName: string): LLMMessage {
  return {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: `call-${toolName}`, name: toolName, arguments: "{}" },
    ],
  };
}

function buildHistoryWithAssistantTurns(n: number): LLMMessage[] {
  const history: LLMMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    history.push(userText(`user-${i}`));
    history.push(assistantText(`asst-${i}`));
  }
  return history;
}

describe("getTurnsSinceTaskManagement", () => {
  it("returns Infinity when no task management call has been made", () => {
    expect(
      getTurnsSinceTaskManagement(buildHistoryWithAssistantTurns(5)),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("counts assistant turns since the last task.create call", () => {
    const history: LLMMessage[] = [
      assistantToolCall("task.create"),
      assistantText("one"),
      assistantText("two"),
      assistantText("three"),
    ];
    expect(getTurnsSinceTaskManagement(history)).toBe(3);
  });

  it("counts assistant turns since the last task.update call", () => {
    const history: LLMMessage[] = [
      assistantToolCall("task.update"),
      assistantText("one"),
      assistantText("two"),
    ];
    expect(getTurnsSinceTaskManagement(history)).toBe(2);
  });

  it("does NOT count task.list, task.get, task.wait, or task.output", () => {
    for (const nonMgmtCall of [
      "task.list",
      "task.get",
      "task.wait",
      "task.output",
    ]) {
      const history: LLMMessage[] = [
        assistantToolCall("task.create"),
        assistantText("one"),
        assistantToolCall(nonMgmtCall),
        assistantText("two"),
      ];
      // The last mgmt call is 3 assistant turns back (turns 1,2,3 since create).
      // The task.list/get/etc turn counts as an assistant turn too but does NOT
      // reset the counter.
      expect(getTurnsSinceTaskManagement(history)).toBe(3);
    }
  });

  it("picks the most recent management call when multiple exist", () => {
    const history: LLMMessage[] = [
      assistantToolCall("task.create"),
      assistantText("a"),
      assistantText("b"),
      assistantToolCall("task.update"),
      assistantText("c"),
    ];
    expect(getTurnsSinceTaskManagement(history)).toBe(1);
  });
});

describe("getTurnsSinceLastTaskReminder", () => {
  it("returns Infinity when no reminder has been injected", () => {
    expect(
      getTurnsSinceLastTaskReminder(buildHistoryWithAssistantTurns(5)),
    ).toBe(Number.POSITIVE_INFINITY);
  });

  it("detects a prior reminder via the header prefix", () => {
    const reminder = `<system-reminder>\n${TASK_REMINDER_HEADER_PREFIX} filler\n</system-reminder>`;
    const history: LLMMessage[] = [
      userText("something else"),
      { role: "user", content: reminder },
      assistantText("a"),
      assistantText("b"),
    ];
    expect(getTurnsSinceLastTaskReminder(history)).toBe(2);
  });
});

describe("shouldInjectTaskReminder", () => {
  const tools = new Set<string>(["task.update", "task.create"]);

  it("returns false when task.update is not in activeToolNames", () => {
    expect(
      shouldInjectTaskReminder({
        history: buildHistoryWithAssistantTurns(20),
        activeToolNames: new Set(["task.create"]),
      }),
    ).toBe(false);
  });

  it("returns true when both thresholds are met", () => {
    const history = buildHistoryWithAssistantTurns(
      TASK_REMINDER_TURNS_SINCE_UPDATE,
    );
    expect(
      shouldInjectTaskReminder({ history, activeToolNames: tools }),
    ).toBe(true);
  });

  it("suppresses when task.update was called within the last 10 turns", () => {
    const history: LLMMessage[] = [
      assistantToolCall("task.update"),
      ...Array.from({ length: 9 }, (_, i) => assistantText(`x${i}`)),
    ];
    expect(
      shouldInjectTaskReminder({ history, activeToolNames: tools }),
    ).toBe(false);
  });

  it("fires once task.update is past the 10-turn window", () => {
    const history: LLMMessage[] = [
      assistantToolCall("task.update"),
      ...Array.from(
        { length: TASK_REMINDER_TURNS_SINCE_UPDATE },
        (_, i) => assistantText(`x${i}`),
      ),
    ];
    expect(
      shouldInjectTaskReminder({ history, activeToolNames: tools }),
    ).toBe(true);
  });

  it("suppresses when a reminder was injected within the last 10 turns", () => {
    const reminder = `<system-reminder>\n${TASK_REMINDER_HEADER_PREFIX}\n</system-reminder>`;
    const history: LLMMessage[] = [
      ...buildHistoryWithAssistantTurns(20),
      { role: "user", content: reminder },
      ...Array.from(
        { length: TASK_REMINDER_TURNS_BETWEEN_REMINDERS - 1 },
        (_, i) => assistantText(`x${i}`),
      ),
    ];
    expect(
      shouldInjectTaskReminder({ history, activeToolNames: tools }),
    ).toBe(false);
  });
});

describe("buildTaskReminderMessage", () => {
  const makeTask = (
    id: string,
    subject: string,
    status: string,
  ): ReminderTaskView => ({ id, subject, status });

  it("wraps the message in system-reminder tags", () => {
    const msg = buildTaskReminderMessage([]);
    expect(typeof msg.content).toBe("string");
    const content = msg.content as string;
    expect(content.startsWith("<system-reminder>\n")).toBe(true);
    expect(content.endsWith("\n</system-reminder>")).toBe(true);
  });

  it("includes the verbatim upstream header", () => {
    const msg = buildTaskReminderMessage([]);
    const content = msg.content as string;
    expect(content).toContain("The task tools haven't been used recently.");
    expect(content).toContain("task.create");
    expect(content).toContain("task.update");
    expect(content).toContain("NEVER mention this reminder");
  });

  it("emits user role with runtime-only user_context merge boundary", () => {
    const msg = buildTaskReminderMessage([]);
    expect(msg.role).toBe("user");
    expect(msg.runtimeOnly?.mergeBoundary).toBe("user_context");
  });

  it("appends the task list when tasks exist", () => {
    const msg = buildTaskReminderMessage([
      makeTask("abc-1", "Fix auth bug", "pending"),
      makeTask("abc-2", "Ship release", "in_progress"),
    ]);
    const content = msg.content as string;
    expect(content).toContain("Here are the existing tasks:");
    expect(content).toContain("#abc-1. [pending] Fix auth bug");
    expect(content).toContain("#abc-2. [in_progress] Ship release");
  });

  it("omits the task list section when empty", () => {
    const msg = buildTaskReminderMessage([]);
    expect(msg.content as string).not.toContain("Here are the existing tasks");
  });
});
