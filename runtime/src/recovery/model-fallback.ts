/**
 * Model-fallback recovery.
 *
 * Hand-port of openclaude `query.ts:928-981`. When the provider/
 * retry layer throws `FallbackTriggeredError`, the primary model has
 * already bailed and the wire is about to retry on the fallback.
 * Phase-3 catches this and:
 *
 *   1. Tombstones orphan assistant messages (tombstone.ts).
 *   2. Discards + recreates the StreamingToolExecutor so orphan
 *      `tool_use_id`s can't leak into the fallback response.
 *   3. Signals the run-turn loop to continue with the new model.
 *
 * Synergy with I-7 (stream abort cascade): the fallback path is a
 * `recovery` destination, not a terminal exit.
 *
 * @module
 */

import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import type { StreamingToolExecutor } from "../tools/streaming-executor.js";
import type { FallbackTriggeredError } from "./api-errors.js";
import { tombstoneOrphans } from "./tombstone.js";
import { emitWarning } from "../session/event-log.js";

export interface ModelFallbackOutcome {
  readonly kind: "switched";
  readonly fromModel: string;
  readonly toModel: string;
  readonly tombstones: number;
}

export interface RunModelFallbackOpts {
  readonly session: Session;
  readonly state: TurnState;
  readonly error: FallbackTriggeredError;
  readonly executor?: StreamingToolExecutor | null;
}

/**
 * Execute the model-fallback recovery step.
 *
 * Post-condition:
 *   - state.assistantMessages / toolResults / toolUseBlocks cleared
 *   - state.streamingToolExecutor nulled (caller constructs fresh
 *     one on next iteration)
 *   - state.transition = { reason: 'model_fallback' } so run-turn
 *     consults the PhaseTransition table for re-entry
 *   - warning event emitted so the event log carries the swap
 *
 * Actual provider swap is signaled via
 * `session.pendingProviderSwitch` which run-turn observes at the
 * top of each iteration (I-13 integration). T13 wires the real
 * provider switch; T8 ships the signal.
 */
export function runModelFallback(opts: RunModelFallbackOpts): ModelFallbackOutcome {
  const { error, session, state } = opts;

  const tombstones = tombstoneOrphans(state, {
    reason: "model_fallback",
    executor: opts.executor ?? null,
  });

  // Signal the next iteration to use the fallback model. T13 wires
  // the real provider factory swap; for T8 we flag the pending-switch
  // slot so run-turn's I-13 path picks it up before the next stream.
  session.pendingProviderSwitch = {
    provider: session.services.provider.name,
    model: error.toModel,
  };

  state.transition = { reason: "model_fallback" };

  emitWarning(
    session.eventLog,
    session.nextInternalSubId(),
    "model_fallback_triggered",
    `falling back from ${error.fromModel} to ${error.toModel} (${tombstones.length} orphan messages tombstoned)`,
  );

  return {
    kind: "switched",
    fromModel: error.fromModel,
    toModel: error.toModel,
    tombstones: tombstones.length,
  };
}
