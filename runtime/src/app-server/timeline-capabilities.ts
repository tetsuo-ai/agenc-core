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
  if (event.type === "turn_changes") return capabilities["turn.changes.v1"] === true ? message : null;
  if (event.type === "turn_complete") {
    if (capabilities["turn.usage.v1"] === true) return message;
    const { usage: _usage, ...payload } = event.payload;
    return { ...message, params: { ...params, [key]: { ...event, payload } } };
  }
  if (event.type !== "turn_failed") return message;
  const { retryable: _retryable, sessionUsable: _sessionUsable, ...legacy } = event.payload;
  const payload = capabilities["turn.failure.v1"] === true
    ? { ...legacy, ...failureAdvice(event.payload) } : legacy;
  return { ...message, params: { ...params, [key]: { ...event, payload } } };
}

/** One opt-in belongs to one prompt on one connection. */
export class PromptProgressGate {
  private readonly prompts = new Map<string, { sessionId: string; calls: Map<string, number> }>();
  async run<T>(sessionId: string, messageId: string, enabled: boolean, task: () => Promise<T>): Promise<T> {
    if (!enabled) return task();
    const key = JSON.stringify([sessionId, messageId]);
    const state = { sessionId, calls: new Map<string, number>() };
    this.prompts.set(key, state);
    try { return await task(); }
    finally { if (this.prompts.get(key) === state) this.prompts.delete(key); }
  }
  project(message: JsonObject): JsonObject | null {
    const params = message.params;
    if (!object(params) || !object(params.event) || params.event.type !== "tool_progress") return message;
    const event = params.event;
    const payload = event.payload;
    if (!object(payload) || typeof params.sessionId !== "string" || typeof params.clientMessageId !== "string") return null;
    const state = this.prompts.get(JSON.stringify([params.sessionId, params.clientMessageId]));
    if (!state || !["Bash", "PowerShell", "exec_command", "write_stdin", "system.exec_command", "system.write_stdin"].includes(String(payload.toolName)) || typeof payload.callId !== "string" || typeof payload.chunk !== "string") return null;
    const used = state.calls.get(payload.callId) ?? 0;
    if (used > 65536 || (!state.calls.has(payload.callId) && state.calls.size >= 256)) return null;
    const chunk = payload.chunk.slice(0, Math.min(4096, 65536 - used));
    const dropped = chunk.length < payload.chunk.length || payload.outputDropped === true;
    state.calls.set(payload.callId, dropped ? 65537 : used + chunk.length);
    return { ...message, params: { ...params, event: { ...event, payload: { ...payload, chunk, ...(dropped ? { outputDropped: true } : {}) } } } };
  }
}
