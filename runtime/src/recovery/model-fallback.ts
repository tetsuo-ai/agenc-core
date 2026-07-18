/**
 * Model-fallback recovery.
 *
 * Hand-port of agenc `query.ts:928-981`. When the provider/
 * retry layer throws `FallbackTriggeredError`, the primary model has
 * already bailed and the wire is about to retry on the fallback.
 * Phase-3 catches this and:
 *
 *   1. Synthesizes terminal `tool_result` rows for any orphan
 *      `tool_use` blocks so the fallback provider never sees a
 *      dangling `tool_use_id` (I-7 stream-abort cascade).
 *   2. Tombstones orphan assistant messages (tombstone.ts).
 *   3. Discards + recreates the StreamingToolExecutor so in-flight
 *      tool calls can't leak into the fallback response (I-41).
 *   4. Emits a typed `executor_discarded` warning so telemetry can
 *      disambiguate the two recovery causes.
 *   5. Signals the run-turn loop to continue with the new model.
 *
 * Synergy with I-7 (stream abort cascade): the fallback path is a
 * `recovery` destination, not a terminal exit.
 *
 * @module
 */

import { readProviderIdentity } from "../llm/provider.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import type { StreamingToolExecutor } from "./_deps/streaming-executor.js";
import type { FallbackTriggeredError } from "./api-errors.js";
import { appendTerminalToolResults } from "./terminal-tool-result.js";
import { tombstoneOrphans } from "./tombstone.js";
import { emitWarning } from "../session/event-log.js";

export interface ModelFallbackOutcome {
  readonly kind: "switched";
  readonly fromModel: string;
  readonly toModel: string;
  readonly tombstones: number;
  readonly orphanToolResultsSynthesized: number;
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
 *   - orphan tool_use blocks synthesized → state.toolResults +
 *     state.messages gain synthetic terminal tool_results BEFORE
 *     tombstone clears them (ensures the fallback-bound message
 *     trail never has dangling tool_use_ids even if a caller
 *     inspects state.messages between steps).
 *   - state.assistantMessages / toolResults / toolUseBlocks cleared
 *   - state.streamingToolExecutor discarded + nulled (caller
 *     constructs a fresh one on next iteration)
 *   - `executor_discarded` warning emitted with cause='model_fallback'
 *   - state.transition = { reason: 'model_fallback' } so run-turn
 *     consults the PhaseTransition table for re-entry
 *   - warning event emitted so the event log carries the swap
 *
 * Actual provider swap is signaled via
 * `session.pendingProviderSwitch` which run-turn observes at the
 * top of each iteration (I-13 integration).
 */
export function runModelFallback(opts: RunModelFallbackOpts): ModelFallbackOutcome {
  const { error, session, state } = opts;

  // Step 1: synthesize terminal tool_results for orphan tool_use
  // blocks BEFORE tombstone clears the batch. Without this, a
  // tombstone + fallback request can leave the provider looking at
  // a history with assistant tool_use_ids whose matching tool_result
  // rows were never emitted. Cause `provider_switched` documents the
  // reason for filter/telemetry consumers.
  const synthetic = appendTerminalToolResults(
    state,
    "provider_switched",
    `model_fallback ${error.fromModel} → ${error.toModel}`,
  );

  // Step 2: tombstone orphans + discard+null the executor. tombstone
  // handles discard() + streamingToolExecutor=null internally; we
  // prefer an explicit caller executor reference so discard fires
  // even when state.streamingToolExecutor was already cleared by a
  // racing cleanup path.
  const tombstones = tombstoneOrphans(state, {
    reason: "model_fallback",
    executor:
      opts.executor ??
      (state.streamingToolExecutor as StreamingToolExecutor | null) ??
      null,
  });

  // Step 3: emit the typed executor_discarded telemetry hook so
  // downstream consumers can disambiguate this from the max-output-
  // tokens recovery discard. tombstone already cleared
  // streamingToolExecutor to null; the emit is fresh evidence, not
  // a second mutation.
  emitWarning(
    session.eventLog,
    session.nextInternalSubId(),
    "executor_discarded",
    "model_fallback",
  );

  // Signal the next iteration to use the fallback model. run-turn's I-13
  // path consumes the pending switch before the next stream.
  session.pendingProviderSwitch = {
    provider:
      error.toProvider ??
      readProviderIdentity(session.services.provider) ??
      session.services.provider.name,
    model: error.toModel,
  };
  state.pendingAdmissionFallback = {
    fromModel: error.fromModel,
    toModel: error.toModel,
    ...(error.fromProvider !== undefined
      ? { fromProvider: error.fromProvider }
      : {}),
    ...(error.toProvider !== undefined
      ? { toProvider: error.toProvider }
      : {}),
    reason: error.reason ?? "provider_fallback_ladder",
  };

  state.transition = { reason: "model_fallback" };

  emitWarning(
    session.eventLog,
    session.nextInternalSubId(),
    "model_fallback_triggered",
    `falling back from ${error.fromModel} to ${error.toModel} (${tombstones.length} orphan messages tombstoned, ${synthetic.length} orphan tool_results synthesized)`,
  );

  return {
    kind: "switched",
    fromModel: error.fromModel,
    toModel: error.toModel,
    tombstones: tombstones.length,
    orphanToolResultsSynthesized: synthetic.length,
  };
}
