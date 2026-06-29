/**
 * Output-style attachment producer.
 *
 * Compatibility producer for the attachment orchestrator.
 *
 * Live output-style injection is handled by `prompts/system-prompt.ts`,
 * where the resolved per-turn `OutputStyleInput` is already available.
 * The attachment renderer remains available for replay/import paths that
 * may encounter persisted `output_style` items, but the live producer stays
 * empty to avoid injecting the same style instructions twice.
 *
 * @module
 */

import type { AttachmentProducer } from "./orchestrator.js";

export const outputStyleProducer: AttachmentProducer = async (
  _opts,
  _trackingState,
) => {
  return [];
};
