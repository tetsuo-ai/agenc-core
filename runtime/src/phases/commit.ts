/**
 * Phase 6 — Commit.
 *
 * The iteration close-out. Increments the turn counter, clears any
 * pending iteration-scoped state (tool-result buffer already pushed
 * onto messages by executeTools), decides whether the turn is done.
 *
 * Mirrors openclaude query.ts:1192-1465 (the final tail of the loop
 * body: await pending tool-use summary, push assistant + tool messages
 * into state.messages, bump turnCount, loop around).
 *
 * T5 scope:
 *   - Increment `turnCount`.
 *   - Clear the per-iteration transition marker.
 *   - Resolve + apply `pendingToolUseSummary` if present (T7 wires).
 *   - Leave `needsFollowUp` as set by streamModel — the dispatcher
 *     reads it to decide whether to loop.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";

export async function commit(
  state: TurnState,
  _ctx: TurnContext,
  _session: Session,
  _signal?: AbortSignal,
): Promise<TurnState> {
  // T7: await streamingToolExecutor pending completion (flushes in-flight
  // streaming tool results into state.toolResults).
  if (state.pendingToolUseSummary) {
    try {
      await state.pendingToolUseSummary;
    } catch {
      /* summary failures are non-fatal; real handling in T7 */
    } finally {
      state.pendingToolUseSummary = undefined;
    }
  }

  state.turnCount += 1;
  state.transition = undefined;
  return state;
}
