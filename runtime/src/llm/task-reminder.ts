/**
 * 10-turn reminder for the `task.*` tool family.
 *
 * Sibling of `todo-reminder.ts`. Fires independently — both reminders
 * can co-exist on the same turn. Upstream runs both without mutual
 * suppression; AgenC matches that pattern.
 *
 * Trigger: `task.update` is in the active toolset AND neither
 * `task.create` nor `task.update` has been invoked in the last 10
 * assistant turns AND no task reminder was injected in the last 10
 * assistant turns. Only management calls count — `task.list`,
 * `task.get`, `task.wait`, `task.output` do not.
 *
 * Counters are scan-derived from the current history — compaction-safe
 * and session-resume-safe. Mirror of `todo-reminder.ts`.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";

export const TASK_REMINDER_TURNS_SINCE_UPDATE = 10;
export const TASK_REMINDER_TURNS_BETWEEN_REMINDERS = 10;

export const TASK_REMINDER_HEADER_PREFIX =
  "The task tools haven't been used recently.";

const TASK_REMINDER_HEADER =
  "The task tools haven't been used recently. If you're working on " +
  "tasks that would benefit from tracking progress, consider using " +
  "task.create to add new tasks and task.update to update task status " +
  "(set to in_progress when starting, completed when done). Also " +
  "consider cleaning up the task list if it has become stale. Only " +
  "use these if relevant to the current work. This is just a gentle " +
  "reminder - ignore if not applicable. Make sure that you NEVER " +
  "mention this reminder to the user";

/**
 * Minimal structural view of a task for reminder rendering. Both
 * `Task` (TaskStore) and `SessionTask` (SessionTaskStore) are
 * structurally assignable to this — the daemon wires
 * `TaskStore.listTasks()` which returns `Task[]`, but the reminder
 * only needs id/subject/status.
 */
export interface ReminderTaskView {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
}

function stringContent(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
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

function isTaskManagementCall(name: string): boolean {
  return name === "task.create" || name === "task.update";
}

export function getTurnsSinceTaskManagement(
  history: readonly LLMMessage[],
): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== "assistant") continue;
    const hadManagement = (message.toolCalls ?? []).some((call) =>
      isTaskManagementCall(call.name),
    );
    if (hadManagement) {
      return countAssistantTurnsBetween(history, index, history.length);
    }
  }
  return Number.POSITIVE_INFINITY;
}

export function getTurnsSinceLastTaskReminder(
  history: readonly LLMMessage[],
): number {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index]!;
    if (message.role !== "user") continue;
    const content = stringContent(message);
    if (content.includes(TASK_REMINDER_HEADER_PREFIX)) {
      return countAssistantTurnsBetween(history, index, history.length);
    }
  }
  return Number.POSITIVE_INFINITY;
}

export interface ShouldInjectTaskReminderParams {
  readonly history: readonly LLMMessage[];
  readonly activeToolNames: ReadonlySet<string>;
}

export function shouldInjectTaskReminder(
  params: ShouldInjectTaskReminderParams,
): boolean {
  if (!params.activeToolNames.has("task.update")) return false;
  const turnsSinceManagement = getTurnsSinceTaskManagement(params.history);
  if (turnsSinceManagement < TASK_REMINDER_TURNS_SINCE_UPDATE) return false;
  const turnsSinceReminder = getTurnsSinceLastTaskReminder(params.history);
  if (turnsSinceReminder < TASK_REMINDER_TURNS_BETWEEN_REMINDERS) return false;
  return true;
}

export function buildTaskReminderMessage(
  tasks: readonly ReminderTaskView[],
): LLMMessage {
  const list = tasks.length === 0
    ? ""
    : "\n\nHere are the existing tasks:\n\n" +
      tasks
        .map((task) => `#${task.id}. [${task.status}] ${task.subject}`)
        .join("\n");
  return {
    role: "user",
    content: `<system-reminder>\n${TASK_REMINDER_HEADER}${list}\n</system-reminder>`,
    runtimeOnly: { mergeBoundary: "user_context" },
  };
}
