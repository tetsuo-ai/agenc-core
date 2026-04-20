/**
 * Stop-hook evaluation helper (shared by commit + continuation-nudge).
 *
 * Mirrors openclaude `src/query/stopHooks.ts` (`handleStopHooks`). Stop
 * hooks run when the model has stopped without emitting tool calls —
 * they can return blocking (block the natural termination and emit a
 * user message to keep going) or non-blocking (allow termination).
 *
 * T5 ships a stub. T8 (recovery ladder + hooks integration) wires the
 * real implementation using the existing AgenC hooks registry at
 * `runtime/src/llm/hooks/`.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";

export interface StopHookResult {
  readonly blocking: boolean;
  /** Reason surfaced to the user / telemetry when a hook blocks. */
  readonly reason?: string;
  /** Optional user-message content to inject before re-entering. */
  readonly injectedMessage?: string;
}

export async function evaluateStopHooks(
  _state: TurnState,
  _ctx: TurnContext,
  _session: Session,
  _signal?: AbortSignal,
): Promise<StopHookResult> {
  // T8 wires real stop-hook loop. For now, never block.
  return { blocking: false };
}
