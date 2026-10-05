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
  /** Transcript length when the prompt was sent. */
  readonly afterIndex: number;
};

/** Whether a user text row arrived at or after `index`. */
export function hasUserRowAfter(messages: readonly unknown[], index: number): boolean {
  for (let i = messages.length - 1; i >= index; i -= 1) {
    const message = messages[i] as
      | { readonly type?: unknown; readonly message?: { readonly content?: unknown } }
      | undefined;
    if (message?.type === "user" && typeof message.message?.content === "string") {
      return true;
    }
  }
  return false;
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
  if (echo === null || !submitting || hasUserRowAfter(messages, echo.afterIndex)) {
    return messages;
  }
  return [...messages, echo.message as T];
}
