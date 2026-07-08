/**
 * Notification → typed prompt-event mapping shared by every transport.
 *
 * The daemon delivers session activity as JSON-RPC notifications
 * (`event.message_chunk`, `event.tool_request`, `event.permission_request`,
 * `event.user_input_request`, `event.mcp_elicitation_request`,
 * `event.agent_status`, `event.session_event`). The subprocess transport's
 * `--output-format stream-json` lines carry the exact same notification
 * objects under their `event` field, so one mapper serves both.
 *
 * Terminal-status and message-chunk detection intentionally mirrors the
 * CLI's daemon one-shot path (`runtime/src/bin/agenc.ts`:
 * `daemonOneShotMessageChunk` / `daemonOneShotFinalStatus`) so an embedder
 * sees the same text and the same completion semantics as `agenc -p`.
 */

import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";

export type AgencStopReason = "completed" | "errored" | "stopped";

/** One streamed event observed while a prompt turn runs. */
export type AgencPromptEvent =
  | {
      readonly type: "text";
      readonly delta: string;
      readonly messageId?: string;
      readonly streamId?: string;
    }
  | {
      readonly type: "tool_call";
      readonly requestId: string;
      readonly toolName: string;
      readonly turnId?: string;
      readonly input?: JsonValue;
      readonly recoveryCategory?: string;
    }
  | {
      readonly type: "permission_request";
      readonly requestId: string;
      readonly toolName?: string;
      readonly permissions: readonly string[];
      readonly input?: JsonValue;
      readonly reason?: string;
    }
  | {
      readonly type: "elicitation_request";
      readonly kind: "request_user_input" | "mcp";
      readonly requestId: string | number;
      readonly serverName?: string;
      readonly questions?: readonly JsonObject[];
      readonly request?: JsonObject;
    }
  | {
      readonly type: "status";
      readonly status?: string;
      readonly runStatus?: string;
      readonly message?: string;
    }
  | {
      readonly type: "session_event";
      readonly event: JsonObject;
    };

export interface AgencUsage extends JsonObject {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly costUsd: number;
}

/** Final outcome of one prompt turn. */
export interface AgencPromptResult {
  readonly stopReason: AgencStopReason;
  /** 0 success, 1 error, 130 stopped/interrupted — mirrors `agenc -p`. */
  readonly exitCode: number;
  /** The turn's final assistant message (or accumulated streamed text). */
  readonly finalMessage: string;
  /** Permission requests that were auto- or callback-denied during the turn. */
  readonly deniedPermissionRequestIds: readonly string[];
  readonly usage?: JsonObject;
  readonly cacheStats?: JsonObject;
}

export interface AgencTerminalStatus {
  readonly code: number;
  readonly message?: string;
}

function eventParams(message: JsonObject): JsonObject | null {
  return isJsonObject(message.params) ? message.params : message;
}

function nestedTranscriptEvent(message: JsonObject): JsonObject | null {
  const params = eventParams(message);
  if (params === null) return null;
  if (isJsonObject(params.event)) return params.event;
  if (isJsonObject(params.msg)) return params.msg;
  return params;
}

/**
 * Extract streamed assistant text from a daemon notification. Mirrors the
 * CLI's `daemonOneShotMessageChunk`.
 */
export function messageChunkFromNotification(
  message: JsonObject,
): string | null {
  const params = eventParams(message);
  if (
    message.method === "event.message_chunk" &&
    params !== null &&
    typeof params.delta === "string"
  ) {
    return params.delta;
  }
  const transcriptEvent = nestedTranscriptEvent(message);
  if (transcriptEvent === null) return null;
  const payload = isJsonObject(transcriptEvent.payload)
    ? transcriptEvent.payload
    : null;
  if (
    transcriptEvent.type === "agent_message_delta" &&
    payload !== null &&
    typeof payload.delta === "string"
  ) {
    return payload.delta;
  }
  if (
    transcriptEvent.type === "agent_message" &&
    payload !== null &&
    typeof payload.message === "string"
  ) {
    return `${payload.message}\n`;
  }
  return null;
}

/**
 * Detect the terminal status of a turn from a daemon notification. Mirrors
 * the CLI's `daemonOneShotFinalStatus`: `event.agent_status` with a terminal
 * run status, or a nested transcript `turn_complete`/`error` event.
 */
export function terminalStatusFromNotification(
  message: JsonObject,
): AgencTerminalStatus | null {
  const params = eventParams(message);
  if (message.method === "event.agent_status" && params !== null) {
    const runStatus =
      typeof params.runStatus === "string" ? params.runStatus : undefined;
    const status = typeof params.status === "string" ? params.status : undefined;
    const statusMessage =
      typeof params.message === "string" ? params.message : undefined;
    if (runStatus === "completed" || status === "idle") {
      return { code: 0, ...(statusMessage !== undefined ? { message: statusMessage } : {}) };
    }
    if (runStatus === "stopped" || status === "stopped") {
      return { code: 130, ...(statusMessage !== undefined ? { message: statusMessage } : {}) };
    }
    if (runStatus === "errored" || status === "error") {
      return { code: 1, ...(statusMessage !== undefined ? { message: statusMessage } : {}) };
    }
  }
  const transcriptEvent = nestedTranscriptEvent(message);
  if (transcriptEvent === null) return null;
  const payload = isJsonObject(transcriptEvent.payload)
    ? transcriptEvent.payload
    : null;
  if (transcriptEvent.type === "turn_complete") {
    const finalMessage =
      payload !== null && typeof payload.lastAgentMessage === "string"
        ? payload.lastAgentMessage
        : undefined;
    return { code: 0, ...(finalMessage !== undefined ? { message: finalMessage } : {}) };
  }
  if (transcriptEvent.type === "error") {
    const errorMessage =
      payload !== null && typeof payload.message === "string"
        ? payload.message
        : undefined;
    return { code: 1, ...(errorMessage !== undefined ? { message: errorMessage } : {}) };
  }
  return null;
}

export function stopReasonFromExitCode(code: number): AgencStopReason {
  if (code === 0) return "completed";
  if (code === 130) return "stopped";
  return "errored";
}

/**
 * Map a raw daemon notification to a typed prompt event. Returns `null` for
 * notifications that carry no session-facing meaning (e.g. realtime audio).
 */
export function promptEventFromNotification(
  message: JsonObject,
): AgencPromptEvent | null {
  const params = eventParams(message);
  const method = message.method;

  if (method === "event.message_chunk" || method === "event.session_event") {
    const delta = messageChunkFromNotification(message);
    if (delta !== null && delta.length > 0) {
      const chunkParams = params ?? {};
      return {
        type: "text",
        delta,
        ...(typeof chunkParams.messageId === "string"
          ? { messageId: chunkParams.messageId }
          : {}),
        ...(typeof chunkParams.streamId === "string"
          ? { streamId: chunkParams.streamId }
          : {}),
      };
    }
    if (method === "event.session_event" && params !== null) {
      const nested = isJsonObject(params.event) ? params.event : params;
      return { type: "session_event", event: nested };
    }
    return null;
  }

  if (params === null) return null;

  if (method === "event.tool_request") {
    if (typeof params.requestId !== "string") return null;
    return {
      type: "tool_call",
      requestId: params.requestId,
      toolName: typeof params.toolName === "string" ? params.toolName : "",
      ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
      ...(params.input !== undefined ? { input: params.input } : {}),
      ...(typeof params.recoveryCategory === "string"
        ? { recoveryCategory: params.recoveryCategory }
        : {}),
    };
  }

  if (method === "event.permission_request") {
    if (typeof params.requestId !== "string" || params.requestId.length === 0) {
      return null;
    }
    const permissions = Array.isArray(params.permissions)
      ? params.permissions.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    return {
      type: "permission_request",
      requestId: params.requestId,
      permissions,
      ...(typeof params.toolName === "string"
        ? { toolName: params.toolName }
        : {}),
      ...(params.input !== undefined ? { input: params.input } : {}),
      ...(typeof params.reason === "string" ? { reason: params.reason } : {}),
    };
  }

  if (method === "event.user_input_request") {
    if (typeof params.requestId !== "string") return null;
    const questions = Array.isArray(params.questions)
      ? params.questions.filter(isJsonObject)
      : [];
    return {
      type: "elicitation_request",
      kind: "request_user_input",
      requestId: params.requestId,
      questions,
    };
  }

  if (method === "event.mcp_elicitation_request") {
    const requestId = params.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") {
      return null;
    }
    return {
      type: "elicitation_request",
      kind: "mcp",
      requestId,
      ...(typeof params.serverName === "string"
        ? { serverName: params.serverName }
        : {}),
      ...(isJsonObject(params.request) ? { request: params.request } : {}),
    };
  }

  if (method === "event.agent_status") {
    return {
      type: "status",
      ...(typeof params.status === "string" ? { status: params.status } : {}),
      ...(typeof params.runStatus === "string"
        ? { runStatus: params.runStatus }
        : {}),
      ...(typeof params.message === "string" ? { message: params.message } : {}),
    };
  }

  return null;
}

/** sessionId carried by a daemon notification, if any. */
export function sessionIdFromNotification(message: JsonObject): string | null {
  if (typeof message.sessionId === "string") return message.sessionId;
  const params = message.params;
  if (isJsonObject(params) && typeof params.sessionId === "string") {
    return params.sessionId;
  }
  return null;
}
