/**
 * Output-style attachment producer.
 *
 * Intended hand-port of reference `getOutputStyleAttachment`
 * (`src/utils/attachments.ts:1598-1613`), which emits an
 * `output_style` system-reminder every turn whenever the active style
 * is non-default.
 *
 * AGENC GAP — Follow-up: AgenC has two separate "output style" surfaces
 * today and neither is threaded through `GetAttachmentsOptions`:
 *
 *   1. `config/schema.ts` `PartialOutputStyleConfig` carries a
 *      cockpit palette `theme` (e.g. "dark"), not the AgenC
 *      style preset shape.
 *   2. `prompts/system-prompt.ts` `OutputStyleInput` (`{ name, prompt }`)
 *      is the actual preset shape but is supplied to the system-prompt
 *      assembler from the per-turn `prepareContext()` result, not via
 *      the orchestrator inputs.
 *
 * Until the runtime exposes the active preset name on
 * `GetAttachmentsOptions` (or the orchestrator gains access to the
 * resolved per-turn context), this producer is a noop. The renderer
 * for `output_style` is already wired in `messages.ts`, so lighting it
 * up later is a one-field change here plus the option-plumbing
 * change at the call site.
 *
 * @module
 */

import type { AttachmentProducer } from "./orchestrator.js";

export const outputStyleProducer: AttachmentProducer = async (
  _opts,
  _trackingState,
) => {
  // Follow-up(attachments): emit `{ kind: "output_style", style }` once the
  // active output-style preset name is reachable from
  // GetAttachmentsOptions. Filter `style === "default"` before emit per
  // AgenC convention.
  return [];
};
