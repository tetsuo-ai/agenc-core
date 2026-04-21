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
import { prepareContext } from "../phases/prepare-context.js";
import { streamModel, StreamModelError } from "../phases/stream-model.js";
import { isTransientProviderError } from "../recovery/api-errors.js";
import {
  RECONNECT_MAX_ATTEMPTS,
  reconnectWithBackoff,
} from "../recovery/reconnection.js";
import * as planModeHelpers from "./plan-mode.js";
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
export async function maybeRunPreviousModelInlineCompact(
  session: Session,
  ctx: TurnContext,
  _totalUsageTokens: number,
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
    await streamModel(state, ctx, session, signal);
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
      const last = state.assistantMessages.at(-1);
      if (last && typeof last.text === "string" && last.text.length > 0) {
        planModeHelpers.maybeCompletePlanItemFromMessage(
          session,
          ctx,
          planStream,
          {
            role: "assistant",
            content: [{ type: "output_text", text: last.text }],
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
  // T13 adds per-provider `streamMaxRetries`; default matches the
  // reconnection module's `RECONNECT_MAX_ATTEMPTS` (5) for parity with
  // the rest of the recovery ladder.
  const maxAttempts = RECONNECT_MAX_ATTEMPTS;

  const outcome = await reconnectWithBackoff<SamplingRequestResult>({
    session,
    signal,
    maxAttempts,
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
// I-13 consumer: apply a staged provider/model/profile switch.
// ─────────────────────────────────────────────────────────────────────

/**
 * I-13 consumer — apply any `session.pendingProviderSwitch` staged by
 * `/model`, `/provider`, `/config profile <name>`, or the recovery
 * model-fallback path. The staging side of I-13 (turn-abort + marker)
 * lives in those commands and in `recovery/model-fallback.ts`; this
 * function is the matching "apply on the next turn" half.
 *
 * Called at the top of `runTurn` so the switch takes effect on the
 * turn that follows the one that staged it. The existing
 * `session.pendingProviderSwitch` check inside the inner sampling-
 * request loop stays as a safety net for mid-turn stages that slip
 * through without calling `abortTerminal` (e.g. recovery-side
 * fallbacks that rely on `state.transition` to exit the loop).
 *
 * Behavior:
 *   - Updates `sessionConfiguration.collaborationMode.model` in place
 *     on the session state (I-30 allows between-turn mutations; the
 *     per-turn snapshot is captured at `buildTurnContext` time, so this
 *     write is visible to the NEXT `buildTurnContext` call).
 *   - When a `profile` slot is set and `session.services.configStore`
 *     is available, delegates the overlay computation to
 *     `resolveProfile(...)`. Today the profile's `model` / `provider`
 *     values are already staged on the same marker by
 *     `commands/config.ts::handleProfileSubcommand` — this function
 *     just ensures the session config reflects them.
 *   - Leaves the active `provider` field on the session unchanged. The
 *     T13 provider factory/registry is what eventually swaps the live
 *     `LLMProvider` instance; for now we only record the target model
 *     so the next turn's snapshot picks up the intended slug.
 *   - Clears the marker via `setPendingProviderSwitch(null)` after
 *     applying so the `pendingProviderSwitch` check in the inner loop
 *     does not re-terminate the fresh turn.
 *   - Emits a `warning` event (cause `provider_switch_applied`)
 *     instead of adding a new EventMsg variant — the warning carries
 *     the structured `before → after` payload in its `message` field.
 */
async function consumePendingProviderSwitch(session: Session): Promise<void> {
  const pending = session.pendingProviderSwitch;
  if (!pending) return;

  // Best-effort read of the current model/provider so the emitted
  // warning can report a before/after. `state.unsafePeek()` is safe
  // here — we only read, the actual mutation goes through `state.with`.
  const peeked = session.state.unsafePeek?.() as
    | {
        sessionConfiguration?: {
          provider?: { slug?: string };
          collaborationMode?: { model?: string };
        };
      }
    | undefined;
  const beforeModel =
    peeked?.sessionConfiguration?.collaborationMode?.model ?? "unknown";
  const beforeProvider =
    peeked?.sessionConfiguration?.provider?.slug ?? "unknown";

  // Resolve profile overlay if the marker carried a profile name and
  // the configStore is wired. When the store is missing the profile
  // slot is still honored for model/provider because the staging site
  // already wrote those fields into the marker from the profile's
  // declared overrides.
  // TODO T13: thread provider-factory so cross-provider switches can
  // actually swap `session.services.provider` here instead of only
  // updating the collaboration-mode model slug.
  let resolvedModel = pending.model;
  if (pending.profile) {
    const configStore = (session.services as unknown as {
      configStore?: {
        current(): unknown;
      };
    }).configStore;
    if (configStore && typeof configStore.current === "function") {
      try {
        const { resolveProfile } = await import("../config/profiles.js");
        const snapshot = configStore.current() as Parameters<
          typeof resolveProfile
        >[0];
        const overlaid = resolveProfile(snapshot, pending.profile);
        if (overlaid.model && overlaid.model.length > 0) {
          resolvedModel = overlaid.model;
        }
      } catch {
        // Fall through with the marker's raw model value — resolveProfile
        // only throws on unknown profile names, which the staging site
        // already validated. Any unexpected failure here should not
        // block the switch.
      }
    }
  }

  // Apply to session state. `session.state.with` may be absent on test
  // fixtures that mock the state with a bare `unsafePeek`; fall back to
  // in-place mutation of the peeked value in that case.
  const applyMutation = (
    state: { sessionConfiguration?: unknown } | undefined,
  ): void => {
    if (!state || typeof state !== "object") return;
    const cfg = state.sessionConfiguration as
      | { collaborationMode?: { model?: string } }
      | undefined;
    if (!cfg) return;
    const currentMode = cfg.collaborationMode;
    if (currentMode) {
      (cfg as { collaborationMode: { model: string } }).collaborationMode = {
        ...currentMode,
        model: resolvedModel || currentMode.model || "",
      };
    }
  };

  const stateLock = session.state as unknown as {
    with?: (fn: (s: unknown) => unknown) => Promise<unknown>;
    unsafePeek?: () => unknown;
  };
  if (typeof stateLock.with === "function") {
    await stateLock.with((s) => {
      applyMutation(s as { sessionConfiguration?: unknown });
    });
  } else if (typeof stateLock.unsafePeek === "function") {
    applyMutation(stateLock.unsafePeek() as { sessionConfiguration?: unknown });
  }

  // Clear the marker so the inner-loop safety net does not re-trigger.
  session.setPendingProviderSwitch(null);

  // Record the applied switch as a warning with a structured cause.
  // Using `warning` (existing EventMsg variant) keeps this change
  // scoped to run-turn.ts without extending the event catalog.
  try {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "provider_switch_applied",
          message: `provider ${beforeProvider} → ${pending.provider}; model ${beforeModel} → ${resolvedModel}${
            pending.profile ? `; profile ${pending.profile}` : ""
          }`,
        },
      },
    });
  } catch {
    // Best-effort telemetry only.
  }
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

  // I-13 consumer: apply any staged provider/model/profile switch from
  // a prior `/model`, `/provider`, `/config profile <name>`, or
  // recovery-side `model_fallback` before this turn's lifecycle emits
  // so downstream `turn_context` reflects the intended model slug (for
  // callers that rebuild `ctx` from `session.state` per turn). The
  // existing `pendingProviderSwitch` check inside the inner sampling
  // loop stays as a safety net — the clear here prevents it from
  // re-terminating this fresh turn.
  await consumePendingProviderSwitch(session);

  // Codex: "if input.is_empty() && !sess.has_pending_input().await { return None }"
  if (userMessage.trim().length === 0) {
    emitTurnStarted();
    emitTurnComplete("");
    const terminal: Terminal = { reason: "completed" };
    yield {
      type: "turn_complete",
      content: "",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      stopReason: "empty_response",
    };
    return terminal;
  }

  emitTurnStarted();

  // T6 gap #119: emit the seed user message exactly once per runTurn
  // invocation. Continuation turns (needsFollowUp=true) stay inside the
  // same generator so this fires once per user-initiated turn, not per
  // phase iteration.
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "user_message",
      payload: { message: userMessage },
    },
  });

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
      // T6 gap #119: cancellation path gets `turn_aborted` so rollouts
      // close the turn boundary with the actual reason.
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
    try {
      const result = await runSamplingRequest(state, ctx, session, signal, pending);
      for (const ev of pending) yield ev;
      // D1 fix: accumulate real provider usage returned from the
      // sampling request so the terminal turn_complete event carries
      // cumulative token consumption across continuation iterations.
      usage = cumulativeUsage(usage, result.usage);
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
