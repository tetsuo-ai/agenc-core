/**
 * Phase-machine identifiers and the continue-site transition table.
 *
 * The AgenC turn is driven by a 6-phase state machine. Each phase is a
 * pure function `(TurnState, TurnContext, Session, AbortSignal?) =>
 * Promise<TurnState>`. The run-turn dispatcher drives the state forward
 * through the phases; recovery paths set `state.transition` and the
 * next iteration resumes at the phase named by `PhaseTransition`.
 *
 * Invariants covered:
 *   I-89 (proposed): phase functions are pure w.r.t. their inputs,
 *                   performing I/O only via injected services on Session.
 *
 * Source citations refer to openclaude `src/query.ts` line numbers per
 * `docs/plan/openclaude-inventory.md §1`.
 *
 * @module
 */

import type { ContinueReason } from "../session/turn-state.js";

export enum Phase {
  PrepareContext = "prepare_context",
  StreamModel = "stream_model",
  PostSampleRecovery = "post_sample_recovery",
  ContinuationNudge = "continuation_nudge",
  ExecuteTools = "execute_tools",
  Commit = "commit",
}

/**
 * Continue-site → next-phase transition table (8 entries from
 * openclaude query.ts). Every entry restarts at PrepareContext because
 * every recovery path requires re-running compaction / prompt assembly
 * before re-entering the stream.
 *
 * Openclaude source line citations (where each continue site writes
 * `transition: { reason: ... }`):
 *   981  → collapse_drain_retry  (context-collapse recovery entry)
 *   1142 → collapse_drain_retry
 *   1198 → reactive_compact_retry
 *   1254 → max_output_tokens_escalate
 *   1286 → max_output_tokens_recovery
 *   1341 → stop_hook_blocking
 *   1377 → token_budget_continuation
 *   1460 → continuation_nudge
 * Codex adds: model_fallback (client.rs retry path).
 */
export const PhaseTransition: Readonly<Record<ContinueReason, Phase>> =
  Object.freeze({
    model_fallback: Phase.PrepareContext,
    // T8: streaming_fallback_retry is a distinct cause from model_fallback
    // (same destination phase, different telemetry). Kept in the table so
    // the phase-machine dispatcher treats both uniformly.
    streaming_fallback_retry: Phase.PrepareContext,
    collapse_drain_retry: Phase.PrepareContext,
    reactive_compact_retry: Phase.PrepareContext,
    max_output_tokens_escalate: Phase.PrepareContext,
    max_output_tokens_recovery: Phase.PrepareContext,
    stop_hook_blocking: Phase.PrepareContext,
    token_budget_continuation: Phase.PrepareContext,
    continuation_nudge: Phase.PrepareContext,
  });

export { prepareContext } from "./prepare-context.js";
export { streamModel } from "./stream-model.js";
export { postSampleRecovery } from "./post-sample-recovery.js";
export { continuationNudge } from "./continuation-nudge.js";
export { executeTools } from "./execute-tools.js";
export { commit } from "./commit.js";
export type { PhaseEvent } from "./events.js";
