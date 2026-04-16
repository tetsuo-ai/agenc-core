/**
 * Autocompact layer — proactive history summarization above a token
 * threshold. Mirrors `claude_code/services/compact/autoCompact.ts`.
 *
 * The actual summarization step is intentionally pluggable: this
 * module exposes the threshold + tracking state, and a small
 * `applyAutocompact` function that wires the trigger logic without
 * baking a specific summarizer in. The chat-executor's existing
 * `compactHistory()` continues to do the model-call summarization;
 * this layer just gives the executor a uniform shape to call into so
 * it can be replaced piecewise later.
 *
 * Cut 5.1 of the context-alignment refactor.
 *
 * @module
 */

import type { LLMMessage, LLMUsage } from "../types.js";
import {
  COMPACT_BOUNDARY_SUBTYPE,
  DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS,
} from "./constants.js";
import { tokenCountWithEstimation } from "./token-count.js";

export interface AutoCompactTrackingState {
  readonly compacted: boolean;
  readonly turnCounter: number;
  readonly turnId: string | null;
  readonly consecutiveFailures: number;
}

export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export function createAutoCompactTrackingState(): AutoCompactTrackingState {
  return {
    compacted: false,
    turnCounter: 0,
    turnId: null,
    consecutiveFailures: 0,
  };
}

interface AutocompactInput {
  readonly messages: readonly LLMMessage[];
  readonly state: AutoCompactTrackingState;
  readonly thresholdTokens?: number;
  readonly lastResponseUsage?: LLMUsage;
  /**
   * Tokens freed by a preceding snip pass in the same iteration. The
   * orchestrator subtracts this from the effective token count so a
   * successful snip can short-circuit a borderline autocompact decision.
   * U0 accepts the parameter for API stability; U1 wires the real
   * threshold adjustment.
   */
  readonly snipTokensFreed?: number;
}

interface AutocompactResult {
  readonly action: "noop" | "autocompacted";
  readonly messages: readonly LLMMessage[];
  readonly state: AutoCompactTrackingState;
  readonly boundary?: LLMMessage;
  readonly tokensBefore: number;
  readonly thresholdTokens: number;
}

/**
 * Decision-only layer. The runtime should observe `result.action ===
 * "autocompacted"` and then run its existing summarizer to actually
 * shrink the history. This module returns the same `messages` it was
 * given so callers can swap in their summarizer behind a clean
 * boundary, then call `markAutocompactComplete` once they're done.
 */
export function applyAutocompact(input: AutocompactInput): AutocompactResult {
  const thresholdTokens =
    input.thresholdTokens ?? DEFAULT_AUTOCOMPACT_THRESHOLD_TOKENS;
  const rawTokensBefore = tokenCountWithEstimation({
    messages: input.messages,
    lastResponseUsage: input.lastResponseUsage,
  });
  const tokensBefore = Math.max(0, rawTokensBefore - (input.snipTokensFreed ?? 0));

  if (tokensBefore < thresholdTokens) {
    return {
      action: "noop",
      messages: input.messages,
      state: {
        ...input.state,
        turnCounter: input.state.turnCounter + 1,
      },
      tokensBefore,
      thresholdTokens,
    };
  }

  return {
    action: "autocompacted",
    messages: input.messages,
    state: {
      compacted: true,
      turnCounter: 0,
      turnId: input.state.turnId ?? newTurnId(),
      consecutiveFailures: 0,
    },
    tokensBefore,
    thresholdTokens,
    boundary: {
      role: "system",
      content:
        `[autocompact] history exceeded ${thresholdTokens} tokens (was ${tokensBefore}); summarization will run`,
    },
  };
}

// Boundary tagging is encoded in the `[autocompact]` content prefix —
// see COMPACT_BOUNDARY_SUBTYPE for the canonical layer name.
void COMPACT_BOUNDARY_SUBTYPE;

/**
 * Called by the runtime after a successful summarization to clear the
 * `compacted` flag and bump the consecutive-failure counter back to 0.
 */
/**
 * Called by the runtime when a summarization attempt fails. Three
 * consecutive failures should trip the circuit breaker and force the
 * caller to surface a hard error rather than retrying indefinitely.
 */
function newTurnId(): string {
  // Lightweight non-crypto random — turn IDs are diagnostic, not security.
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function markAutocompactSuccess(
  state: AutoCompactTrackingState,
): AutoCompactTrackingState {
  return {
    ...state,
    compacted: false,
    consecutiveFailures: 0,
  };
}

export function markAutocompactFailure(
  state: AutoCompactTrackingState,
): AutoCompactTrackingState {
  return {
    ...state,
    consecutiveFailures: state.consecutiveFailures + 1,
  };
}

export function shouldSkipAutocompactForCircuitBreaker(
  state: AutoCompactTrackingState,
): boolean {
  return state.consecutiveFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
}
