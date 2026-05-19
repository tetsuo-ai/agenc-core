/**
 * Critical-system-reminder attachment producer.
 *
 * Hand-port of reference `getCriticalSystemReminderAttachment`
 * (`src/utils/attachments.ts:1588-1596`). One-shot drain of
 * `trackingState.pendingCriticalReminder`: external runtime producers
 * (mode transitions, rate-limit warnings, runtime-issued operator
 * notices) write to that field; this producer emits the reminder once
 * and clears the field so re-firing requires a re-set.
 *
 * @module
 */

import type { AttachmentProducer } from "./orchestrator.js";

export const criticalReminderProducer: AttachmentProducer = async (
  _opts,
  trackingState,
) => {
  const content = trackingState.pendingCriticalReminder;
  if (content === undefined || content.length === 0) return [];

  trackingState.pendingCriticalReminder = undefined;
  return [{ kind: "critical_system_reminder", content }];
};
