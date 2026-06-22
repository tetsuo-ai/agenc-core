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
import type { LLMMessage } from "../llm/types.js";
import {
  cloneLlmContent as cloneContent,
  fromRuntimeMessageContent,
  toRuntimeMessageContent,
} from "../llm/content-conversion.js";
import { compactConversation } from "../services/compact/compact.js";
import type { RuntimeMessage } from "../services/compact/types.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type { TurnState } from "../session/turn-state.js";
import { StreamModelError } from "./stream-model.js";
import {
  isFallbackTriggeredError,
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

type ContextCollapseOverflowRecoveryResult =
  | { readonly kind: "applied"; readonly reason: string }
  | { readonly kind: "pass" }
  | { readonly kind: "surface"; readonly reason: string };

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

export async function runContextCollapseOverflowRecovery(params: {
  readonly state: TurnState;
}): Promise<ContextCollapseOverflowRecoveryResult> {
  const recovered = await recoverFromOverflow(
    toCollapseRuntimeMessages(params.state.messagesForQuery),
  );
  if (recovered.committed <= 0) {
    return { kind: "pass" } as const;
  }
  params.state.messagesForQuery = fromCollapseRuntimeMessages(
    recovered.messages as CollapseRuntimeMessage[],
  );
  params.state.messages = [...params.state.messagesForQuery];
  return {
    kind: "applied",
    reason: "context_collapse",
  } as const;
}

async function recoverFromOverflow(
  messages: RuntimeMessage[],
): Promise<{ readonly messages: RuntimeMessage[]; readonly committed: number }> {
  if (messages.length < 4) return { messages, committed: 0 };
  const retainedTail = selectOverflowRetainedTail(messages);
  const compacted = await compactConversation(
    messages,
    {},
    "Recover from a prompt-too-long provider response.",
  );
  return {
    messages: [
      compacted.boundaryMarker,
      ...compacted.summaryMessages,
      ...retainedTail,
    ],
    committed: 1,
  };
}

function selectOverflowRetainedTail(
  messages: readonly RuntimeMessage[],
): readonly RuntimeMessage[] {
  const keepCount = Math.min(3, messages.length);
  let start = messages.length - keepCount;
  const first = messages[start];
  const toolCallId = toolResultId(first);
  if (toolCallId === null) return messages.slice(start);

  const assistantIndex = findAssistantToolCallOwner(
    messages,
    start - 1,
    toolCallId,
  );
  if (assistantIndex !== null) {
    start = assistantIndex;
  }
  return messages.slice(start);
}

function toolResultId(message: RuntimeMessage | undefined): string | null {
  if (!message) return null;
  const candidate = message as CollapseRuntimeMessage;
  if (candidate.originalRole !== "tool" && candidate.role !== "tool") {
    return null;
  }
  const id = candidate.toolCallId?.trim();
  return id && id.length > 0 ? id : null;
}

function findAssistantToolCallOwner(
  messages: readonly RuntimeMessage[],
  fromIndex: number,
  toolCallId: string,
): number | null {
  for (let index = fromIndex; index >= 0; index -= 1) {
    const message = messages[index] as CollapseRuntimeMessage | undefined;
    if (!message) continue;
    if (toolResultId(message) !== null) continue;
    const calls = message.toolCalls ?? [];
    if (calls.some((call) => call.id === toolCallId)) return index;
    return null;
  }
  return null;
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
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.phase !== undefined ? { phase: message.phase } : {}),
      type: role,
      message: {
        role,
        content: runtimeContent,
      },
      uuid: `agenc-${role}-${index}`,
      timestamp: new Date(0).toISOString(),
      ...(message.toolCalls !== undefined
        ? {
            toolCalls: message.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              arguments: call.arguments,
            })),
          }
        : {}),
      ...(message.role === "tool" ? { isMeta: true } : {}),
    };
  });
}

function toRuntimeWireRole(role: LLMMessage["role"]): RuntimeWireRole {
  if (role === "tool") return "user";
  if (role === "developer") return "system";
  return role;
}

function fromCollapseRuntimeMessages(
  messages: readonly CollapseRuntimeMessage[],
): LLMMessage[] {
  return messages
    .map(fromCollapseRuntimeMessage)
    .filter((message): message is LLMMessage => message !== null);
}

function fromCollapseRuntimeMessage(
  message: CollapseRuntimeMessage,
): LLMMessage | null {
  const toolCalls = cloneToolCalls(message);
  if (message.role && message.content !== undefined) {
    const role = message.originalRole ?? message.role;
    return {
      role,
      content: fromRuntimeMessageContent(message.content),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
      ...(message.phase === "commentary" || message.phase === "final_answer"
        ? { phase: message.phase }
        : {}),
    };
  }
  const role = normalizeRole(message.message?.role ?? message.type);
  if (!role) return null;
  return {
    role,
    content: fromRuntimeMessageContent(readContent(message)),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
  };
}

function cloneToolCalls(
  message: CollapseRuntimeMessage,
): LLMMessage["toolCalls"] | undefined {
  if (!message.toolCalls || message.toolCalls.length === 0) return undefined;
  return message.toolCalls.map((call) => ({
    id: call.id,
    name: call.name,
    arguments: call.arguments ?? "",
  }));
}

function normalizeRole(value: unknown): LLMMessage["role"] | null {
  if (
    value === "system" ||
    value === "developer" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool"
  ) {
    return value;
  }
  return null;
}

function readContent(
  message: CollapseRuntimeMessage,
): LLMMessage["content"] {
  const content = message.message?.content ?? message.content ?? "";
  return cloneContent(content);
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
          const drain = await runContextCollapseOverflowRecovery({
            state: c.state,
          });
          if (drain.kind === "applied") {
            c.state.transition = { reason: "collapse_drain_retry" };
            return drain;
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

// Token-budget continuations are a *legitimate* productive loop driven
// by the user's token target (e.g. "+500k") — they are NOT a recovery
// loop, so they must not share the 5-entry recovery safety cap
// (MAX_RECOVERY_REENTRIES). Sharing it caused large targets to silently
// halt after ~5 continuations. The real "stop" signal for this path is
// the BudgetTracker's own diminishing-returns guard (token-budget.ts),
// which stops emitting `pendingBudgetDecision` once the target is met or
// progress stalls; this counter is only a runaway backstop sized far
// above any realistic continuation count for a single turn.
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
