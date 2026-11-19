/**
 * Who reads the advice in a turn's failure text, so the advice names only
 * actions that reader has.
 *
 * The TUI runs `/compact` and `/clear`. Every other daemon client (Desktop,
 * the SDK, a phone) has no slash commands, so it gets the same advice in
 * plain words, and a client that offers the action itself gets none. The
 * daemon runner records the reader per session: the client that started the
 * session (`metadata.mode: "tui"` for the TUI), then the client of each prompt
 * as its turn starts, from what that client declared in `initialize`. A
 * session no person can answer (`nonInteractive`) gets no advice, and an
 * in-process session, which has no daemon client, is read by the TUI.
 */

export type TurnAdviceReader =
  /** Runs Core's slash commands: advice may name /compact and /clear. */
  | "tui"
  /** A daemon client without slash commands: the same advice in plain words. */
  | "client"
  /** A daemon client that offers Compact itself on a context-full failure: no advice. */
  | "client_with_compact";

const readers = new WeakMap<object, TurnAdviceReader>();

export function setTurnAdviceReader(session: object, reader: TurnAdviceReader): void {
  readers.set(session, reader);
}

export function turnAdviceReader(
  session: object & { readonly services?: { readonly runtimeOptions?: { readonly nonInteractive?: unknown } } },
): TurnAdviceReader | "none" {
  if (session.services?.runtimeOptions?.nonInteractive === true) return "none";
  return readers.get(session) ?? "tui";
}

/**
 * The advice after "The conversation is too large for the next reply…", for a
 * turn that ended `compact_failed`. `full` also names a larger model and starts
 * with a space; `short` is a whole sentence of its own. Empty when the reader
 * gets no advice. The TUI's wording is unchanged from before readers existed.
 */
export function contextFullAdvice(
  reader: TurnAdviceReader | "none",
  form: "full" | "short",
): string {
  switch (reader) {
    case "tui":
      return form === "full"
        ? " Run /compact to retry, start a new conversation with /clear, or use a model with a larger context window."
        : "Run /compact to retry, or start a new conversation with /clear.";
    case "client":
      return form === "full"
        ? " Compact the conversation and retry, start a new conversation, or use a model with a larger context window."
        : "Compact the conversation and retry, or start a new conversation.";
    case "client_with_compact":
    case "none":
      return "";
  }
}
