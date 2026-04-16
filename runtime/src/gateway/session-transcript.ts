import { randomUUID } from "node:crypto";
import type { LLMMessage } from "../llm/types.js";
import { repairToolTurnSequence } from "../llm/tool-turn-validator.js";
import type {
  MemoryBackend,
  TranscriptCapableMemoryBackend,
  TranscriptEvent,
  TranscriptEventInput,
  TranscriptMessagePayload,
  TranscriptMetadataProjectionPayload,
  TranscriptCustomPayload,
} from "../memory/types.js";
import {
  SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY,
  SESSION_INTERACTIVE_CONTEXT_STATE_METADATA_KEY,
  SESSION_REVIEW_SURFACE_STATE_METADATA_KEY,
  SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY,
  SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY,
  SESSION_SHELL_PROFILE_METADATA_KEY,
  SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY,
  SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY,
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  SESSION_STATEFUL_SESSION_START_CONTEXT_MESSAGES_METADATA_KEY,
  SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY,
  SESSION_WORKFLOW_STATE_METADATA_KEY,
} from "./session.js";

const TRANSCRIPT_KV_PREFIX = "transcript:v1:";
const SUBAGENT_TRANSCRIPT_PREFIX = "subagent-session:";
const BACKGROUND_RUN_TRANSCRIPT_PREFIX = "background-run-session:";
const CONTINUE_FROM_INTERRUPTED_TURN_PROMPT = "Continue from where you left off.";
const SESSION_METADATA_PROJECTION_KEY = "session.metadata";
const ALLOWED_SESSION_METADATA_KEYS = new Set<string>([
  SESSION_SHELL_PROFILE_METADATA_KEY,
  SESSION_WORKFLOW_STATE_METADATA_KEY,
  SESSION_STATEFUL_RESUME_ANCHOR_METADATA_KEY,
  SESSION_STATEFUL_HISTORY_COMPACTED_METADATA_KEY,
  SESSION_STATEFUL_ARTIFACT_CONTEXT_METADATA_KEY,
  SESSION_STATEFUL_ARTIFACT_RECORDS_METADATA_KEY,
  SESSION_ACTIVE_TASK_CONTEXT_METADATA_KEY,
  SESSION_REVIEW_SURFACE_STATE_METADATA_KEY,
  SESSION_VERIFICATION_SURFACE_STATE_METADATA_KEY,
  SESSION_RUNTIME_CONTRACT_SNAPSHOT_METADATA_KEY,
  SESSION_RUNTIME_CONTRACT_STATUS_SNAPSHOT_METADATA_KEY,
  SESSION_STATEFUL_SESSION_START_CONTEXT_MESSAGES_METADATA_KEY,
  SESSION_INTERACTIVE_CONTEXT_STATE_METADATA_KEY,
]);

export interface TranscriptRecoveryOptions {
  readonly injectContinuationPrompt?: boolean;
}

export interface TranscriptInterruptionState {
  readonly kind: "none" | "interrupted_prompt";
  readonly message?: LLMMessage;
}

export interface TranscriptRecoveryState {
  readonly history: readonly LLMMessage[];
  readonly metadata?: Record<string, unknown>;
  readonly interruption: TranscriptInterruptionState;
}

export type SessionTranscriptEvent =
  | SessionTranscriptMessageEvent
  | SessionTranscriptHistorySnapshotEvent
  | SessionTranscriptMetadataProjectionEvent;

export interface SessionTranscriptBaseEvent {
  readonly version: 1;
  readonly seq?: number;
  readonly eventId: string;
  readonly dedupeKey?: string;
  readonly timestamp: number;
  readonly surface:
    | "webchat"
    | "text"
    | "voice"
    | "subagent"
    | "background"
    | "system";
}

export interface SessionTranscriptMessageEvent
  extends SessionTranscriptBaseEvent {
  readonly kind: "message";
  readonly message: LLMMessage;
}

export interface SessionTranscriptHistorySnapshotEvent
  extends SessionTranscriptBaseEvent {
  readonly kind: "history_snapshot";
  readonly reason: "migration" | "compaction" | "fork";
  readonly history: readonly LLMMessage[];
  readonly boundaryId?: string;
}

export interface SessionTranscriptMetadataProjectionEvent
  extends SessionTranscriptBaseEvent {
  readonly kind: "metadata_projection";
  readonly key: string;
  readonly value: unknown;
}

export interface SessionTranscriptDocument {
  readonly version: 1;
  readonly streamId: string;
  readonly nextSeq: number;
  readonly events: readonly SessionTranscriptEvent[];
}

function transcriptKey(streamId: string): string {
  return `${TRANSCRIPT_KV_PREFIX}${streamId}`;
}

function cloneMessage(message: LLMMessage): LLMMessage {
  return JSON.parse(JSON.stringify(message)) as LLMMessage;
}

function cloneEvent(event: SessionTranscriptEvent): SessionTranscriptEvent {
  return JSON.parse(JSON.stringify(event)) as SessionTranscriptEvent;
}

function cloneUnknown<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isWhitespaceOnlyMessage(message: LLMMessage): boolean {
  if (typeof message.content === "string") {
    return message.content.trim().length === 0;
  }
  if (!Array.isArray(message.content)) {
    return false;
  }
  return message.content.every((part) =>
    part.type === "text" ? part.text.trim().length === 0 : false
  );
}

function dropWhitespaceOnlyAssistantMessages(
  history: readonly LLMMessage[],
): readonly LLMMessage[] {
  if (history.length === 0) return history;
  const filtered = history.filter((message, index) => {
    if (message.role !== "assistant") return true;
    if (message.toolCalls && message.toolCalls.length > 0) return true;
    const isLast = index === history.length - 1;
    if (isLast) return true;
    return !isWhitespaceOnlyMessage(message);
  });
  return filtered.length === history.length ? history : filtered;
}

function dropUnresolvedToolTurns(
  history: readonly LLMMessage[],
): readonly LLMMessage[] {
  const issued = new Set<string>();
  const resolved = new Set<string>();
  for (const message of history) {
    if (message.role === "assistant" && message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        const id = toolCall.id?.trim();
        if (id) issued.add(id);
      }
    }
    if (message.role === "tool") {
      const id = message.toolCallId?.trim();
      if (id) resolved.add(id);
    }
  }
  if (issued.size === resolved.size) {
    let allResolved = true;
    for (const id of issued) {
      if (!resolved.has(id)) {
        allResolved = false;
        break;
      }
    }
    if (allResolved) {
      return history;
    }
  }

  const next: LLMMessage[] = [];
  for (const message of history) {
    if (
      message.role === "assistant" &&
      message.toolCalls &&
      message.toolCalls.length > 0
    ) {
      const unresolvedCalls = message.toolCalls.filter((toolCall) => {
        const id = toolCall.id?.trim();
        return id ? !resolved.has(id) : true;
      });
      if (unresolvedCalls.length === message.toolCalls.length) {
        continue;
      }
      if (unresolvedCalls.length > 0) {
        next.push({
          ...cloneMessage(message),
          toolCalls: message.toolCalls.filter((toolCall) => {
            const id = toolCall.id?.trim();
            return id ? resolved.has(id) : false;
          }),
        });
        continue;
      }
    }
    if (message.role === "tool") {
      const id = message.toolCallId?.trim();
      if (id && !issued.has(id)) {
        continue;
      }
    }
    next.push(cloneMessage(message));
  }
  return next;
}

function detectInterruptedTurn(
  history: readonly LLMMessage[],
): TranscriptInterruptionState {
  const lastRelevant = [...history]
    .reverse()
    .find((message) => message.role !== "system");
  if (!lastRelevant) {
    return { kind: "none" };
  }
  if (lastRelevant.role === "assistant" || lastRelevant.role === "tool") {
    return { kind: "none" };
  }
  const content =
    typeof lastRelevant.content === "string"
      ? lastRelevant.content.trim()
      : lastRelevant.content
          .filter((part) => part.type === "text")
          .map((part) => part.text.trim())
          .join(" ")
          .trim();
  if (content.length === 0 || content === CONTINUE_FROM_INTERRUPTED_TURN_PROMPT) {
    return { kind: "none" };
  }
  return { kind: "interrupted_prompt", message: cloneMessage(lastRelevant) };
}

function sanitizeProjectedSessionMetadata(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {};
  for (const key of ALLOWED_SESSION_METADATA_KEYS) {
    if (key in candidate) {
      projected[key] = cloneUnknown(candidate[key]);
    }
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

function normalizeSurface(
  value: unknown,
): SessionTranscriptBaseEvent["surface"] {
  switch (value) {
    case "webchat":
    case "text":
    case "voice":
    case "subagent":
    case "background":
    case "system":
      return value;
    default:
      return "system";
  }
}

function normalizeDocument(
  streamId: string,
  value: unknown,
): SessionTranscriptDocument {
  if (
    value &&
    typeof value === "object" &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { events?: unknown }).events)
  ) {
    const candidate = value as SessionTranscriptDocument;
    return {
      version: 1,
      streamId,
      nextSeq:
        typeof candidate.nextSeq === "number" && Number.isFinite(candidate.nextSeq)
          ? candidate.nextSeq
          : candidate.events.length + 1,
      events: candidate.events.map((event) => cloneEvent(event)),
    };
  }
  return {
    version: 1,
    streamId,
    nextSeq: 1,
    events: [],
  };
}

function toStoredTranscriptInput(
  event: SessionTranscriptEvent,
): TranscriptEventInput {
  const metadata = { surface: event.surface } satisfies Record<string, unknown>;
  switch (event.kind) {
    case "message":
      return {
        version: 1,
        eventId: event.eventId,
        dedupeKey: event.dedupeKey,
        timestamp: event.timestamp,
        metadata,
        kind: "message",
        payload: {
          role: event.message.role,
          content: cloneUnknown(event.message.content),
          ...(event.message.phase ? { phase: event.message.phase } : {}),
          ...(event.message.toolCalls
            ? { toolCalls: cloneUnknown(event.message.toolCalls) }
            : {}),
          ...(event.message.toolCallId
            ? { toolCallId: event.message.toolCallId }
            : {}),
          ...(event.message.toolName ? { toolName: event.message.toolName } : {}),
        },
      };
    case "metadata_projection":
      return {
        version: 1,
        eventId: event.eventId,
        dedupeKey: event.dedupeKey,
        timestamp: event.timestamp,
        metadata,
        kind: "metadata_projection",
        payload: {
          key: event.key,
          value: cloneUnknown(event.value),
        },
      };
    case "history_snapshot":
      return {
        version: 1,
        eventId: event.eventId,
        dedupeKey: event.dedupeKey,
        timestamp: event.timestamp,
        metadata,
        kind: "custom",
        payload: {
          name: "history_snapshot",
          data: {
            reason: event.reason,
            ...(event.boundaryId ? { boundaryId: event.boundaryId } : {}),
            history: event.history.map((message) => cloneMessage(message)),
          },
        },
      };
  }
}

function fromStoredTranscriptEvent(
  event: TranscriptEvent,
): SessionTranscriptEvent | undefined {
  const surface = normalizeSurface(event.metadata?.surface);
  switch (event.kind) {
    case "message": {
      const payload = event.payload as TranscriptMessagePayload;
      return {
        version: 1,
        seq: event.seq,
        eventId: event.eventId,
        ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
        timestamp: event.timestamp,
        surface,
        kind: "message",
        message: {
          role: payload.role,
          content: cloneUnknown(payload.content),
          ...(payload.phase ? { phase: payload.phase } : {}),
          ...(payload.toolCalls
            ? { toolCalls: cloneUnknown(payload.toolCalls) }
            : {}),
          ...(payload.toolCallId
            ? { toolCallId: payload.toolCallId }
            : {}),
          ...(payload.toolName ? { toolName: payload.toolName } : {}),
        },
      };
    }
    case "metadata_projection": {
      const payload = event.payload as TranscriptMetadataProjectionPayload;
      return {
        version: 1,
        seq: event.seq,
        eventId: event.eventId,
        ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
        timestamp: event.timestamp,
        surface,
        kind: "metadata_projection",
        key: payload.key,
        value: cloneUnknown(payload.value),
      };
    }
    case "custom": {
      const payload = event.payload as TranscriptCustomPayload;
      if (payload.name !== "history_snapshot") {
        return undefined;
      }
      if (
        !payload.data ||
        typeof payload.data !== "object" ||
        !Array.isArray((payload.data as { history?: unknown }).history)
      ) {
        return undefined;
      }
      return {
        version: 1,
        seq: event.seq,
        eventId: event.eventId,
        ...(event.dedupeKey ? { dedupeKey: event.dedupeKey } : {}),
        timestamp: event.timestamp,
        surface,
        kind: "history_snapshot",
        reason:
          (payload.data as { reason?: unknown }).reason === "migration" ||
          (payload.data as { reason?: unknown }).reason === "fork"
            ? ((payload.data as { reason: "migration" | "fork" }).reason)
            : "compaction",
        history: (payload.data as { history: readonly LLMMessage[] }).history.map(
          (message) => cloneMessage(message),
        ),
        ...((payload.data as { boundaryId?: unknown }).boundaryId &&
        typeof (payload.data as { boundaryId?: unknown }).boundaryId ===
          "string"
          ? {
              boundaryId: (payload.data as { boundaryId: string }).boundaryId,
            }
          : {}),
      };
    }
    default:
      return undefined;
  }
}

async function appendTranscriptBatchFallback(
  memoryBackend: MemoryBackend,
  streamId: string,
  events: readonly SessionTranscriptEvent[],
): Promise<SessionTranscriptEvent[]> {
  const key = transcriptKey(streamId);
  const current = normalizeDocument(
    streamId,
    await memoryBackend.get<SessionTranscriptDocument>(key),
  );
  const existingEventIds = new Set(current.events.map((event) => event.eventId));
  const existingDedupeKeys = new Set(
    current.events
      .map((event) => event.dedupeKey)
      .filter((value): value is string => typeof value === "string"),
  );

  let nextSeq = current.nextSeq;
  const appended: SessionTranscriptEvent[] = [];
  const mergedEvents = [...current.events];
  for (const event of events) {
    if (existingEventIds.has(event.eventId)) {
      continue;
    }
    if (event.dedupeKey && existingDedupeKeys.has(event.dedupeKey)) {
      continue;
    }
    const normalized: SessionTranscriptEvent = {
      ...cloneEvent(event),
      seq: nextSeq++,
    };
    mergedEvents.push(normalized);
    appended.push(normalized);
    existingEventIds.add(normalized.eventId);
    if (normalized.dedupeKey) {
      existingDedupeKeys.add(normalized.dedupeKey);
    }
  }

  await memoryBackend.set(key, {
    version: 1,
    streamId,
    nextSeq,
    events: mergedEvents,
  } satisfies SessionTranscriptDocument);
  return appended;
}

export async function appendTranscriptBatch(
  memoryBackend: MemoryBackend,
  streamId: string,
  events: readonly SessionTranscriptEvent[],
): Promise<SessionTranscriptEvent[]> {
  const capable = memoryBackend as MemoryBackend & TranscriptCapableMemoryBackend;
  if (typeof capable.appendTranscript === "function") {
    const stored = await capable.appendTranscript(
      streamId,
      events.map((event) => toStoredTranscriptInput(event)),
    );
    return stored
      .map((event) => fromStoredTranscriptEvent(event))
      .filter((event): event is SessionTranscriptEvent => event !== undefined);
  }
  return appendTranscriptBatchFallback(memoryBackend, streamId, events);
}

export async function loadTranscript(
  memoryBackend: MemoryBackend,
  streamId: string,
  afterSeq?: number,
): Promise<SessionTranscriptDocument | undefined> {
  const capable = memoryBackend as MemoryBackend & TranscriptCapableMemoryBackend;
  if (typeof capable.loadTranscript === "function") {
    const stored = await capable.loadTranscript(streamId, {
      ...(afterSeq === undefined ? {} : { afterSeq }),
    });
    if (stored.length === 0) {
      return undefined;
    }
    return {
      version: 1,
      streamId,
      nextSeq: stored[stored.length - 1]!.seq + 1,
      events: stored
        .map((event) => fromStoredTranscriptEvent(event))
        .filter((event): event is SessionTranscriptEvent => event !== undefined),
    };
  }

  const document = normalizeDocument(
    streamId,
    await memoryBackend.get<SessionTranscriptDocument>(transcriptKey(streamId)),
  );
  if (document.events.length === 0) {
    return undefined;
  }
  if (afterSeq === undefined) {
    return document;
  }
  return {
    ...document,
    events: document.events.filter((event) => (event.seq ?? 0) > afterSeq),
  };
}

export async function deleteTranscript(
  memoryBackend: MemoryBackend,
  streamId: string,
): Promise<boolean> {
  const capable = memoryBackend as MemoryBackend & TranscriptCapableMemoryBackend;
  if (typeof capable.deleteTranscript === "function") {
    return (await capable.deleteTranscript(streamId)) > 0;
  }
  return memoryBackend.delete(transcriptKey(streamId));
}

export async function listTranscriptStreams(
  memoryBackend: MemoryBackend,
  prefix?: string,
): Promise<string[]> {
  const capable = memoryBackend as MemoryBackend & TranscriptCapableMemoryBackend;
  if (typeof capable.listTranscriptStreams === "function") {
    return capable.listTranscriptStreams(prefix);
  }
  const keys = await memoryBackend.listKeys(
    `${TRANSCRIPT_KV_PREFIX}${prefix ?? ""}`,
  );
  return keys.map((key) => key.slice(TRANSCRIPT_KV_PREFIX.length));
}

export function subAgentTranscriptStreamId(sessionId: string): string {
  return `${SUBAGENT_TRANSCRIPT_PREFIX}${sessionId}`;
}

export function backgroundRunTranscriptStreamId(sessionId: string): string {
  return `${BACKGROUND_RUN_TRANSCRIPT_PREFIX}${sessionId}`;
}

export function historyFromTranscript(
  document: SessionTranscriptDocument | undefined,
): readonly LLMMessage[] {
  if (!document) return [];
  let history: LLMMessage[] = [];
  for (const event of document.events) {
    if (event.kind === "history_snapshot") {
      history = event.history.map((message) => cloneMessage(message));
      continue;
    }
    if (event.kind === "message") {
      history.push(cloneMessage(event.message));
    }
  }
  return history;
}

export function metadataFromTranscript(
  document: SessionTranscriptDocument | undefined,
): Record<string, unknown> | undefined {
  if (!document) return undefined;
  let metadata: Record<string, unknown> | undefined;
  for (const event of document.events) {
    if (
      event.kind === "metadata_projection" &&
      event.key === SESSION_METADATA_PROJECTION_KEY
    ) {
      metadata = sanitizeProjectedSessionMetadata(event.value);
    }
  }
  return metadata ? cloneUnknown(metadata) : undefined;
}

export function recoverTranscriptState(
  document: SessionTranscriptDocument | undefined,
  options?: TranscriptRecoveryOptions,
): TranscriptRecoveryState {
  const history = historyFromTranscript(document);
  const withoutWhitespace = dropWhitespaceOnlyAssistantMessages(history);
  const withoutUnresolved = dropUnresolvedToolTurns(withoutWhitespace);
  const interruption = detectInterruptedTurn(withoutUnresolved);
  const recovered = withoutUnresolved.map((message) => cloneMessage(message));
  if (
    options?.injectContinuationPrompt === true &&
    interruption.kind === "interrupted_prompt"
  ) {
    recovered.push({
      role: "user",
      content: CONTINUE_FROM_INTERRUPTED_TURN_PROMPT,
    });
  }
  return {
    history: repairToolTurnSequence(recovered, {
      repairMissingResults: true,
    }),
    metadata: metadataFromTranscript(document),
    interruption,
  };
}

export function recoverTranscriptHistory(
  document: SessionTranscriptDocument | undefined,
  options?: TranscriptRecoveryOptions,
): readonly LLMMessage[] {
  return recoverTranscriptState(document, options).history;
}

export function createTranscriptMessageEvent(params: {
  readonly surface: SessionTranscriptBaseEvent["surface"];
  readonly message: LLMMessage;
  readonly dedupeKey?: string;
  readonly timestamp?: number;
}): SessionTranscriptMessageEvent {
  return {
    version: 1,
    eventId: randomUUID(),
    ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
    timestamp: params.timestamp ?? Date.now(),
    surface: params.surface,
    kind: "message",
    message: cloneMessage(params.message),
  };
}

export function createTranscriptHistorySnapshotEvent(params: {
  readonly surface: SessionTranscriptBaseEvent["surface"];
  readonly history: readonly LLMMessage[];
  readonly reason: SessionTranscriptHistorySnapshotEvent["reason"];
  readonly dedupeKey?: string;
  readonly timestamp?: number;
  readonly boundaryId?: string;
}): SessionTranscriptHistorySnapshotEvent {
  return {
    version: 1,
    eventId: randomUUID(),
    ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
    timestamp: params.timestamp ?? Date.now(),
    surface: params.surface,
    kind: "history_snapshot",
    reason: params.reason,
    history: params.history.map((message) => cloneMessage(message)),
    ...(params.boundaryId ? { boundaryId: params.boundaryId } : {}),
  };
}

export function createTranscriptMetadataProjectionEvent(params: {
  readonly surface: SessionTranscriptBaseEvent["surface"];
  readonly key: string;
  readonly value: unknown;
  readonly dedupeKey?: string;
  readonly timestamp?: number;
}): SessionTranscriptMetadataProjectionEvent {
  return {
    version: 1,
    eventId: randomUUID(),
    ...(params.dedupeKey ? { dedupeKey: params.dedupeKey } : {}),
    timestamp: params.timestamp ?? Date.now(),
    surface: params.surface,
    kind: "metadata_projection",
    key: params.key,
    value: cloneUnknown(params.value),
  };
}

export async function forkTranscript(
  memoryBackend: MemoryBackend,
  sourceStreamId: string,
  targetStreamId: string,
): Promise<boolean> {
  const loaded = await loadTranscript(memoryBackend, sourceStreamId);
  if (!loaded || loaded.events.length === 0) {
    return false;
  }
  await appendTranscriptBatch(
    memoryBackend,
    targetStreamId,
    loaded.events.map((event) => ({
      ...cloneEvent(event),
      eventId: randomUUID(),
      seq: undefined,
      dedupeKey: undefined,
    })),
  );
  return true;
}
