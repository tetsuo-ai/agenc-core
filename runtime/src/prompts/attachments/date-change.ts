/**
 * Date-change attachment producer.
 *
 * Hand-port of reference `getDateChangeAttachments`
 * (`src/utils/attachments.ts:1416-1445`). Fires a one-shot
 * `date_change` attachment when the local calendar date differs from
 * the date last emitted for this session. The first turn seeds the
 * tracking state without emitting (the attachment marks a real
 * boundary, not the initial sample).
 *
 * Skips AgenC's Kairos transcript-flush branch — AgenC does not
 * ship the Kairos assistant mode.
 *
 * @module
 */

import type { AttachmentProducer } from "./orchestrator.js";

/**
 * Compute today's local ISO date (YYYY-MM-DD).
 *
 * Note: `Date.prototype.toISOString()` returns UTC. We use the
 * UTC slice here to match AgenC's `getLocalISODate()` behavior
 * which also keys on the same calendar surface — when the local TZ
 * crosses a UTC boundary the producer fires once on that boundary,
 * which matches AgenC's behavior on the same calendar drift.
 */
function getLocalISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

export const dateChangeProducer: AttachmentProducer = async (
  _opts,
  trackingState,
) => {
  const today = getLocalISODate();
  const last = trackingState.lastEmittedDate;

  if (last === undefined) {
    // First turn — seed the tracking state, do not emit. The attachment
    // marks a real day boundary, not the initial sample.
    trackingState.lastEmittedDate = today;
    return [];
  }

  if (today === last) return [];

  trackingState.lastEmittedDate = today;
  return [{ kind: "date_change", newDate: today }];
};
