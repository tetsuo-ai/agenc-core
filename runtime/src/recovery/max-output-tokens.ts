/**
 * Max-output-tokens recovery (escalate + continuation).
 *
 * Hand-port of openclaude `query.ts:1221-1291`. When a stream's
 * assistant message is withheld because it hit the provider's
 * max_output_tokens limit, two recovery paths apply:
 *
 *   1. **Escalate** (1221-1255) — first attempt only (override
 *      unset): set `maxOutputTokensOverride = 64_000`, re-enter
 *      Phase 1. No meta message needed — same request, bigger ceiling.
 *
 *   2. **Continuation** (1257-1291) — escalate already fired (or
 *      caller opted out). Inject "Resume directly — do not apologize"
 *      meta message, bump `maxOutputTokensRecoveryCount`, re-enter
 *      Phase 1. Capped at `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`.
 *
 * After both exhaust, the turn surfaces the error.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";

export const MAX_OUTPUT_TOKENS_ESCALATED = 64_000;
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

const RESUME_META_CONTENT =
  "Continue generating directly from where you left off. Do not apologize, do not restart, do not add preamble. Pick up at the next token.";

export type MaxOutputTokensOutcome =
  | { readonly kind: "escalate" }
  | { readonly kind: "continuation" }
  | { readonly kind: "exhausted"; readonly reason: string }
  | { readonly kind: "not_applicable" };

export interface RunMaxOutputTokensOpts {
  readonly session: Session;
  readonly state: TurnState;
  /** Whether this call should ever escalate to 64k. Providers that
   *  already cap below 8k can opt out. */
  readonly escalateAllowed?: boolean;
}

/**
 * Decide + mutate state for the next iteration. Called by phase-3
 * post-sample-recovery after `isWithheldMaxOutputTokens` fires.
 *
 * State mutations:
 *   - escalate: sets `state.maxOutputTokensOverride`, marks transition
 *   - continuation: appends meta message, bumps counter, marks transition
 *   - exhausted: no state change (caller surfaces the error)
 */
export function runMaxOutputTokensRecovery(
  opts: RunMaxOutputTokensOpts,
): MaxOutputTokensOutcome {
  const { state } = opts;
  const overrideUnset = state.maxOutputTokensOverride === undefined;
  const escalateAllowed = opts.escalateAllowed !== false;

  // Step 1: escalate path — first attempt, override unset.
  if (overrideUnset && escalateAllowed) {
    state.maxOutputTokensOverride = MAX_OUTPUT_TOKENS_ESCALATED;
    state.transition = { reason: "max_output_tokens_escalate" };
    return { kind: "escalate" };
  }

  // Step 2: continuation path — bump counter if under the cap.
  if (state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    const metaMessage: LLMMessage = {
      role: "user",
      content: RESUME_META_CONTENT,
    };
    state.messages.push(metaMessage);
    state.maxOutputTokensRecoveryCount += 1;
    state.transition = { reason: "max_output_tokens_recovery" };
    return { kind: "continuation" };
  }

  // Step 3: cap exhausted. Surface the error.
  return {
    kind: "exhausted",
    reason: `max_output_tokens_recovery_limit (${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT})`,
  };
}
