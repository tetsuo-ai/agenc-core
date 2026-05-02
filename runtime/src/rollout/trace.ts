/**
 * Ports the narrow writer/bundle slice of upstream Rust `rollout-trace/` into
 * AgenC debug bundles. Bundles are append-only and self-contained: manifest,
 * raw event JSONL, and payload files.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { JsonValue } from "../app-server/protocol/index.js";
import { AGENC_ROLLOUT_TRACE_DIR } from "./metadata.js";

export const AGENC_ROLLOUT_TRACE_FORMAT = "agenc.rollout.trace";
export const AGENC_ROLLOUT_TRACE_SCHEMA_VERSION = 1;
export const AGENC_ROLLOUT_TRACE_REDUCED_FORMAT = "agenc.rollout.trace.reduced";
export const AGENC_ROLLOUT_TRACE_REDUCED_STATE_FILE = "state.json";

export interface AgenCRolloutTraceManifest {
  readonly format: typeof AGENC_ROLLOUT_TRACE_FORMAT;
  readonly schemaVersion: typeof AGENC_ROLLOUT_TRACE_SCHEMA_VERSION;
  readonly traceId: string;
  readonly rolloutId: string;
  readonly rootSessionId: string;
  readonly createdAt: string;
  readonly rawEventLog: string;
  readonly payloadsDir: string;
}

export interface AgenCRolloutTracePayloadRef {
  readonly payloadId: string;
  readonly kind: string;
  readonly path: string;
}

export interface AgenCRolloutTraceEvent {
  readonly schemaVersion: typeof AGENC_ROLLOUT_TRACE_SCHEMA_VERSION;
  readonly seq: number;
  readonly traceId: string;
  readonly rolloutId: string;
  readonly writtenAt: string;
  readonly payload: JsonValue;
}

export type AgenCRolloutTraceExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "aborted";

export interface AgenCRolloutTraceReducedState {
  readonly format: typeof AGENC_ROLLOUT_TRACE_REDUCED_FORMAT;
  readonly schemaVersion: typeof AGENC_ROLLOUT_TRACE_SCHEMA_VERSION;
  readonly traceId: string;
  readonly rolloutId: string;
  readonly rootSessionId: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: AgenCRolloutTraceExecutionStatus;
  readonly eventCount: number;
  readonly sessions: Record<string, AgenCRolloutTraceReducedSession>;
  readonly turns: Record<string, AgenCRolloutTraceReducedTurn>;
  readonly toolCalls: Record<string, AgenCRolloutTraceReducedToolCall>;
  readonly inferenceCalls: Record<string, AgenCRolloutTraceReducedInferenceCall>;
  readonly conversationItems: Record<string, AgenCRolloutTraceReducedEventObject>;
  readonly codeCells: Record<string, AgenCRolloutTraceReducedEventObject>;
  readonly terminalSessions: Record<string, AgenCRolloutTraceReducedEventObject>;
  readonly terminalOperations: Record<string, AgenCRolloutTraceReducedEventObject>;
  readonly compactions: Record<string, AgenCRolloutTraceReducedEventObject>;
  readonly compactionRequests: Record<string, AgenCRolloutTraceReducedEventObject>;
  readonly interactionEdges: Record<string, AgenCRolloutTraceReducedEventObject>;
  readonly protocolEvents: Record<string, AgenCRolloutTraceReducedEventObject>;
  readonly rawPayloads: Record<string, AgenCRolloutTracePayloadRef>;
}

export interface AgenCRolloutTraceReducedSession {
  readonly sessionId: string;
  readonly agentPath?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly status: AgenCRolloutTraceExecutionStatus;
}

export interface AgenCRolloutTraceReducedTurn {
  readonly turnId: string;
  readonly sessionId?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: AgenCRolloutTraceExecutionStatus;
  readonly eventSeqs: readonly number[];
}

export interface AgenCRolloutTraceReducedToolCall {
  readonly toolCallId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly kind?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: AgenCRolloutTraceExecutionStatus;
  readonly eventSeqs: readonly number[];
}

export interface AgenCRolloutTraceReducedInferenceCall {
  readonly inferenceCallId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly model?: string;
  readonly providerName?: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly status: AgenCRolloutTraceExecutionStatus;
  readonly eventSeqs: readonly number[];
  readonly conversationItemIds?: readonly string[];
}

export interface AgenCRolloutTraceReducedEventObject {
  readonly id: string;
  readonly type: string;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly status?: AgenCRolloutTraceExecutionStatus;
  readonly payload: JsonValue;
  readonly eventSeqs: readonly number[];
}

const MANIFEST_FILE = "manifest.json";
const TRACE_FILE = "trace.jsonl";
const PAYLOADS_DIR = "payloads";

export class AgenCRolloutTraceBundle {
  readonly bundleDir: string;
  readonly manifest: AgenCRolloutTraceManifest;
  #seq = 0;

  constructor(options: {
    readonly rootDir: string;
    readonly rolloutId: string;
    readonly rootSessionId: string;
    readonly traceId?: string;
    readonly createdAt?: string;
  }) {
    const traceId = options.traceId ?? randomUUID();
    assertSafeTraceId(traceId);
    this.bundleDir = join(options.rootDir, AGENC_ROLLOUT_TRACE_DIR, traceId);
    mkdirSync(join(this.bundleDir, PAYLOADS_DIR), { recursive: true, mode: 0o700 });
    this.manifest = {
      format: AGENC_ROLLOUT_TRACE_FORMAT,
      schemaVersion: AGENC_ROLLOUT_TRACE_SCHEMA_VERSION,
      traceId,
      rolloutId: options.rolloutId,
      rootSessionId: options.rootSessionId,
      createdAt: options.createdAt ?? new Date().toISOString(),
      rawEventLog: TRACE_FILE,
      payloadsDir: PAYLOADS_DIR,
    };
    writeFileSync(
      join(this.bundleDir, MANIFEST_FILE),
      `${JSON.stringify(this.manifest, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    writeFileSync(join(this.bundleDir, TRACE_FILE), "", {
      encoding: "utf8",
      flag: "a",
      mode: 0o600,
    });
  }

  writePayload(kind: string, payload: JsonValue): AgenCRolloutTracePayloadRef {
    const payloadId = randomUUID();
    const path = join(PAYLOADS_DIR, `${payloadId}.json`);
    writeFileSync(
      join(this.bundleDir, path),
      `${JSON.stringify(payload, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    return { payloadId, kind, path };
  }

  appendEvent(
    payload: JsonValue,
    options: { readonly now?: () => string } = {},
  ): AgenCRolloutTraceEvent {
    const event: AgenCRolloutTraceEvent = {
      schemaVersion: AGENC_ROLLOUT_TRACE_SCHEMA_VERSION,
      seq: this.#seq + 1,
      traceId: this.manifest.traceId,
      rolloutId: this.manifest.rolloutId,
      writtenAt: options.now?.() ?? new Date().toISOString(),
      payload,
    };
    appendFileSync(join(this.bundleDir, TRACE_FILE), `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.#seq = event.seq;
    return event;
  }
}

export function readAgenCRolloutTraceBundle(bundleDir: string): {
  readonly manifest: AgenCRolloutTraceManifest;
  readonly events: readonly AgenCRolloutTraceEvent[];
} {
  const manifest = JSON.parse(
    readFileSync(join(bundleDir, MANIFEST_FILE), "utf8"),
  );
  const normalizedManifest = normalizeTraceManifest(manifest);
  const tracePath = resolveBundlePath(
    bundleDir,
    normalizedManifest.rawEventLog,
    "trace event log",
  );
  const events = existsSync(tracePath)
    ? readFileSync(tracePath, "utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => normalizeTraceEvent(JSON.parse(line), normalizedManifest))
    : [];
  return { manifest: normalizedManifest, events };
}

export function replayAgenCRolloutTraceBundle(
  bundleDir: string,
  options: { readonly writeCache?: boolean } = {},
): AgenCRolloutTraceReducedState {
  const { manifest, events } = readAgenCRolloutTraceBundle(bundleDir);
  const tracePath = resolveBundlePath(bundleDir, manifest.rawEventLog, "trace event log");
  if (!existsSync(tracePath)) {
    throw new Error(`trace event log missing: ${tracePath}`);
  }
  let state: AgenCRolloutTraceReducedState = {
    format: AGENC_ROLLOUT_TRACE_REDUCED_FORMAT,
    schemaVersion: AGENC_ROLLOUT_TRACE_SCHEMA_VERSION,
    traceId: manifest.traceId,
    rolloutId: manifest.rolloutId,
    rootSessionId: manifest.rootSessionId,
    startedAt: manifest.createdAt,
    status: "running",
    eventCount: events.length,
    sessions: {
      [manifest.rootSessionId]: {
        sessionId: manifest.rootSessionId,
        status: "running",
        startedAt: manifest.createdAt,
      },
    },
    turns: {},
    toolCalls: {},
    inferenceCalls: {},
    conversationItems: {},
    codeCells: {},
    terminalSessions: {},
    terminalOperations: {},
    compactions: {},
    compactionRequests: {},
    interactionEdges: {},
    protocolEvents: {},
    rawPayloads: {},
  };

  let expectedSeq = 1;
  for (const event of events) {
    if (event.seq !== expectedSeq) {
      throw new Error(`trace event sequence gap: expected ${expectedSeq}, got ${event.seq}`);
    }
    validatePayloadRefs(bundleDir, manifest.payloadsDir, event);
    state = reduceTraceEvent(state, event, bundleDir);
    expectedSeq += 1;
  }

  if (options.writeCache === true) {
    writeFileSync(
      join(bundleDir, AGENC_ROLLOUT_TRACE_REDUCED_STATE_FILE),
      `${JSON.stringify(state, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  return state;
}

export function readAgenCRolloutTraceReducedState(
  bundleDir: string,
): AgenCRolloutTraceReducedState {
  return JSON.parse(
    readFileSync(join(bundleDir, AGENC_ROLLOUT_TRACE_REDUCED_STATE_FILE), "utf8"),
  ) as AgenCRolloutTraceReducedState;
}

function reduceTraceEvent(
  state: AgenCRolloutTraceReducedState,
  event: AgenCRolloutTraceEvent,
  bundleDir: string,
): AgenCRolloutTraceReducedState {
  const payload = asRecord(event.payload);
  if (payload === undefined) return state;

  const rawPayloads = { ...state.rawPayloads };
  for (const ref of findPayloadRefs(event.payload)) {
    rawPayloads[ref.payloadId] = ref;
  }

  let next: AgenCRolloutTraceReducedState = { ...state, rawPayloads };
  const type = readString(payload.type);
  if (type === "rollout_ended") {
    next = {
      ...next,
      status: readStatus(payload.status, "completed"),
      endedAt: event.writtenAt,
    };
  } else if (type === "thread_started" || type === "session_started") {
    const sessionId = readAnyString(payload, "threadId", "thread_id", "sessionId", "session_id");
    if (sessionId !== undefined) {
      const agentPath = readAnyString(payload, "agentPath", "agent_path");
      const existing = next.sessions[sessionId];
      if (existing?.agentPath !== undefined) {
        throw new Error(`trace session started twice: ${sessionId}`);
      }
      next = {
        ...next,
        sessions: {
          ...next.sessions,
          [sessionId]: {
            ...next.sessions[sessionId],
            sessionId,
            ...(agentPath !== undefined ? { agentPath } : {}),
            startedAt: event.writtenAt,
            status: "running",
          },
        },
      };
    }
  } else if (type === "thread_ended" || type === "session_ended") {
    const sessionId = readAnyString(payload, "threadId", "thread_id", "sessionId", "session_id");
    if (sessionId !== undefined) {
      if (next.sessions[sessionId] === undefined) {
        throw new Error(`trace session ended before start: ${sessionId}`);
      }
      next = updateSession(next, sessionId, {
        endedAt: event.writtenAt,
        status: readStatus(payload.status, "completed"),
      });
    }
  } else if (type === "agenc_turn_started" || type === "turn_started") {
    const turnId = readAnyString(
      payload,
      "agencTurnId",
      "agenc_turn_id",
      "turnId",
      "turn_id",
    );
    if (turnId !== undefined) {
      if (next.turns[turnId] !== undefined) {
        throw new Error(`trace turn started twice: ${turnId}`);
      }
      next = upsertTurn(next, turnId, {
        sessionId: readAnyString(payload, "threadId", "thread_id", "sessionId", "session_id"),
        startedAt: event.writtenAt,
        status: "running",
        eventSeqs: [event.seq],
      });
    }
  } else if (type === "agenc_turn_ended" || type === "turn_complete") {
    const turnId = readAnyString(
      payload,
      "agencTurnId",
      "agenc_turn_id",
      "turnId",
      "turn_id",
    );
    if (turnId !== undefined) {
      if (next.turns[turnId] === undefined) {
        throw new Error(`trace turn ended before start: ${turnId}`);
      }
      next = upsertTurn(next, turnId, {
        endedAt: event.writtenAt,
        status: readStatus(payload.status, "completed"),
        eventSeqs: [event.seq],
      });
    }
  } else if (type === "tool_call_started" || type === "tool_dispatch_started") {
    const toolCallId = readAnyString(payload, "toolCallId", "tool_call_id", "callId", "call_id");
    if (toolCallId !== undefined) {
      if (next.toolCalls[toolCallId] !== undefined) {
        throw new Error(`trace tool call started twice: ${toolCallId}`);
      }
      const sessionId = readAnyString(payload, "threadId", "thread_id", "sessionId", "session_id");
      const turnId = readAnyString(
        payload,
        "agencTurnId",
        "agenc_turn_id",
        "turnId",
        "turn_id",
      );
      validateTurnOwner(next, turnId, sessionId);
      next = upsertToolCall(next, toolCallId, {
        sessionId,
        turnId,
        kind: readString(payload.kind) ?? readString(payload.toolName),
        startedAt: event.writtenAt,
        status: "running",
        eventSeqs: [event.seq],
      });
    }
  } else if (type === "tool_call_ended" || type === "tool_dispatch_ended") {
    const toolCallId = readAnyString(payload, "toolCallId", "tool_call_id", "callId", "call_id");
    if (toolCallId !== undefined) {
      if (next.toolCalls[toolCallId] === undefined) {
        throw new Error(`trace tool call ended before start: ${toolCallId}`);
      }
      next = upsertToolCall(next, toolCallId, {
        endedAt: event.writtenAt,
        status: readStatus(payload.status, "completed"),
        eventSeqs: [event.seq],
      });
    }
  } else if (type === "inference_attempt_started" || type === "inference_started") {
    const inferenceCallId = readAnyString(
      payload,
      "inferenceCallId",
      "inference_call_id",
      "inferenceAttemptId",
      "inference_attempt_id",
      "inferenceId",
      "inference_id",
    );
    if (inferenceCallId !== undefined) {
      if (next.inferenceCalls[inferenceCallId] !== undefined) {
        throw new Error(`trace inference started twice: ${inferenceCallId}`);
      }
      const sessionId = readAnyString(payload, "threadId", "thread_id", "sessionId", "session_id");
      const turnId = readAnyString(
        payload,
        "agencTurnId",
        "agenc_turn_id",
        "turnId",
        "turn_id",
      );
      validateTurnOwner(next, turnId, sessionId);
      next = upsertInferenceCall(next, inferenceCallId, {
        sessionId,
        turnId,
        model: readString(payload.model),
        providerName: readAnyString(payload, "providerName", "provider_name"),
        startedAt: event.writtenAt,
        status: "running",
        eventSeqs: [event.seq],
      });
      next = reduceInferencePayloadConversationItems(
        next,
        bundleDir,
        inferenceCallId,
        event,
        firstPayloadRef(payload.request_payload ?? payload.requestPayload),
      );
    }
  } else if (
    type === "inference_attempt_completed" ||
    type === "inference_attempt_ended" ||
    type === "inference_completed" ||
    type === "inference_attempt_failed" ||
    type === "inference_failed" ||
    type === "inference_cancelled"
  ) {
    const inferenceCallId = readAnyString(
      payload,
      "inferenceCallId",
      "inference_call_id",
      "inferenceAttemptId",
      "inference_attempt_id",
      "inferenceId",
      "inference_id",
    );
    if (inferenceCallId !== undefined) {
      if (next.inferenceCalls[inferenceCallId] === undefined) {
        throw new Error(`trace inference ended before start: ${inferenceCallId}`);
      }
      next = upsertInferenceCall(next, inferenceCallId, {
        endedAt: event.writtenAt,
        status: type.endsWith("failed")
          ? "failed"
          : type.endsWith("cancelled")
            ? "cancelled"
            : readStatus(payload.status, "completed"),
        eventSeqs: [event.seq],
      });
      next = reduceInferencePayloadConversationItems(
        next,
        bundleDir,
        inferenceCallId,
        event,
        firstPayloadRef(
          payload.response_payload ??
            payload.responsePayload ??
            payload.partial_response_payload ??
            payload.partialResponsePayload,
        ),
      );
    }
  } else if (type === "conversation_item_observed") {
    const itemId = readAnyString(payload, "itemId", "item_id", "conversationItemId", "conversation_item_id") ??
      `conversation:${event.seq}`;
    next = upsertReducedEventObject(next, "conversationItems", itemId, event, payload);
  } else if (type === "code_cell_started") {
    const codeCellId = readAnyString(
      payload,
      "codeCellId",
      "code_cell_id",
      "runtimeCellId",
      "runtime_cell_id",
    ) ?? `code-cell:${event.seq}`;
    next = upsertReducedEventObject(next, "codeCells", codeCellId, event, payload, {
      status: "running",
      startedAt: event.writtenAt,
    });
  } else if (type === "code_cell_initial_response" || type === "code_cell_ended") {
    const codeCellId = readAnyString(
      payload,
      "codeCellId",
      "code_cell_id",
      "runtimeCellId",
      "runtime_cell_id",
    ) ?? `code-cell:${event.seq}`;
    next = upsertReducedEventObject(next, "codeCells", codeCellId, event, payload, {
      status: readStatus(payload.status, type === "code_cell_ended" ? "completed" : "running"),
      ...(type === "code_cell_ended" ? { endedAt: event.writtenAt } : {}),
    });
  } else if (
    type === "tool_call_runtime_started" ||
    type === "tool_call_runtime_ended"
  ) {
    const operationId = readAnyString(payload, "terminalOperationId", "terminal_operation_id") ??
      `${readAnyString(payload, "toolCallId", "tool_call_id") ?? "tool"}:runtime`;
    next = upsertReducedEventObject(next, "terminalOperations", operationId, event, payload, {
      status: type.endsWith("ended") ? readStatus(payload.status, "completed") : "running",
      ...(type.endsWith("ended") ? { endedAt: event.writtenAt } : { startedAt: event.writtenAt }),
    });
    const terminalId = readAnyString(payload, "terminalId", "terminal_id");
    if (terminalId !== undefined) {
      next = upsertReducedEventObject(next, "terminalSessions", terminalId, event, payload);
    }
  } else if (
    type === "compaction_request_started" ||
    type === "compaction_request_completed" ||
    type === "compaction_request_ended" ||
    type === "compaction_request_failed"
  ) {
    const requestId = readAnyString(
      payload,
      "compactionRequestId",
      "compaction_request_id",
    ) ?? readAnyString(payload, "compactionId", "compaction_id") ??
      `compaction-request:${event.seq}`;
    next = upsertReducedEventObject(next, "compactionRequests", requestId, event, payload, {
      status: type.endsWith("started")
        ? "running"
        : type.endsWith("failed")
          ? "failed"
          : readStatus(payload.status, "completed"),
      ...(type.endsWith("started") ? { startedAt: event.writtenAt } : { endedAt: event.writtenAt }),
    });
  } else if (type === "compaction_installed") {
    const compactionId = readAnyString(payload, "compactionId", "compaction_id") ??
      `compaction:${event.seq}`;
    next = upsertReducedEventObject(next, "compactions", compactionId, event, payload, {
      status: "completed",
      endedAt: event.writtenAt,
    });
  } else if (type === "agent_result_observed") {
    const edgeId = readAnyString(payload, "edgeId", "edge_id") ?? `edge:${event.seq}`;
    next = upsertReducedEventObject(next, "interactionEdges", edgeId, event, payload);
  } else if (type === "protocol_event_observed") {
    const protocolId = readAnyString(payload, "eventId", "event_id") ??
      `protocol:${event.seq}`;
    next = upsertReducedEventObject(next, "protocolEvents", protocolId, event, payload);
  }

  return next;
}

function updateSession(
  state: AgenCRolloutTraceReducedState,
  sessionId: string,
  patch: Partial<AgenCRolloutTraceReducedSession>,
): AgenCRolloutTraceReducedState {
  return {
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: {
        ...state.sessions[sessionId],
        ...patch,
        sessionId,
        status: patch.status ?? state.sessions[sessionId]?.status ?? "running",
      },
    },
  };
}

function upsertTurn(
  state: AgenCRolloutTraceReducedState,
  turnId: string,
  patch: Partial<AgenCRolloutTraceReducedTurn>,
): AgenCRolloutTraceReducedState {
  const current = state.turns[turnId];
  const eventSeqs = [...(current?.eventSeqs ?? []), ...(patch.eventSeqs ?? [])];
  return {
    ...state,
    turns: {
      ...state.turns,
      [turnId]: {
        ...current,
        ...patch,
        turnId,
        startedAt: patch.startedAt ?? current?.startedAt ?? state.startedAt,
        status: patch.status ?? current?.status ?? "running",
        eventSeqs,
      },
    },
  };
}

function upsertToolCall(
  state: AgenCRolloutTraceReducedState,
  toolCallId: string,
  patch: Partial<AgenCRolloutTraceReducedToolCall>,
): AgenCRolloutTraceReducedState {
  const current = state.toolCalls[toolCallId];
  const eventSeqs = [...(current?.eventSeqs ?? []), ...(patch.eventSeqs ?? [])];
  return {
    ...state,
    toolCalls: {
      ...state.toolCalls,
      [toolCallId]: {
        ...current,
        ...patch,
        toolCallId,
        startedAt: patch.startedAt ?? current?.startedAt ?? state.startedAt,
        status: patch.status ?? current?.status ?? "running",
        eventSeqs,
      },
    },
  };
}

function upsertInferenceCall(
  state: AgenCRolloutTraceReducedState,
  inferenceCallId: string,
  patch: Partial<AgenCRolloutTraceReducedInferenceCall>,
): AgenCRolloutTraceReducedState {
  const current = state.inferenceCalls[inferenceCallId];
  const eventSeqs = [...(current?.eventSeqs ?? []), ...(patch.eventSeqs ?? [])];
  return {
    ...state,
    inferenceCalls: {
      ...state.inferenceCalls,
      [inferenceCallId]: {
        ...current,
        ...patch,
        inferenceCallId,
        startedAt: patch.startedAt ?? current?.startedAt ?? state.startedAt,
        status: patch.status ?? current?.status ?? "running",
        eventSeqs,
      },
    },
  };
}

function validateTurnOwner(
  state: AgenCRolloutTraceReducedState,
  turnId: string | undefined,
  sessionId: string | undefined,
): void {
  if (turnId === undefined || sessionId === undefined) return;
  const turn = state.turns[turnId];
  if (turn !== undefined && turn.sessionId !== undefined && turn.sessionId !== sessionId) {
    throw new Error(`trace turn owner mismatch: ${turnId}`);
  }
}

function reduceInferencePayloadConversationItems(
  state: AgenCRolloutTraceReducedState,
  bundleDir: string,
  inferenceCallId: string,
  event: AgenCRolloutTraceEvent,
  payloadRef: AgenCRolloutTracePayloadRef | undefined,
): AgenCRolloutTraceReducedState {
  if (payloadRef === undefined) return state;
  const payload = JSON.parse(readFileSync(resolve(bundleDir, payloadRef.path), "utf8")) as JsonValue;
  const items = extractConversationPayloadItems(payload);
  if (items.length === 0) return state;
  let next = state;
  const conversationItemIds = [
    ...(state.inferenceCalls[inferenceCallId]?.conversationItemIds ?? []),
  ];
  items.forEach((item, index) => {
    const itemObject = asRecord(item);
    const id = readAnyString(itemObject ?? {}, "id", "item_id") ??
      `${inferenceCallId}:${payloadRef.kind}:${index + 1}`;
    conversationItemIds.push(id);
    next = upsertReducedEventObject(next, "conversationItems", id, event, {
      type: "conversation_item",
      payload: item,
    });
  });
  return upsertInferenceCall(next, inferenceCallId, {
    conversationItemIds,
    eventSeqs: [],
  });
}

function extractConversationPayloadItems(payload: JsonValue): JsonValue[] {
  if (Array.isArray(payload)) return payload;
  const object = asRecord(payload);
  if (object === undefined) return [];
  for (const key of ["items", "messages", "input", "output"]) {
    const value = object[key];
    if (Array.isArray(value)) return value;
  }
  if (readString(object.role) !== undefined && object.content !== undefined) {
    return [object];
  }
  return [];
}

function firstPayloadRef(value: JsonValue | undefined): AgenCRolloutTracePayloadRef | undefined {
  return value === undefined ? undefined : findPayloadRefs(value)[0];
}

function upsertReducedEventObject(
  state: AgenCRolloutTraceReducedState,
  collection: keyof Pick<
    AgenCRolloutTraceReducedState,
    | "conversationItems"
    | "codeCells"
    | "terminalSessions"
    | "terminalOperations"
    | "compactions"
    | "compactionRequests"
    | "interactionEdges"
    | "protocolEvents"
  >,
  id: string,
  event: AgenCRolloutTraceEvent,
  payload: Record<string, JsonValue>,
  patch: Partial<AgenCRolloutTraceReducedEventObject> = {},
): AgenCRolloutTraceReducedState {
  const current = state[collection][id];
  return {
    ...state,
    [collection]: {
      ...state[collection],
      [id]: {
        ...current,
        ...patch,
        id,
        type: readString(payload.type) ?? "unknown",
        sessionId: patch.sessionId ??
          current?.sessionId ??
          readAnyString(payload, "threadId", "thread_id", "sessionId", "session_id"),
        turnId: patch.turnId ??
          current?.turnId ??
          readAnyString(payload, "agencTurnId", "agenc_turn_id", "turnId", "turn_id"),
        payload,
        eventSeqs: [...(current?.eventSeqs ?? []), event.seq],
      },
    },
  };
}

function normalizeTraceEvent(
  parsed: unknown,
  manifest: AgenCRolloutTraceManifest,
): AgenCRolloutTraceEvent {
  const object = asRecord(parsed as JsonValue);
  if (object === undefined) throw new Error("trace event must be an object");
  if (typeof object.schemaVersion === "number") {
    if (
      typeof object.wallTimeUnixMs === "number" ||
      object.traceId === undefined ||
      object.writtenAt === undefined
    ) {
      return normalizeCurrentRawTraceEvent(object, manifest);
    }
    if (object.schemaVersion !== AGENC_ROLLOUT_TRACE_SCHEMA_VERSION) {
      throw new Error(`unsupported trace event schemaVersion: ${object.schemaVersion}`);
    }
    if (typeof object.seq !== "number" || typeof object.writtenAt !== "string") {
      throw new Error("trace event envelope missing seq or writtenAt");
    }
    if (typeof object.traceId !== "string" || object.traceId.length === 0) {
      throw new Error("trace event envelope missing traceId");
    }
    if (object.traceId !== manifest.traceId) {
      throw new Error("trace event traceId does not match manifest");
    }
    if (typeof object.rolloutId !== "string" || object.rolloutId.length === 0) {
      throw new Error("trace event envelope missing rolloutId");
    }
    if (object.rolloutId !== manifest.rolloutId) {
      throw new Error("trace event rolloutId does not match manifest");
    }
    if (object.payload === undefined) {
      throw new Error("trace event envelope missing payload");
    }
    return object as unknown as AgenCRolloutTraceEvent;
  }
  if (typeof object.schema_version !== "number") {
    throw new Error("raw trace event missing schema_version");
  }
  if (object.schema_version !== AGENC_ROLLOUT_TRACE_SCHEMA_VERSION) {
    throw new Error(`unsupported raw trace event schema_version: ${object.schema_version}`);
  }
  const seq = typeof object.seq === "number" ? object.seq : undefined;
  const payload = enrichPayloadWithEnvelopeContext(object.payload, object);
  if (seq === undefined || payload === undefined) {
    throw new Error("trace event envelope missing seq or payload");
  }
  if (typeof object.wall_time_unix_ms !== "number") {
    throw new Error("raw trace event missing wall_time_unix_ms");
  }
  const rolloutId = readString(object.rollout_id);
  if (rolloutId === undefined || rolloutId.length === 0) {
    throw new Error("raw trace event missing rollout_id");
  }
  if (rolloutId !== manifest.rolloutId) {
    throw new Error("raw trace event rollout_id does not match manifest");
  }
  return {
    schemaVersion: AGENC_ROLLOUT_TRACE_SCHEMA_VERSION,
    seq,
    traceId: manifest.traceId,
    rolloutId,
    writtenAt: new Date(object.wall_time_unix_ms).toISOString(),
    payload,
  };
}

function normalizeCurrentRawTraceEvent(
  object: Record<string, JsonValue>,
  manifest: AgenCRolloutTraceManifest,
): AgenCRolloutTraceEvent {
  if (object.schemaVersion !== AGENC_ROLLOUT_TRACE_SCHEMA_VERSION) {
    throw new Error(`unsupported trace event schemaVersion: ${object.schemaVersion}`);
  }
  if (typeof object.seq !== "number") {
    throw new Error("trace event envelope missing seq");
  }
  if (typeof object.wallTimeUnixMs !== "number") {
    throw new Error("trace event envelope missing wallTimeUnixMs");
  }
  const rolloutId = readString(object.rolloutId);
  if (rolloutId === undefined || rolloutId.length === 0) {
    throw new Error("trace event envelope missing rolloutId");
  }
  if (rolloutId !== manifest.rolloutId) {
    throw new Error("trace event rolloutId does not match manifest");
  }
  const payload = enrichPayloadWithEnvelopeContext(object.payload, object);
  if (payload === undefined) throw new Error("trace event envelope missing payload");
  return {
    schemaVersion: AGENC_ROLLOUT_TRACE_SCHEMA_VERSION,
    seq: object.seq,
    traceId: manifest.traceId,
    rolloutId,
    writtenAt: new Date(object.wallTimeUnixMs).toISOString(),
    payload,
  };
}

function normalizeTraceManifest(parsed: unknown): AgenCRolloutTraceManifest {
  const object = asRecord(parsed as JsonValue);
  if (object === undefined) throw new Error("trace manifest must be an object");
  const schemaVersion = typeof object.schemaVersion === "number"
    ? object.schemaVersion
    : typeof object.schema_version === "number"
      ? object.schema_version
      : undefined;
  if (schemaVersion !== AGENC_ROLLOUT_TRACE_SCHEMA_VERSION) {
    throw new Error("unsupported trace manifest schema version");
  }
  const startedAtMs = typeof object.started_at_unix_ms === "number"
    ? object.started_at_unix_ms
    : undefined;
  const traceId = readAnyString(object, "traceId", "trace_id");
  const rolloutId = readAnyString(object, "rolloutId", "rollout_id");
  const rootSessionId = readAnyString(object, "rootSessionId", "rootThreadId", "root_thread_id");
  const createdAt = readAnyString(object, "createdAt", "created_at") ??
    (typeof object.startedAtUnixMs === "number"
      ? new Date(object.startedAtUnixMs).toISOString()
      : startedAtMs !== undefined
        ? new Date(startedAtMs).toISOString()
        : undefined);
  if (traceId === undefined || traceId.length === 0) {
    throw new Error("trace manifest missing trace_id");
  }
  if (rolloutId === undefined || rolloutId.length === 0) {
    throw new Error("trace manifest missing rollout_id");
  }
  if (rootSessionId === undefined || rootSessionId.length === 0) {
    throw new Error("trace manifest missing root_thread_id");
  }
  if (createdAt === undefined || createdAt.length === 0) {
    throw new Error("trace manifest missing timestamp");
  }
  return {
    format: AGENC_ROLLOUT_TRACE_FORMAT,
    schemaVersion: AGENC_ROLLOUT_TRACE_SCHEMA_VERSION,
    traceId,
    rolloutId,
    rootSessionId,
    createdAt,
    rawEventLog: readAnyString(object, "rawEventLog", "raw_event_log") ?? TRACE_FILE,
    payloadsDir: readAnyString(object, "payloadsDir", "payloads_dir") ?? PAYLOADS_DIR,
  };
}

function enrichPayloadWithEnvelopeContext(
  payload: JsonValue | undefined,
  envelope: Record<string, JsonValue>,
): JsonValue | undefined {
  const payloadObject = asRecord(payload);
  if (payloadObject === undefined) return payload;
  return normalizePayloadNames({
    ...payloadObject,
    ...(payloadObject.thread_id === undefined && (envelope.thread_id ?? envelope.threadId) !== undefined
      ? { thread_id: envelope.thread_id ?? envelope.threadId }
      : {}),
    ...(payloadObject.agenc_turn_id === undefined &&
      (envelope.agenc_turn_id ?? envelope.agencTurnId) !== undefined
      ? { agenc_turn_id: envelope.agenc_turn_id ?? envelope.agencTurnId }
      : {}),
    ...(payloadObject.agenc_turn_id === undefined
      ? optionalRecordField("agenc_turn_id", readSuffixedString(envelope, "_turn_id"))
      : {}),
  });
}

function normalizePayloadNames(
  payload: Record<string, JsonValue>,
): Record<string, JsonValue> {
  const type = readString(payload.type);
  const mappedType = type?.endsWith("_turn_started")
    ? "agenc_turn_started"
    : type?.endsWith("_turn_ended")
      ? "agenc_turn_ended"
      : type;
  return {
    ...payload,
    ...(mappedType !== undefined ? { type: mappedType } : {}),
    ...(payload.agenc_turn_id === undefined
      ? optionalRecordField("agenc_turn_id", readSuffixedString(payload, "_turn_id"))
      : {}),
  };
}

function validatePayloadRefs(
  bundleDir: string,
  payloadsDir: string,
  event: AgenCRolloutTraceEvent,
): void {
  for (const ref of findPayloadRefs(event.payload)) {
    const payloadPath = resolve(bundleDir, ref.path);
    const payloadRoot = resolveBundlePath(bundleDir, payloadsDir, "payload directory");
    if (!isPathInside(payloadRoot, payloadPath)) {
      throw new Error(`trace payload escapes payload root: ${ref.path}`);
    }
    if (!existsSync(payloadPath)) {
      throw new Error(`trace payload missing: ${ref.path}`);
    }
  }
}

function findPayloadRefs(value: JsonValue): AgenCRolloutTracePayloadRef[] {
  if (value === null || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry) => findPayloadRefs(entry));
  const object = value as Record<string, JsonValue>;
  const payloadId = readAnyString(object, "payloadId", "payload_id", "rawPayloadId", "raw_payload_id");
  const path = readString(object.path);
  if (payloadId !== undefined && path !== undefined) {
    return [{ payloadId, kind: readPayloadKind(object.kind), path }];
  }
  return Object.values(object).flatMap((entry) => findPayloadRefs(entry));
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, JsonValue>;
}

function readString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readAnyString(
  object: Record<string, JsonValue>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = readString(object[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readSuffixedString(
  object: Record<string, JsonValue>,
  suffix: string,
): string | undefined {
  for (const [key, value] of Object.entries(object)) {
    if (key.endsWith(suffix) && typeof value === "string") return value;
  }
  return undefined;
}

function optionalRecordField(
  key: string,
  value: JsonValue | undefined,
): Record<string, JsonValue> {
  return value === undefined ? {} : { [key]: value };
}

function readPayloadKind(value: JsonValue | undefined): string {
  const direct = readString(value);
  if (direct !== undefined) return direct;
  const object = asRecord(value);
  return readString(object?.type) ?? "payload";
}

function readStatus(
  value: JsonValue | undefined,
  fallback: AgenCRolloutTraceExecutionStatus,
): AgenCRolloutTraceExecutionStatus {
  return value === "running" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "aborted"
    ? value
    : fallback;
}

function assertSafeTraceId(traceId: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(traceId)) {
    throw new Error(`unsafe rollout trace id: ${traceId}`);
  }
}

function resolveBundlePath(
  bundleDir: string,
  manifestPath: string,
  label: string,
): string {
  if (isAbsolute(manifestPath)) {
    throw new Error(`${label} path must be relative: ${manifestPath}`);
  }
  const target = resolve(bundleDir, manifestPath);
  const base = resolve(bundleDir);
  if (!isPathInside(base, target)) {
    throw new Error(`${label} path escapes trace bundle: ${manifestPath}`);
  }
  return target;
}

function isPathInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}
