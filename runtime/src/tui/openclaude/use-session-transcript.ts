import { useEffect, useMemo, useReducer } from "react";

import type { LLMMessage } from "../../llm/types.js";
import type { Event } from "../../session/event-log.js";
import { adaptTranscriptEvents } from "./message-adapter.js";
import type { OpenClaudeBridgeSession } from "./session-types.js";

type TranscriptEvent = Event | {
  readonly type: string;
  readonly payload?: unknown;
  readonly [key: string]: unknown;
};

interface TranscriptState {
  readonly events: readonly TranscriptEvent[];
  readonly keys: ReadonlySet<string>;
}

type TranscriptAction =
  | { readonly kind: "reset"; readonly events: readonly TranscriptEvent[] }
  | { readonly kind: "append"; readonly event: TranscriptEvent };

function eventKey(event: TranscriptEvent): string {
  if ("seq" in event && typeof event.seq === "number") return `seq:${event.seq}`;
  if ("id" in event && typeof event.id === "string") return `id:${event.id}`;
  try {
    return JSON.stringify(event);
  } catch {
    return `${event.type}:${Date.now()}:${Math.random()}`;
  }
}

function reducer(state: TranscriptState, action: TranscriptAction): TranscriptState {
  switch (action.kind) {
    case "reset": {
      const keys = new Set<string>();
      const events: TranscriptEvent[] = [];
      for (const event of action.events) {
        const key = eventKey(event);
        if (keys.has(key)) continue;
        keys.add(key);
        events.push(event);
      }
      return { events, keys };
    }
    case "append": {
      const key = eventKey(action.event);
      if (state.keys.has(key)) return state;
      return {
        events: [...state.events, action.event],
        keys: new Set([...state.keys, key]),
      };
    }
  }
}

function initialEvents(session: OpenClaudeBridgeSession): readonly TranscriptEvent[] {
  const fromGetter = session.getInitialTranscriptEvents?.();
  const fromProperty = session.initialTranscriptEvents;
  return [...((fromGetter ?? fromProperty ?? []) as readonly TranscriptEvent[])];
}

export function useSessionTranscript(
  session: OpenClaudeBridgeSession,
  startupMessages: readonly LLMMessage[] = [],
) {
  const [state, dispatch] = useReducer(reducer, { events: [], keys: new Set() });

  useEffect(() => {
    dispatch({ kind: "reset", events: initialEvents(session) });
  }, [session]);

  useEffect(() => {
    const unsubscribeLog = session.eventLog?.subscribe((event) => {
      dispatch({ kind: "append", event });
    });
    const unsubscribePhase = session.subscribeToEvents?.((event) => {
      if (event && typeof event === "object" && "type" in event) {
        dispatch({ kind: "append", event: event as TranscriptEvent });
      }
    });
    return () => {
      unsubscribeLog?.();
      unsubscribePhase?.();
    };
  }, [session]);

  return useMemo(
    () => adaptTranscriptEvents(state.events, startupMessages),
    [state.events, startupMessages],
  );
}
