/**
 * Heartbeat types (TODO task 14, Phase 2).
 *
 * A heartbeat is a periodic autonomous agent turn: on each tick, if the gates
 * pass, the agent reads HEARTBEAT.md and acts, replying
 * `HEARTBEAT_OK` (suppressed) when there is nothing to do. This is the
 * proactive half of the personal agent — bounded by the task-15 budget layer so
 * it can never become the OpenClaw idle-burn furnace.
 *
 * Everything is injected (clock, turn-runner, delivery, file reader) so
 * the scheduler + runner are unit-tested against fakes with a fake clock.
 */

/** `none` runs the turn but delivers nothing; otherwise deliver to a channel. */
export type HeartbeatTarget =
  | { readonly kind: "none" }
  | { readonly kind: "channel"; readonly channelId: string; readonly conversationId: string };

export interface HeartbeatPolicy {
  readonly enabled: boolean;
  /** Seconds between ticks (default 1800 = 30 min). */
  readonly intervalSeconds: number;
  /**
   * Local active hours [startHour, endHour) in 24h; outside them, ticks are
   * skipped. `null` = always active.
   */
  readonly activeHours: readonly [number, number] | null;
  /** Skip a tick if a heartbeat turn is already running. */
  readonly skipWhenBusy: boolean;
  readonly target: HeartbeatTarget;
}

export interface HeartbeatTurnResult {
  readonly finalMessage: string;
}

/** Runs one heartbeat turn (prompt → assistant text). Injected. */
export interface HeartbeatTurnRunner {
  run(prompt: string): Promise<HeartbeatTurnResult>;
}

/** Delivers heartbeat output to a channel target. Injected (gateway-backed). */
export interface HeartbeatDelivery {
  deliver(target: HeartbeatTarget, text: string): Promise<void>;
}

/** Reads HEARTBEAT.md; returns null when absent (→ nothing to do). Injected. */
export interface HeartbeatFileReader {
  read(): string | null;
}

export interface HeartbeatClock {
  now(): Date;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(handle: ReturnType<typeof setTimeout>): void;
}

/** Why a given tick did what it did — surfaced for logs + tests. */
export type HeartbeatTickOutcome =
  | { readonly kind: "skipped"; readonly reason: HeartbeatSkipReason }
  | { readonly kind: "ok_suppressed" }
  | { readonly kind: "delivered"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export type HeartbeatSkipReason =
  | "disabled"
  | "outside_active_hours"
  | "busy"
  | "cron_running"
  | "no_heartbeat_file";

/** The literal reply that suppresses delivery ("nothing to do"). */
export const HEARTBEAT_OK = "HEARTBEAT_OK";
