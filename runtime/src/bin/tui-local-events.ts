import type { SlashCommandResult } from "../commands/types.js";
import type { PhaseEvent } from "../phases/events.js";

export type LocalTuiEventSubscriber = (event: unknown) => void;

export interface LocalTuiPhaseEventTarget {
  emitPhaseEvent?: (event: PhaseEvent) => void;
}

export function emitLocalTuiEvent(
  subscribers: Iterable<LocalTuiEventSubscriber>,
  event: unknown,
): void {
  for (const subscriber of subscribers) {
    try {
      subscriber(event);
    } catch {
      // Match Session.emitPhaseEvent subscriber isolation.
    }
  }
}

export function emitLocalTuiPhaseEvent(
  target: LocalTuiPhaseEventTarget | null | undefined,
  subscribers: Iterable<LocalTuiEventSubscriber>,
  event: PhaseEvent,
): void {
  if (typeof target?.emitPhaseEvent === "function") {
    target.emitPhaseEvent(event);
    return;
  }
  emitLocalTuiEvent(subscribers, event);
}

export function emitLocalTuiSlashResult(
  subscribers: Iterable<LocalTuiEventSubscriber>,
  input: string,
  result: SlashCommandResult,
): void {
  emitLocalTuiEvent(subscribers, {
    type: "slash_result",
    input,
    result,
    timestamp: Date.now(),
  });
}
