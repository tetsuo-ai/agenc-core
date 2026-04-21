/**
 * useQuery — bridges the AgenC session event stream into React state.
 *
 * Subscribes to a structural `SessionLike` on mount, accumulates
 * `PhaseEvent` values for the current turn, and exposes a terminal-safe
 * `submit` wrapper that delegates to the session's own submit path when
 * available.
 *
 * Why `SessionLike` (structural) instead of the concrete `Session`:
 *   - T12 Wave 2 lands before the Session wires a canonical
 *     `subscribeToEvents` surface. Tests need to pass lightweight stubs
 *     without touching the 40+ Session constructor requirements.
 *   - The real Session exposes `eventLog.subscribe(...)` which yields the
 *     lower-level `Event` envelope, not the phase-layer `PhaseEvent`. A
 *     thin adapter in App.tsx (Wave 2-A) converts between the two; this
 *     hook stays at the `PhaseEvent` level because that is the shape the
 *     TUI components consume.
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
  submit?(message: string): Promise<void>;
  abortTerminal(reason: string): void;
}

export interface UseQueryResult {
  readonly events: readonly PhaseEvent[];
  readonly isStreaming: boolean;
  readonly currentTurnId: string | null;
  submit(message: string): Promise<void>;
}

interface QueryState {
  events: PhaseEvent[];
  isStreaming: boolean;
  currentTurnId: string | null;
}

type QueryAction =
  | { readonly kind: "reset" }
  | { readonly kind: "event"; readonly event: PhaseEvent };

const initialState: QueryState = {
  events: [],
  isStreaming: false,
  currentTurnId: null,
};

function reducer(state: QueryState, action: QueryAction): QueryState {
  switch (action.kind) {
    case "reset":
      return initialState;
    case "event": {
      const { event } = action;
      if (event.type === "turn_start") {
        return {
          events: [event],
          isStreaming: true,
          currentTurnId: state.currentTurnId,
        };
      }
      if (event.type === "turn_complete") {
        return {
          events: [...state.events, event],
          isStreaming: false,
          currentTurnId: state.currentTurnId,
        };
      }
      return {
        events: [...state.events, event],
        isStreaming: state.isStreaming,
        currentTurnId: state.currentTurnId,
      };
    }
    default:
      return state;
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
  const [state, dispatch] = useReducer(reducer, initialState);
  // Keep a ref to the session so the callback identity is stable even
  // if the caller passes a new object reference per render.
  const sessionRef = useRef<SessionLike>(session);
  sessionRef.current = session;

  useEffect(() => {
    const subscribe = session.subscribeToEvents;
    if (typeof subscribe !== "function") {
      warnOnce(
        "subscribeToEvents-missing",
        "session.subscribeToEvents is not wired; event stream will stay empty.",
      );
      return undefined;
    }

    let disposed = false;
    const handler = (event: PhaseEvent): void => {
      if (disposed) return;
      dispatch({ kind: "event", event });
    };

    let unsubscribe: () => void;
    try {
      unsubscribe = subscribe.call(session, handler);
    } catch (error) {
      warnOnce(
        "subscribeToEvents-throw",
        `session.subscribeToEvents threw: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return undefined;
    }

    return () => {
      disposed = true;
      try {
        unsubscribe?.();
      } catch {
        // Unsubscribe errors are non-fatal; we're tearing down anyway.
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
