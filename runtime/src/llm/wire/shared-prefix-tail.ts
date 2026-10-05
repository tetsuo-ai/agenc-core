/**
 * Shared-prefix tail placement for chat-completions providers.
 *
 * DeepSeek caches prompt prefixes per account, so one session can read what
 * an earlier session wrote. The chat-completions wire sends the whole system
 * prompt as the leading system message and the server renders the tool
 * definitions after it. The dynamic tail of that prompt (memory directories,
 * working directory) differs per session, so the prefix two sessions share
 * ends inside the system message: on deepseek-flash a session's first request
 * read 5,120 of about 19,900 prompt tokens from cache.
 *
 * A provider whose hints say it shares prefixes across sessions (native
 * DeepSeek) gets the static head as the leading system message and the tail as
 * a `<system-reminder>` user message after the leading setup reminders. The
 * head, the tool definitions and the setup reminders that do not change
 * between sessions then form one shared prefix (16,896 tokens in the same
 * measurement). The tail is fixed for the session, so later requests of the
 * session still read it from cache.
 *
 * The switch is the session's `AGENC_SHARED_PREFIX_TAIL` (captured with the
 * rest of the session environment, so a client sets it per session); a false
 * value turns the layout off. The adapter reads it and passes the result to
 * the wire as `sharedPrefixTail`.
 *
 * @module
 */

import { isEnvDefinedFalsy } from "../../utils/envBoolean.js";

export const SHARED_PREFIX_TAIL_ENV = "AGENC_SHARED_PREFIX_TAIL";

const SYSTEM_REMINDER_OPEN = "<system-reminder>";

/** On unless the session environment sets `AGENC_SHARED_PREFIX_TAIL` to a false value. */
export function sharedPrefixTailEnabled(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return !isEnvDefinedFalsy(env[SHARED_PREFIX_TAIL_ENV]);
}

/** The tail as the user message that carries it. */
export function sessionTailReminder(tail: string): Record<string, unknown> {
  return {
    role: "user",
    content: `${SYSTEM_REMINDER_OPEN}\n${tail.trim()}\n</system-reminder>`,
  };
}

function leadingText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const first: unknown = content[0];
  if (first === null || typeof first !== "object") return undefined;
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : undefined;
}

/**
 * Index after the leading system message and the setup reminders that follow
 * it: user messages that open with `<system-reminder>`. The first message that
 * is not one (normally the user's request) is where the tail goes.
 */
export function afterLeadingSetupReminders(
  wireMessages: readonly Record<string, unknown>[],
): number {
  let index = 0;
  while (index < wireMessages.length && wireMessages[index]?.role === "system") {
    index += 1;
  }
  while (index < wireMessages.length) {
    const message = wireMessages[index];
    const text = message?.role === "user" ? leadingText(message.content) : undefined;
    if (text === undefined || !text.trimStart().startsWith(SYSTEM_REMINDER_OPEN)) break;
    index += 1;
  }
  return index;
}
