/**
 * Turn-start reminder for background sessions that ended while no
 * exec-family result followed.
 *
 * A background session's end is reported on the next exec_command,
 * write_stdin, kill_process or list_processes result of its conversation
 * (unified-exec/process-manager.ts `takeSessionEndNotices`). When the model
 * ended its turn, or kept to other tools, nothing carried it. The next turn
 * of that conversation then starts with one line per ended session. Like the
 * run-deadline reminders it is runtime-only: never durable history. It never
 * starts a turn on its own; an idle session stays idle.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { UnifiedExecProcessManagerLike } from "../unified-exec/types.js";
import { formatSessionEndNotice } from "../tools/system/exec-result-format.js";

interface BackgroundSessionReminderSession {
  readonly conversationId?: unknown;
  readonly services?: {
    readonly unifiedExecManager?: Pick<UnifiedExecProcessManagerLike, "takeSessionEndNotices">;
  };
}

/**
 * Drain this conversation's pending end notices into one runtime-only
 * reminder, or undefined when none is pending. Draining means a later exec
 * result does not repeat them.
 */
export function backgroundSessionEndReminder(
  session: BackgroundSessionReminderSession,
): LLMMessage | undefined {
  const take = session.services?.unifiedExecManager?.takeSessionEndNotices;
  if (take === undefined) return undefined;
  const ownerId = typeof session.conversationId === "string" && session.conversationId.length > 0
    ? session.conversationId
    : undefined;
  const notices = take.call(session.services!.unifiedExecManager, ownerId === undefined ? {} : { ownerId });
  if (notices.length === 0) return undefined;
  return {
    role: "user",
    content: `<system-reminder>\n${notices.map(formatSessionEndNotice).join("\n")}\n</system-reminder>`,
    runtimeOnly: { excludeFromDurableHistory: true },
  };
}
