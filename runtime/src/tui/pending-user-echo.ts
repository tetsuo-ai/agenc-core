/**
 * The prompt the user just sent, shown in the transcript the moment Enter
 * lands. The daemon's own user row can take most of a second on the first
 * turn (the session is created then), and until it arrives the sent text
 * had vanished from the screen. Display only: nothing on the request path
 * waits on it.
 */
export type PendingUserEcho = {
  /** clientMessageId of the submission this echo stands in for. */
  readonly id: string;
  readonly message: unknown;
  /** The text that was sent. */
  readonly text: string;
  /** User text rows in the transcript when the prompt was sent. */
  readonly userRowsBefore: number;
  /** Text of the newest user row when the prompt was sent. */
  readonly lastUserTextBefore: string | null;
};

/**
 * User text rows in the transcript. Tool results are user rows too, but they
 * carry block arrays, not text. Counting rather than indexing keeps the
 * hand-over right when the transcript re-projects and rows move.
 */
export function countUserTextRows(messages: readonly unknown[]): number {
  let count = 0;
  for (const entry of messages) {
    if (userText(entry) !== null) count += 1;
  }
  return count;
}

/** Text of the newest user text row, or null when there is none. */
export function lastUserText(messages: readonly unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = userText(messages[index]);
    if (text !== null) return text;
  }
  return null;
}

function userText(entry: unknown): string | null {
  const message = entry as
    | { readonly type?: unknown; readonly message?: { readonly content?: unknown } }
    | undefined;
  return message?.type === "user" && typeof message.message?.content === "string"
    ? message.message.content
    : null;
}

/**
 * True once the daemon's own row for the echoed prompt is in the transcript:
 * there are more user rows than when it was sent, or the newest user row
 * now reads the sent text. The second check covers a transcript that lost
 * older rows meanwhile, which keeps the count from going up.
 */
function daemonRowLanded(messages: readonly unknown[], echo: PendingUserEcho): boolean {
  if (countUserTextRows(messages) > echo.userRowsBefore) return true;
  return echo.lastUserTextBefore !== echo.text && lastUserText(messages) === echo.text;
}

/**
 * The transcript to draw: the daemon's messages plus the echo while its
 * submission is still in flight and the daemon's own user row has not
 * landed. `submitting` is false once the submission settles or fails, so a
 * failed send never leaves its echo behind.
 */
export function withPendingUserEcho<T>(
  messages: readonly T[],
  echo: PendingUserEcho | null,
  submitting: boolean,
): readonly T[] {
  if (echo === null || !submitting || daemonRowLanded(messages, echo)) {
    return messages;
  }
  return [...messages, echo.message as T];
}
