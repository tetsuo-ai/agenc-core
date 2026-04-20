/**
 * Phase 1 — Prepare Context.
 *
 * Mirrors openclaude query.ts:268-459 (the top of each iteration).
 * Responsibilities:
 *   1. Project the post-compact/post-collapse/post-snip/post-microcompact
 *      `messagesForQuery` view over the full `messages` history.
 *   2. Apply per-message tool-result budget (content replacement).
 *   3. Call auto-compact if over threshold.
 *   4. Enforce the hard blocking limit when auto-compact is off.
 *
 * For T5 the implementation is a lean pass-through: `messagesForQuery`
 * is `[...state.messages]`. The compaction pipeline is stubbed — the
 * full wiring lands when `src/llm/compact/**` is lifted from tsconfig
 * exclude (T5b / T6).
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";

export async function prepareContext(
  state: TurnState,
  _ctx: TurnContext,
  _session: Session,
  _signal?: AbortSignal,
): Promise<TurnState> {
  // openclaude query.ts:369: `let messagesForQuery = [...getMessagesAfterCompactBoundary(messages)]`
  state.messagesForQuery = [...state.messages];

  // T5b/T6: call autoCompactIfNeeded() once src/llm/compact/** is un-excluded.
  // T7:     call applyToolResultBudget() once content-replacement wiring lands.
  // T8:     blocking-limit check once token-count helpers + recovery ladder land.
  return state;
}
