/**
 * useQuery — bridges the AgenC session event stream into React state.
 *
 * Subscribes to a structural `SessionLike` on mount, accumulates
 * `PhaseEvent` values for the current turn, and exposes a terminal-safe
 * `submit` wrapper that delegates to the session's own submit path when
 * available.
 *
 * Why `SessionLike` (structural) instead of the concrete `Session`:
 *   - Tests still need lightweight stubs without touching the 40+
 *     Session constructor requirements.
 *   - The live Session now exposes a bootstrap-installed
 *     `submit`/`subscribeToEvents` contract, but the hook intentionally
 *     stays structural so replay harnesses and future adapters can drive
 *     the same TUI surface without subclassing `Session`.
 *
 * Event handling rules:
 *   - `turn_start` clears the accumulator and flips `isStreaming` to true.
 *   - Any other event type is appended while streaming.
 *   - `turn_complete` flips `isStreaming` to false but keeps the event list
 *     visible so the renderer can keep painting the final turn.
 *
 * Fallbacks:
 *   - If `session.subscribeToEvents` is missing we log once to stderr and
 *     return a no-op subscription; the hook still renders and `submit`
 *     still works through whatever path the session provides.
 *   - If `session.submit` is missing we log once to stderr on invocation.
 *
 * @module
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import type { PhaseEvent } from "../../phases/events.js";
import type { Event } from "../../session/event-log.js";
import type {
  TranscriptEventEnvelope,
  TranscriptSlashResultEvent,
  TranscriptSourceEvent,
} from "../state/events-to-messages.js";
import {
  appendBoundedTranscriptText,
  truncateTranscriptJsonArgs,
  truncateTranscriptText,
} from "../state/transcript-limits.js";

/**
 * Minimal structural shape this hook depends on. Any Session-like
 * object — the real `Session`, a deterministic test stub, or a replay
 * harness — can drive the hook as long as it matches this surface.
 */
export interface SessionLike {
  readonly activeTurn: {
    unsafePeek(): { readonly turnId: string } | null;
  } | null;
  subscribeToEvents?(
    cb: (event: PhaseEvent | TranscriptSlashResultEvent) => void,
  ): () => void;
  readonly eventLog?: {
    subscribe(cb: (event: Event) => void): () => void;
  };
  readonly initialTranscriptEvents?: readonly TranscriptSourceEvent[];
  getInitialTranscriptEvents?(): readonly TranscriptSourceEvent[];
  submit?(message: string): Promise<void>;
  abortTerminal(reason: string): void;
}

export interface UseQueryResult {
  readonly events: readonly TranscriptSourceEvent[];
  readonly isStreaming: boolean;
  readonly currentTurnId: string | null;
  submit(message: string): Promise<void>;
}

interface QueryState {
  events: TranscriptSourceEvent[];
  isStreaming: boolean;
  currentTurnId: string | null;
  seenEventKeys: Set<string>;
  lastEventSeq: number;
}

const MAX_BUFFERED_TRANSCRIPT_EVENTS = 2_500;
const TARGET_BUFFERED_TRANSCRIPT_EVENTS = 2_000;
const MAX_BUFFERED_TRANSCRIPT_CHARS = 1_500_000;
const TARGET_BUFFERED_TRANSCRIPT_CHARS = 1_000_000;

interface ResetPayload {
  readonly initialEvents: readonly TranscriptSourceEvent[];
  readonly liveTurnId: string | null;
}

type AgentMessageDeltaEnvelope = Extract<
  TranscriptEventEnvelope,
  { readonly type: "agent_message_delta" }
>;
type AgentMessageEnvelope = Extract<
  TranscriptEventEnvelope,
  { readonly type: "agent_message" }
>;
type ToolProgressEnvelope = Extract<
  TranscriptEventEnvelope,
  { readonly type: "tool_progress" }
>;

type QueryAction =
  | {
      readonly kind: "reset";
      readonly payload: ResetPayload;
    }
  | { readonly kind: "event"; readonly event: TranscriptSourceEvent };

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}

function transcriptEventKey(event: TranscriptSourceEvent): string | null {
  if ("seq" in event && typeof event.seq === "number") {
    return `seq:${event.seq}`;
  }
  if ("id" in event && typeof event.id === "string" && event.id.length > 0) {
    return `id:${event.id}`;
  }
  if (
    event.type === "slash_result" &&
    typeof event.timestamp === "number"
  ) {
    return `slash:${event.turnId ?? ""}:${event.input}:${event.timestamp}`;
  }
  if (!("payload" in event)) {
    return null;
  }
  return `${event.type}:${stableSerialize(event.payload)}`;
}

function transcriptEventSeq(event: TranscriptSourceEvent): number | null {
  return "seq" in event && typeof event.seq === "number" ? event.seq : null;
}

function sanitizeTranscriptEventForTui(
  event: TranscriptSourceEvent,
): TranscriptSourceEvent {
  switch (event.type) {
    case "tool_progress":
      return {
        ...event,
        payload: {
          ...event.payload,
          chunk: truncateTranscriptText(event.payload.chunk),
        },
      };
    case "tool_call_started":
      return {
        ...event,
        payload: {
          ...event.payload,
          args: truncateTranscriptJsonArgs(event.payload.args),
        },
      };
    case "tool_call_completed":
      return {
        ...event,
        payload: {
          ...event.payload,
          result: truncateTranscriptText(event.payload.result),
        },
      };
    case "exec_command_end":
      return {
        ...event,
        payload: {
          ...event.payload,
          ...(typeof event.payload.stdout === "string"
            ? { stdout: truncateTranscriptText(event.payload.stdout) }
            : {}),
          ...(typeof event.payload.stderr === "string"
            ? { stderr: truncateTranscriptText(event.payload.stderr) }
            : {}),
        },
      };
    case "tool_call":
      return {
        ...event,
        toolCall: {
          ...event.toolCall,
          arguments: truncateTranscriptJsonArgs(event.toolCall.arguments),
        },
      };
    case "tool_result":
      return {
        ...event,
        result: {
          ...event.result,
          content: truncateTranscriptText(event.result.content),
        },
      };
    default:
      return event;
  }
}

function stringCost(value: unknown): number {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + stringCost(entry), 0);
  }
  if (value && typeof value === "object") {
    return Object.values(value).reduce(
      (sum, entry) => sum + stringCost(entry),
      0,
    );
  }
  return 0;
}

function eventStringCost(event: TranscriptSourceEvent): number {
  return stringCost(event);
}

function isPruneBoundaryEvent(event: TranscriptSourceEvent): boolean {
  return (
    event.type === "turn_start" ||
    event.type === "turn_started" ||
    event.type === "context_compacted"
  );
}

function pruneBufferedTranscriptEvents(
  events: readonly TranscriptSourceEvent[],
): {
  readonly events: TranscriptSourceEvent[];
  readonly rebuiltSeenKeys: boolean;
} {
  if (events.length <= MAX_BUFFERED_TRANSCRIPT_EVENTS) {
    const totalChars = events.reduce(
      (sum, event) => sum + eventStringCost(event),
      0,
    );
    if (totalChars <= MAX_BUFFERED_TRANSCRIPT_CHARS) {
      return { events: [...events], rebuiltSeenKeys: false };
    }
  }

  let startIndex = Math.max(0, events.length - TARGET_BUFFERED_TRANSCRIPT_EVENTS);
  let retainedChars = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    retainedChars += eventStringCost(events[index]!);
    if (
      retainedChars > TARGET_BUFFERED_TRANSCRIPT_CHARS &&
      index > startIndex
    ) {
      startIndex = index + 1;
      break;
    }
  }

  for (let index = startIndex; index < events.length - 1; index += 1) {
    if (isPruneBoundaryEvent(events[index]!)) {
      startIndex = index;
      break;
    }
  }

  if (startIndex <= 0) {
    return { events: [...events], rebuiltSeenKeys: false };
  }
  return {
    events: events.slice(startIndex),
    rebuiltSeenKeys: true,
  };
}

function isAgentMessageDeltaEvent(
  event: TranscriptSourceEvent,
): event is AgentMessageDeltaEnvelope {
  return event.type === "agent_message_delta";
}

function isAgentMessageEvent(
  event: TranscriptSourceEvent,
): event is AgentMessageEnvelope {
  return event.type === "agent_message";
}

function isToolProgressEvent(
  event: TranscriptSourceEvent,
): event is ToolProgressEnvelope {
  return event.type === "tool_progress";
}

function isCompactBoundaryEvent(event: TranscriptSourceEvent): boolean {
  return event.type === "context_compacted";
}

function findLastCompactBoundaryIndex(
  events: readonly TranscriptSourceEvent[],
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (isCompactBoundaryEvent(events[index]!)) return index;
  }
  return -1;
}

function rebuildSeenEventKeys(
  events: readonly TranscriptSourceEvent[],
): Set<string> {
  const seenEventKeys = new Set<string>();
  for (const event of events) {
    if (transcriptEventSeq(event) !== null) continue;
    const key = transcriptEventKey(event);
    if (key !== null) seenEventKeys.add(key);
  }
  return seenEventKeys;
}

function sameProgressSlot(
  left: ToolProgressEnvelope,
  right: ToolProgressEnvelope,
): boolean {
  return (
    left.payload.callId === right.payload.callId &&
    left.payload.toolName === right.payload.toolName &&
    (left.payload.stream ?? "status") === (right.payload.stream ?? "status") &&
    left.payload.processId === right.payload.processId
  );
}

function bufferTranscriptEvent(
  events: readonly TranscriptSourceEvent[],
  rawEvent: TranscriptSourceEvent,
): {
  readonly events: TranscriptSourceEvent[];
  readonly rebuiltSeenKeys: boolean;
} {
  const event = sanitizeTranscriptEventForTui(rawEvent);
  if (isCompactBoundaryEvent(event)) {
    const previousBoundary = findLastCompactBoundaryIndex(events);
    const retained =
      previousBoundary >= 0 ? events.slice(previousBoundary + 1) : [...events];
    const compacted = {
      events: [...retained, event],
      rebuiltSeenKeys: previousBoundary >= 0,
    };
    const pruned = pruneBufferedTranscriptEvents(compacted.events);
    return {
      events: pruned.events,
      rebuiltSeenKeys: compacted.rebuiltSeenKeys || pruned.rebuiltSeenKeys,
    };
  }

  const last = events.at(-1);
  if (
    last &&
    isAgentMessageDeltaEvent(last) &&
    isAgentMessageDeltaEvent(event)
  ) {
    const coalesced = [
      ...events.slice(0, -1),
      {
        ...event,
        payload: {
          delta: appendBoundedTranscriptText(
            last.payload.delta,
            event.payload.delta,
          ),
        },
      },
    ];
    const pruned = pruneBufferedTranscriptEvents(coalesced);
    return { events: pruned.events, rebuiltSeenKeys: pruned.rebuiltSeenKeys };
  }

  if (last && isAgentMessageDeltaEvent(last) && isAgentMessageEvent(event)) {
    const replaced = [...events.slice(0, -1), event];
    const pruned = pruneBufferedTranscriptEvents(replaced);
    return { events: pruned.events, rebuiltSeenKeys: pruned.rebuiltSeenKeys };
  }

  if (
    last &&
    isToolProgressEvent(last) &&
    isToolProgressEvent(event) &&
    sameProgressSlot(last, event)
  ) {
    const stream = event.payload.stream ?? "status";
    const chunk =
      stream === "stdout" || stream === "stderr"
        ? appendBoundedTranscriptText(last.payload.chunk, event.payload.chunk)
        : event.payload.chunk;
    const coalesced = [
      ...events.slice(0, -1),
      {
        ...event,
        payload: {
          ...event.payload,
          chunk,
        },
      },
    ];
    const pruned = pruneBufferedTranscriptEvents(coalesced);
    return { events: pruned.events, rebuiltSeenKeys: pruned.rebuiltSeenKeys };
  }

  const appended = [...events, event];
  const pruned = pruneBufferedTranscriptEvents(appended);
  return { events: pruned.events, rebuiltSeenKeys: pruned.rebuiltSeenKeys };
}

function buildEventIndex(events: readonly TranscriptSourceEvent[]): {
  readonly events: TranscriptSourceEvent[];
  readonly seenEventKeys: Set<string>;
  readonly lastEventSeq: number;
} {
  const dedupeKeys = new Set<string>();
  let buffered: TranscriptSourceEvent[] = [];
  let lastEventSeq = 0;
  for (const rawEvent of events) {
    const event = sanitizeTranscriptEventForTui(rawEvent);
    const seq = transcriptEventSeq(event);
    if (seq !== null && seq <= lastEventSeq) {
      continue;
    }
    const key = seq === null ? transcriptEventKey(event) : null;
    if (key !== null) {
      if (dedupeKeys.has(key)) {
        continue;
      }
      dedupeKeys.add(key);
    }
    if (seq !== null) {
      lastEventSeq = Math.max(lastEventSeq, seq);
    }
    buffered = bufferTranscriptEvent(buffered, event).events;
  }
  return {
    events: buffered,
    seenEventKeys: rebuildSeenEventKeys(buffered),
    lastEventSeq,
  };
}

function createInitialState(
  payload: ResetPayload = {
    initialEvents: [],
    liveTurnId: null,
  },
): QueryState {
  const { initialEvents, liveTurnId } = payload;
  const indexed = buildEventIndex(initialEvents);
  let isStreaming = false;
  let currentTurnId: string | null = null;
  for (const event of indexed.events) {
    if (event.type === "turn_start" || event.type === "turn_started") {
      isStreaming = true;
    }
    if (event.type === "turn_complete" || event.type === "turn_aborted") {
      isStreaming = false;
    }
    if (event.type === "turn_started") {
      const turnId =
        "payload" in event &&
        event.payload &&
        typeof event.payload === "object" &&
        "turnId" in event.payload &&
        typeof event.payload.turnId === "string"
          ? event.payload.turnId
          : null;
      if (turnId) currentTurnId = turnId;
    }
    if (event.type === "turn_start") {
      currentTurnId = `turn-${event.turnIndex + 1}`;
    }
  }
  return {
    events: [...indexed.events],
    // Resume / history hydration should not look like a live tail unless the
    // session still reports an active turn at mount/reset time.
    isStreaming: liveTurnId !== null ? true : false,
    currentTurnId: liveTurnId ?? currentTurnId,
    seenEventKeys: indexed.seenEventKeys,
    lastEventSeq: indexed.lastEventSeq,
  };
}

function reduceCurrentTurnId(
  priorTurnId: string | null,
  event: TranscriptSourceEvent,
): string | null {
  if (event.type === "turn_start") {
    return `turn-${event.turnIndex + 1}`;
  }
  if (
    event.type === "turn_started" &&
    "payload" in event &&
    event.payload &&
    typeof event.payload === "object" &&
    "turnId" in event.payload &&
    typeof event.payload.turnId === "string"
  ) {
    return event.payload.turnId;
  }
  return priorTurnId;
}

function reducer(state: QueryState, action: QueryAction): QueryState {
  switch (action.kind) {
    case "reset":
      return createInitialState(action.payload);
    case "event": {
      const event = sanitizeTranscriptEventForTui(action.event);
      const eventSeq = transcriptEventSeq(event);
      if (eventSeq !== null && eventSeq <= state.lastEventSeq) {
        return state;
      }
      const eventKey = eventSeq === null ? transcriptEventKey(event) : null;
      if (eventKey !== null && state.seenEventKeys.has(eventKey)) {
        return state;
      }
      const buffered = bufferTranscriptEvent(state.events, event);
      const nextSeenEventKeys = buffered.rebuiltSeenKeys
        ? rebuildSeenEventKeys(buffered.events)
        : new Set(state.seenEventKeys);
      if (eventKey !== null) {
        nextSeenEventKeys.add(eventKey);
      }
      const nextLastEventSeq =
        eventSeq !== null ? Math.max(state.lastEventSeq, eventSeq) : state.lastEventSeq;
      if (event.type === "turn_start" || event.type === "turn_started") {
        return {
          events: buffered.events,
          isStreaming: true,
          currentTurnId: reduceCurrentTurnId(state.currentTurnId, event),
          seenEventKeys: nextSeenEventKeys,
          lastEventSeq: nextLastEventSeq,
        };
      }
      if (event.type === "turn_complete" || event.type === "turn_aborted") {
        return {
          events: buffered.events,
          isStreaming: false,
          currentTurnId: reduceCurrentTurnId(state.currentTurnId, event),
          seenEventKeys: nextSeenEventKeys,
          lastEventSeq: nextLastEventSeq,
        };
      }
      return {
        events: buffered.events,
        isStreaming: state.isStreaming,
        currentTurnId: reduceCurrentTurnId(state.currentTurnId, event),
        seenEventKeys: nextSeenEventKeys,
        lastEventSeq: nextLastEventSeq,
      };
    }
    default:
      return state;
  }
}

function resolveInitialTranscriptEvents(
  session: SessionLike,
): readonly TranscriptSourceEvent[] {
  try {
    if (typeof session.getInitialTranscriptEvents === "function") {
      return session.getInitialTranscriptEvents() ?? [];
    }
  } catch {
    return [];
  }
  return session.initialTranscriptEvents ?? [];
}

function makeTranscriptEnvelope<K extends TranscriptEventEnvelope["type"]>(
  id: string | undefined,
  seq: number | undefined,
  type: K,
  payload: Extract<TranscriptEventEnvelope, { readonly type: K }>["payload"],
): Extract<TranscriptEventEnvelope, { readonly type: K }> {
  return {
    id,
    seq,
    type,
    payload,
  } as Extract<TranscriptEventEnvelope, { readonly type: K }>;
}

function toTranscriptEvent(event: Event): TranscriptEventEnvelope | null {
  switch (event.msg.type) {
    case "session_configured":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "turn_started":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "turn_complete":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "turn_aborted":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "user_message":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "agent_message":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "agent_message_delta":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "tool_call_started":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "tool_call_completed":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "tool_progress":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "exec_command_begin":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "exec_command_end":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "context_compacted":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "warning":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "error":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "stream_error":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "deprecation_notice":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "plan_started":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "plan_delta":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "plan_item_completed":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    case "plan_exited":
      return makeTranscriptEnvelope(event.id, event.seq, event.msg.type, event.msg.payload);
    default:
      return null;
  }
}

function isPhaseOnlyTranscriptEvent(
  event: PhaseEvent | TranscriptSlashResultEvent,
): event is TranscriptSlashResultEvent {
  return event.type === "slash_result";
}

/**
 * One-shot stderr warning. Multiple hook mounts should not spam the
 * terminal; we track each distinct tag in a module-local Set.
 */
const warned = new Set<string>();
function warnOnce(tag: string, message: string): void {
  if (warned.has(tag)) return;
  warned.add(tag);
  // Use stderr directly so ink's patchConsole and test stdout capture
  // don't swallow the warning. Keep the message structured for greppability.
  try {
    process.stderr.write(`[useQuery] ${message}\n`);
  } catch {
    // Some sandboxed test harnesses stub stderr; swallow to stay non-fatal.
  }
}

/**
 * Resolve the turn-id the session is currently running, or `null` if
 * the active-turn slot has not been populated yet.
 */
function peekTurnId(session: SessionLike): string | null {
  const slot = session.activeTurn;
  if (!slot) return null;
  try {
    const peek = slot.unsafePeek();
    return peek?.turnId ?? null;
  } catch {
    // unsafePeek can throw when the lock is held by a writer; treat that
    // as "no known turn id" rather than propagating into React render.
    return null;
  }
}

export function useQuery(session: SessionLike): UseQueryResult {
  const buildResetPayload = (): ResetPayload => ({
    initialEvents: resolveInitialTranscriptEvents(session),
    liveTurnId: peekTurnId(session),
  });
  const [state, dispatch] = useReducer(
    reducer,
    buildResetPayload(),
    createInitialState,
  );
  // Keep a ref to the session so the callback identity is stable even
  // if the caller passes a new object reference per render.
  const sessionRef = useRef<SessionLike>(session);
  sessionRef.current = session;

  useEffect(() => {
    dispatch({
      kind: "reset",
      payload: buildResetPayload(),
    });
  }, [session]);

  useEffect(() => {
    let disposed = false;
    const unsubscribers: Array<() => void> = [];
    const push = (event: TranscriptSourceEvent): void => {
      if (disposed) return;
      dispatch({ kind: "event", event });
    };

    const eventLogSubscribe = session.eventLog?.subscribe;
    if (typeof eventLogSubscribe === "function") {
      try {
        unsubscribers.push(
          eventLogSubscribe.call(session.eventLog, (event: Event) => {
            const transcriptEvent = toTranscriptEvent(event);
            if (transcriptEvent) {
              push(transcriptEvent);
            }
          }),
        );
      } catch (error) {
        warnOnce(
          "eventLog-subscribe-throw",
          `session.eventLog.subscribe threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    const subscribeToEvents = session.subscribeToEvents;
    if (typeof subscribeToEvents === "function") {
      try {
        unsubscribers.push(
          subscribeToEvents.call(session, (event) => {
            if (
              isPhaseOnlyTranscriptEvent(event) ||
              typeof eventLogSubscribe !== "function"
            ) {
              push(event);
            }
          }),
        );
      } catch (error) {
        warnOnce(
          "subscribeToEvents-throw",
          `session.subscribeToEvents threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (unsubscribers.length === 0) {
      warnOnce(
        "transcript-stream-missing",
        "session transcript stream is not wired; transcript will stay static.",
      );
      return undefined;
    }

    return () => {
      disposed = true;
      for (const unsubscribe of unsubscribers) {
        try {
          unsubscribe();
        } catch {
          // Unsubscribe errors are non-fatal; we're tearing down anyway.
        }
      }
    };
  }, [session]);

  const submit = useCallback(async (message: string): Promise<void> => {
    const current = sessionRef.current;
    const submitImpl = current.submit;
    if (typeof submitImpl !== "function") {
      warnOnce(
        "submit-missing",
        "session.submit is not wired; user input was dropped.",
      );
      return;
    }
    await submitImpl.call(current, message);
  }, []);

  return {
    events: state.events,
    isStreaming: state.isStreaming,
    currentTurnId: state.currentTurnId ?? peekTurnId(session),
    submit,
  };
}

/**
 * Testing-only helper. Resets the warn-once Set so tests that mount
 * bare sessions in isolation can re-assert "warn was emitted".
 */
export function __resetWarnOnceForTests(): void {
  warned.clear();
}
