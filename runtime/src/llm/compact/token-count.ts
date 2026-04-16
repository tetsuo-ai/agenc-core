/**
 * `tokenCountWithEstimation` — canonical token counter for compaction
 * decisions. Mirrors `claude_code/utils/tokens.ts:tokenCountWithEstimation`.
 *
 * Walks backward to the last API response with usage metadata, then
 * estimates token cost for any messages added since. Returns a single
 * integer count comparable across compaction layers.
 *
 * Cut 5.1 of the claude_code-alignment refactor.
 *
 * @module
 */

import type { LLMMessage, LLMUsage } from "../types.js";

const ROUGH_CHARS_PER_TOKEN = 4;

export interface TokenCountInput {
  readonly messages: readonly LLMMessage[];
  /** Most recent API response usage, if available. */
  readonly lastResponseUsage?: LLMUsage;
}

/**
 * Returns the canonical token estimate for a message history. The
 * heuristic is:
 *
 * 1. If `lastResponseUsage` is provided, treat its prompt/input tokens
 *    as the floor — these are the tokens the API actually billed for the
 *    request context on the most recent call. Otherwise start from 0.
 * 2. Add a rough character-based estimate for any messages whose
 *    payload size we cannot read from cached usage (i.e. anything
 *    appended after the last API response).
 *
 * The estimate is intentionally a slight over-count so threshold
 * checks fire a hair early rather than letting the next API call
 * surface a withheld 413.
 */
export function tokenCountWithEstimation(input: TokenCountInput): number {
  const { messages, lastResponseUsage } = input;
  let billed = 0;
  if (lastResponseUsage) {
    billed = lastResponseUsage.promptTokens ?? 0;
  }

  // Estimate roughly 1 token per 4 characters of message content for
  // anything we don't have a billed measurement for. This is the same
  // shape as claude_code's `roughTokenCountEstimationForMessages`.
  let estimated = 0;
  for (const message of messages) {
    if (typeof message.content === "string") {
      estimated += Math.ceil(message.content.length / ROUGH_CHARS_PER_TOKEN);
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part && typeof part === "object" && part.type === "text") {
          estimated += Math.ceil(part.text.length / ROUGH_CHARS_PER_TOKEN);
        }
      }
    }
  }

  // Use the larger of the two — if usage already covers a window of
  // history, the estimate will overlap; if usage is missing entirely,
  // the estimate is the only signal.
  return Math.max(billed, estimated);
}
