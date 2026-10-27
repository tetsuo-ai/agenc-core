import { isRecord } from "../utils/record.js";

/** A discarded attempt, rather than a terminal disconnect retaining its prefix. */
export function isStreamAttemptDiscard(event: { readonly type?: unknown; readonly payload?: unknown }): boolean {
  if (event.type !== "stream_error" || !isRecord(event.payload)) return false;
  if (event.payload.cause === "stream_attempt_discarded") return true;
  if (event.payload.cause !== "stream_disconnected" || typeof event.payload.message !== "string") return false;
  // Older journals have no explicit discard record. Recognize the controlled
  // reconnect notice from streamRetryNoticeMessage, never refusal/exhaustion
  // messages (or retry-like words embedded in a provider error's detail).
  return /^(?:repetitive reasoning|no model progress|stream idle|connection lost \([A-Z_]+\)|rate limited|request timed out|provider error(?: \(HTTP \d+\))?|stream interruption), retrying in (?:up to )?\d+ s \(\d+\/\d+\): /u.test(event.payload.message);
}
