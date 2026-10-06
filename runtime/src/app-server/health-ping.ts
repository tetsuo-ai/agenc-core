import type { HealthPingResult } from "./protocol/index.js";

/** A connection liveness proof needs no session, readiness or memory counters. */
export function healthPingResult(nowMs: number): HealthPingResult {
  return { ok: true, now: new Date(nowMs).toISOString() };
}
