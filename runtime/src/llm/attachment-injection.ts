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
 *   1. `todo_reminder`   — stale TodoWrite list (`todo-reminder.ts`).
 *   2. `task_reminder`   — stale task.create/task.update (`task-reminder.ts`).
 *   3. `verify_reminder` — cumulative unverified edits since the most
 *                           recent verifier spawn (`verify-reminder.ts`).
 *                           Plan-mode-less adaptation of the upstream
 *                           `verify_plan_reminder`.
 *
 * All three reminders can fire on the same turn. They are independent
 * by design — each one anchors on a different signal, so a single-
 * counter deadlock cannot suppress all of them at once.
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
import {
  buildVerifyReminderMessage,
  shouldInjectVerifyReminder,
} from "./verify-reminder.js";

export interface AttachmentContext {
  readonly history: readonly LLMMessage[];
  readonly activeToolNames: ReadonlySet<string>;
  readonly todos: readonly TodoItem[];
  readonly tasks: readonly ReminderTaskView[];
  /**
   * Runtime counters that back the `verify_reminder` trigger. Supplied
   * by the background-run supervisor (where they live on
   * `ActiveBackgroundRun`); omitted by interactive (webchat,
   * text-channel) call sites where the reminder is out of scope —
   * interactive turns are short-horizon and do not accumulate
   * unverified edits the way background runs do.
   *
   * Separating these counters from history (rather than scanning for
   * an anchor event such as an `execute_with_agent` tool_use with
   * `verifierObligations`) matches the reference runtime's
   * `AppState.pendingPlanVerification` pattern and survives history
   * compaction.
   */
  readonly mutatingEditsSinceLastVerifierSpawn?: number;
  readonly assistantTurnsSinceLastVerifyReminder?: number;
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
  if (
    shouldInjectVerifyReminder({
      activeToolNames: ctx.activeToolNames,
      mutatingEditsSinceLastVerifierSpawn:
        ctx.mutatingEditsSinceLastVerifierSpawn,
      assistantTurnsSinceLastVerifyReminder:
        ctx.assistantTurnsSinceLastVerifyReminder,
    })
  ) {
    messages.push(buildVerifyReminderMessage());
  }
  return { messages };
}
