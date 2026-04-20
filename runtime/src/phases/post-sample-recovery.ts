/**
 * Phase 3 — Post-Sample Recovery.
 *
 * Evaluates the 7-strategy recovery ladder after the model stream
 * completes. Mirrors openclaude `query.ts:1082-1299`. Routes through
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
 *   I-40 (reactive-compact throw guard) — enforced in reactive-compact.ts.
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
import { isFallbackTriggeredError } from "../recovery/api-errors.js";
import { RecoveryLadder } from "../recovery/fallback-ladder.js";
import { runCollapseDrain } from "../recovery/collapse-drain.js";
import { runReactiveCompact } from "../recovery/reactive-compact.js";
import { runMaxOutputTokensRecovery } from "../recovery/max-output-tokens.js";
import { runModelFallback } from "../recovery/model-fallback.js";
import {
  evaluateWithholdCascade,
  isMediaWithholdRoute,
} from "../recovery/withhold-cascading.js";
import type { StreamingToolExecutor } from "../tools/streaming-executor.js";
import { tombstoneOrphans } from "../recovery/tombstone.js";

/**
 * Phase-3 entry point. Called by run-turn after the stream-model
 * phase finishes (either normally with assistantMessages, or with
 * a StreamModelError carrying a recoverable cause).
 *
 * Mutates state + returns. On applied recovery the caller sees the
 * new `state.transition` and loops; on exhaustion the caller
 * terminates the turn.
 */
const TOKEN_BUDGET_CONTINUATION_PROMPT =
  "You are over the per-turn token budget. Continue the task but end the current step and hand off at a logical boundary.";

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
    emitWarning(
      session.eventLog,
      session.nextInternalSubId(),
      "token_budget_continuation",
      state.pendingBudgetDecision.reason,
    );
    state.messages.push({
      role: "user",
      content: TOKEN_BUDGET_CONTINUATION_PROMPT,
    });
    state.transition = { reason: "token_budget_continuation" };
    // Reset hasAttemptedReactiveCompact on this branch (openclaude
    // query.ts:1369 — token-budget continuation clears; stop-hook-blocking
    // preserves).
    state.hasAttemptedReactiveCompact = false;
    state.pendingBudgetDecision = undefined;
    state.recoveryReentryCount += 1;
    return state;
  }

  const lastMessage = state.assistantMessages.at(-1);
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
          const drain = await runCollapseDrain(c.state, { session: c.session });
          if (drain.kind === "drained") {
            return { kind: "applied", reason: `collapse_drain(${drain.committed})` };
          }
          // Fall through to reactive-compact on no-op or skipped-guard.
        }
        if (c.lastMessage) {
          const rc = await runReactiveCompact({
            session: c.session,
            state: c.state,
            lastMessage: c.lastMessage,
          });
          if (rc.kind === "compacted") {
            return { kind: "applied", reason: "reactive_compact" };
          }
          if (rc.kind === "threw") {
            return { kind: "surface", reason: "reactive_compact_threw" };
          }
        }
        emitError(c.session.eventLog, c.session.nextInternalSubId(), {
          cause: "prompt_too_long_exhausted",
          message: "413 recovery exhausted",
        });
        return { kind: "surface", reason: "prompt_too_long" };
      },

      async onMedia(c) {
        if (!c.lastMessage || !isMediaWithholdRoute(c.lastMessage)) {
          return { kind: "pass" };
        }
        const rc = await runReactiveCompact({
          session: c.session,
          state: c.state,
          lastMessage: c.lastMessage,
        });
        if (rc.kind === "compacted") {
          return { kind: "applied", reason: "media_reactive_compact" };
        }
        emitError(c.session.eventLog, c.session.nextInternalSubId(), {
          cause: "image_error",
          message: "media-size recovery exhausted",
        });
        return { kind: "surface", reason: "image_error" };
      },

      async onMaxOutputTokens(c) {
        const outcome = runMaxOutputTokensRecovery({
          session: c.session,
          state: c.state,
        });
        if (outcome.kind === "escalate" || outcome.kind === "continuation") {
          return { kind: "applied", reason: outcome.kind };
        }
        if (outcome.kind === "exhausted") {
          emitError(c.session.eventLog, c.session.nextInternalSubId(), {
            cause: "max_output_tokens_exhausted",
            message: outcome.reason,
          });
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
        c.state.transition = { reason: "model_fallback" };
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
