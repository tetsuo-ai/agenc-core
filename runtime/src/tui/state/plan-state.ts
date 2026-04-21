/**
 * Plan-state helpers (T12 Wave 4-C).
 *
 * Tiny utility module consumed by the App root so the Banner
 * (Wave 4-B) can light up its `hasPlanActive` indicator from the same
 * event stream that the transcript's `<PlanProgress>` renders.
 *
 * The helper is intentionally pure — it folds the event history and
 * does not maintain its own subscription. Consumers should pass the
 * current slice of plan events whenever they re-render, so the
 * derived state stays a function of the event log (I-27/I-49).
 *
 * @module
 */

import type { PlanProgressProps } from "../transcript/PlanProgress.js";

/**
 * Re-export of the discriminated plan-event union declared alongside
 * `<PlanProgress>`. Kept here as an alias so callers that want only
 * the state helper don't pull in the renderer.
 */
export type PlanEvent = PlanProgressProps["events"][number];

/**
 * Returns `true` if plan mode is currently active based on the event
 * history, `false` otherwise. "Latest wins" — the most recent
 * `plan_started` / `plan_exited` pair determines the current state, so
 * a `plan_started` after a `plan_exited` re-activates plan mode.
 *
 * Empty history and a history containing only `plan_delta` /
 * `plan_item_completed` events return `false` because those events
 * cannot exist outside of an active plan scope in practice; the
 * function still guards against that case defensively.
 */
export function isPlanActive(events: ReadonlyArray<PlanEvent>): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.kind === "plan_started") return true;
    if (ev.kind === "plan_exited") return false;
  }
  return false;
}
