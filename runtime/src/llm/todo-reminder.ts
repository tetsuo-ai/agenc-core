/**
 * 10-turn reminder for the `TodoWrite` tool.
 *
 * Purpose: when the model has not called `TodoWrite` in a while, inject
 * a user-role `<system-reminder>` listing the current todo list with
 * passive wording that nudges the model toward using the tool without
 * commanding it. Mirrors the upstream reference runtime's todo reminder
 * at `utils/attachments.ts:3266-3317` + `utils/messages.ts:3660-3679`.
 *
 * Counter model is scan-derived from the current history — no persisted
 * fields anywhere. Two counters:
 *
 *   - `turnsSinceTodoWrite` — assistant turns since the most recent
 *     assistant message whose `toolCalls` includes a `TodoWrite`
 *     invocation. `Infinity` if never called in the visible history.
 *
 *   - `turnsSinceLastTodoReminder` — assistant turns since the most
 *     recent user-role message whose content begins with the reminder
 *     header sentinel. `Infinity` if never emitted.
 *
 * Trigger: both counters must be `>= 10`.
 *
 * Suppression, in order:
 *   - `TodoWrite` not in the active toolset — the model can't act on
 *     the reminder anyway. Matches upstream's tool-availability gate.
 *   - `task.*` tool call in the last 10 assistant turns — the model is
 *     using the richer sub-agent orchestration surface; nagging it
 *     toward TodoWrite would be incoherent. AgenC-specific (upstream
 *     has no `task.*` family).
 *
 * The emitted message content is the verbatim upstream header text
 * (trailing newline included), followed by the current list rendered
 * with newline separators inside square brackets, wrapped in literal
 * `<system-reminder>` / `</system-reminder>` tags at the wire level.
 * Those tags are what the model sees in its context — they are the
 * model contract, not a UI artifact.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";
import { TODO_WRITE_TOOL_NAME } from "../tools/system/todo-write.js";
import type { TodoItem } from "../tools/system/todo-store.js";

export const TODO_REMINDER_TURNS_SINCE_WRITE = 10;
export const TODO_REMINDER_TURNS_BETWEEN_REMINDERS = 10;

/**
 * First-sentence anchor used to detect a previously-emitted reminder in
 * history. Kept stable across minor tweaks so scan-derived
 * `turnsSinceLastTodoReminder` remains accurate.
 */
export const TODO_REMINDER_HEADER_PREFIX =
  "The TodoWrite tool hasn't been used recently.";

const TODO_REMINDER_HEADER =
  "The TodoWrite tool hasn't been used recently. If you're working " +
  "on tasks that would benefit from tracking progress, consider using " +
  "the TodoWrite tool to track progress. Also consider cleaning up the " +
  "todo list if has become stale and no longer matches what you are " +
  "working on. Only use it if it's relevant to the current work. This " +
  "is just a gentle reminder - ignore if not applicable. Make sure " +
  "that you NEVER mention this reminder to the user";

function stringContent(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  // Concatenate text parts only; image parts are irrelevant for scans.
  return message.content
    .map((part) => {
      if (part.type === "text") return part.text;
      return "";
    })
    .join("");
}

function countAssistantTurnsBetween(
  history: readonly LLMMessage[],
  startExclusive: number,
  endExclusive: number,
): number {
  let count = 0;
  for (let index = startExclusive + 1; index < endExclusive; index += 1) {
    if (history[index]?.role === "assistant") count += 1;
  }
  return count;
}

export function getTurnsSinceTodoWrite(
  history: readonly LLMMessage[],
): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== "assistant") continue;
    const hadTodoWrite = (message.toolCalls ?? []).some(
      (call) => call.name === TODO_WRITE_TOOL_NAME,
    );
    if (hadTodoWrite) {
      return countAssistantTurnsBetween(history, index, history.length);
    }
  }
  return Number.POSITIVE_INFINITY;
}

export function getTurnsSinceLastTodoReminder(
  history: readonly LLMMessage[],
): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== "user") continue;
    const content = stringContent(message);
    if (content.includes(TODO_REMINDER_HEADER_PREFIX)) {
      return countAssistantTurnsBetween(history, index, history.length);
    }
  }
  return Number.POSITIVE_INFINITY;
}

export function getTurnsSinceRecentTaskToolUse(
  history: readonly LLMMessage[],
): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== "assistant") continue;
    const hadTaskCall = (message.toolCalls ?? []).some((call) =>
      call.name.startsWith("task."),
    );
    if (hadTaskCall) {
      return countAssistantTurnsBetween(history, index, history.length);
    }
  }
  return Number.POSITIVE_INFINITY;
}

export interface ShouldInjectTodoReminderParams {
  readonly history: readonly LLMMessage[];
  readonly activeToolNames: ReadonlySet<string>;
}

export function shouldInjectTodoReminder(
  params: ShouldInjectTodoReminderParams,
): boolean {
  if (!params.activeToolNames.has(TODO_WRITE_TOOL_NAME)) return false;
  const turnsSinceTaskUse = getTurnsSinceRecentTaskToolUse(params.history);
  if (turnsSinceTaskUse < TODO_REMINDER_TURNS_SINCE_WRITE) return false;
  const turnsSinceWrite = getTurnsSinceTodoWrite(params.history);
  if (turnsSinceWrite < TODO_REMINDER_TURNS_SINCE_WRITE) return false;
  const turnsSinceReminder = getTurnsSinceLastTodoReminder(params.history);
  if (turnsSinceReminder < TODO_REMINDER_TURNS_BETWEEN_REMINDERS) return false;
  return true;
}

export function buildTodoReminderMessage(
  todos: readonly TodoItem[],
): LLMMessage {
  const list = todos.length === 0
    ? ""
    : "\n\nHere are the existing contents of your todo list:\n\n[" +
      todos
        .map((todo, index) =>
          `${index + 1}. [${todo.status}] ${todo.content}`,
        )
        .join("\n") +
      "]";
  return {
    role: "user",
    content: `<system-reminder>\n${TODO_REMINDER_HEADER}${list}\n</system-reminder>`,
    runtimeOnly: { mergeBoundary: "user_context" },
  };
}
