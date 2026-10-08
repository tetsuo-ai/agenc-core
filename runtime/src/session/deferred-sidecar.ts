import type { Event, EventLog } from "./event-log.js";
import type { Sidecar } from "./sidecar.js";

/** Own one subscription from startup through shutdown; attach its consumer later. */
export function deferSidecar(log: EventLog): { attach(sidecar: Sidecar): Sidecar; close(): void } {
  const pending: Event[] = [];
  let consumer: Sidecar | undefined;
  let closed = false;
  const unsubscribe = log.subscribe(event => {
    if (consumer) void consumer.onEvent(event);
    else pending.push(event);
  });
  const close = (): void => { if (!closed) { closed = true; unsubscribe(); pending.length = 0; } };
  return {
    close,
    attach(sidecar) {
      if (closed || consumer) throw new Error("deferred sidecar already attached or closed");
      consumer = sidecar;
      for (const event of pending.splice(0)) void sidecar.onEvent(event);
      // The owned subscription already delivers live events. The manager owns
      // lifecycle only, so attaching it cannot duplicate observations.
      return { name: sidecar.name, onEvent: () => {},
        start: () => sidecar.start?.(),
        stop: async () => { close(); await sidecar.stop?.(); },
        isDegraded: () => sidecar.isDegraded?.() ?? false };
    },
  };
}
