/// <reference lib="es2024.promise" />

import { classifyTurnTerminal } from "../contracts/turn-terminal.js";

interface SubmissionEvents {
  subscribeToEvents?(listener: (event: unknown) => void): () => void;
}

/** Forward live events from the mount's existing subscription, without replay. */
export function createSubmissionTerminalEvents() {
  const listeners = new Set<(event: unknown) => void>();
  return {
    subscribeToEvents(listener: (event: unknown) => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    publish(event: unknown): void {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

/** A durable terminal can arrive before (or without) the stream RPC response. */
export async function awaitSubmissionTerminal(
  session: SubmissionEvents,
  clientMessageId: string | undefined,
  submit: () => Promise<void>,
): Promise<void> {
  if (clientMessageId === undefined || session.subscribeToEvents === undefined) {
    await submit();
    return;
  }
  const terminal = Promise.withResolvers<void>();
  let expectedTurnId: string | undefined;
  const unsubscribe = session.subscribeToEvents((event) => {
    if (event === null || typeof event !== "object") return;
    const outer = event as Record<string, unknown>;
    const record = outer.msg !== null && typeof outer.msg === "object"
      ? outer.msg as Record<string, unknown> : outer;
    if (typeof record.type !== "string") return;
    const payload = record.payload !== null && typeof record.payload === "object"
      ? record.payload as Record<string, unknown> : {};
    const identity = outer.clientMessageId ?? payload.clientMessageId ?? payload.messageId;
    const turnId = payload.turnId ?? outer.turnId;
    // Never release this submission for a stale, sibling or locally fabricated
    // unscoped terminal. A real start/user echo binds its daemon turn identity.
    if (identity !== undefined && identity !== clientMessageId) return;
    if (identity === clientMessageId && typeof turnId === "string" &&
        (record.type === "turn_started" || record.type === "turn_start" || record.type === "user_message")) {
      expectedTurnId = turnId;
    }
    if (identity !== clientMessageId &&
        (expectedTurnId === undefined || turnId !== expectedTurnId)) return;
    if (typeof turnId !== "string" || turnId.length === 0) return;
    if (classifyTurnTerminal({ type: record.type, payload, turnId }, {
      ...(expectedTurnId === undefined ? {} : { expectedTurnId }),
    }) !== undefined) terminal.resolve();
  });
  try {
    // Both branches stay observed, including a late RPC rejection after the
    // terminal won. Subscribe first so a synchronous start/end cannot be lost.
    await Promise.race([Promise.resolve().then(submit), terminal.promise]);
  } finally {
    unsubscribe();
  }
}
