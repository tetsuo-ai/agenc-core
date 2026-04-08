/**
 * Layered compaction (Cut 5.1, claude_code-alignment).
 *
 * Replaces the legacy `prompt-budget.ts` ad-hoc compaction with a
 * `claude_code/services/compact/`-style ordered chain:
 *
 *     snip → microcompact → autocompact   (per-iteration)
 *     reactiveCompact                     (post-error 413 fallback)
 *
 * Each layer is a small pure function that takes `(messages, state)`
 * and returns `{ messages, state, boundary?, action }`. The chain is
 * driven from the chat-executor's iteration loop in the order above.
 *
 * The implementations here are intentionally minimal — they ship the
 * shape and the integration points so the rest of the runtime can
 * call them, with bigger heuristics moved into each layer over time.
 *
 * @module
 */

export {
  applySnip,
  createSnipState,
  type SnipState,
} from "./snip.js";
export {
  applyMicrocompact,
  createMicrocompactState,
  type MicrocompactState,
} from "./microcompact.js";
export {
  applyAutocompact,
  createAutoCompactTrackingState,
  type AutoCompactTrackingState,
} from "./autocompact.js";
export {
  applyReactiveCompact,
  createReactiveCompactState,
  type ReactiveCompactState,
} from "./reactive-compact.js";
export {
  tokenCountWithEstimation,
  type TokenCountInput,
} from "./token-count.js";
export {
  ESCALATED_MAX_TOKENS,
  DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS,
  DEFAULT_SNIP_GAP_MS,
  DEFAULT_MICROCOMPACT_GAP_MS,
} from "./constants.js";

