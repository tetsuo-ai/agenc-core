/**
 * Max-output-tokens recovery (escalate + continuation).
 *
 * Hand-port of openclaude `query.ts:1221-1291`. When a stream's
 * assistant message is withheld because it hit the provider's
 * max_output_tokens limit, two recovery paths apply:
 *
 *   1. **Escalate** (1221-1255) — first attempt only (override
 *      unset): set `maxOutputTokensOverride = 64_000`, re-enter
 *      Phase 1. No meta message needed — same request, bigger ceiling.
 *
 *   2. **Continuation** (1257-1291) — escalate already fired (or
 *      caller opted out). Inject "Resume directly — do not apologize"
 *      meta message, bump `maxOutputTokensRecoveryCount`, re-enter
 *      Phase 1. Capped at `MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3`.
 *
 * After both exhaust, the turn surfaces the error.
 *
 * T8: both recovery paths discard + recreate the StreamingToolExecutor
 * before the next iteration. The truncated assistant batch that hit
 * `max_output_tokens` may have emitted partial `tool_use` blocks that
 * never reached the executor's completion state, so we treat the
 * executor as poisoned on every max-output-tokens recovery path.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import { emitWarning } from "../session/event-log.js";
import type { Session } from "../session/session.js";
import type { TurnState } from "../session/turn-state.js";
import type { StreamingToolExecutor } from "../tools/streaming-executor.js";
import { appendTerminalToolResults } from "./terminal-tool-result.js";

export const MAX_OUTPUT_TOKENS_ESCALATED = 64_000;
export const MAX_OUTPUT_TOKENS_RECOVERY_LIMIT = 3;

const RESUME_META_CONTENT =
  "Continue generating directly from where you left off. Do not apologize, do not restart, do not add preamble. Pick up at the next token.";

export type MaxOutputTokensOutcome =
  | { readonly kind: "escalate" }
  | { readonly kind: "continuation" }
  | { readonly kind: "exhausted"; readonly reason: string }
  | { readonly kind: "not_applicable" };

export interface RunMaxOutputTokensOpts {
  readonly session: Session;
  readonly state: TurnState;
  /** Whether this call should ever escalate to 64k. Providers that
   *  already cap below 8k can opt out. */
  readonly escalateAllowed?: boolean;
}

/**
 * T8: discard the in-flight StreamingToolExecutor and null the state
 * slot so the next phase iteration builds a fresh executor. Matches
 * the model-fallback pattern. Idempotent via the I-41 re-entrance
 * guard on `executor.discard`.
 */
function discardExecutorForMaxOutputTokens(
  session: Session,
  state: TurnState,
): void {
  appendTerminalToolResults(
    state,
    "aborted",
    "max_output_tokens recovery aborted in-flight tool execution",
  );
  const executor = state.streamingToolExecutor as StreamingToolExecutor | null;
  if (executor !== null && executor !== undefined) {
    try {
      (executor as { discard: (reason?: string) => void }).discard(
        "max_output_tokens",
      );
    } catch {
      /* I-41: re-entrance guard absorbs a second discard */
    }
  }
  state.streamingToolExecutor = null;
  emitWarning(
    session.eventLog,
    session.nextInternalSubId(),
    "executor_discarded",
    "max_output_tokens",
  );
}

/**
 * Decide + mutate state for the next iteration. Called by phase-3
 * post-sample-recovery after `isWithheldMaxOutputTokens` fires.
 *
 * State mutations:
 *   - escalate: sets `state.maxOutputTokensOverride`, marks transition
 *   - continuation: appends meta message, bumps counter, marks transition
 *   - exhausted: no state change (caller surfaces the error)
 *
 * Both escalate and continuation additionally discard+recreate the
 * StreamingToolExecutor and emit `executor_discarded` telemetry.
 */
export function runMaxOutputTokensRecovery(
  opts: RunMaxOutputTokensOpts,
): MaxOutputTokensOutcome {
  const { session, state } = opts;
  const overrideUnset = state.maxOutputTokensOverride === undefined;
  const escalateAllowed = opts.escalateAllowed !== false;

  // Step 1: escalate path — first attempt, override unset.
  if (overrideUnset && escalateAllowed) {
    state.maxOutputTokensOverride = MAX_OUTPUT_TOKENS_ESCALATED;
    state.transition = { reason: "max_output_tokens_escalate" };
    discardExecutorForMaxOutputTokens(session, state);
    return { kind: "escalate" };
  }

  // Step 2: continuation path — bump counter if under the cap.
  if (state.maxOutputTokensRecoveryCount < MAX_OUTPUT_TOKENS_RECOVERY_LIMIT) {
    const metaMessage: LLMMessage = {
      role: "user",
      content: RESUME_META_CONTENT,
    };
    state.messages.push(metaMessage);
    state.maxOutputTokensRecoveryCount += 1;
    state.transition = { reason: "max_output_tokens_recovery" };
    discardExecutorForMaxOutputTokens(session, state);
    return { kind: "continuation" };
  }

  // Step 3: cap exhausted. Surface the error.
  return {
    kind: "exhausted",
    reason: `max_output_tokens_recovery_limit (${MAX_OUTPUT_TOKENS_RECOVERY_LIMIT})`,
  };
}
