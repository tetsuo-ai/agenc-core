/**
 * Constants shared by the layered compaction modules.
 *
 * Mirrors `claude_code/services/compact/constants.ts`.
 *
 * @module
 */

/**
 * Token ceiling for the per-call `max_output_tokens` escalation. Mirrors
 * `claude_code/utils/context.ts:ESCALATED_MAX_TOKENS`. Used by the
 * reactive-compact path when a withheld `max_output_tokens` error
 * surfaces and we want to retry with a larger output budget before
 * compacting history.
 */
export const ESCALATED_MAX_TOKENS = 64_000;

/**
 * Fraction of the model's context window at which autocompact fires.
 * 0.4 means "compact when the prompt exceeds 40% of the context window."
 * This gives the model 40% of its window for history before compaction,
 * leaving 60% for the remaining prompt overhead (system prompt, tools,
 * current turn, output).
 *
 * The previous hardcoded 120K threshold was 6% of a 2M window, causing
 * the model to lose its working memory after ~30 tool calls. Scaling
 * by percentage means the threshold automatically adapts to any model:
 *   - grok-4.20-beta-0309-reasoning (2M): 800K threshold
 *   - grok-4-1-fast (2M): 800K threshold
 *   - grok-3-mini (128K): 51K threshold
 *   - ollama local (32K): 12.8K threshold
 */
export const DEFAULT_AUTOCOMPACT_THRESHOLD_FRACTION = 0.4;

/**
 * Fallback token threshold when the context window size is unknown
 * (contextWindowTokens not provided). Conservative at 120K to avoid
 * OOM on small-context models. When the context window IS known,
 * `DEFAULT_AUTOCOMPACT_THRESHOLD_FRACTION` is used instead.
 */
export const DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS = 120_000;

/**
 * Compute the autocompact threshold from the model's context window.
 * Returns the fraction-based threshold when `contextWindowTokens` is
 * provided, otherwise falls back to the hardcoded default.
 */
export function computeAutocompactThreshold(
  contextWindowTokens?: number,
): number {
  if (
    typeof contextWindowTokens === "number" &&
    Number.isFinite(contextWindowTokens) &&
    contextWindowTokens > 0
  ) {
    return Math.floor(contextWindowTokens * DEFAULT_AUTOCOMPACT_THRESHOLD_FRACTION);
  }
  return DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS;
}

/**
 * Default time gap between activity bursts that allows the snip layer
 * to drop the oldest tail messages. 15 minutes mirrors claude_code's
 * default snip window.
 */
export const DEFAULT_SNIP_GAP_MS = 15 * 60 * 1000;

/**
 * Default time gap between turns that triggers the microcompact layer
 * to clear cold tool-result content (without summarizing — just
 * replace the bytes with a placeholder so the model doesn't pay for
 * recall of stale tool output).
 */
export const DEFAULT_MICROCOMPACT_GAP_MS = 5 * 60 * 1000;

/** Hard ceiling on how many tail messages snip will keep on the wire. */
export const DEFAULT_SNIP_KEEP_RECENT = 30;

/**
 * Marker subtype on the system message that boundary helpers emit. The
 * executor filters these out when calling the model so they never reach
 * the API, but they're persisted to the session log so users can see
 * where compaction events happened.
 */
export const COMPACT_BOUNDARY_SUBTYPE = "compact_boundary";
