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
 * Today the module emits at most one message: the TodoWrite reminder
 * from `todo-reminder.ts`. Future attachments (plan-mode
 * re-attachment, other runtime reminders) land here in the same
 * priority order the upstream runtime uses.
 *
 * @module
 */

import type { LLMMessage } from "./types.js";
import type { TodoItem } from "../tools/system/todo-store.js";
import {
  buildTodoReminderMessage,
  shouldInjectTodoReminder,
} from "./todo-reminder.js";

export interface AttachmentContext {
  readonly history: readonly LLMMessage[];
  readonly activeToolNames: ReadonlySet<string>;
  readonly todos: readonly TodoItem[];
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
  return { messages };
}
