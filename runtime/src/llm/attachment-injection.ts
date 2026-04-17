/**
 * Shared entry point for runtime-injected user-role attachments.
 *
 * Both the webchat chat-executor (`chat-executor-tool-loop.ts`) and
 * the background-run supervisor (`background-run-supervisor.ts`) call
 * this exact function at the same point in their respective flows —
 * immediately before the next model call — so both surfaces see the
 * same injection behavior. Upstream's reference runtime uses one
 * shared `getAttachments` pipeline; having two independent hooks
 * here would create drift between interactive and background paths.
 *
 * Emitted reminders, in upstream priority order:
 *   1. `todo_reminder`  — stale TodoWrite list (see `todo-reminder.ts`).
 *   2. `task_reminder`  — stale task.create/task.update (see
 *                          `task-reminder.ts`).
 *
 * Both reminders can fire on the same turn. Upstream runs them
 * independently with no mutual suppression, and AgenC matches that.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";
import type { TodoItem } from "../tools/system/todo-store.js";
import {
  buildTodoReminderMessage,
  shouldInjectTodoReminder,
} from "./todo-reminder.js";
import {
  buildTaskReminderMessage,
  shouldInjectTaskReminder,
  type ReminderTaskView,
} from "./task-reminder.js";

export interface AttachmentContext {
  readonly history: readonly LLMMessage[];
  readonly activeToolNames: ReadonlySet<string>;
  readonly todos: readonly TodoItem[];
  readonly tasks: readonly ReminderTaskView[];
}

export interface AttachmentInjectionResult {
  readonly messages: readonly LLMMessage[];
}

export function collectAttachments(
  ctx: AttachmentContext,
): AttachmentInjectionResult {
  const messages: LLMMessage[] = [];
  if (
    shouldInjectTodoReminder({
      history: ctx.history,
      activeToolNames: ctx.activeToolNames,
    })
  ) {
    messages.push(buildTodoReminderMessage(ctx.todos));
  }
  if (
    shouldInjectTaskReminder({
      history: ctx.history,
      activeToolNames: ctx.activeToolNames,
    })
  ) {
    messages.push(buildTaskReminderMessage(ctx.tasks));
  }
  return { messages };
}
