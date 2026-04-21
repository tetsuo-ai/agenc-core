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
  TranscriptSourceEvent,
} from "../state/events-to-messages.js";

/**
 * Minimal structural shape this hook depends on. Any Session-like
 * object — the real `Session`, a deterministic test stub, or a replay
 * harness — can drive the hook as long as it matches this surface.
 */
export interface SessionLike {
  readonly activeTurn: {
    unsafePeek(): { readonly turnId: string } | null;
  } | null;
  subscribeToEvents?(cb: (event: PhaseEvent) => void): () => void;
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
}

type QueryAction =
  | {
      readonly kind: "reset";
      readonly initialEvents: readonly TranscriptSourceEvent[];
    }
  | { readonly kind: "event"; readonly event: TranscriptSourceEvent };

function createInitialState(
  initialEvents: readonly TranscriptSourceEvent[] = [],
): QueryState {
  let isStreaming = false;
  let currentTurnId: string | null = null;
  for (const event of initialEvents) {
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
    events: [...initialEvents],
    isStreaming,
    currentTurnId,
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
      return createInitialState(action.initialEvents);
    case "event": {
      const { event } = action;
      if (event.type === "turn_start" || event.type === "turn_started") {
        return {
          events: [...state.events, event],
          isStreaming: true,
          currentTurnId: reduceCurrentTurnId(state.currentTurnId, event),
        };
      }
      if (event.type === "turn_complete" || event.type === "turn_aborted") {
        return {
          events: [...state.events, event],
          isStreaming: false,
          currentTurnId: reduceCurrentTurnId(state.currentTurnId, event),
        };
      }
      return {
        events: [...state.events, event],
        isStreaming: state.isStreaming,
        currentTurnId: reduceCurrentTurnId(state.currentTurnId, event),
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

function toTranscriptEvent(event: Event): TranscriptEventEnvelope | null {
  switch (event.msg.type) {
    case "turn_started":
    case "turn_complete":
    case "turn_aborted":
    case "user_message":
    case "agent_message":
    case "agent_message_delta":
    case "tool_call_started":
    case "tool_call_completed":
    case "tool_progress":
    case "exec_command_begin":
    case "exec_command_end":
    case "context_compacted":
    case "warning":
    case "error":
    case "stream_error":
    case "deprecation_notice":
    case "plan_started":
    case "plan_delta":
    case "plan_item_completed":
    case "plan_exited":
      return {
        id: event.id,
        seq: event.seq,
        type: event.msg.type,
        payload: event.msg.payload,
      };
    default:
      return null;
  }
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
  const [state, dispatch] = useReducer(
    reducer,
    resolveInitialTranscriptEvents(session),
    createInitialState,
  );
  // Keep a ref to the session so the callback identity is stable even
  // if the caller passes a new object reference per render.
  const sessionRef = useRef<SessionLike>(session);
  sessionRef.current = session;

  useEffect(() => {
    dispatch({
      kind: "reset",
      initialEvents: resolveInitialTranscriptEvents(session),
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
    if (typeof subscribeToEvents === "function" && unsubscribers.length === 0) {
      try {
        unsubscribers.push(
          subscribeToEvents.call(session, (event: PhaseEvent) => push(event)),
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
