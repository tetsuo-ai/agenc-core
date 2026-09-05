/**
 * Daemon event correlation, notification projection and run status mapping.
 * Split out of background-agent-runner.ts as a pure move.
 */

import type { LLMContentPart } from "../../llm/types.js";
import type { AgentStatus as ThreadAgentStatus } from "../../agents/status.js";
import type { Event } from "../../session/event-log.js";
import type {
  AgenCDaemonSessionNotification,
  AgentRunStatus,
  AgentStatus as DaemonAgentStatus,
  JsonObject,
  JsonValue,
} from "../protocol/index.js";
import { JSON_RPC_VERSION } from "../protocol/index.js";
import { EVENT_GAP_EVENT } from "../../contracts/run-contracts.js";

import {
  positiveSequence,
  nonNegativeSequence,
  positiveInteger,
  assistantMessageId,
  historyEpochForBoundary,
  jsonObjectArray,
  isJsonObject,
  isJsonValue,
  stringArray,
  isToolRecoveryCategory,
} from "./shared.js";
import type {
  AgenCBackgroundAgentMessageTerminal,
  ActiveBackgroundAgent,
  BackgroundAgentDaemonEvent,
} from "./shared.js";
import { BACKGROUND_RUNNER_GAP_SOURCE } from "./snapshot-retention.js";

function sessionUserMessageEventFromDaemonEvent(
  event: BackgroundAgentDaemonEvent,
): Event | null {
  if (
    event.type !== "user_message" ||
    event.payload === undefined ||
    event.payload.message === undefined
  ) {
    return null;
  }
  return {
    id: event.id,
    msg: {
      type: "user_message",
      payload: {
        message: event.payload.message as string | readonly LLMContentPart[],
        ...(typeof event.payload.displayText === "string"
          ? { displayText: event.payload.displayText }
          : {}),
        ...(Array.isArray(event.payload.images)
          ? { images: stringArray(event.payload.images) }
          : {}),
        ...(typeof event.payload.queuedCommandUuid === "string"
          ? { queuedCommandUuid: event.payload.queuedCommandUuid }
          : {}),
        ...(typeof event.messageId === "string"
          ? { messageId: event.messageId }
          : {}),
        ...(typeof event.streamId === "string"
          ? { streamId: event.streamId }
          : {}),
        ...(typeof event.acceptedAt === "string"
          ? { acceptedAt: event.acceptedAt }
          : {}),
      },
    },
  };
}

function correlateDaemonEvent(
  active: ActiveBackgroundAgent,
  event: BackgroundAgentDaemonEvent,
): BackgroundAgentDaemonEvent {
  const runId = active.thread.threadId;
  if (event.type === "history_cleared" || event.type === "transcript_epoch") {
    active.historyEpoch = historyEpochForBoundary(
      runId,
      event.eventId ?? event.id,
    );
    return { ...event, runId, historyEpoch: active.historyEpoch };
  }

  const submission = active.messageSubmission;
  const isSubmissionUserMarker =
    submission !== undefined &&
    event.type === "user_message" &&
    (event.messageId === submission.clientMessageId ||
      event.payload?.messageId === submission.clientMessageId);
  if (
    submission !== undefined &&
    submission.turnId === undefined &&
    event.type !== "turn_started" &&
    !isSubmissionUserMarker
  ) {
    // The durable user marker is visible before the queued input owns a
    // runtime turn. Do not stamp tail events from the preceding turn with the
    // new submission's identity while waiting for its turn_started boundary.
    return {
      ...event,
      runId,
      historyEpoch: active.historyEpoch,
      ...(typeof event.payload?.turnId === "string"
        ? { turnId: event.payload.turnId }
        : {}),
    };
  }
  if (
    submission !== undefined &&
    event.type === "turn_started" &&
    typeof event.payload?.turnId === "string"
  ) {
    submission.turnId = event.payload.turnId;
  }

  const turnId =
    submission?.turnId ??
    (typeof event.payload?.turnId === "string"
      ? event.payload.turnId
      : undefined);
  let messageId = event.messageId;
  if (
    submission !== undefined &&
    (event.type === "agent_message_delta" || event.type === "agent_message")
  ) {
    if (submission.activeAssistantMessageId === undefined) {
      submission.activeAssistantMessageId = assistantMessageId(
        turnId ?? submission.clientMessageId,
        submission.assistantMessageOrdinal,
      );
    }
    messageId = submission.activeAssistantMessageId;
    if (event.type === "agent_message") {
      submission.activeAssistantMessageId = undefined;
      submission.assistantMessageOrdinal += 1;
    }
  } else if (
    submission === undefined &&
    event.type === "agent_message" &&
    messageId === undefined
  ) {
    messageId = `assistant:${event.eventId ?? event.id}`;
  }
  if (submission !== undefined) {
    const terminal = messageTerminalFromDaemonEvent(event, submission.turnId);
    if (terminal !== undefined) submission.terminal = terminal;
  }

  return {
    ...event,
    runId,
    historyEpoch: active.historyEpoch,
    ...(turnId !== undefined ? { turnId } : {}),
    ...(submission !== undefined
      ? { clientMessageId: submission.clientMessageId }
      : {}),
    ...(messageId !== undefined ? { messageId } : {}),
  };
}

function messageTerminalFromDaemonEvent(
  event: BackgroundAgentDaemonEvent,
  expectedTurnId: string | undefined,
): AgenCBackgroundAgentMessageTerminal | undefined {
  const eventTurnId =
    event.turnId ??
    (typeof event.payload?.turnId === "string"
      ? event.payload.turnId
      : undefined);
  if (
    expectedTurnId !== undefined &&
    eventTurnId !== undefined &&
    eventTurnId !== expectedTurnId
  ) {
    return undefined;
  }
  if (event.type === "turn_complete") {
    return {
      code: 0,
      ...(typeof event.payload?.lastAgentMessage === "string"
        ? { message: event.payload.lastAgentMessage }
        : {}),
    };
  }
  if (event.type === "turn_aborted") {
    return {
      code: 130,
      ...(typeof event.payload?.reason === "string"
        ? { message: event.payload.reason }
        : {}),
    };
  }
  // `error` is session telemetry, not a turn closer. Stop-hook throws and
  // similar sites emit it while the turn continues and later writes
  // turn_complete / turn_aborted.
  return undefined;
}

/**
 * Session `error` records are diagnostic events, not lifecycle boundaries.
 * Terminal run failures arrive through RunAgentProgressEvent.run_error and
 * update the lifecycle status there. Keep the diagnostic event visible
 * without letting it poison the keep-alive session first.
 */
function projectTelemetryErrorAsSessionOnly(
  event: BackgroundAgentDaemonEvent,
): BackgroundAgentDaemonEvent {
  if (event.type === "error") {
    return { ...event, statusProjection: "session_only" };
  }
  return event;
}

function scopeDirectShellDaemonEvent(
  active: ActiveBackgroundAgent,
  event: BackgroundAgentDaemonEvent,
): BackgroundAgentDaemonEvent {
  const payload = event.payload;
  const correlationIds = [
    event.id,
    payload?.callId,
    payload?.queuedCommandUuid,
  ];
  if (
    !correlationIds.some(
      (candidate) =>
        typeof candidate === "string" &&
        active.shellExecutionsById.has(candidate),
    )
  ) {
    return event;
  }
  return { ...event, statusProjection: "session_only" };
}

export function notificationFromDaemonEvent(
  sessionId: string,
  agentId: string,
  event: BackgroundAgentDaemonEvent,
): AgenCDaemonSessionNotification {
  const base = eventBaseParams(sessionId, agentId, event);
  const payload = event.payload;
  if (
    event.type === "mcp_status_changed" &&
    isJsonObject(payload) &&
    typeof payload.revision === "number" &&
    Number.isSafeInteger(payload.revision) &&
    payload.revision >= 0
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.mcp_status_changed",
      params: {
        sessionId,
        revision: payload.revision,
      },
    };
  }
  if (
    event.type === "agent_message_delta" &&
    isJsonObject(payload) &&
    typeof payload.delta === "string"
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.message_chunk",
      params: {
        ...base,
        ...(event.messageId !== undefined
          ? { messageId: event.messageId }
          : {}),
        ...(event.streamId !== undefined ? { streamId: event.streamId } : {}),
        delta: payload.delta,
      },
    };
  }
  if (
    event.type === "tool_call_started" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.toolName === "string"
  ) {
    const input = toolRequestInputFromPayload(payload);
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.tool_request",
      params: {
        ...base,
        requestId: payload.callId,
        toolName: payload.toolName,
        ...(input !== undefined ? { input } : {}),
        ...(isToolRecoveryCategory(payload.recoveryCategory)
          ? { recoveryCategory: payload.recoveryCategory }
          : {}),
      },
    };
  }
  if (
    event.type === "request_permissions" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string"
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.permission_request",
      params: {
        ...base,
        requestId: payload.callId,
        ...(typeof payload.toolName === "string"
          ? { toolName: payload.toolName }
          : {}),
        ...(typeof payload.turnId === "string"
          ? { turnId: payload.turnId }
          : {}),
        permissions: stringArray(payload.permissions),
        ...(payload.input !== undefined ? { input: payload.input } : {}),
        ...(typeof payload.reason === "string"
          ? { reason: payload.reason }
          : {}),
        ...(typeof payload.planContent === "string"
          ? { planContent: payload.planContent }
          : {}),
        ...(typeof payload.planFilePath === "string"
          ? { planFilePath: payload.planFilePath }
          : {}),
      },
    };
  }
  if (
    event.type === "request_user_input" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.turnId === "string" &&
    Array.isArray(payload.questions)
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.user_input_request",
      params: {
        ...base,
        requestId:
          typeof payload.requestId === "string"
            ? payload.requestId
            : payload.callId,
        callId: payload.callId,
        turnId: payload.turnId,
        questions: jsonObjectArray(payload.questions),
        ...(isJsonObject(payload.clientAction)
          ? { clientAction: payload.clientAction }
          : {}),
      },
    };
  }
  if (
    event.type === "mcp_elicitation_request" &&
    isJsonObject(payload) &&
    typeof payload.serverName === "string" &&
    (typeof payload.requestId === "string" ||
      typeof payload.requestId === "number") &&
    typeof payload.turnId === "string" &&
    isJsonObject(payload.request)
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.mcp_elicitation_request",
      params: {
        ...base,
        requestId: payload.requestId,
        serverName: payload.serverName,
        turnId: payload.turnId,
        request: payload.request,
      },
    };
  }
  if (
    event.type === "agent_status" &&
    isJsonObject(payload) &&
    typeof payload.status === "string"
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        ...base,
        agentId: base.agentId ?? sessionId,
        status:
          payload.status === "error" || payload.status === "stopped"
            ? payload.status
            : "idle",
        ...(agentRunStatusFromPayload(payload.runStatus) !== undefined
          ? { runStatus: agentRunStatusFromPayload(payload.runStatus) }
          : {}),
        ...(typeof payload.turnId === "string"
          ? { turnId: payload.turnId }
          : {}),
        ...(typeof payload.message === "string"
          ? { message: payload.message }
          : {}),
        ...(isJsonObject(payload.budgetHalt)
          ? { budgetHalt: payload.budgetHalt }
          : {}),
        ...(isJsonObject(payload.budgetUsage)
          ? { budgetUsage: payload.budgetUsage }
          : {}),
      },
    };
  }
  if (
    event.type === "run_terminal" &&
    isJsonObject(payload) &&
    typeof payload.status === "string"
  ) {
    const terminalStatus = daemonStatusFromRunTerminal(payload.status);
    const runStatus = agentRunStatusFromRunTerminal(payload.status);
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        ...base,
        agentId: base.agentId ?? sessionId,
        status: terminalStatus,
        runStatus,
        ...(typeof payload.finalMessage === "string"
          ? { message: payload.finalMessage }
          : typeof payload.stopReason === "string"
            ? { message: payload.stopReason }
            : {}),
      },
    };
  }
  if (
    event.type === EVENT_GAP_EVENT &&
    isJsonObject(payload) &&
    payload.source === BACKGROUND_RUNNER_GAP_SOURCE &&
    typeof payload.runId === "string" &&
    payload.runId.length > 0 &&
    positiveInteger(payload.retiredCount) > 0
  ) {
    const afterSequence = nonNegativeSequence(payload.afterSequence);
    const firstAvailableSequence = positiveSequence(
      payload.firstAvailableSequence,
    );
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.event_gap",
      params: {
        ...base,
        type: EVENT_GAP_EVENT,
        kind: EVENT_GAP_EVENT,
        runId: payload.runId,
        reason: "retention",
        source: BACKGROUND_RUNNER_GAP_SOURCE,
        retiredCount: positiveInteger(payload.retiredCount),
        ...(typeof payload.coordinatesAvailable === "boolean"
          ? { coordinatesAvailable: payload.coordinatesAvailable }
          : {}),
        ...(afterSequence !== undefined ? { afterSequence } : {}),
        ...(firstAvailableSequence !== undefined
          ? { firstAvailableSequence }
          : {}),
      },
    };
  }
  if (
    (event.type === "turn_started" ||
      event.type === "turn_complete" ||
      event.type === "turn_aborted" ||
      event.type === "error") &&
    event.statusProjection !== "session_only" &&
    isJsonObject(payload)
  ) {
    return {
      jsonrpc: JSON_RPC_VERSION,
      method: "event.agent_status",
      params: {
        ...base,
        agentId: base.agentId ?? sessionId,
        status: agentStatusFromEventType(event.type),
        runStatus: agentRunStatusFromEventType(event.type),
        ...(typeof payload.turnId === "string"
          ? { turnId: payload.turnId }
          : {}),
        ...(typeof payload.message === "string"
          ? { message: payload.message }
          : typeof payload.reason === "string"
            ? { message: payload.reason }
            : typeof payload.lastAgentMessage === "string"
              ? { message: payload.lastAgentMessage }
              : {}),
        ...(isJsonObject(payload.budgetHalt)
          ? { budgetHalt: payload.budgetHalt }
          : {}),
        ...(isJsonObject(payload.budgetUsage)
          ? { budgetUsage: payload.budgetUsage }
          : {}),
      },
    };
  }
  return {
    jsonrpc: JSON_RPC_VERSION,
    method: "event.session_event",
    params: {
      ...base,
      event: {
        id: event.id,
        type: event.type,
        ...(event.messageId !== undefined
          ? { messageId: event.messageId }
          : {}),
        ...(event.streamId !== undefined ? { streamId: event.streamId } : {}),
        ...(event.acceptedAt !== undefined
          ? { acceptedAt: event.acceptedAt }
          : {}),
        ...(payload !== undefined ? { payload } : {}),
      },
    },
  };
}

function eventBaseParams(
  sessionId: string,
  agentId: string,
  event: BackgroundAgentDaemonEvent,
): {
  readonly sessionId: string;
  readonly eventId: string;
  readonly agentId: string;
  readonly runId?: string;
  readonly historyEpoch?: string;
  readonly sequence?: number;
  readonly acceptedAt?: string;
  readonly turnId?: string;
  readonly clientMessageId?: string;
  readonly messageId?: string;
} {
  return {
    sessionId,
    eventId: event.eventId ?? event.id,
    agentId,
    ...(event.runId !== undefined ? { runId: event.runId } : {}),
    ...(event.historyEpoch !== undefined
      ? { historyEpoch: event.historyEpoch }
      : {}),
    ...(event.sequence !== undefined ? { sequence: event.sequence } : {}),
    ...(event.acceptedAt !== undefined ? { acceptedAt: event.acceptedAt } : {}),
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    ...(event.clientMessageId !== undefined
      ? { clientMessageId: event.clientMessageId }
      : {}),
    ...(event.messageId !== undefined ? { messageId: event.messageId } : {}),
  };
}

function agentStatusFromEventType(type: string): DaemonAgentStatus {
  switch (type) {
    case "turn_started":
      return "running";
    case "error":
      return "error";
    case "turn_aborted":
      return "idle";
    case "turn_complete":
    default:
      return "idle";
  }
}

function daemonStatusFromRunTerminal(status: unknown): DaemonAgentStatus {
  switch (status) {
    case "completed":
      return "idle";
    case "failed":
    case "unknown_outcome":
      return "error";
    case "cancelled":
    default:
      return "stopped";
  }
}

function agentRunStatusFromRunTerminal(status: unknown): AgentRunStatus {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
    case "unknown_outcome":
      return "errored";
    case "cancelled":
    default:
      return "stopped";
  }
}

function agentRunStatusFromEventType(type: string): AgentRunStatus {
  switch (type) {
    case "turn_started":
      return "running";
    case "error":
      return "errored";
    case "turn_aborted":
      return "completed";
    case "turn_complete":
    default:
      return "completed";
  }
}

function agentRunStatusFromPayload(value: unknown): AgentRunStatus | undefined {
  switch (value) {
    case "pending":
    case "running":
    case "working":
    case "paused":
    case "blocked":
    case "suspended":
    case "completed":
    case "errored":
    case "stopped":
      return value;
    default:
      return undefined;
  }
}

function toolRequestInputFromPayload(
  payload: JsonObject,
): JsonValue | undefined {
  if (payload.input !== undefined && isJsonValue(payload.input)) {
    return payload.input;
  }
  if (typeof payload.args !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(payload.args);
    return isJsonValue(parsed) ? parsed : payload.args;
  } catch {
    return payload.args;
  }
}

/**
 * Translate session-level events that the PhaseEvent → RunAgentProgressEvent
 * pipeline does not cover into BackgroundAgentDaemonEvents the daemon's
 * notification fan-out can deliver. Currently:
 *
 *   - elicitation/user-input requests (`request_user_input`,
 *     `mcp_elicitation_request`, `mcp_elicitation_complete`)
 *   - durable user transcript messages emitted by runtime turns
 *   - collab-agent lifecycle events emitted by `spawn_agent`,
 *     `wait_agent`, `send_message`, and `close_agent`
 *   - runtime warnings emitted before or during a turn
 *   - streaming tool progress chunks (`tool_progress`)
 *   - extended-thinking + reasoning-summary streaming events
 *     (`assistant_thinking_block_start`/`delta`/`block_stop`,
 *     `agent_thinking`)
 *
 * The bridge subscribes to `session.eventLog` (live; writes to the rollout
 * are a separate downstream consumer) and forwards a translated event into
 * the same `#emitOrBufferEvent` pipeline that PhaseEvents use.
 */
const COLLAB_AGENT_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "collab_agent_spawn_begin",
  "collab_agent_spawn_end",
  "collab_agent_status",
  "collab_agent_interaction_begin",
  "collab_agent_interaction_end",
  "collab_waiting_begin",
  "collab_waiting_end",
  "collab_close_begin",
  "collab_close_end",
]);

/**
 * Core run events whose live representation must be the exact canonical
 * Session.EventLog record. Returning null for an unsequenced record is
 * intentional: synthesizing an identity here would make live delivery
 * impossible to reconcile with run.replay after reconnect.
 */
const CANONICAL_CORE_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([
  "history_cleared",
  "transcript_epoch",
  "agent_message_delta",
  "tool_call_started",
  "tool_call_completed",
  "turn_started",
  "turn_complete",
  "turn_aborted",
  "warning",
  "error",
  "stream_error",
  "effect_intent",
  "effect_result",
  "effect_unknown_outcome",
  "effect_review_resolved",
  "request_permissions",
  "permission_decision",
  "execution_admission",
  "artifact_intent",
  "artifact_committed",
  "recovery_decision",
  "run_terminal",
  "run_reopened",
  "run_suspended",
  "run_resumed",
  "run_runtime_settings_changed",
  "run_cancel_requested",
]);

export function daemonEventFromUnboundSessionEvent(event: {
  readonly eventId?: unknown;
  readonly id?: unknown;
  readonly seq?: unknown;
  readonly msg?: {
    readonly type?: unknown;
    readonly payload?: unknown;
  };
}): BackgroundAgentDaemonEvent | null {
  const type = event.msg?.type;
  const payload = event.msg?.payload;
  const id =
    typeof event.id === "string" && event.id.length > 0
      ? event.id
      : typeof type === "string"
        ? type
        : "elicitation";
  const sequence =
    typeof event.seq === "number" &&
    Number.isSafeInteger(event.seq) &&
    event.seq > 0
      ? event.seq
      : undefined;
  const eventId =
    typeof event.eventId === "string" && event.eventId.length > 0
      ? event.eventId
      : sequence !== undefined
        ? `legacy-event:${sequence}:${id}`
        : id;
  if (
    typeof type === "string" &&
    CANONICAL_CORE_SESSION_EVENT_TYPES.has(type)
  ) {
    if (sequence === undefined || !isJsonObject(payload)) return null;
    return { id, eventId, sequence, type, payload };
  }
  if (
    type === "request_user_input" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.turnId === "string" &&
    Array.isArray(payload.questions)
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        callId: payload.callId,
        requestId:
          typeof payload.requestId === "string"
            ? payload.requestId
            : payload.callId,
        turnId: payload.turnId,
        questions: jsonObjectArray(payload.questions),
        ...(isJsonObject(payload.clientAction)
          ? { clientAction: payload.clientAction }
          : {}),
      },
    };
  }
  if (
    type === "mcp_elicitation_request" &&
    isJsonObject(payload) &&
    typeof payload.serverName === "string" &&
    (typeof payload.requestId === "string" ||
      typeof payload.requestId === "number") &&
    typeof payload.turnId === "string" &&
    isJsonObject(payload.request)
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        serverName: payload.serverName,
        requestId: payload.requestId,
        turnId: payload.turnId,
        request: payload.request,
      },
    };
  }
  if (
    type === "mcp_elicitation_complete" &&
    isJsonObject(payload) &&
    typeof payload.serverName === "string" &&
    typeof payload.elicitationId === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        serverName: payload.serverName,
        elicitationId: payload.elicitationId,
      },
    };
  }
  if (
    type === "user_message" &&
    isJsonObject(payload) &&
    payload.message !== undefined
  ) {
    const messageId =
      typeof payload.messageId === "string" ? payload.messageId : undefined;
    const streamId =
      typeof payload.streamId === "string" ? payload.streamId : undefined;
    const acceptedAt =
      typeof payload.acceptedAt === "string" ? payload.acceptedAt : undefined;
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      ...(messageId !== undefined ? { messageId } : {}),
      ...(streamId !== undefined ? { streamId } : {}),
      ...(acceptedAt !== undefined ? { acceptedAt } : {}),
      payload: {
        message: payload.message,
        ...(messageId !== undefined ? { messageId } : {}),
        ...(streamId !== undefined ? { streamId } : {}),
        ...(acceptedAt !== undefined ? { acceptedAt } : {}),
        ...(typeof payload.displayText === "string"
          ? { displayText: payload.displayText }
          : {}),
        ...(Array.isArray(payload.images)
          ? { images: stringArray(payload.images) }
          : {}),
        ...(typeof payload.queuedCommandUuid === "string"
          ? { queuedCommandUuid: payload.queuedCommandUuid }
          : {}),
      },
    };
  }
  if (
    typeof type === "string" &&
    COLLAB_AGENT_SESSION_EVENT_TYPES.has(type) &&
    isJsonObject(payload) &&
    typeof payload.callId === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  // Provider token accounting for the latest model call. Telemetry like
  // collab_agent_status: clients drive live context gauges off it, and
  // without forwarding it a UI can only estimate context from transcript
  // characters — blind to tool output, which is where context really goes.
  if (
    type === "token_count" &&
    isJsonObject(payload) &&
    typeof payload.promptTokens === "number" &&
    typeof payload.totalTokens === "number"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  if (
    type === "tool_progress" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.toolName === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  // Assistant message-complete boundaries. `agent_message` is emitted per
  // completed assistant message segment (run-turn) and persisted to the
  // rollout, but the live wire only carried `agent_message_delta` — so a
  // daemon-attached TUI accumulated the deltas of CONSECUTIVE messages
  // into one streaming buffer with no separator ("…subagents.No M1-named
  // files…"). The reducer's agent_message case is what closes a segment
  // (pushes the completed row, clears the buffer); forward it live.
  if (
    type === "agent_message" &&
    isJsonObject(payload) &&
    typeof payload.message === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  // Per-stream provider usage. Emitted via `session.emit` from
  // `phases/stream-model.ts` (T6 #119) and persisted to the rollout, but
  // never bridged live — so a daemon-attached TUI had no usage source at
  // all: its synthesized assistant messages carry zero usage and the
  // workbench ctx% read 0 for the whole session. Forward the payload
  // verbatim; the TUI reducer derives `latestUsage` from it.
  if (type === "token_count" && isJsonObject(payload)) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  // Streaming tool-argument events (input_json_delta family). Same live
  // bridge gap as the thinking events below: providers that stream tool
  // arguments (grok function_call_arguments deltas, Messages-API
  // input_json_delta) emit these through stream-model, and the TUI needs
  // them for in-flight tool rendering, the spinner's cumulative token
  // estimate, and stream-liveness accounting.
  if (
    type === "tool_input_block_start" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.index === "number"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  if (
    type === "tool_input_delta" &&
    isJsonObject(payload) &&
    typeof payload.callId === "string" &&
    typeof payload.index === "number" &&
    typeof payload.partialJson === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload,
    };
  }
  // Extended-thinking + reasoning-summary events. These are emitted via
  // `session.emit` from `phases/stream-model.ts` and persisted to the
  // rollout, but the live notification path needs an explicit bridge:
  // the PhaseEvent → RunAgentProgressEvent → BackgroundAgentDaemonEvent
  // pipeline at `phaseEventToProgressEvent` does not carry them, so the
  // TUI's `event.session_event` catch-all never sees them without this.
  if (
    type === "assistant_thinking_block_start" &&
    isJsonObject(payload) &&
    typeof payload.index === "number"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        index: payload.index,
        redacted: payload.redacted === true,
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
      },
    };
  }
  if (
    type === "assistant_thinking_delta" &&
    isJsonObject(payload) &&
    typeof payload.delta === "string" &&
    typeof payload.index === "number"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        delta: payload.delta,
        index: payload.index,
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
      },
    };
  }
  if (
    type === "assistant_thinking_block_stop" &&
    isJsonObject(payload) &&
    typeof payload.index === "number"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        index: payload.index,
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
      },
    };
  }
  if (
    type === "agent_thinking" &&
    isJsonObject(payload) &&
    typeof payload.text === "string"
  ) {
    return {
      id,
      eventId,
      ...(sequence !== undefined ? { sequence } : {}),
      type,
      payload: {
        text: payload.text,
        ...(payload.redacted === true ? { redacted: true } : {}),
        ...(typeof payload.kind === "string" ? { kind: payload.kind } : {}),
      },
    };
  }
  return null;
}

function mapThreadStatus(status: ThreadAgentStatus): DaemonAgentStatus {
  switch (status.status) {
    case "completed":
    case "not_found":
    case "shutdown":
      return "stopped";
    case "interrupted":
    case "idle":
      return "idle";
    case "errored":
      return "error";
    case "pending_init":
    case "running":
      return "running";
  }
}

function eventFromThreadStatus(
  status: ThreadAgentStatus,
): BackgroundAgentDaemonEvent | null {
  switch (status.status) {
    case "running":
      return {
        id: status.turnId,
        type: "turn_started",
        payload: {
          turnId: status.turnId,
          ...(status.startedAtMs !== undefined
            ? { startedAt: status.startedAtMs }
            : {}),
        },
      };
    case "completed":
      return {
        id: status.turnId,
        type: "turn_complete",
        payload: {
          turnId: status.turnId,
          ...(status.lastMessage !== undefined
            ? { lastAgentMessage: status.lastMessage }
            : {}),
          ...(status.endedAtMs !== undefined
            ? { completedAt: status.endedAtMs }
            : {}),
        },
      };
    case "idle":
      // Keep-alive worker between turns: surface a turn_complete so the daemon
      // flips the agent to idle/completed instead of leaving it "running"
      // forever. The id must be unique per transition (the keep-alive turnId is
      // constant across turns), so suffix the monotonic end timestamp.
      return {
        id: `idle-${status.turnId}-${status.endedAtMs}`,
        type: "turn_complete",
        payload: {
          turnId: status.turnId,
          completedAt: status.endedAtMs,
        },
      };
    case "errored":
      return {
        id: status.turnId,
        type: "error",
        payload: {
          cause: "background_agent_error",
          message: status.error,
          turnId: status.turnId,
        },
      };
    case "interrupted":
      return {
        id: `interrupted-${status.turnId}`,
        type: "agent_status",
        payload: {
          status: "idle",
          runStatus: "completed",
          turnId: status.turnId,
          message: status.reason,
        },
      };
    case "shutdown":
      return {
        id: `shutdown-${status.endedAtMs}`,
        type: "agent_status",
        payload: {
          status: "stopped",
          runStatus: "stopped",
          message: "shutdown",
        },
      };
    case "not_found":
      return {
        id: "not-found",
        type: "agent_status",
        payload: {
          status: "stopped",
          runStatus: "stopped",
          message: "not_found",
        },
      };
    case "pending_init":
      return null;
  }
}

export {
  sessionUserMessageEventFromDaemonEvent,
  correlateDaemonEvent,
  projectTelemetryErrorAsSessionOnly,
  scopeDirectShellDaemonEvent,
  daemonStatusFromRunTerminal,
  mapThreadStatus,
  eventFromThreadStatus,
};
