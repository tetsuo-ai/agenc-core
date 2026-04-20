/**
 * Phase 3 — Post-Sample Recovery.
 *
 * Mirrors openclaude query.ts:1082-1299 (the ladder of post-stream
 * recovery paths: aborted_streaming, prompt_too_long, media-recovery,
 * reactive-compact, max_output_tokens escalate/recovery, completion).
 *
 * T5 scope: no-op pass-through. The full ladder lands in T8 (recovery
 * ladder) — it depends on subsystems that land in T6 (compaction),
 * T7 (streaming watchdog), and T11 (permission modes).
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";

export async function postSampleRecovery(
  state: TurnState,
  _ctx: TurnContext,
  _session: Session,
  _signal?: AbortSignal,
): Promise<TurnState> {
  // T8: full recovery ladder. For T5 all paths fall through to commit.
  return state;
}
