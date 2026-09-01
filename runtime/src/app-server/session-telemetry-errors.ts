/**
 * Canonical `error` causes that are session telemetry, not run death.
 *
 * Mid-turn sites emit these while the turn continues (stream reconnect,
 * stop-hook throw, leftover prompt-hook blocks). Treating them as
 * `agent.status = error` latches keep-alive daemon sessions: lifecycle
 * refresh copies the snapshot and then refuses later `message.send`.
 */

export const SESSION_TELEMETRY_ERROR_CAUSES: ReadonlySet<string> = new Set([
  "user_prompt_submit_hook_blocked",
  "stop_hook_threw",
  "stream_disconnected",
]);

export function isSessionTelemetryErrorCause(cause: unknown): boolean {
  return typeof cause === "string" && SESSION_TELEMETRY_ERROR_CAUSES.has(cause);
}

export function isSessionTelemetryErrorPayload(payload: unknown): boolean {
  if (payload === null || typeof payload !== "object") return false;
  return isSessionTelemetryErrorCause(
    (payload as { readonly cause?: unknown }).cause,
  );
}
