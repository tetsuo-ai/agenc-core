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
  /** User text rows in the transcript when the prompt was sent. */
  readonly userRowsBefore: number;
};

/**
 * User text rows in the transcript. Tool results are user rows too, but they
 * carry block arrays, not text. Counting rather than indexing keeps the
 * hand-over right when the transcript re-projects and rows move.
 */
export function countUserTextRows(messages: readonly unknown[]): number {
  let count = 0;
  for (const entry of messages) {
    const message = entry as
      | { readonly type?: unknown; readonly message?: { readonly content?: unknown } }
      | undefined;
    if (message?.type === "user" && typeof message.message?.content === "string") {
      count += 1;
    }
  }
  return count;
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
  if (echo === null || !submitting || countUserTextRows(messages) > echo.userRowsBefore) {
    return messages;
  }
  return [...messages, echo.message as T];
}
