/**
 * The typed boundary of an automatic compaction: one `context_compacted`
 * event per automatic compaction, followed by the session metadata.
 *
 * It is reported where the compaction commits (after its last commit when
 * it committed twice), before the model call that follows it, so a client
 * draws the line at the compaction's place and the rollout reads commit,
 * boundary, session_meta (the post-commit window the canonical rollout
 * scanner expects). The commit phase calls it too, as a fallback for a
 * commit whose caller did not report it.
 *
 * @module
 */

import { isSelectableHistoryUserMessage, splitActiveHistory, type Session } from "./session.js";
import type { TurnState } from "./turn-state.js";

/**
 * Emits the boundary of the latest automatic compaction once; a no-op
 * otherwise. True when it emitted the boundary.
 */
export function emitAutoCompactBoundary(state: TurnState, session: Session): boolean {
  const tracking = state.autoCompactTracking;
  if (!tracking || !tracking.compacted || tracking.turnCounter !== 0) return false;
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "context_compacted",
      payload: {
        summary: `auto-compact boundary (turnId=${tracking.turnId})`,
        activeUserMessageIds: splitActiveHistory(state.messages).activeHistory.flatMap((message) =>
          isSelectableHistoryUserMessage(message) &&
          typeof message.runtimeOnly?.responseItemId === "string"
            ? [message.runtimeOnly.responseItemId] : []),
      },
    },
  });
  // T6 I-24b: re-append session metadata so --resume readers that
  // scan the last 16KB of the rollout still find the session
  // header even after many compacts have pushed it out of range.
  session.rolloutStore?.store.reAppendSessionMetadata();
  // Mark the boundary as consumed so it fires once, until the next
  // successful compact stamps a new tracking state.
  state.autoCompactTracking = { ...tracking, turnCounter: 1 };
  return true;
}
