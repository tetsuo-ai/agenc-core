import type { JsonObject } from "./protocol/index.js";

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Display advice only. Never schedules a retry or changes session authority. */
export function failureAdvice(payload: JsonObject): JsonObject {
  const code = payload.code;
  const sessionUsable = typeof payload.sessionUsable === "boolean"
    ? payload.sessionUsable
    : !["background_agent_error", "session_closed", "session_corrupt"].includes(String(code));
  const retryable = typeof payload.retryable === "boolean" ? payload.retryable
    : sessionUsable && (object(payload.transportFailure) ||
      ["transport_error", "provider_error", "empty_response", "error", "turn_execution_failed"].includes(String(code)));
  return { retryable, sessionUsable };
}

/** Project a copy at the connection boundary. Canonical events stay untouched. */
export function timelineNotification(message: JsonObject, capabilities: JsonObject = {}): JsonObject | null {
  const params = message.params;
  if (!object(params)) return message;
  const key = message.method === "event.session_event" ? "event" : "turnEvent";
  const event = params[key];
  if (!object(event) || !object(event.payload)) return message;
  if (event.type !== "turn_failed") return message;
  const { retryable: _retryable, sessionUsable: _sessionUsable, ...legacy } = event.payload;
  const payload = capabilities["turn.failure.v1"] === true
    ? { ...legacy, ...failureAdvice(event.payload) } : legacy;
  return { ...message, params: { ...params, [key]: { ...event, payload } } };
}
