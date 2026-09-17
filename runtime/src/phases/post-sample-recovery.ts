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

import { createHash } from "node:crypto";
import {
  runtimeWireEnvelope,
  toolCallsForRuntime,
} from "../session/runtime-message-conversion.js";

import { emitError, emitWarning } from "../session/event-log.js";
import type { LLMMessage } from "../llm/types.js";
import {
  toRuntimeMessageContent,
} from "../llm/content-conversion.js";
import { compactConversation } from "../services/compact/compact.js";
import type { RuntimeMessage } from "../services/compact/types.js";
import {
  CompactionCleanupPendingError,
  finalizeCompactionTransaction,
} from "../services/compact/finalize-transaction.js";
import {
  CompactionCannotReduceError,
  CompactionFailurePersistenceError,
  CompactionTransactionError,
  type CompactionFailureReason,
} from "../services/compact/transaction-types.js";
import {
  AGGRESSIVE_COMPACTION_FOCUS,
  EMERGENCY_COMPACTION_FOCUS,
  nextLadderTiers,
  resolveCompactionLadderPolicy,
  type CompactionLadderTier,
} from "../services/compact/ladder.js";
import { createRuntimeEmergencySummarizer } from "../services/compact/emergency-summarizer.js";
import { runPostCompactCleanup } from "../services/compact/postCompactCleanup.js";
import { resetMicrocompactState } from "../services/compact/microCompact.js";
import { responseItemToLlmMessage } from "../session/message-history-conversion.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { StreamModelError } from "./stream-model.js";
import {
  isFallbackTriggeredError,
  isRecoverableContextOverflowStreamError,
  isWithheld413Message,
} from "../recovery/api-errors.js";
import { RecoveryLadder } from "../recovery/fallback-ladder.js";
import { resetRecoveryReentries } from "../recovery/fallback-ladder.js";
import { runMaxOutputTokensRecovery } from "../recovery/max-output-tokens.js";
import { runModelFallback } from "../recovery/model-fallback.js";
import { escalatedMaxOutputTokensForModel } from "../llm/model-metadata.js";
import {
  evaluateWithholdCascade,
  markContextCollapseAttempted,
  resetContextCollapseAttempted,
} from "../recovery/withhold-cascading.js";
import type { StreamingToolExecutor } from "./_deps/tool-runtime.js";
import { tombstoneOrphans } from "../recovery/tombstone.js";
import { executeStopFailureHooks } from "./stop-hooks.js";
import { recoverRejectedTextToolCall } from "../recovery/rejected-text-tool-call.js";

/** One compaction ladder tier that declined during a 413 collapse, with history unchanged. */
export interface ContextCollapseTierFailure {
  readonly tier: CompactionLadderTier;
  readonly reason: CompactionFailureReason | CompactionCannotReduceError["code"];
  readonly message: string;
}

export type ContextCollapseAttempt =
  | { readonly kind: "applied"; readonly reason: string; readonly tier: CompactionLadderTier }
  | { readonly kind: "pass" }
  | {
      /** Every allowed tier declined without changing history. */
      readonly kind: "ladder_exhausted";
      readonly reason: string;
      readonly failures: readonly ContextCollapseTierFailure[];
    };

/** The reactive collapse shares its degraded-tier warning with the proactive ladder. */
const REACTIVE_COLLAPSE_LADDER_LABEL = "reactive_recovery/in_turn";

type RuntimeWireRole = NonNullable<RuntimeMessage["role"]>;

type CollapseRuntimeMessage = Omit<
  RuntimeMessage,
  "role" | "originalRole" | "message"
> & {
  readonly role?: RuntimeWireRole;
  readonly originalRole?: LLMMessage["role"];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly arguments?: string;
  }[];
  readonly phase?: string;
  readonly type?: string;
  readonly message?: {
    readonly role?: string;
    readonly content?: unknown;
  };
};

/**
 * The bounded 413 collapse: compact the overflowing query projection through
 * the degraded compaction ladder and commit the first tier that succeeds.
 *
 * Every tier runs the same durable transaction; only the summary focus, the
 * verbatim tail and (for `emergency_local`) the summarizer differ. Each tier
 * either commits or declines with history unchanged, so a decline is a
 * reason to step down the ladder, never to end the turn. When every allowed
 * tier has declined the caller receives `ladder_exhausted` and ends the turn
 * on its typed `prompt_too_long_exhausted` path. Faults that leave the
 * history state uncertain (`intent_failed`, `commit_failed`, a pending
 * cleanup, a persistence failure, an abort) still propagate.
 */
export async function runContextCollapseOverflowRecovery(params: {
  readonly state: TurnState;
  readonly session?: Session;
  readonly turnContext?: TurnContext;
  readonly signal?: AbortSignal;
}): Promise<ContextCollapseAttempt> {
  const session = params.session;
  if (session?.rolloutStore === null || session?.rolloutStore === undefined) {
    return { kind: "pass" } as const;
  }
  const recovered = await recoverFromOverflow(
    toCollapseRuntimeMessages(params.state.messagesForQuery),
    session,
    params.state,
    params.turnContext,
    params.signal,
  );
  if (recovered.kind !== "committed") return recovered;
  const cleanup = (): void => cleanupSessionAfterCompaction(session);
  try {
    await finalizeCompactionTransaction({
      store: session.rolloutStore,
      attemptId: recovered.attemptId,
      applyProjection: () => {
        params.state.messagesForQuery = [...recovered.messages];
        params.state.messages = [...params.state.messagesForQuery];
        // A commit ends the ladder episode: the next decline may climb again.
        params.state.compactionLadder = undefined;
      },
      cleanup,
    });
  } catch (error) {
    if (error instanceof CompactionCleanupPendingError) {
      session.registerCompactionCleanupRetry(recovered.attemptId, cleanup);
    }
    throw error;
  }
  return {
    kind: "applied",
    reason: "context_collapse",
    tier: recovered.tier,
  } as const;
}

/**
 * Transaction failures after which no further tier may run: the history
 * state is uncertain (a pin, intent or commit failed part-way; a recovery
 * was interrupted) or the run is stopping. `ladderAppliesToDecline` excludes
 * the same `pin_failed` and `aborted` cases from the proactive ladder.
 */
const FATAL_COLLAPSE_FAILURE_REASONS: ReadonlySet<CompactionFailureReason> =
  new Set([
    "aborted",
    "pin_failed",
    "intent_failed",
    "commit_failed",
    "recovery_interrupted",
  ]);

/**
 * True for a compaction failure that left history unchanged and that a more
 * aggressive tier may still resolve: a planner refusal inside compaction's
 * own resource bounds (#2520: many small messages exhaust the node ceiling
 * while the transcript is nowhere near the context window), a rejected or
 * failed summary, a shrink floor the standard plan could not meet.
 *
 * Such a failure must not escape the 413 trigger as an untyped throw: the
 * recovery ladder converts any exception into `surface` with
 * `trigger_threw`, ending the turn without the typed
 * `prompt_too_long_exhausted` record and with ladder tiers unused.
 *
 * Every other error still propagates, including `CompactionCleanupPendingError`,
 * which the transaction deliberately rethrows after registering its retry.
 */
export function isCompactionTierFailure(
  error: unknown,
): error is CompactionTransactionError | CompactionCannotReduceError {
  if (error instanceof CompactionCannotReduceError) return true;
  if (!(error instanceof CompactionTransactionError)) return false;
  if (error instanceof CompactionFailurePersistenceError) return false;
  return !FATAL_COLLAPSE_FAILURE_REASONS.has(error.reason);
}

function describeCollapseTierFailure(failure: ContextCollapseTierFailure): string {
  return `${failure.tier}=${failure.reason} (${failure.message.slice(0, 160)})`;
}

function cleanupSessionAfterCompaction(session: Session): void {
  const direct = session as unknown as {
    readonly readFileState?: { clear(): void };
    readonly clearSearchIndexes?: () => void;
    readonly clearToolIndexes?: () => void;
  };
  const snapshot = (
    session as unknown as {
      readonly state?: { unsafePeek?: () => unknown };
    }
  ).state?.unsafePeek?.() as {
    readonly readFileState?: { clear(): void };
  } | undefined;
  runPostCompactCleanup({
    clearReadFileState: () =>
      (direct.readFileState ?? snapshot?.readFileState)?.clear(),
    clearProviderResponseId: () => session.clearProviderResponseId(),
    clearSearchIndexes: direct.clearSearchIndexes,
    clearToolIndexes: direct.clearToolIndexes,
    resetMicrocompactState,
  });
}

type OverflowRecovery =
  | { readonly kind: "pass" }
  | {
      readonly kind: "committed";
      readonly messages: readonly LLMMessage[];
      readonly attemptId: string;
      readonly tier: CompactionLadderTier;
    }
  | {
      readonly kind: "ladder_exhausted";
      readonly reason: string;
      readonly failures: readonly ContextCollapseTierFailure[];
    };

const STANDARD_COLLAPSE_FOCUS =
  "Recover from a prompt-too-long provider response.";

/**
 * Focus strings double as each tier's identity in the durable configuration
 * digest (`requested_focus`), so the transaction's failure guard counts each
 * tier separately, exactly as the proactive ladder does.
 */
function collapseTierFocus(tier: CompactionLadderTier): string {
  switch (tier) {
    case "standard":
      return STANDARD_COLLAPSE_FOCUS;
    case "aggressive_summary":
      return AGGRESSIVE_COMPACTION_FOCUS;
    case "emergency_local":
      return EMERGENCY_COMPACTION_FOCUS;
    default: {
      const exhaustive: never = tier;
      throw new Error(`unknown compaction ladder tier: ${String(exhaustive)}`);
    }
  }
}

function collapseTierOptions(
  tier: CompactionLadderTier,
): Parameters<typeof compactConversation>[3] {
  switch (tier) {
    case "standard":
      return {};
    case "aggressive_summary":
      return { keepCount: 0 };
    case "emergency_local":
      return { keepCount: 0, summarizer: createRuntimeEmergencySummarizer() };
    default: {
      const exhaustive: never = tier;
      throw new Error(`unknown compaction ladder tier: ${String(exhaustive)}`);
    }
  }
}

function collapseTierFailure(
  tier: CompactionLadderTier,
  error: CompactionTransactionError | CompactionCannotReduceError,
): ContextCollapseTierFailure {
  return {
    tier,
    reason:
      error instanceof CompactionTransactionError ? error.reason : error.code,
    message: error.message,
  };
}

/**
 * Compact the overflowing projection through the compaction ladder
 * (`standard`, then `aggressive_summary`, then `emergency_local`), stopping
 * at the first tier that commits.
 *
 * The overflow usually IS one oversized recent result, and the standard plan
 * keeps a verbatim tail that may reproduce it; the degraded tiers keep no
 * tail, and the last one needs no model call at all. A tier that declines
 * leaves history unchanged and steps down; the run-turn ladder already did
 * this for the proactive gate (#2497), while this reactive path made one
 * attempt and ended the turn with tiers unused (#2520).
 */
async function recoverFromOverflow(
  messages: RuntimeMessage[],
  session: Session,
  state: TurnState,
  turnContext?: TurnContext,
  signal?: AbortSignal,
): Promise<OverflowRecovery> {
  if (messages.length < 4) return { kind: "pass" };
  const rolloutStore = session.rolloutStore;
  if (rolloutStore === null || rolloutStore === undefined) {
    return { kind: "pass" };
  }
  const provider = turnContext?.provider ?? session.services.provider;
  const modelInfo = turnContext?.modelInfo ?? session.modelInfo;
  const abortController = new AbortController();
  const forwardAbort = (): void => abortController.abort(signal?.reason);
  if (signal?.aborted === true) forwardAbort();
  else signal?.addEventListener("abort", forwardAbort, { once: true });
  const context = {
    provider,
    admissionSession: session,
    compactionTransaction: rolloutStore,
    compactionMode: "automatic" as const,
    abortController,
    options: {
      mainLoopModel: modelInfo.slug,
      ...(modelInfo.contextWindow !== undefined
        ? { contextWindowTokens: modelInfo.contextWindow }
        : {}),
      ...(modelInfo.maxOutputTokens !== undefined
        ? { maxOutputTokens: modelInfo.maxOutputTokens }
        : {}),
      ...(turnContext?.baseInstructions !== undefined
        ? { systemPrompt: turnContext.baseInstructions }
        : {}),
      querySource: "overflow_recovery",
    },
  };
  const policy = resolveCompactionLadderPolicy(turnContext?.config);
  const failures: ContextCollapseTierFailure[] = [];
  /** Commits, or records the tier's decline and returns it. Faults propagate. */
  const attempt = async (
    tier: CompactionLadderTier,
  ): Promise<
    | OverflowRecovery
    | {
        readonly kind: "declined";
        readonly error: CompactionTransactionError | CompactionCannotReduceError;
      }
  > => {
    try {
      const compacted = await compactConversation(
        messages,
        context,
        collapseTierFocus(tier),
        collapseTierOptions(tier),
      );
      if (compacted.transaction === undefined) {
        throw new Error(
          "overflow recovery did not produce a durable transaction",
        );
      }
      return {
        kind: "committed",
        messages: compacted.transaction.committed.replacement_history.map(
          responseItemToLlmMessage,
        ),
        attemptId: compacted.transaction.attempt_id,
        tier,
      };
    } catch (error) {
      if (abortController.signal.aborted || !isCompactionTierFailure(error)) {
        throw error;
      }
      failures.push(collapseTierFailure(tier, error));
      return { kind: "declined", error };
    }
  };
  try {
    const standard = await attempt("standard");
    if (standard.kind !== "declined") return standard;
    // Each degraded tier runs at most once per episode, shared with the
    // proactive ladder; a commit on either path starts a new episode.
    const degradedTiers = nextLadderTiers(
      policy,
      {
        wasCompacted: false,
        skippedReason: standard.error.message,
        consecutiveFailures: 0,
        ...(standard.error instanceof CompactionTransactionError
          ? { skippedFailureReason: standard.error.reason }
          : { skippedCode: standard.error.code }),
      },
      state.compactionLadder?.tiersAttempted ?? [],
    );
    for (const tier of degradedTiers) {
      const previous = failures.at(-1);
      const attempted = state.compactionLadder?.tiersAttempted ?? [];
      state.compactionLadder = { tiersAttempted: [...attempted, tier] };
      emitWarning(
        session.eventLog,
        session.nextInternalSubId(),
        "auto_compact_degraded",
        `${REACTIVE_COLLAPSE_LADDER_LABEL}: tier=${tier} attempting after ${previous?.reason ?? "decline"}`,
      );
      const degraded = await attempt(tier);
      if (degraded.kind !== "declined") return degraded;
    }
  } finally {
    signal?.removeEventListener("abort", forwardAbort);
  }
  return {
    kind: "ladder_exhausted",
    reason: `compaction declined at every ladder tier: ${failures
      .map(describeCollapseTierFailure)
      .join("; ")}`,
    failures,
  };
}

function toCollapseRuntimeMessages(
  messages: readonly LLMMessage[],
): CollapseRuntimeMessage[] {
  return messages.map((message, index) => {
    const runtimeContent = toRuntimeMessageContent(message.content);
    if (message.role === "system") {
      return {
        role: "system",
        type: "system",
        content: runtimeContent,
        uuid: `agenc-system-${index}`,
        timestamp: new Date(0).toISOString(),
      };
    }
    const role = toRuntimeWireRole(message.role);
    return {
      role,
      content: runtimeContent,
      ...(message.role !== role ? { originalRole: message.role } : {}),
      ...(message.toolCallId !== undefined
        ? { toolCallId: message.toolCallId }
        : {}),
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.phase !== undefined ? { phase: message.phase } : {}),
      ...runtimeWireEnvelope(role, runtimeContent, index),
      ...toolCallsForRuntime(message.toolCalls),
      ...(message.role === "tool" ? { isMeta: true } : {}),
      ...(message.runtimeOnly !== undefined
        ? { runtimeOnly: message.runtimeOnly }
        : {}),
    };
  });
}

function toRuntimeWireRole(role: LLMMessage["role"]): RuntimeWireRole {
  if (role === "tool") return "user";
  if (role === "developer") return "system";
  return role;
}

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

  // Defense in depth for direct/future callers: an Editor interaction is
  // bounded to its immutable request plus trusted read/proposal tool loop.
  // The recovery ladder can compact/rewrite messages, inject prompts, execute
  // hooks, or stage a model/provider switch, so no ladder transition may
  // survive this request-scoped boundary.
  if (ctx.editorInteraction !== undefined) {
    state.pendingBudgetDecision = undefined;
    state.transition = undefined;
    return state;
  }

  // Invalid text-shaped tool calls never enter the executable tool ledger.
  // This separate cap survives other recovery strategies and durable resume.
  // Any budget continuation is still honored; the outer request boundary
  // remains responsible for hard context, cost and admission limits.
  if (state.pendingTextToolCallCorrection !== undefined) {
    recoverRejectedTextToolCall(state);
    if (state.textToolCallCorrectionFailure !== undefined) return state;
    if (state.pendingBudgetDecision?.kind === "stop") {
      await applyPendingBudgetContinuation(state, ctx, session, signal);
      if (state.transition?.reason === "token_budget_continuation") {
        state.transition = { reason: "text_tool_call_correction" };
      } else if (state.transition === undefined) {
        state.textToolCallCorrectionFailure = "The tool-call correction could not continue within the turn's token budget. The requested action did not complete.";
      }
    }
    return state;
  }

  // I-22: if stream-model stashed a budget-exceeded decision on a
  // tool-free response, route to token_budget_continuation before the
  // trigger ladder. If tool calls are pending, run-turn applies the
  // same continuation after Phase 5 so history remains paired.
  if (
    state.pendingBudgetDecision?.kind === "stop" &&
    state.toolUseBlocks.length === 0 &&
    (state.assistantMessages.at(-1)?.toolCalls.length ?? 0) === 0
  ) {
    return applyPendingBudgetContinuation(state, ctx, session, signal);
  }

  const lastMessage = state.assistantMessages.at(-1);
  // StreamModelError may have been stashed on the budget decision
  // slot or surfaced by the caller as a thrown error. Phase-3 sees
  // a TurnState; the run-turn dispatcher forwards FallbackTriggered
  // via the `streamError` hint if it happens mid-stream.
  const streamError = (state as TurnState & { lastStreamError?: unknown })
    .lastStreamError;
  // A provider refusal thrown as a typed context overflow is the same 413 as a
  // withheld message, so it must not clear the one-collapse-per-overflow latch.
  if (
    (!lastMessage || !isWithheld413Message(lastMessage)) &&
    !isRecoverableContextOverflowStreamError(state, streamError)
  ) {
    resetContextCollapseAttempted(state);
  }

  // Build the ladder with T8 actions.
  const ladder = new RecoveryLadder({
    session,
    actions: {
      async on413(c) {
        const gate = evaluateWithholdCascade(c.state, c.lastMessage, c.streamError);
        if (gate.kind === "route_to_collapse_drain") {
          markContextCollapseAttempted(c.state);
          const drain = await runContextCollapseOverflowRecovery({
            state: c.state,
            session: c.session,
            turnContext: ctx,
            ...(signal !== undefined ? { signal } : {}),
          });
          if (drain.kind === "applied") {
            if (drain.tier !== "standard") {
              emitWarning(
                c.session.eventLog,
                c.session.nextInternalSubId(),
                "auto_compact_degraded",
                `${REACTIVE_COLLAPSE_LADDER_LABEL}: tier=${drain.tier} compacted`,
              );
            }
            c.state.transition = { reason: "collapse_drain_retry" };
            return { kind: "applied", reason: drain.reason };
          }
          if (drain.kind === "ladder_exhausted") {
            emitWarning(
              c.session.eventLog,
              c.session.nextInternalSubId(),
              "context_collapse_ladder_exhausted",
              drain.reason,
            );
          }
        }
        emitError(c.session, c.session.nextInternalSubId(), {
          cause: "prompt_too_long_exhausted",
          message: "413 recovery exhausted",
        });
        await executeStopFailureHooks(c.state, ctx, c.session);
        return { kind: "surface", reason: "prompt_too_long" };
      },

      async onMedia(c) {
        emitError(c.session, c.session.nextInternalSubId(), {
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
          emitError(c.session, c.session.nextInternalSubId(), {
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
        const executor = c.state
          .streamingToolExecutor as StreamingToolExecutor | null;
        // A streaming fallback discards the partial answer and asks the model
        // for it again. That only helps when the next attempt differs, and
        // sampling is not guaranteed to make it differ: an observed grok-4.6
        // turn degenerated into repeating one token until it hit the output
        // cap, and attempts 3 and 4 came back byte-for-byte identical --
        // 36,879 characters each. The ladder then burned its remaining
        // re-entries reproducing the same failure, ~2M prompt tokens for no
        // output at all.
        //
        // Identical partials mean regeneration is deterministic here, so the
        // retries left cannot produce anything new. Surface the failure on the
        // repeat instead of paying for it five times.
        const digest = partialAnswerDigest(c.state);
        const previous = lastDiscardedPartial.get(c.state);
        lastDiscardedPartial.set(c.state, digest);
        if (previous !== undefined && previous === digest) {
          tombstoneOrphans(c.state, {
            reason: "streaming_fallback",
            executor,
          });
          const reason =
            "streaming fallback regenerated a byte-identical partial answer; " +
            "retrying cannot change a deterministic result";
          emitError(c.session.eventLog, c.session.nextInternalSubId(), {
            cause: "streaming_fallback_deterministic",
            message: reason,
          });
          lastDiscardedPartial.delete(c.state);
          return { kind: "surface", reason };
        }
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
        const executor = c.state
          .streamingToolExecutor as StreamingToolExecutor | null;
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

// Token-budget continuations are a *legitimate* productive loop driven
// by the user's token target (e.g. "+500k") — they are NOT a recovery
// loop, so they must not share the 5-entry recovery safety cap
// (MAX_RECOVERY_REENTRIES). Sharing it caused large targets to silently
// halt after ~5 continuations. The real "stop" signal for this path is
// the BudgetTracker's own diminishing-returns guard (token-budget.ts),
// which stops emitting `pendingBudgetDecision` once the target is met or
// progress stalls; this counter is only a runaway backstop sized far
// above any realistic continuation count for a single turn.
/**
 * Digest of the partial answer a streaming fallback is about to discard, kept
 * per turn so the next fallback can tell "the model produced something new"
 * from "the model produced exactly what it produced last time".
 */
const lastDiscardedPartial = new WeakMap<TurnState, string>();

function partialAnswerDigest(state: TurnState): string {
  const text = state.assistantMessages
    .map((message) => message.text ?? "")
    .join(" ");
  return `${state.assistantMessages.length}:${text.length}:${createHash("sha256").update(text).digest("hex")}`;
}

const MAX_BUDGET_CONTINUATIONS = 10_000;
const budgetContinuationCounts = new WeakMap<TurnState, number>();

export async function applyPendingBudgetContinuation(
  state: TurnState,
  _ctx: TurnContext,
  session: Session,
  signal?: AbortSignal,
): Promise<TurnState> {
  if (signal?.aborted) return state;
  if (state.pendingBudgetDecision?.kind !== "stop") return state;

  // Use a dedicated per-turn counter independent of the recovery
  // re-entry cap. A successful budget continuation is a clean,
  // non-recovery iteration, so it also resets the recovery safety cap
  // (via resetRecoveryReentries) — preserving that cap exclusively for
  // genuine back-to-back recovery loops.
  const budgetCount = (budgetContinuationCounts.get(state) ?? 0) + 1;
  if (budgetCount > MAX_BUDGET_CONTINUATIONS) {
    emitError(session.eventLog, session.nextInternalSubId(), {
      cause: "recovery_loop",
      message: `token-budget continuation exceeded MAX_BUDGET_CONTINUATIONS=${MAX_BUDGET_CONTINUATIONS}`,
    });
    budgetContinuationCounts.delete(state);
    state.pendingBudgetDecision = undefined;
    state.transition = undefined;
    return state;
  }
  budgetContinuationCounts.set(state, budgetCount);
  resetRecoveryReentries(state);
  emitWarning(
    session.eventLog,
    session.nextInternalSubId(),
    "recovery_triggered",
    `trigger=token_budget_continuation, budgetContinuation=${budgetCount}/${MAX_BUDGET_CONTINUATIONS}`,
  );

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
  state.hasAttemptedReactiveCompact = false;
  state.maxOutputTokensRecoveryCount = 0;
  state.maxOutputTokensOverride = undefined;
  state.pendingToolUseSummary = undefined;
  state.stopHookActive = undefined;
  state.pendingBudgetDecision = undefined;
  return state;
}

// Re-export so run-turn can detect the wire-layer error class without
// importing from the recovery directory.
export { isFallbackTriggeredError, StreamModelError };
