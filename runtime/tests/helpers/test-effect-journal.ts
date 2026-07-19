import { EventLog, type Event } from "../../src/session/event-log.js";

/**
 * Minimal canonical-effect seam for unit tests that exercise admitted legacy
 * entry points without constructing a complete Session/RolloutStore pair.
 */
export function createTestEffectJournal() {
  const eventLog = new EventLog();
  const effectEvents: Event[] = [];
  return {
    effectEvents,
    eventLog,
    rolloutStore: {
      assertToolAdmissionAllowed: () => {},
      recordEffectEvent: (event: Event) => effectEvents.push(event),
    },
    emit: (event: Event) => eventLog.emit(event),
  };
}
