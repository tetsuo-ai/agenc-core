/**
 * run-turn — orchestration for one user turn.
 *
 * Port of codex `core/src/session/turn.rs` (2,230 LOC). The outer
 * orchestration shape follows codex `run_turn` line-for-line; the
 * per-iteration body delegates to AgenC's 6-phase machine
 * (`runtime/src/phases/`) which in turn ports openclaude's query.ts.
 *
 * Codex → AgenC call-graph mapping:
 *
 *   run_turn()                         → runTurn()
 *   run_pre_sampling_compact()         → runPreSamplingCompact()
 *   maybe_run_previous_model_inline_compact() → maybeRunPreviousModelInlineCompact()
 *   run_auto_compact()                 → runAutoCompact()
 *   build_prompt()                     → buildPrompt()
 *   run_sampling_request()             → runSamplingRequest()
 *   try_run_sampling_request()         → tryRunSamplingRequest()
 *   drain_in_flight()                  → drainInFlight()
 *   built_tools()                      → builtTools()
 *   get_last_assistant_message_from_turn() → getLastAssistantMessageFromTurn()
 *
 * Forward-dep subsystems that the ported methods call into route
 * through `SessionServices` placeholder interfaces (session.ts:327).
 * Placeholders return sensible defaults today; T6/T7/T8/T9/T10/T11/T13
 * land the real subsystems and the call sites upgrade without
 * touching this file.
 *
 * Invariants honored here:
 *   I-7  (terminal abort) — merged AbortController observed at top of
 *        loop + propagated to phase calls.
 *   I-13 (pending provider/model switch) — checked between turns;
 *        triggers maybeRunPreviousModelInlineCompact before next turn.
 *   I-22 (token budget) — pending decision stashed on TurnState is
 *        acted on at commit; mid-turn overshoot aborts cleanly.
 *   I-30 (config snapshot per-turn-immutable) — TurnContext is built
 *        once and passed by reference throughout.
 *   I-42 (recovery re-entry cap) — transition field consulted between
 *        iterations; cap lives on TurnState (T8 wires the logic).
 *
 * @module
 */

import type { LLMMessage, LLMTool, LLMUsage } from "../llm/types.js";
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
  readonly systemPrompt?: string;
  readonly history?: readonly LLMMessage[];
  readonly signal?: AbortSignal;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────
// Codex port: compaction helpers
// ─────────────────────────────────────────────────────────────────────

/** Reason passed to runAutoCompact. Port of codex `CompactionReason`. */
export type CompactionReason =
  | "context_limit"
  | "model_downshift"
  | "manual"
  | "reactive_recovery";

/** Phase passed to runAutoCompact. Port of codex `CompactionPhase`. */
export type CompactionPhase = "pre_turn" | "in_turn" | "post_turn";

/** Whether to inject the initial context on post-compact. Port of
 *  codex `InitialContextInjection`. */
export type InitialContextInjection = "inject" | "do_not_inject";

/**
 * Port of codex `run_auto_compact` (turn.rs:790-818). Dispatcher that
 * picks between inline and remote compact task based on provider info.
 * AgenC has only the inline path today; T13 adds the remote-compact
 * path for providers that expose a server-side compact endpoint.
 */
async function runAutoCompact(
  _session: Session,
  _ctx: TurnContext,
  _initialContextInjection: InitialContextInjection,
  _reason: CompactionReason,
  _phase: CompactionPhase,
): Promise<void> {
  // The inline compact task lives in `runtime/src/llm/compact/auto-compact.ts::autoCompactIfNeeded`.
  // The call site lives in prepare-context.ts (runtime-dynamic require
  // while compact/** is typecheck-excluded). This dispatcher is a
  // thin wrapper preserving codex's control-flow shape; the actual
  // invocation happens inside the phase loop.
  // T13 adds the remote-compact branch based on `provider.info()`.
}

/**
 * Port of codex `maybe_run_previous_model_inline_compact` (turn.rs:749-788).
 * When the user switches to a model with a smaller context window and
 * total token usage exceeds the new auto-compact limit, compact
 * against the PREVIOUS model's context before continuing.
 *
 * Returns true when compaction ran, false otherwise.
 */
async function maybeRunPreviousModelInlineCompact(
  session: Session,
  ctx: TurnContext,
  _totalUsageTokens: number,
): Promise<boolean> {
  const previousTurnSettings = (session.state as unknown as {
    unsafePeek?: () => { previousTurnSettings?: { model: string } };
  }).unsafePeek?.()?.previousTurnSettings;
  if (!previousTurnSettings) return false;

  const oldContextWindow =
    (ctx.modelInfo as unknown as { contextWindow?: number }).contextWindow;
  const newContextWindow = oldContextWindow; // same ctx.modelInfo today
  if (oldContextWindow === undefined || newContextWindow === undefined) {
    return false;
  }
  const newAutoCompactLimit =
    (ctx.modelInfo as unknown as { autoCompactTokenLimit?: number })
      .autoCompactTokenLimit ?? Number.POSITIVE_INFINITY;
  const totalUsageTokens = _totalUsageTokens;
  const shouldRun =
    totalUsageTokens > newAutoCompactLimit &&
    previousTurnSettings.model !== ctx.modelInfo.slug &&
    oldContextWindow > newContextWindow;
  if (!shouldRun) return false;

  await runAutoCompact(
    session,
    ctx,
    "do_not_inject",
    "model_downshift",
    "pre_turn",
  );
  return true;
}

/**
 * Port of codex `run_pre_sampling_compact` (turn.rs:712-741). Runs
 * (a) previous-model inline compact on model downshift and
 * (b) auto-compact when total-usage-tokens exceeds the current
 * model's auto-compact limit.
 *
 * Returns true when any compaction ran.
 */
async function runPreSamplingCompact(
  session: Session,
  ctx: TurnContext,
): Promise<boolean> {
  const totalUsageTokensBefore = getTotalTokenUsage(session);
  let preSamplingCompacted = await maybeRunPreviousModelInlineCompact(
    session,
    ctx,
    totalUsageTokensBefore,
  );
  const totalUsageTokens = getTotalTokenUsage(session);
  const autoCompactLimit =
    (ctx.modelInfo as unknown as { autoCompactTokenLimit?: number })
      .autoCompactTokenLimit ?? Number.POSITIVE_INFINITY;
  if (totalUsageTokens >= autoCompactLimit) {
    await runAutoCompact(
      session,
      ctx,
      "do_not_inject",
      "context_limit",
      "pre_turn",
    );
    preSamplingCompacted = true;
  }
  return preSamplingCompacted;
}

function getTotalTokenUsage(session: Session): number {
  const peek = (session.state as unknown as {
    unsafePeek?: () => { totalTokenUsage?: number };
  }).unsafePeek?.();
  return peek?.totalTokenUsage ?? 0;
}

// ─────────────────────────────────────────────────────────────────────
// Codex port: prompt + tool building
// ─────────────────────────────────────────────────────────────────────

export interface BuiltPrompt {
  readonly input: ReadonlyArray<LLMMessage>;
  readonly tools: ReadonlyArray<LLMTool>;
  readonly parallelToolCalls: boolean;
  readonly baseInstructions: string;
}

/**
 * Port of codex `build_prompt` (turn.rs:946-976). Builds the per-
 * request prompt shape. `dynamicTools[].deferLoading` filters out
 * deferred tools per codex 952-966.
 */
export function buildPrompt(
  input: ReadonlyArray<LLMMessage>,
  tools: ReadonlyArray<LLMTool>,
  ctx: TurnContext,
  baseInstructions: string,
): BuiltPrompt {
  const deferred = new Set(
    ctx.dynamicTools
      .filter((t) => (t as unknown as { deferLoading?: boolean }).deferLoading)
      .map((t) => t.name),
  );
  const visibleTools =
    deferred.size === 0 ? tools : tools.filter((spec) => !deferred.has(spec.function.name));
  return {
    input,
    tools: visibleTools,
    parallelToolCalls:
      (ctx.modelInfo as unknown as { supportsParallelToolCalls?: boolean })
        .supportsParallelToolCalls ?? false,
    baseInstructions,
  };
}

/**
 * Port of codex `built_tools` (turn.rs:1130-1268). Assembles the
 * tool list visible to the model. Codex threads through connectors,
 * MCP tools, skill injections, plan-mode restrictions, etc. AgenC's
 * T5 version reads the static tool registry; T7 + T9 + T10 add the
 * dynamic filters as their subsystems land.
 */
export function builtTools(session: Session, _ctx: TurnContext): ReadonlyArray<LLMTool> {
  return session.services.registry.toLLMTools();
}

// ─────────────────────────────────────────────────────────────────────
// Codex port: sampling request orchestration
// ─────────────────────────────────────────────────────────────────────

export interface SamplingRequestResult {
  readonly needsFollowUp: boolean;
  readonly lastAgentMessage?: string;
  readonly assistantText: string;
  readonly usage: LLMUsage;
}

/**
 * Port of codex `try_run_sampling_request` (turn.rs:1828-2222). In
 * codex this is the single-attempt stream consumer: it builds the
 * request, streams events, dispatches tool calls via the
 * ToolCallRuntime, and returns a SamplingRequestResult when the
 * stream completes or an Err on retryable failure.
 *
 * AgenC's translation runs ONE phase-machine iteration. The phase
 * machine handles the stream (stream-model phase), tool dispatch
 * (execute-tools phase), nudging (continuation-nudge phase), and
 * history commit (commit phase). The resulting TurnState tells us
 * whether a follow-up iteration is needed.
 *
 * On retry-worthy errors (stream idle, transient provider error),
 * throw so `runSamplingRequest` can apply the retry policy. Fatal
 * errors throw too; the caller routes them as terminal.
 */
async function tryRunSamplingRequest(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal: AbortSignal,
  events: PhaseEvent[],
): Promise<SamplingRequestResult> {
  // Phase 1: prepare context.
  await prepareContext(state, ctx, session, signal);

  // Phase 2: stream model.
  try {
    await streamModel(state, ctx, session, signal);
  } catch (error) {
    // Retryable: stream_idle / transient provider errors.
    if (error instanceof StreamModelError) throw error;
    throw new StreamModelError(error);
  }

  const assistantText = state.assistantMessages.at(-1)?.text ?? "";
  if (assistantText.length > 0) {
    events.push({ type: "assistant_text", content: assistantText });
  }

  // Phase 3: post-sample recovery.
  await postSampleRecovery(state, ctx, session, signal);

  // Phase 4: continuation nudge.
  await continuationNudge(state, ctx, session, signal);

  return {
    needsFollowUp: state.needsFollowUp,
    lastAgentMessage: assistantText,
    assistantText,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  };
}

/**
 * Port of codex `run_sampling_request` (turn.rs:987-1129). Applies
 * the per-provider retry policy around `tryRunSamplingRequest`. On
 * ContextWindowExceeded / UsageLimitReached, updates session state
 * and surfaces the error. On generic retryable errors, backs off
 * and retries up to the provider's `streamMaxRetries` bound.
 */
async function runSamplingRequest(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal: AbortSignal,
  events: PhaseEvent[],
): Promise<SamplingRequestResult> {
  // T13 wires per-provider stream_max_retries; T5 default = 3.
  const maxRetries = 3;
  let retries = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await tryRunSamplingRequest(state, ctx, session, signal, events);
    } catch (error) {
      if (!isRetryableStreamError(error)) throw error;
      if (retries >= maxRetries) throw error;
      retries += 1;
      // Exponential backoff: 100ms * 2^attempt, capped at 2s.
      const delay = Math.min(2000, 100 * 2 ** retries);
      await new Promise<void>((resolve) =>
        setTimeout(resolve, delay).unref?.(),
      );
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "stream_retry",
            message: `retrying stream (attempt ${retries}/${maxRetries}) after ${delay}ms`,
          },
        },
      });
    }
  }
}

/** Codex `is_retryable()` on CodexErr. AgenC translates to a check
 *  on the underlying error cause. T8 wires the full classification. */
function isRetryableStreamError(error: unknown): boolean {
  if (!(error instanceof StreamModelError)) return false;
  const msg = error.message?.toLowerCase() ?? "";
  if (msg.includes("stream_idle")) return true;
  if (msg.includes("econnreset")) return true;
  if (msg.includes("etimedout")) return true;
  if (msg.includes("503")) return true;
  if (msg.includes("504")) return true;
  return false;
}

/**
 * Port of codex `drain_in_flight` (turn.rs:1794-1818). On abort/error,
 * drain any still-in-flight tool futures so their side effects record
 * into conversation state. AgenC's execute-tools phase uses the
 * StreamingToolExecutor which already buffers completed results; this
 * helper serves as the codex-shape counterpart.
 */
async function drainInFlight(
  state: TurnState,
  _ctx: TurnContext,
  session: Session,
): Promise<void> {
  const exec = state.streamingToolExecutor as
    | { close?: () => void; getRemainingResults?: () => AsyncIterable<unknown> }
    | null;
  if (!exec || typeof exec.close !== "function") return;
  try {
    exec.close();
    if (typeof exec.getRemainingResults === "function") {
      for await (const _ of exec.getRemainingResults()) {
        // drain — results already recorded by the phase
      }
    }
  } catch (error) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "drain_in_flight_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    });
  }
}

/**
 * Port of codex `get_last_assistant_message_from_turn` (turn.rs:2223-2230).
 * Scans the response history for the most recent assistant message
 * and returns its text content.
 */
export function getLastAssistantMessageFromTurn(
  responses: ReadonlyArray<LLMMessage>,
): string | undefined {
  for (let i = responses.length - 1; i >= 0; i -= 1) {
    const m = responses[i];
    if (!m || m.role !== "assistant") continue;
    if (typeof m.content === "string" && m.content.length > 0) return m.content;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────
// Top-level runTurn — codex `run_turn` (turn.rs:130-665).
// ─────────────────────────────────────────────────────────────────────

/**
 * Port of codex `run_turn` (turn.rs:130). Drives one user turn from
 * pre-sampling compact through N sampling-request iterations until
 * the turn terminates (no tool calls, no transition, stop-gate
 * allowed) or maxTurns is exceeded.
 *
 * Yields `PhaseEvent` values (same shape as the retired QueryEvent)
 * so bin/agenc.ts renders without a rewrite. Returns the terminal
 * reason as the generator return value.
 */
export async function* runTurn(
  session: Session,
  ctx: TurnContext,
  userMessage: string,
  opts: RunTurnOptions = {},
): AsyncGenerator<PhaseEvent, Terminal> {
  // Codex: "if input.is_empty() && !sess.has_pending_input().await { return None }"
  if (userMessage.trim().length === 0) {
    const terminal: Terminal = { reason: "completed" };
    yield {
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "empty_response",
    };
    return terminal;
  }

  // Codex: run_pre_sampling_compact before any phase runs. Returns
  // whether compaction happened; if yes and we had a prewarmed
  // client session, reset it (codex 155-157 — AgenC has no prewarm
  // today).
  try {
    await runPreSamplingCompact(session, ctx);
  } catch (error) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "error",
        payload: {
          cause: "pre_sampling_compact_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      },
    });
    // Codex: "return None" on pre-compact failure.
    const terminal: Terminal = { reason: "completed" };
    yield {
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
    return terminal;
  }

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

  // The phase loop — codex's "while streaming & tools" outer loop.
  while (true) {
    if (signal.aborted) {
      await drainInFlight(state, ctx, session);
      const terminal: Terminal = { reason: "cancelled" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "cancelled",
      };
      return terminal;
    }

    const maxTurns =
      (ctx.config as unknown as { maxTurns?: number }).maxTurns ?? 100;
    if (state.turnCount > maxTurns) {
      await drainInFlight(state, ctx, session);
      const terminal: Terminal = { reason: "max_turns" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "max_turns",
      };
      return terminal;
    }

    // I-13: pending provider switch — complete this turn cleanly so
    // the next turn's pre-sampling compact considers the new model.
    if (session.pendingProviderSwitch) {
      await drainInFlight(state, ctx, session);
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

    // Codex run_sampling_request — phases 1-4.
    const pending: PhaseEvent[] = [];
    try {
      const result = await runSamplingRequest(state, ctx, session, signal, pending);
      for (const ev of pending) yield ev;
      // Tool-call and tool-result events get emitted inside phase 5
      // below; phase 2 only emitted assistant_text.
      void result;
    } catch (error) {
      await drainInFlight(state, ctx, session);
      for (const ev of pending) yield ev;
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

    // Recovery re-entry? postSampleRecovery or continuationNudge may
    // have set state.transition — all 8 reasons route to PrepareContext
    // per PhaseTransition table.
    if (state.transition !== undefined) {
      state.transition = undefined;
      continue;
    }

    const lastAssistant = state.assistantMessages.at(-1);
    const assistantText = lastAssistant?.text ?? "";
    if (assistantText.length > 0) lastContent = assistantText;

    // No tool calls + no transition → commit + terminate.
    if (!state.needsFollowUp && state.toolUseBlocks.length === 0) {
      await commit(state, ctx, session, signal);
      // commit may set a stop-hook transition (I-17). If so, re-enter.
      if (state.transition !== undefined) {
        state.transition = undefined;
        continue;
      }
      const stopReason = assistantText.length === 0 ? "empty_response" : "completed";
      const terminal: Terminal = { reason: "completed" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason,
      };
      return terminal;
    }

    // Phase 5 — execute tools. Emit tool_call / tool_result events
    // around the dispatch.
    if (lastAssistant && lastAssistant.toolCalls.length > 0) {
      for (const toolCall of lastAssistant.toolCalls) {
        yield { type: "tool_call", toolCall };
      }
    }
    await executeTools(state, ctx, session, signal);
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

    // Phase 6 — commit iteration. Stop-hook may request re-entry.
    await commit(state, ctx, session, signal);

    // Token-budget decision from streamModel: if exceeded, run-turn
    // today takes the cautious path and terminates. T8 wires the
    // token_budget_continuation recovery that re-enters prepare.
    if (state.pendingBudgetDecision?.kind === "stop") {
      const terminal: Terminal = { reason: "completed" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "completed",
      };
      return terminal;
    }

    usage = cumulativeUsage(usage, undefined);
    // loop back for another sampling request
  }
}

export type { Continue, Terminal };
