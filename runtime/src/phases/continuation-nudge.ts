/**
 * Phase 4 — Continuation Nudge.
 *
 * Mirrors openclaude query.ts:1300-1465 (stop-hook run, token-budget
 * continuation, continuation-nudge decision).
 *
 * The nudge fires when the model stopped without emitting tool calls
 * but runtime heuristics (tokens-remaining, user-intent markers, etc.)
 * indicate the work is not actually done. A nudge injects a user
 * message like "Continue with the task. Use the appropriate tools to
 * proceed." and re-enters PrepareContext. Capped at
 * MAX_CONTINUATION_NUDGES=3 (openclaude query.ts:163) to prevent
 * infinite nudge loops.
 *
 * For T5 the phase is a lean early-return: if there are no tool calls
 * and no error, the turn is complete. Stop-hook + token-budget
 * integration land in T8.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";

export const MAX_CONTINUATION_NUDGES = 3;

export async function continuationNudge(
  state: TurnState,
  _ctx: TurnContext,
  _session: Session,
  _signal?: AbortSignal,
): Promise<TurnState> {
  // T8: stop-hook invocation, token-budget check, nudge injection.
  // For T5: fall through so commit decides terminal vs next iteration
  // based on `needsFollowUp` / `toolUseBlocks.length`.
  return state;
}
