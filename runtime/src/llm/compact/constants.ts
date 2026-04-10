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
 * Default token threshold above which the proactive autocompact layer
 * will summarize history. Configurable per-session via the executor's
 * `sessionCompactionThreshold`.
 *
 * Raised from 120K to 800K to support large-context models (grok-4.20
 * at 2M context). At 120K the model compacted at 6% of the 2M window,
 * losing most of its working memory after ~30 tool calls — the model
 * would forget which files it had written, which phases were complete,
 * and what build errors it had seen. At 800K the model can sustain
 * 80+ tool calls before compaction fires (~40% of 2M).
 *
 * TODO: scale dynamically from the model's context window
 * (e.g. contextWindowTokens * 0.4) once the tool loop has access to
 * the execution profile.
 */
export const DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS = 800_000;

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
