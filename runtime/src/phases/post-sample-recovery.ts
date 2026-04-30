/**
 * Phase 3 — Post-Sample Recovery.
 *
 * Evaluates the 7-strategy recovery ladder after the model stream
 * completes. Mirrors agenc `query.ts:1082-1299`. Routes through
 * the ordered trigger priority (I-10) under the recovery-in-flight
 * exclusive lock (I-62) with the per-turn re-entry cap (I-42).
 *
 * Invariants wired:
 *   I-7  (stream abort cascade) — terminal abort reasons short-
 *        circuit to exit; recovery reasons continue the loop.
 *   I-10 (trigger priority explicit) — via `triggers.ts` ordered array.
 *   I-17 (stop-hook recursion cap) — enforced via state counter +
 *        stop-hooks phase, not here.
 *   I-22 (token-budget mid-stream) — checked in stream-model, recovery
 *        here acts on the `pendingBudgetDecision` state slot.
 *   I-39 (stop-hook throw guard) — enforced in stop-hooks.ts.
 *   I-42 (recovery re-entry cap) — RecoveryLadder owns the counter.
 *   I-62 (recovery-trigger evaluation exclusive) — RecoveryLadder
 *        acquires `session.recoveryInFlight` lock.
 *
 * @module
 */

import { emitError, emitWarning } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { StreamModelError } from "./stream-model.js";
import {
  isFallbackTriggeredError,
  isWithheld413Message,
} from "../recovery/api-errors.js";
import { RecoveryLadder } from "../recovery/fallback-ladder.js";
import { reserveRecoveryReentry } from "../recovery/fallback-ladder.js";
import { runMaxOutputTokensRecovery } from "../recovery/max-output-tokens.js";
import { runModelFallback } from "../recovery/model-fallback.js";
import { escalatedMaxOutputTokensForModel } from "../llm/model-metadata.js";
import {
  evaluateWithholdCascade,
  markContextCollapseAttempted,
  resetContextCollapseAttempted,
} from "../recovery/withhold-cascading.js";
import {
  runAgenCContextCollapseOverflowRecovery,
} from "../agenc/adapters/runtime-session.js";
import type { StreamingToolExecutor } from "./_deps/orchestrator-types.js";
import { tombstoneOrphans } from "../recovery/tombstone.js";
import { executeStopFailureHooks } from "./stop-hooks.js";

/**
 * Phase-3 entry point. Called by run-turn after the stream-model
 * phase finishes (either normally with assistantMessages, or with
 * a StreamModelError carrying a recoverable cause).
 *
 * Mutates state + returns. On applied recovery the caller sees the
 * new `state.transition` and loops; on exhaustion the caller
 * terminates the turn.
 */
export async function postSampleRecovery(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<TurnState> {
  if (signal?.aborted) return state;

  // I-22: if stream-model stashed a budget-exceeded decision on the
  // state, route to token_budget_continuation BEFORE walking the
  // trigger ladder. Mid-stream overshoot is its own recovery branch.
  if (state.pendingBudgetDecision?.kind === "stop") {
    const reservation = await reserveRecoveryReentry(session, state, {
      triggerName: "token_budget_continuation",
    });
    if (reservation.kind === "exhausted") {
      state.pendingBudgetDecision = undefined;
      state.transition = undefined;
      return state;
    }
    const continuationMessage = state.pendingBudgetDecision.reason;
    resetContextCollapseAttempted(state);
    emitWarning(
      session.eventLog,
      session.nextInternalSubId(),
      "token_budget_continuation",
      continuationMessage,
    );
    state.messages.push({
      role: "user",
      content: continuationMessage,
    });
    state.transition = { reason: "token_budget_continuation" };
    // Match AgenC's continuation branch as closely as the current
    // phase split allows: clear recovery-specific one-shot state before
    // re-entering PrepareContext with the injected continuation prompt.
    state.hasAttemptedReactiveCompact = false;
    state.maxOutputTokensRecoveryCount = 0;
    state.maxOutputTokensOverride = undefined;
    state.pendingToolUseSummary = undefined;
    state.stopHookActive = undefined;
    state.pendingBudgetDecision = undefined;
    return state;
  }

  const lastMessage = state.assistantMessages.at(-1);
  if (!lastMessage || !isWithheld413Message(lastMessage)) {
    resetContextCollapseAttempted(state);
  }
  // StreamModelError may have been stashed on the budget decision
  // slot or surfaced by the caller as a thrown error. Phase-3 sees
  // a TurnState; the run-turn dispatcher forwards FallbackTriggered
  // via the `streamError` hint if it happens mid-stream.
  const streamError = (state as TurnState & { lastStreamError?: unknown })
    .lastStreamError;

  // Build the ladder with T8 actions.
  const ladder = new RecoveryLadder({
    session,
    actions: {
      async on413(c) {
        const gate = evaluateWithholdCascade(c.state, c.lastMessage);
        if (gate.kind === "route_to_collapse_drain") {
          markContextCollapseAttempted(c.state);
          const drain = await runAgenCContextCollapseOverflowRecovery({
            session: c.session,
            state: c.state,
            ...(c.lastMessage !== undefined ? { lastMessage: c.lastMessage } : {}),
          });
          if (drain.kind === "applied") {
            c.state.transition = { reason: "collapse_drain_retry" };
            return drain;
          }
        }
        emitError(c.session.eventLog, c.session.nextInternalSubId(), {
          cause: "prompt_too_long_exhausted",
          message: "413 recovery exhausted",
        });
        await executeStopFailureHooks(c.state, ctx, c.session);
        return { kind: "surface", reason: "prompt_too_long" };
      },

      async onMedia(c) {
        emitError(c.session.eventLog, c.session.nextInternalSubId(), {
          cause: "image_error",
          message: "media-size recovery exhausted",
        });
        await executeStopFailureHooks(c.state, ctx, c.session);
        return { kind: "surface", reason: "image_error" };
      },

      async onMaxOutputTokens(c) {
        const outcome = runMaxOutputTokensRecovery({
          session: c.session,
          state: c.state,
          escalateAllowed:
            ctx.modelInfo.maxOutputTokensCappedDefault === true &&
            ctx.modelInfo.maxOutputTokensExplicit !== true,
          escalatedMaxOutputTokens: escalatedMaxOutputTokensForModel(
            ctx.modelInfo,
          ),
        });
        if (outcome.kind === "escalate" || outcome.kind === "continuation") {
          return { kind: "applied", reason: outcome.kind };
        }
        if (outcome.kind === "exhausted") {
          emitError(c.session.eventLog, c.session.nextInternalSubId(), {
            cause: "max_output_tokens_exhausted",
            message: outcome.reason,
          });
          await executeStopFailureHooks(c.state, ctx, c.session);
          return { kind: "surface", reason: outcome.reason };
        }
        return { kind: "pass" };
      },

      async onStopHookBlocking(c) {
        // I-17 cap checked by commit; here we just wire the transition
        // so the next iteration enters PrepareContext. The stop-hooks
        // phase file is the real actor on the inject itself.
        c.state.transition = { reason: "stop_hook_blocking" };
        return { kind: "applied", reason: "stop_hook_blocking" };
      },

      async onStreamingFallback(c) {
        const executor = c.state.streamingToolExecutor as StreamingToolExecutor | null;
        tombstoneOrphans(c.state, {
          reason: "streaming_fallback",
          executor,
        });
        emitWarning(
          c.session.eventLog,
          c.session.nextInternalSubId(),
          "streaming_fallback_tombstoned",
          "partial assistant messages tombstoned; executor recreated",
        );
        emitWarning(
          c.session.eventLog,
          c.session.nextInternalSubId(),
          "executor_discarded",
          "streaming_fallback",
        );
        // T8: streaming_fallback_retry is the dedicated cause for this
        // recovery path. Distinct from `model_fallback` (reserved for
        // FallbackTriggeredError / cross-model swaps) so downstream
        // telemetry can disambiguate the two.
        c.state.transition = { reason: "streaming_fallback_retry" };
        return { kind: "applied", reason: "streaming_fallback" };
      },

      async onFallbackError(c, error) {
        const executor = c.state.streamingToolExecutor as StreamingToolExecutor | null;
        runModelFallback({
          session: c.session,
          state: c.state,
          error,
          executor,
        });
        return { kind: "applied", reason: "model_fallback" };
      },
    },
  });

  void ctx;

  const outcome = await ladder.run(state, lastMessage, streamError);
  switch (outcome.kind) {
    case "applied":
      // transition is set by the action; run-turn picks it up and
      // loops back to PrepareContext.
      return state;
    case "surface":
      // The action already emitted the typed error; the run-turn
      // dispatcher observes the lack of transition + surface the
      // last message terminally.
      return state;
    case "reentry_cap_exhausted":
      // I-42: ladder already emitted error:'recovery_loop'. Clear
      // the transition so run-turn terminates rather than re-entering.
      state.transition = undefined;
      return state;
    case "no_match":
      // No recovery fired — normal stream completion path.
      return state;
  }
}

// Re-export so run-turn can detect the wire-layer error class without
// importing from the recovery directory.
export { isFallbackTriggeredError, StreamModelError };
