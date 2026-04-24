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

import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMMessageValidationError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
} from "../llm/errors.js";
import type { LLMMessage, LLMTool, LLMUsage } from "../llm/types.js";
import { commit } from "../phases/commit.js";
import { continuationNudge } from "../phases/continuation-nudge.js";
import type { PhaseEvent } from "../phases/events.js";
import { executeTools } from "../phases/execute-tools.js";
import { postSampleRecovery } from "../phases/post-sample-recovery.js";
import {
  getPrepareContextTerminal,
  prepareContext,
} from "../phases/prepare-context.js";
import {
  buildCompactedRolloutItem,
  buildPostCompactMessages,
} from "../llm/compact/compact.js";
import {
  streamModel,
  StreamModelError,
  type StreamModelRequestContract,
} from "../phases/stream-model.js";
import { isTransientProviderError } from "../recovery/api-errors.js";
import { reconnectWithBackoff } from "../recovery/reconnection.js";
import { reserveRecoveryReentry } from "../recovery/fallback-ladder.js";
import * as planModeHelpers from "./plan-mode.js";
import {
  buildCompactCacheSafeParams,
  createSessionBackedCompactContext,
} from "./compact-runtime-context.js";
import type { ResponseItem } from "./rollout-item.js";
import type { Session } from "./session.js";
import { toTurnContextItem, type TurnContext } from "./turn-context.js";
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
  /** Optional transcript-facing text when the model-visible prompt was expanded. */
  readonly displayUserMessage?: string;
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

function toResponseItem(message: LLMMessage): ResponseItem {
  return {
    role: message.role,
    content:
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => ({ ...part })),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
  };
}

function terminalToStopReason(
  reason: Terminal["reason"],
): Extract<PhaseEvent, { type: "turn_complete" }>["stopReason"] {
  switch (reason) {
    case "completed":
    case "max_turns":
    case "cancelled":
      return reason;
    default:
      return "error";
  }
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
export type InitialContextInjection =
  | "before_last_user_message"
  | "do_not_inject";

/**
 * Structural shape of the resolved `autoCompactIfNeeded` export. Mirrors
 * `src/llm/compact/auto-compact.ts::autoCompactIfNeeded` and the loose
 * shape used in `prepare-context.ts` Stage 6 so both call sites share
 * one type. Compact module lives under a typecheck-excluded tree (its
 * external deps are not all ported yet), so the parameter list stays
 * loose (`unknown[]`).
 */
export interface AutoCompactResult {
  readonly wasCompacted: boolean;
  readonly compactionResult?: {
    summaryMessages?: LLMMessage[];
    attachments?: LLMMessage[];
    hookResults?: LLMMessage[];
  };
  readonly consecutiveFailures?: number;
}
export type AutoCompactImpl = (
  ...args: unknown[]
) => Promise<AutoCompactResult>;

// Test-only override — when set, `runAutoCompact` calls this instead of
// dynamic-require'ing the real `auto-compact.js`. Lets unit tests assert
// the dispatcher was reached with the expected arguments without
// spinning up the full compact subsystem. Clear via
// `setAutoCompactImplForTests(null)` between tests.
let autoCompactImplOverride: AutoCompactImpl | null = null;

export function setAutoCompactImplForTests(
  impl: AutoCompactImpl | null,
): void {
  autoCompactImplOverride = impl;
}

function resolveAutoCompactImpl(): AutoCompactImpl | null {
  if (autoCompactImplOverride) return autoCompactImplOverride;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require("../llm/compact/auto-compact.js") as {
      autoCompactIfNeeded?: AutoCompactImpl;
    };
    return mod?.autoCompactIfNeeded ?? null;
  } catch {
    return null;
  }
}

/**
 * Port of codex `run_auto_compact` (turn.rs:790-818). Dispatcher that
 * picks between inline and remote compact task based on provider info.
 * AgenC has only the inline path today; T13 adds the remote-compact
 * path for providers that expose a server-side compact endpoint.
 *
 * Behavior:
 *   - Resolves `autoCompactIfNeeded` (real module or test override).
 *     When nothing is wired yet (external deps not ported), returns
 *     false and the caller proceeds with uncompacted state — same
 *     feature-off fallback used by `prepare-context.ts` Stage 6.
 *   - Calls `autoCompactIfNeeded` with the session's current messages
 *     plus per-turn context. Threshold/circuit-breaker logic lives
 *     inside the compact module; the dispatcher is a thin wrapper.
 *   - When `state` is provided and compaction ran, splices the post-
 *     compact messages back into `state.messages` / `state.messagesForQuery`
 *     and stamps `state.autoCompactTracking` so the next phase sees the
 *     compacted view. (codex's pre-sampling compact runs before the
 *     first phase iteration; mutating state here is how we guarantee
 *     `prepareContext` reads the compacted view.)
 *   - Never swallows errors silently — emits `warning:auto_compact_failed`
 *     and returns false so the caller proceeds with uncompacted state.
 *
 * Returns true when compaction actually ran.
 */
async function runAutoCompact(
  session: Session,
  ctx: TurnContext,
  initialContextInjection: InitialContextInjection,
  reason: CompactionReason,
  phase: CompactionPhase,
  state?: TurnState,
): Promise<boolean> {
  const impl = resolveAutoCompactImpl();
  if (!impl) return false;

  // Source-of-truth for the message set depends on when the dispatcher
  // is called. Pre-sampling compact runs before the phase loop, so
  // `state.messages` holds the seed history. Inline compact (T13)
  // called mid-loop would prefer `messagesForQuery`. Prefer the latter
  // when populated, fall back to `messages`.
  const messages =
    state && state.messagesForQuery.length > 0
      ? state.messagesForQuery
      : (state?.messages ?? []);
  const querySource =
    reason === "model_downshift" ? "model_downshift" : "repl_main_thread";
  const compactContext = createSessionBackedCompactContext(session, {
    turnContext: ctx,
    querySource,
    isNonInteractiveSession: false,
    verbose: false,
  });

  try {
    const cacheSafeParams = await buildCompactCacheSafeParams(
      compactContext,
      messages as never,
    );
    const result = await impl(
      messages,
      compactContext,
      cacheSafeParams,
      querySource,
      state?.autoCompactTracking,
      state?.snipTokensFreed ?? 0,
      initialContextInjection,
    );

    if (result.wasCompacted && state) {
      if (!result.compactionResult) {
        throw new Error(
          "autoCompactIfNeeded reported success without a compactionResult",
        );
      }
      const cr = result.compactionResult as
        | {
            boundaryMarker?: unknown;
            summaryMessages?: LLMMessage[];
            attachments?: LLMMessage[];
            hookResults?: LLMMessage[];
            messagesToKeep?: unknown[];
            preCompactTokenCount?: number;
            postCompactTokenCount?: number;
          }
        | undefined;
      if (cr) {
        session.rolloutStore?.appendRollout(
          {
            type: "compacted",
            payload: buildCompactedRolloutItem({
              ...cr,
              summaryMessages: cr.summaryMessages ?? [],
              attachments: cr.attachments ?? [],
              hookResults: cr.hookResults ?? [],
            }),
          },
          { durable: true },
        );
      }
      const compacted = buildPostCompactMessages(
        cr as Parameters<typeof buildPostCompactMessages>[0],
      ) as unknown as LLMMessage[];
      // Replace both the full history view and the per-iteration
      // projection so `prepareContext` (next phase) sees the same
      // post-compact replacement history the rollout recorded.
      state.messages = compacted;
      state.messagesForQuery = [...compacted];
      // Stamp auto-compact tracking so the commit phase emits the
      // boundary marker (runtime/src/phases/commit.ts).
      state.autoCompactTracking = {
        compacted: true,
        turnId: `auto-${reason}-${phase}-${Date.now().toString(36)}`,
        turnCounter: 0,
        consecutiveFailures: 0,
      };
      return true;
    }

    if (
      result.consecutiveFailures !== undefined &&
      state?.autoCompactTracking
    ) {
      state.autoCompactTracking = {
        ...state.autoCompactTracking,
        consecutiveFailures: result.consecutiveFailures,
      };
    }

    return result.wasCompacted === true;
  } catch (error) {
    // Never silently swallow compact failures. Emit a structured
    // warning carrying the reason/phase so downstream observability can
    // distinguish model-downshift compacts from context-limit compacts.
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "auto_compact_failed",
          message: `${reason}/${phase}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        },
      },
    });
    return false;
  }
}

/**
 * Port of codex `maybe_run_previous_model_inline_compact` (turn.rs:749-788).
 * When the user switches to a model with a smaller context window and
 * total token usage exceeds the new auto-compact limit, compact
 * against the PREVIOUS model's context before continuing.
 *
 * Returns true when compaction ran, false otherwise.
 */
export async function maybeRunPreviousModelInlineCompact(
  session: Session,
  ctx: TurnContext,
  _totalUsageTokens: number,
  state?: TurnState,
): Promise<boolean> {
  // A1 fix: codex resolves the previous model's TurnContext via
  // `turn_context.with_model(previous_turn_settings.model, models_manager)`
  // and reads its context_window. AgenC has no models_manager yet, so
  // we accept an optional pre-resolved `contextWindow` (and/or
  // `modelInfo`) carried alongside `previousTurnSettings.model`. The
  // new context window always comes from the CURRENT turn's
  // `ctx.modelInfo`, not from the previous turn. This makes the
  // model-downshift branch reachable instead of comparing
  // `oldContextWindow > oldContextWindow`, which can never be true.
  const previousTurnSettings = (session.state as unknown as {
    unsafePeek?: () => {
      previousTurnSettings?: {
        model: string;
        contextWindow?: number;
        modelInfo?: { contextWindow?: number };
      };
    };
  }).unsafePeek?.()?.previousTurnSettings;
  if (!previousTurnSettings) return false;

  const newContextWindow =
    (ctx.modelInfo as unknown as { contextWindow?: number }).contextWindow;
  const oldContextWindow =
    previousTurnSettings.contextWindow ??
    previousTurnSettings.modelInfo?.contextWindow;
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

  return await runAutoCompact(
    session,
    ctx,
    "do_not_inject",
    "model_downshift",
    "pre_turn",
    state,
  );
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
  state?: TurnState,
): Promise<boolean> {
  const totalUsageTokensBefore = getTotalTokenUsage(session);
  let preSamplingCompacted = await maybeRunPreviousModelInlineCompact(
    session,
    ctx,
    totalUsageTokensBefore,
    state,
  );
  const totalUsageTokens = getTotalTokenUsage(session);
  const autoCompactLimit =
    (ctx.modelInfo as unknown as { autoCompactTokenLimit?: number })
      .autoCompactTokenLimit ?? Number.POSITIVE_INFINITY;
  if (totalUsageTokens >= autoCompactLimit) {
    const contextLimitCompacted = await runAutoCompact(
      session,
      ctx,
      "do_not_inject",
      "context_limit",
      "pre_turn",
      state,
    );
    preSamplingCompacted = preSamplingCompacted || contextLimitCompacted;
  }
  return preSamplingCompacted;
}

function getTotalTokenUsage(session: Session): number {
  const peek = (session.state as unknown as {
    unsafePeek?: () => {
      totalTokenUsage?: number | { totalTokens?: number };
    };
  }).unsafePeek?.();
  const field = peek?.totalTokenUsage;
  if (typeof field === "number") return field;
  return field?.totalTokens ?? 0;
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

function buildSamplingRequestContract(
  state: TurnState,
  session: Session,
  ctx: TurnContext,
): StreamModelRequestContract {
  const baseInstructions = (
    ctx as TurnContext & { baseInstructions?: string }
  ).baseInstructions;
  return buildPrompt(
    state.messagesForQuery,
    builtTools(session, ctx),
    ctx,
    baseInstructions ?? "",
  );
}

// ─────────────────────────────────────────────────────────────────────
// Codex port: sampling request orchestration
// ─────────────────────────────────────────────────────────────────────

export interface SamplingRequestResult {
  readonly needsFollowUp: boolean;
  readonly lastAgentMessage?: string;
  readonly assistantText: string;
  readonly usage: LLMUsage;
  readonly terminal?: Terminal;
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
  const prepareTerminal = getPrepareContextTerminal(state);
  if (prepareTerminal) {
    const assistantText = prepareTerminal.assistantMessage.text ?? "";
    if (assistantText.length > 0) {
      state.assistantMessages = [prepareTerminal.assistantMessage];
      state.messages.push({
        role: "assistant",
        content: assistantText,
      });
      events.push({ type: "assistant_text", content: assistantText });
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "agent_message",
          payload: { message: assistantText },
        },
      });
    }
    return {
      needsFollowUp: false,
      lastAgentMessage: assistantText,
      assistantText,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      terminal: prepareTerminal.terminal,
    };
  }
  const request = buildSamplingRequestContract(state, session, ctx);

  // Plan-mode stream state (T11). When the turn's collaboration mode is
  // `plan`, stash per-turn plan-mode bookkeeping on turn-state so the
  // post-stream finalize hook below (and future delta callbacks) share
  // one `PlanModeStreamState` instance.
  if (planModeHelpers.isPlanMode(ctx)) {
    const withPlan = state as TurnState & {
      planModeStream?: planModeHelpers.PlanModeStreamState;
    };
    if (withPlan.planModeStream === undefined) {
      withPlan.planModeStream = planModeHelpers.createPlanModeStreamState(
        ctx.subId,
      );
    }
  }

  // Phase 2: stream model.
  let streamModelError: StreamModelError | null = null;
  try {
    await streamModel(state, ctx, session, request, signal);
  } catch (error) {
    if (error instanceof StreamModelError) {
      streamModelError = error;
    } else {
      streamModelError = new StreamModelError(error);
    }
  }

  // Plan-mode: after the stream finishes, let the helper finalize any
  // plan item embedded in the final assistant message. No-op when not
  // in plan mode or when no `<plan>` block was found.
  if (planModeHelpers.isPlanMode(ctx)) {
    const withPlan = state as TurnState & {
      planModeStream?: planModeHelpers.PlanModeStreamState;
    };
    const planStream = withPlan.planModeStream;
    if (planStream) {
      const last = state.messages.at(-1);
      if (
        last?.role === "assistant" &&
        typeof last.content === "string" &&
        last.content.length > 0
      ) {
        planModeHelpers.maybeCompletePlanItemFromMessage(
          session,
          ctx,
          planStream,
          {
            role: "assistant",
            content: [{ type: "output_text", text: last.content }],
          },
        );
      }
    }
  }

  // T8: stash any wire-layer error on state for the recovery ladder
  // to consume. FallbackTriggeredError + stream_idle + provider 5xx
  // all become stream errors here; the ladder classifies them via
  // `state.lastStreamError` + ordered trigger evaluation (I-10).
  if (streamModelError) {
    (state as TurnState & { lastStreamError?: unknown }).lastStreamError =
      streamModelError.cause ?? streamModelError;
  }

  const assistantText = state.assistantMessages.at(-1)?.text ?? "";
  if (assistantText.length > 0) {
    events.push({ type: "assistant_text", content: assistantText });
  }

  // Phase 3: post-sample recovery. Always runs — even on stream
  // error — so the ladder can decide between recovery vs terminal.
  await postSampleRecovery(state, ctx, session, signal);

  // If recovery applied a transition (any of I-10's triggers fired),
  // swallow the stream error and let the outer loop re-enter
  // PrepareContext.
  if (state.transition !== undefined) {
    (state as TurnState & { lastStreamError?: unknown }).lastStreamError = undefined;
    streamModelError = null;
  }

  // Still-unrecovered stream error → bubble for runSamplingRequest's
  // retry policy to decide (stream_idle + transient).
  if (streamModelError) {
    throw streamModelError;
  }

  // Phase 4: continuation nudge.
  await continuationNudge(state, ctx, session, signal);

  return {
    needsFollowUp: state.needsFollowUp,
    lastAgentMessage: assistantText,
    assistantText,
    // D1 fix: thread the real provider-reported usage stashed by
    // streamModel. Falling back to zeros only when the provider
    // genuinely reported nothing (e.g. aborted before first chunk).
    usage: state.lastResponseUsage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    },
  };
}

/**
 * Port of codex `run_sampling_request` (turn.rs:987-1129). Applies the
 * per-provider retry policy around `tryRunSamplingRequest`.
 *
 * T8: retries route through `reconnectWithBackoff` from
 * `recovery/reconnection.ts` so every attempt shares the suspend-aware
 * jittered exponential backoff used by the rest of the recovery ladder.
 * Transient classification fans through two predicates in order:
 *
 *   1. `isRetryableStreamError` — typed discrimination on
 *      `StreamModelError.cause`. Covers `LLMServerError`,
 *      `LLMRateLimitError`, `LLMTimeoutError`, and the `stream_idle`
 *      watchdog path. Also fails closed on
 *      `LLMContextWindowExceededError` / auth failures.
 *   2. `isTransientProviderError` — substring + `status` classifier
 *      over the raw underlying error. Catches socket hangups /
 *      `5xx`-tagged errors that bubbled up without a typed wrapper.
 *
 * Non-transient errors bubble out of `reconnectWithBackoff` immediately
 * (`throw err`) so `runTurn` can route them to terminal.
 */
async function runSamplingRequest(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  signal: AbortSignal,
  events: PhaseEvent[],
): Promise<SamplingRequestResult> {
  const outcome = await reconnectWithBackoff<SamplingRequestResult>({
    session,
    signal,
    attempt: () => tryRunSamplingRequest(state, ctx, session, signal, events),
    isTransient: (err) => {
      if (isRetryableStreamError(err)) return true;
      // Fall-through: the raw-error classifier covers bare
      // ECONNRESET / 5xx / socket-hang-up failures that never got
      // wrapped in StreamModelError.
      if (err instanceof StreamModelError) {
        return isTransientProviderError(err.cause);
      }
      return isTransientProviderError(err);
    },
    onTransientRetry: async () => {
      const reservation = await reserveRecoveryReentry(session, state, {
        triggerName: "reconnect",
      });
      return reservation.kind === "reserved";
    },
  });

  if (outcome.kind === "ok") return outcome.value;
  if (outcome.kind === "aborted") {
    const abortReason =
      (signal as AbortSignal & { reason?: unknown }).reason ?? outcome.reason;
    throw new StreamModelError(
      abortReason instanceof Error ? abortReason : new Error(String(abortReason)),
    );
  }
  // exhausted
  const lastError = outcome.lastError;
  if (lastError instanceof Error) throw lastError;
  throw new Error(`stream_retries_exhausted: ${String(lastError)}`);
}

/**
 * Codex `is_retryable()` on CodexErr. AgenC classifies via typed
 * error discrimination on the underlying cause rather than substring
 * matching against `error.message`, which is fragile: a
 * `LLMContextWindowExceededError` whose provider message happens to
 * contain "504" in metadata would previously false-match.
 *
 * Retryable causes:
 *   - stream_idle watchdog abort (thrown from stream-model with a
 *     plain `Error` whose message begins `stream_idle:` — the only
 *     remaining message-based check, since it carries no type).
 *   - `LLMServerError`   (HTTP 5xx from the provider envelope)
 *   - `LLMTimeoutError`  (request timed out / abort)
 *   - `LLMRateLimitError` (429 + retry-after)
 *   - transient node networking: error `code` in
 *     {ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, EAI_AGAIN}
 *
 * Non-retryable (explicit):
 *   - `LLMContextWindowExceededError` (413 — reactive compact owns it)
 *   - `LLMAuthenticationError`
 *   - `LLMMessageValidationError`
 *
 * T8 wires the full classification (reactive compact recovery, etc.).
 */
export function isRetryableStreamError(error: unknown): boolean {
  if (!(error instanceof StreamModelError)) return false;
  const cause = error.cause;

  // Explicitly non-retryable typed causes — fail closed before any
  // generic branch so a provider message containing "504" can't
  // accidentally retry a context-window or auth failure.
  if (cause instanceof LLMContextWindowExceededError) return false;
  if (cause instanceof LLMAuthenticationError) return false;
  if (cause instanceof LLMMessageValidationError) return false;

  // Typed retryable causes.
  if (cause instanceof LLMServerError) return true;
  if (cause instanceof LLMTimeoutError) return true;
  if (cause instanceof LLMRateLimitError) return true;

  // Transient node networking via error `code`.
  const code = (cause as { code?: unknown } | null | undefined)?.code;
  if (typeof code === "string") {
    if (
      code === "ECONNRESET" ||
      code === "ECONNREFUSED" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE" ||
      code === "EAI_AGAIN"
    ) {
      return true;
    }
  }

  // stream_idle watchdog path throws a plain `Error` whose message is
  // `stream_idle: no data for Nms`. That's the sole remaining
  // message-based check and it's a controlled runtime string, not a
  // provider payload that could contain user-supplied substrings.
  if (cause instanceof Error && cause.message?.startsWith("stream_idle")) {
    return true;
  }

  return false;
}

/**
 * D1 fix: resolve the outer-loop iteration cap. Codex terminates on
 * the model's stop-signal, not on an iteration count; AgenC keeps the
 * cap as a safety net so a buggy provider can't spin forever. The
 * default is raised from 100 to 1000 (deep agent plans routinely cross
 * 100 tool iterations) and an env override lets ops dial it per
 * deployment without rebuilding. `ctx.config.maxTurns` still wins when
 * present so explicit session configuration is authoritative.
 */
function resolveMaxTurns(ctx: TurnContext): number {
  const explicit = (ctx.config as unknown as { maxTurns?: number }).maxTurns;
  if (typeof explicit === "number" && Number.isFinite(explicit) && explicit > 0) {
    return explicit;
  }
  const envRaw = process.env.AGENC_MAX_TURNS;
  if (envRaw !== undefined) {
    const parsed = Number.parseInt(envRaw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return 1000;
}

/**
 * Port of codex `drain_in_flight` (turn.rs:1794-1818). On abort/error,
 * drain any still-in-flight tool futures so their side effects record
 * into conversation state.
 *
 * Openclaude parity (`query.ts:1046-1060`): each synthetic tool_result
 * yielded from the executor MUST be surfaced back into the output
 * stream and appended to `state.messages` / `state.toolResults` so
 * every orphan `tool_use` block sent by the model during the
 * abort/error window has a paired `tool_result`. Without this, the
 * next turn's provider request would fail the Anthropic/openai
 * tool-use-id pairing contract.
 *
 * The executor's internal abort + discard logic is responsible for
 * generating the synthetic terminal results themselves. This helper
 * only closes the queue, iterates the result stream, records each
 * pair, and emits the `tool_call_completed` event the same way
 * `execute-tools` does so observers and rollouts see the turn close
 * cleanly.
 */
/** @internal — exported for drainInFlight unit tests only. */
export async function drainInFlight(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
): Promise<void> {
  const exec = state.streamingToolExecutor as
    | {
        close?: () => void;
        getRemainingResults?: () => AsyncIterable<{
          toolCall: { id: string; name: string };
          result: { content: string; isError?: boolean };
          status: "completed" | "synthetic_error";
        }>;
      }
    | null;
  if (!exec || typeof exec.close !== "function") return;
  try {
    exec.close();
    if (typeof exec.getRemainingResults === "function") {
      for await (const drained of exec.getRemainingResults()) {
        const callId = drained.toolCall.id;
        const toolName = drained.toolCall.name;
        const result = drained.result;
        // Emit the tool_call_completed event so rollouts + observers
        // close the turn boundary with the synthetic result (I-8).
        const toolResultBytes = Buffer.byteLength(result.content, "utf8");
        session.emit(
          {
            id: session.nextInternalSubId(),
            msg: {
              type: "tool_call_completed",
              payload: {
                callId,
                result: result.content,
                isError: result.isError === true,
              },
            },
          },
          {
            turnId: ctx.subId,
            toolResultBytes,
          },
        );
        // Append both the LLM-facing tool message and the user-facing
        // tool_result record so the pair shows up in the next
        // request and in session history.
        state.toolResults.push({
          uuid: crypto.randomUUID(),
          role: "user",
          toolCallId: callId,
          toolName,
          content: result.content,
        });
        state.messages.push({
          role: "tool",
          toolCallId: callId,
          content: result.content,
        });
      }
    }
    // Clear the executor so a fresh one is created on the next
    // iteration, mirroring the per-iteration lifecycle in
    // executeTools().
    state.streamingToolExecutor = null;
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
// Top-level runTurn kernel — codex `run_turn` (turn.rs:130-665).
// Session owns the live entrypoint; the exported free function below is
// a compatibility adapter that delegates back into Session.
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
export async function* runTurnKernel(
  session: Session,
  ctx: TurnContext,
  userMessage: string,
  opts: RunTurnOptions = {},
): AsyncGenerator<PhaseEvent, Terminal> {
  // T6 gap #119: canonical turn-lifecycle emits. Each `runTurn`
  // invocation must flank its work with a `turn_started` +
  // `turn_context` pair and either a matching `turn_complete` (happy
  // path) or `turn_aborted` (cancel/error path) so durable rollouts
  // see closed turn boundaries. Without these, I-48 orphan-TurnStarted
  // recovery in rollout-reconstruction would treat every clean turn
  // as a `process_killed` abort.
  const turnStartedAt = Date.now();
  const emitTurnStarted = (): void => {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "turn_started",
        payload: {
          turnId: ctx.subId,
          startedAt: turnStartedAt,
          ...(ctx.modelInfo.contextWindow !== undefined
            ? { modelContextWindow: ctx.modelInfo.contextWindow }
            : {}),
          collaborationModeKind: ctx.collaborationMode.model,
        },
      },
    });
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "turn_context",
        payload: toTurnContextItem(ctx),
      },
    });
  };
  const emitTurnComplete = (content: string): void => {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "turn_complete",
        payload: {
          turnId: ctx.subId,
          lastAgentMessage: content,
          completedAt: Date.now(),
          durationMs: Date.now() - turnStartedAt,
        },
      },
    });
  };
  const emitTurnAborted = (reason: string): void => {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "turn_aborted",
        payload: {
          turnId: ctx.subId,
          reason,
        },
      },
    });
  };
  const referenceContextItem = toTurnContextItem(ctx);

  // I-13 consumer: apply any staged provider/model/profile switch from
  // a prior `/model`, `/provider`, `/config profile <name>`, or
  // recovery-side `model_fallback` before this turn's lifecycle emits
  // so downstream `turn_context` reflects the intended model slug (for
  // callers that rebuild `ctx` from `session.state` per turn). The
  // existing `pendingProviderSwitch` check inside the inner sampling
  // loop stays as a safety net — the clear here prevents it from
  // re-terminating this fresh turn.
  const sessionOwner = session as Session & {
    consumePendingProviderSwitch?: () => Promise<void>;
  };
  if (typeof sessionOwner.consumePendingProviderSwitch === "function") {
    await sessionOwner.consumePendingProviderSwitch();
  }
  session.bindProviderConversation();

  // Codex: `if input.is_empty() && !sess.has_pending_input().await { return None }`
  // Empty/no-pending-input is a no-op turn, not a synthetic completed
  // turn. Callers that want to force work must enqueue pending input or
  // pass a non-empty user message.
  if (userMessage.trim().length === 0 && !session.hasPendingInput()) {
    return { reason: "completed" };
  }

  // Seed the initial TurnState BEFORE pre-sampling compact so the
  // dispatcher can splice post-compact messages back into state and the
  // first `prepareContext` call reads the compacted view. Codex's
  // equivalent operates on the session-held conversation directly;
  // AgenC's phase machine reads `state.messages`, so the compact result
  // has to land there.
  const { system, prior, user } = buildSeedMessages(opts, userMessage);
  const priorFull = system ? [system, ...prior] : prior;
  const durableHistoryStartIndex = system ? 1 : 0;

  let state: TurnState = buildInitialTurnState(ctx, user, {
    priorMessages: priorFull,
  });
  let persistedMessageCount = priorFull.length;
  const persistTurnRolloutBaseline = (): void => {
    session.rolloutStore?.appendRollout({
      type: "turn_context",
      payload: referenceContextItem,
    });
  };
  const persistNewResponseItems = (): void => {
    if (!session.rolloutStore) return;
    if (state.messages.length < persistedMessageCount) {
      persistedMessageCount = state.messages.length;
    }
    const nextItems = state.messages.slice(persistedMessageCount);
    for (const message of nextItems) {
      session.rolloutStore.appendRollout({
        type: "response_item",
        payload: toResponseItem(message),
      });
    }
    persistedMessageCount = state.messages.length;
  };
  const syncSessionState = async (): Promise<void> => {
    persistNewResponseItems();
    const durableHistory = state.messages.slice(durableHistoryStartIndex);
    await session.state.with((sessionState) => {
      sessionState.history = durableHistory.map((message) => ({
        ...message,
        ...(Array.isArray(message.content)
          ? { content: message.content.map((part) => ({ ...part })) }
          : {}),
        ...(message.toolCalls !== undefined
          ? { toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })) }
          : {}),
      }));
      sessionState.previousTurnSettings = {
        model: ctx.modelInfo.slug,
        ...(ctx.realtimeActive !== undefined
          ? { realtimeActive: ctx.realtimeActive }
          : {}),
        ...(ctx.modelInfo.contextWindow !== undefined
          ? {
              contextWindow: ctx.modelInfo.contextWindow,
              modelInfo: { contextWindow: ctx.modelInfo.contextWindow },
            }
          : {}),
      };
      sessionState.referenceContextItem = referenceContextItem;
    });
  };

  emitTurnStarted();
  persistTurnRolloutBaseline();
  session.budgetTracker?.resetForTurn();

  // T6 gap #119: emit the seed user message exactly once per runTurn
  // invocation. Continuation turns (needsFollowUp=true) stay inside the
  // same generator so this fires once per user-initiated turn, not per
  // phase iteration.
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "user_message",
      payload: { message: opts.displayUserMessage ?? userMessage },
    },
  });
  persistNewResponseItems();

  // Codex: run_pre_sampling_compact before any phase runs. Returns
  // whether compaction happened; if yes and we had a prewarmed
  // client session, reset it (codex 155-157 — AgenC has no prewarm
  // today).
  try {
    await runPreSamplingCompact(session, ctx, state);
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
    await syncSessionState();
    emitTurnComplete("");
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
      // T6 gap #119: cancellation path gets `turn_aborted` so rollouts
      // close the turn boundary with the actual reason.
      await syncSessionState();
      emitTurnAborted(
        String((signal as AbortSignal & { reason?: unknown }).reason ?? "cancelled"),
      );
      const terminal: Terminal = { reason: "cancelled" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "cancelled",
      };
      return terminal;
    }

    const maxTurns = resolveMaxTurns(ctx);
    if (state.turnCount > maxTurns) {
      await drainInFlight(state, ctx, session);
      await syncSessionState();
      emitTurnComplete(lastContent);
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
      await syncSessionState();
      emitTurnComplete(lastContent);
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
    // Hoisted so the mid-turn compaction check after the try/catch can
    // read the just-returned model_needs_follow_up signal. Codex reads
    // this from `SamplingRequestResult` at turn.rs:468-476 right before
    // the `token_limit_reached && needs_follow_up` arm at turn.rs:493.
    let modelNeedsFollowUp = false;
    try {
      const result = await runSamplingRequest(state, ctx, session, signal, pending);
      for (const ev of pending) yield ev;
      // D1 fix: accumulate real provider usage returned from the
      // sampling request so the terminal turn_complete event carries
      // cumulative token consumption across continuation iterations.
      usage = cumulativeUsage(usage, result.usage);
      modelNeedsFollowUp = result.needsFollowUp;
      if (result.terminal) {
        if (result.assistantText.length > 0) {
          lastContent = result.assistantText;
        }
        await syncSessionState();
        emitTurnComplete(lastContent);
        yield {
          type: "turn_complete",
          content: lastContent,
          usage,
          stopReason: terminalToStopReason(result.terminal.reason),
        };
        return result.terminal;
      }
    } catch (error) {
      await drainInFlight(state, ctx, session);
      for (const ev of pending) yield ev;
      const sme = error instanceof StreamModelError ? error : undefined;
      const underlying =
        (sme?.cause instanceof Error ? sme.cause : undefined) ??
        (error instanceof Error ? error : new Error(String(error)));
      if (signal.aborted) {
        // T6 gap #119: cancelled-with-error still gets `turn_aborted`
        // so rollout reconstruction sees a closed turn boundary.
        emitTurnAborted(
          String(
            (signal as AbortSignal & { reason?: unknown }).reason ??
              underlying.message ??
              "cancelled",
          ),
        );
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
      // T6 gap #119: error-terminated turn still completes the turn
      // boundary for rollout reducers.
      await syncSessionState();
      emitTurnComplete(lastContent);
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
      if (
        state.transition.reason === "model_fallback" &&
        session.pendingProviderSwitch !== null &&
        typeof sessionOwner.consumePendingProviderSwitch === "function"
      ) {
        await sessionOwner.consumePendingProviderSwitch();
      }
      state.transition = undefined;
      continue;
    }

    // Mid-turn compaction — port of codex `turn.rs:493-508`. When the
    // just-finished sampling step pushed total token usage at or past
    // the current model's auto-compact limit AND a follow-up is still
    // required (tool calls pending or mailbox has queued user input),
    // compact before the next sampling request instead of letting the
    // next prepareContext stage blow through the window.
    //
    // Codex contract reconstructed here:
    //   token_limit_reached = total_usage_tokens >= auto_compact_limit
    //   needs_follow_up     = model_needs_follow_up || has_pending_input
    //   if both: run_auto_compact(MidTurn) -> reset_websocket_session -> continue
    //
    // AgenC signal mapping:
    //   model_needs_follow_up ← `result.needsFollowUp` (set by stream-model
    //     when `toolUseBlocks.length > 0`; cleared by execute-tools after
    //     dispatch, so we must evaluate BEFORE execute-tools runs below).
    //   has_pending_input     ← `session.hasPendingInput()` (mailbox queue).
    //   total_usage_tokens    ← `getTotalTokenUsage(session)` reads the
    //     cross-turn cumulative `SessionState.totalTokenUsage` maintained
    //     by the stream-model writer (phases/stream-model.ts) after every
    //     provider response, mirroring codex
    //     `TokenUsageInfo::append_last_usage` (protocol.rs:2294-2297).
    //   auto_compact_limit    ← `ctx.modelInfo.autoCompactTokenLimit`.
    //
    // Provider continuity reset (codex `client_session.reset_websocket_session()`):
    //   `runAutoCompact` → `autoCompactIfNeeded` → `runPostCompactCleanup`
    //   → `context.clearProviderResponseId()` wires through
    //   `session.clearProviderResponseId()`, which is AgenC's equivalent.
    //   That covers the reset when compaction actually runs; we add an
    //   explicit `session.bindProviderConversation()` rebind after
    //   compaction to mirror codex's "the next sampling request must
    //   look like a fresh conversation" guarantee.
    //
    // Codex parity: mid-turn compaction must re-inject the current
    // reference-context snapshot immediately before the last real user
    // message in the compacted replacement history. That wiring is
    // carried by `before_last_user_message` through runAutoCompact →
    // autoCompactIfNeeded → compactConversation/session-memory compact.
    const hasPendingInput = session.hasPendingInput();
    const needsFollowUpForCompact = modelNeedsFollowUp || hasPendingInput;
    const autoCompactLimit =
      (ctx.modelInfo as unknown as { autoCompactTokenLimit?: number })
        .autoCompactTokenLimit ?? Number.POSITIVE_INFINITY;
    const totalUsageTokens = getTotalTokenUsage(session);
    const tokenLimitReached = totalUsageTokens >= autoCompactLimit;

    if (tokenLimitReached && needsFollowUpForCompact) {
      let midTurnCompacted = false;
      try {
        midTurnCompacted = await runAutoCompact(
          session,
          ctx,
          "before_last_user_message",
          "context_limit",
          "in_turn",
          state,
        );
      } catch (error) {
        // Codex returns None on mid-turn compact failure. AgenC's
        // analogue is to terminate the turn cleanly with an error
        // event so rollout reducers see a closed turn boundary.
        // Matches the failure handling pattern used by
        // `pre_sampling_compact_failed` at the top of runTurnKernel.
        await drainInFlight(state, ctx, session);
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "error",
            payload: {
              cause: "mid_turn_compact_failed",
              message: error instanceof Error ? error.message : String(error),
            },
          },
        });
        await syncSessionState();
        emitTurnComplete(lastContent);
        const underlying =
          error instanceof Error ? error : new Error(String(error));
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

      if (!midTurnCompacted) {
        // Codex's `is_err()` arm fires only on dispatcher failure. If
        // the dispatcher ran but reported `wasCompacted=false` (circuit
        // breaker tripped, feature disabled, or threshold logic inside
        // the compact module disagreed with our outer check), we do NOT
        // loop — that would spin forever with unchanged state. Surface
        // the token-limit condition as a terminal error matching the
        // semantics of codex's `return None`.
        await drainInFlight(state, ctx, session);
        const reasonText = `mid_turn_compact_skipped: tokens=${totalUsageTokens} limit=${autoCompactLimit}`;
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "error",
            payload: {
              cause: "mid_turn_compact_failed",
              message: reasonText,
            },
          },
        });
        await syncSessionState();
        emitTurnComplete(lastContent);
        const underlying = new Error(reasonText);
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

      // Codex `client_session.reset_websocket_session()` parity.
      // `runAutoCompact` → `runPostCompactCleanup` already called
      // `session.clearProviderResponseId()` via the compact context;
      // rebind the provider HTTP client to the current conversation
      // so the next request opens a fresh continuation under the same
      // conversationId (codex's websocket session is keyed per
      // conversation the same way).
      session.bindProviderConversation();
      // Codex sets `can_drain_pending_input = !model_needs_follow_up;`
      // to gate mailbox drain on the outer loop's next iteration. AgenC
      // does not yet surface a matching gate (the phase machine drains
      // pending input whenever `prepareContext` decides), so there is
      // nothing to set here; the session mailbox fires naturally on the
      // next iteration.
      continue;
    }

    const lastAssistant = state.assistantMessages.at(-1);
    const assistantText = lastAssistant?.text ?? "";
    if (assistantText.length > 0) lastContent = assistantText;

    // No tool calls + no transition → commit + terminate.
    if (!state.needsFollowUp && state.toolUseBlocks.length === 0) {
      await commit(state, ctx, session, signal);
      await syncSessionState();
      // commit may set a stop-hook transition (I-17). If so, re-enter.
      if (state.transition !== undefined) {
        state.transition = undefined;
        continue;
      }
      const stopReason = assistantText.length === 0 ? "empty_response" : "completed";
      // T6 gap #119: canonical happy-path `turn_complete` so rollouts
      // record the close of this turn's lifecycle.
      emitTurnComplete(lastContent);
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
    await syncSessionState();

    // Token-budget decision from streamModel: if exceeded, run-turn
    // today takes the cautious path and terminates. T8 wires the
    // token_budget_continuation recovery that re-enters prepare.
    if (state.pendingBudgetDecision?.kind === "stop") {
      emitTurnComplete(lastContent);
      const terminal: Terminal = { reason: "completed" };
      yield {
        type: "turn_complete",
        content: lastContent,
        usage,
        stopReason: "completed",
      };
      return terminal;
    }

    // D1 fix: usage is accumulated immediately after runSamplingRequest
    // returns (above). No-op dummy accumulation removed.
    // loop back for another sampling request
  }
}

export function runTurn(
  session: Session,
  ctx: TurnContext,
  userMessage: string,
  opts: RunTurnOptions = {},
): AsyncGenerator<PhaseEvent, Terminal> {
  const sessionOwner = session as Session & {
    runTurn?: (
      userMessage: string,
      opts?: {
        ctx?: TurnContext;
        systemPrompt?: string;
        history?: readonly LLMMessage[];
        signal?: AbortSignal;
        displayUserMessage?: string;
      },
    ) => AsyncGenerator<PhaseEvent, Terminal>;
  };
  if (typeof sessionOwner.runTurn === "function") {
    return sessionOwner.runTurn(userMessage, {
      ctx,
      systemPrompt: opts.systemPrompt,
      history: opts.history,
      signal: opts.signal,
      displayUserMessage: opts.displayUserMessage,
    });
  }
  return runTurnKernel(session, ctx, userMessage, opts);
}

export type { Continue, Terminal };

// ─────────────────────────────────────────────────────────────────────
// Plan-mode helpers — port of codex turn.rs:1537-1793. Exported from
// run-turn.ts so existing call sites can tree-shake them. The
// implementations live in `./plan-mode.ts` because they're pure helpers
// with no dependency on the outer turn loop.
// ─────────────────────────────────────────────────────────────────────

export {
  createPlanModeStreamState,
  emitAgentMessageInPlanMode,
  emitStreamedAssistantTextDelta,
  flushAssistantTextSegmentsAll,
  flushAssistantTextSegmentsForItem,
  handleAssistantItemDoneInPlanMode,
  handlePlanSegments,
  isPlanMode,
  maybeCompletePlanItemFromMessage,
  realtimeTextForEvent,
  trackTurnResolvedConfigAnalytics,
} from "./plan-mode.js";

export type {
  AssistantMessageStreamParsersLike,
  ParsedAssistantTextDelta,
  PlanItem,
  PlanItemState,
  PlanModeStreamState,
  PlanResponseItem,
  PlanSegment,
  PlanTurnItem,
} from "./plan-mode.js";
