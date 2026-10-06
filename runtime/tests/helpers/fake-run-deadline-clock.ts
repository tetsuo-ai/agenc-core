import type { RunDeadlineClock } from "../../src/session/run-deadline.js";

/**
 * Manual clock for the run-deadline logic (#2503): time moves only when a
 * test calls `advance`, which fires every scheduled callback that became due.
 */
export interface FakeRunDeadlineClock extends RunDeadlineClock {
  advance(ms: number): void;
  readonly pending: () => number;
}

export function createFakeRunDeadlineClock(startMs = 1_000_000): FakeRunDeadlineClock {
  let now = startMs;
  let nextId = 0;
  const timers = new Map<number, { readonly due: number; readonly fire: () => void }>();
  return {
    now: () => now,
    schedule(delayMs, fire) {
      const id = nextId++;
      timers.set(id, { due: now + Math.max(0, delayMs), fire });
      return () => {
        timers.delete(id);
      };
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) {
        if (timer.due > now) continue;
        timers.delete(id);
        timer.fire();
      }
    },
    pending: () => timers.size,
  };
}
