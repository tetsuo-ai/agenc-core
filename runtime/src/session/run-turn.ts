/**
 * run-turn — the phase-machine dispatcher for one user turn.
 *
 * Replaces the skeletal top-level loop from `runtime/src/query.ts`
 * with the 6-phase state machine documented in
 * `docs/plan/architecture.md §Phase Machine`.
 *
 * Phases and their source-of-truth (openclaude `query.ts` line ranges):
 *   1. PrepareContext       — :268-459
 *   2. StreamModel          — :561-1082
 *   3. PostSampleRecovery   — :1082-1299
 *   4. ContinuationNudge    — :1300-1465
 *   5. ExecuteTools         — :1467-1635
 *   6. Commit               — :1192-1465 (iteration tail)
 *
 * The 8 continue sites (PhaseTransition table) all route back to
 * PrepareContext. Openclaude `transition: { reason: ... }` reads are
 * preserved via `state.transition` so T8's recovery ladder can
 * introspect the re-entry cause without reading message contents.
 *
 * Invariants honored here:
 *   I-7  (terminal abort): signal check at top of loop; session-level
 *        AbortController observed. maxTurns exhaustion → terminal with
 *        `stopReason: "max_turns"`.
 *   I-13 (pending provider switch): checked at top-of-loop; a switch
 *        forces the turn to abort cleanly so the next turn picks up
 *        the new provider (full wiring in T13).
 *   I-22 (token budget): `state.pendingBudgetDecision` consulted; T8
 *        acts on it from the continuation-nudge phase.
 *   I-30 (config snapshot): TurnContext.configSnapshot is frozen at
 *        build time; phases read from `ctx.configSnapshot`.
 *
 * @module
 */

import type { LLMMessage, LLMUsage } from "../llm/types.js";
import { commit } from "../phases/commit.js";
import { continuationNudge } from "../phases/continuation-nudge.js";
import type { PhaseEvent } from "../phases/events.js";
import { executeTools } from "../phases/execute-tools.js";
import { postSampleRecovery } from "../phases/post-sample-recovery.js";
import { prepareContext } from "../phases/prepare-context.js";
import { streamModel, StreamModelError } from "../phases/stream-model.js";
import type { Session } from "./session.js";
import type { TurnContext } from "./turn-context.js";
import {
  buildInitialTurnState,
  resetIterationFields,
  type Continue,
  type Terminal,
  type TurnState,
} from "./turn-state.js";

export interface RunTurnOptions {
  /** System prompt messages already in `ctx.config` projection but T5
   *  takes them as explicit history to keep bin/agenc.ts wiring
   *  simple. T10 removes this once the session-local history store
   *  (SessionState.history) is the source of truth. */
  readonly systemPrompt?: string;
  /** Existing conversation history. T6/T10 wires via SessionState. */
  readonly history?: readonly LLMMessage[];
  /** User-provided cancellation signal merged with session.abortController. */
  readonly signal?: AbortSignal;
}

function buildSeedMessages(
  opts: RunTurnOptions,
  userMessage: string,
): { system?: LLMMessage; prior: LLMMessage[]; user: LLMMessage } {
  const system: LLMMessage | undefined = opts.systemPrompt
    ? { role: "system", content: opts.systemPrompt }
    : undefined;
  const prior: LLMMessage[] = [...(opts.history ?? [])];
  const user: LLMMessage = { role: "user", content: userMessage };
  return { system, prior, user };
}

function mergeSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): AbortSignal {
  if (!a) return b;
  if (a.aborted) return a;
  if (b.aborted) return b;
  const merged = new AbortController();
  const onA = () => merged.abort((a as AbortSignal & { reason?: unknown }).reason);
  const onB = () => merged.abort((b as AbortSignal & { reason?: unknown }).reason);
  a.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return merged.signal;
}

function cumulativeUsage(acc: LLMUsage, next: LLMUsage | undefined): LLMUsage {
  if (!next) return acc;
  return {
    promptTokens: acc.promptTokens + (next.promptTokens ?? 0),
    completionTokens: acc.completionTokens + (next.completionTokens ?? 0),
    totalTokens: acc.totalTokens + (next.totalTokens ?? 0),
  };
}

/**
 * Dispatcher: drive the 6-phase state machine for one user turn.
 *
 * Yields `PhaseEvent` values (same shape as the retired `QueryEvent`)
 * so `bin/agenc.ts`'s renderer doesn't need to change. Returns the
 * terminal reason as the generator return value.
 */
export async function* runTurn(
  session: Session,
  ctx: TurnContext,
  userMessage: string,
  opts: RunTurnOptions = {},
): AsyncGenerator<PhaseEvent, Terminal> {
  const { system, prior, user } = buildSeedMessages(opts, userMessage);
  const priorFull = system ? [system, ...prior] : prior;

  let state: TurnState = buildInitialTurnState(ctx, user, {
    priorMessages: priorFull,
  });

  const signal = mergeSignals(opts.signal, session.abortController.signal);

  let usage: LLMUsage = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  let lastContent = "";

  yield { type: "turn_start", turnIndex: 0 };

  while (true) {
    // I-7: top-of-loop abort check.
    if (signal.aborted) {
      const terminal: Terminal = { reason: "cancelled" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "cancelled",
      };
      return terminal;
    }

    // maxTurns guard. ctx.config.maxTurns is T10 territory — for T5
    // we fall back to a sensible default if the field isn't present
    // on the placeholder Config.
    const maxTurns = (ctx.config as unknown as { maxTurns?: number }).maxTurns ?? 100;
    if (state.turnCount > maxTurns) {
      const terminal: Terminal = { reason: "max_turns" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "max_turns",
      };
      return terminal;
    }

    // I-13: pending provider switch — exit turn so next turn picks up
    // the new provider. Full wiring in T13 (provider factory).
    if (session.pendingProviderSwitch) {
      const terminal: Terminal = { reason: "completed" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "completed",
      };
      return terminal;
    }

    resetIterationFields(state);

    // Phase 1 — prepare context.
    state = await prepareContext(state, ctx, session, signal);

    // Phase 2 — stream model.
    try {
      state = await streamModel(state, ctx, session, signal);
    } catch (error) {
      const sme = error instanceof StreamModelError ? error : undefined;
      const underlying =
        (sme?.cause instanceof Error ? sme.cause : undefined) ??
        (error instanceof Error ? error : new Error(String(error)));
      if (signal.aborted) {
        const terminal: Terminal = { reason: "cancelled" };
        yield {
          type: "turn_complete",
          content: lastContent,
          usage,
          stopReason: "cancelled",
          error: underlying,
        };
        return terminal;
      }
      const terminal: Terminal = { reason: "completed", error: underlying };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "error",
        error: underlying,
      };
      return terminal;
    }

    // Emit assistant_text for rendering parity with the retired query.ts.
    const lastAssistant = state.assistantMessages.at(-1);
    const assistantText = lastAssistant?.text ?? "";
    if (assistantText.length > 0) {
      lastContent = assistantText;
      yield {
        type: "assistant_text",
        content: assistantText,
      };
    }

    // Phase 3 — post-sample recovery.
    state = await postSampleRecovery(state, ctx, session, signal);
    if (state.transition !== undefined) {
      // Recovery requested re-entry; transition table maps all reasons
      // to PrepareContext — just clear the transition + continue.
      state.transition = undefined;
      continue;
    }

    // Phase 4 — continuation nudge (pre-tools).
    state = await continuationNudge(state, ctx, session, signal);
    if (state.transition !== undefined) {
      state.transition = undefined;
      continue;
    }

    // If no tool calls and no pending follow-up, commit + terminate.
    if (!state.needsFollowUp && state.toolUseBlocks.length === 0) {
      state = await commit(state, ctx, session, signal);

      const stopReason =
        assistantText.length === 0 ? "empty_response" : "completed";
      const terminal: Terminal = {
        reason: assistantText.length === 0 ? "completed" : "completed",
      };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason,
      };
      return terminal;
    }

    // Phase 5 — execute tools. Emit tool_call / tool_result events
    // as the registry dispatches. The phase itself pushes user-role
    // tool result messages onto state.messages.
    if (lastAssistant && lastAssistant.toolCalls.length > 0) {
      for (const toolCall of lastAssistant.toolCalls) {
        yield { type: "tool_call", toolCall };
      }
    }

    state = await executeTools(state, ctx, session, signal);

    // Surface tool_result events. execute-tools pushed UserMessage
    // records onto state.toolResults and LLMMessage tool-rows onto
    // state.messages; we reconstruct rendering events from the pairing.
    if (lastAssistant) {
      for (let i = 0; i < lastAssistant.toolCalls.length; i += 1) {
        const call = lastAssistant.toolCalls[i];
        const userRec = state.toolResults[i];
        if (!call || !userRec) continue;
        yield {
          type: "tool_result",
          toolCall: call,
          result: {
            content: typeof userRec.content === "string" ? userRec.content : "",
            isError: false,
          },
        };
      }
    }

    // Accumulate usage from the just-completed stream.
    const lastAssistantTx = state.assistantMessages.at(-1);
    void lastAssistantTx;
    // T7/T8 wire real usage propagation from streamModel. For now
    // a single call → single usage sum which streamModel captures in
    // its response metrics; we leave usage at zero here and let T7
    // populate when chatStream lands.
    usage = cumulativeUsage(usage, undefined);

    // Phase 6 — commit iteration.
    state = await commit(state, ctx, session, signal);

    // Loop (continue-to-next-iteration via next while-true tick).
    // Intentional no `transition` check here — a successful iteration
    // leaves `transition: undefined`, and re-entry on this branch is
    // the normal agentic-loop path, not a recovery re-entry.
  }
}

// Export for testability.
export type { Continue, Terminal };
