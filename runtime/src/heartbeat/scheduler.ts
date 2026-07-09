/**
 * Heartbeat scheduler (TODO task 14).
 *
 * A fixed-interval tick driver over an injectable clock (mirrors the
 * cron-scheduler pattern so tests drive a fake clock). Re-entrancy safe: at
 * most one tick runs at a time. `start()` arms the first timer; each completed
 * tick arms the next; `stop()` cancels and awaits any in-flight tick.
 */

import type { HeartbeatClock, HeartbeatTickOutcome } from "./types.js";

export interface HeartbeatSchedulerOptions {
  readonly intervalSeconds: number;
  readonly clock: HeartbeatClock;
  /** Runs one tick; must not throw. */
  onTick(): Promise<HeartbeatTickOutcome>;
  readonly onOutcome?: (outcome: HeartbeatTickOutcome) => void;
}

export class HeartbeatScheduler {
  readonly #o: HeartbeatSchedulerOptions;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;
  #inFlight: Promise<void> = Promise.resolve();

  constructor(options: HeartbeatSchedulerOptions) {
    this.#o = options;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#arm();
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#timer !== null) {
      this.#o.clock.clearTimer(this.#timer);
      this.#timer = null;
    }
    await this.#inFlight;
  }

  #arm(): void {
    if (!this.#running) return;
    const ms = Math.max(1, this.#o.intervalSeconds * 1000);
    this.#timer = this.#o.clock.setTimer(() => {
      this.#timer = null;
      this.#inFlight = this.#fire();
    }, ms);
  }

  async #fire(): Promise<void> {
    try {
      const outcome = await this.#o.onTick();
      this.#o.onOutcome?.(outcome);
    } catch (error) {
      this.#o.onOutcome?.({ kind: "error", message: String(error) });
    } finally {
      // Arm the next tick only if still running (stop() may have flipped it).
      this.#arm();
    }
  }
}
