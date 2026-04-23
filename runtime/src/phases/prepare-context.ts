/**
 * Phase 1 — Prepare Context.
 *
 * Mirrors openclaude `query.ts:311-652` — the staged pre-model-call
 * chain:
 *
 *   1. **Compact-boundary projection** — rebuild `messagesForQuery`
 *      from the slice AFTER the most recent compact-summary message
 *      in `state.messages` (`getMessagesAfterCompactBoundary` in
 *      openclaude). Implemented here in pure TS.
 *
 *   2. **Tool-result budgeting** (`applyToolResultBudget`) — per-tool
 *      result-size enforcement with optional persistence.
 *
 *   3. **Snip compaction** (`snipCompactIfNeeded`) — removes oversized
 *      tool-result bodies pre-autocompact.
 *
 *   4. **MicroCompact** (`microcompact`) — streaming micro-compaction.
 *
 *   5. **Context-collapse projection** (`applyCollapsesIfNeeded`) —
 *      idempotent view over the REPL's full history.
 *
 *   6. **AutoCompactIfNeeded** (`autoCompactIfNeeded`) — full-context
 *      compaction when token count crosses the threshold.
 *
 *   7. **Blocking-limit preempt** — hard fail when auto-compact is off
 *      and cumulative tokens cross the blocking limit.
 *
 * The compact-boundary projection is live in T5; the compaction
 * pipeline stages 2-7 call into `runtime/src/llm/compact/**` via
 * literal-path dynamic imports (`safeCompactImport`) so tsup traces
 * each stage module into the runtime bundle. I-18 is reachable
 * through stage 6 (`autoCompactIfNeeded` -> `compactConversation` ->
 * `assertCompactionShrank`), so a near-identity summary on the
 * autocompact path throws `CompactionShrinkRatioError`, which the
 * caller's catch uses to bump the
 * `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3` circuit breaker.
 *
 * Invariants wired:
 *   I-2  (clearResponseId on compact) — handled by
 *        post-compact-cleanup.ts via grok/incremental tracker registry.
 *   I-18 (compaction shrink assertion) — lives inside compact.ts.
 *   I-88 (per-turn toolResultBytes index) — T6 wires; no-op here.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import type { QuerySource } from "./_deps/query-source.js";
import { calculateTokenWarningState, isAutoCompactEnabled } from "../llm/compact/auto-compact.js";
import {
  buildCompactedRolloutItem,
  buildPostCompactMessages,
} from "../llm/compact/compact.js";
import {
  buildCompactCacheSafeParams,
  createSessionBackedCompactContext,
} from "../session/compact-runtime-context.js";
import { PROMPT_TOO_LONG_ERROR_MESSAGE } from "../recovery/api-errors.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";
import type {
  AssistantMessage,
  Terminal,
  TurnState,
} from "../session/turn-state.js";
import { finalContextTokensFromLastResponse } from "../recovery/_deps/tokens.js";
import { tokenCountWithEstimation } from "../llm/compact/_deps/token-counts.js";
import { applyToolResultBudget } from "./_deps/tool-result-storage.js";
import { recordContentReplacement } from "./_deps/session-storage.js";

/**
 * Dynamic loader for the compact/ subsystem. Each compact stage is
 * loaded through a literal-path dynamic `import()` so tsup/esbuild
 * traces the module into the runtime bundle (variable-path dynamic
 * imports are NOT traced). Result is `null` when the module tree
 * fails to resolve at runtime — callers treat that as "stage
 * disabled", matching openclaude's feature-off behavior.
 *
 * Historical: the previous `safeCompactRequire` helper silently
 * swallowed every load failure. That hid real module-evaluation
 * regressions (a compact stage throwing at import time looked
 * identical to a stage not yet wired). Runtime `MODULE_NOT_FOUND` /
 * `ERR_MODULE_NOT_FOUND` is the only benign failure mode here and is
 * still silent, because with literal dynamic imports those only fire
 * when the bundler genuinely did not trace the module (legitimate
 * "stage disabled"). Every other error path now emits
 * `warning:compact_stage_failed` so silent regressions can't hide.
 *
 * `stageLabel` is embedded in the emitted warning so operators can
 * see which compaction stage failed without decoding bundler paths.
 */
async function safeCompactImport<T = unknown>(
  stageLabel: "snip_compact" | "micro_compact" | "auto_compact",
  loader: () => Promise<unknown>,
  session?: Session,
): Promise<T | null> {
  try {
    const mod = await loader();
    return mod as T;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code ?? "")
        : "";
    // Expected when the bundler legitimately tree-shook this stage
    // (no import graph ties to it) — stays silent to avoid per-turn
    // warning spam.
    if (code !== "MODULE_NOT_FOUND" && code !== "ERR_MODULE_NOT_FOUND") {
      session?.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "compact_stage_failed",
            message: `compact stage ${stageLabel} failed to load: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        },
      });
    }
    return null;
  }
}

/**
 * Look backwards through `messages` for the most recent compact-
 * boundary marker. openclaude marks boundaries with a system-role
 * message carrying `isCompactSummary` / `isCompactBoundary`. AgenC's
 * LLMMessage doesn't carry that flag yet (T6 adds it with the real
 * rollout), so we detect the boundary by searching for an assistant
 * message whose content begins with a compact-summary marker token
 * or an anchor-preserved user message tagged with the compact
 * attachment kind. Returns the slice from the message AFTER the
 * boundary onward (or the full history when no boundary exists).
 *
 * Openclaude reference: `llm/compact/grouping.ts` +
 * `utils/messages.ts::getMessagesAfterCompactBoundary`.
 */
const COMPACT_BOUNDARY_PREFIX = "<agenc-compact-boundary>";

function getMessagesAfterCompactBoundary(
  messages: ReadonlyArray<LLMMessage>,
): LLMMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!m) continue;
    const content = typeof m.content === "string" ? m.content : "";
    if (content.startsWith(COMPACT_BOUNDARY_PREFIX)) {
      return messages.slice(i + 1).map((x) => ({ ...x }));
    }
  }
  return messages.map((x) => ({ ...x }));
}

interface AutoCompactModule {
  autoCompactIfNeeded?: (...args: unknown[]) => Promise<{
    wasCompacted: boolean;
    compactionResult?: unknown;
    consecutiveFailures?: number;
  }>;
}

interface MicroCompactModule {
  microcompactMessages?: (...args: unknown[]) => Promise<{
    messages: LLMMessage[];
    compactionInfo?: unknown;
  }>;
}

interface SnipCompactModule {
  snipCompactIfNeeded?: (messages: LLMMessage[]) => {
    messages: LLMMessage[];
    tokensFreed: number;
  };
}

export interface PrepareContextTerminalState {
  readonly terminal: Terminal;
  readonly assistantMessage: AssistantMessage;
}

const PREPARE_CONTEXT_TERMINAL = Symbol("prepare_context_terminal");

type TurnStateWithPrepareContextTerminal = TurnState & {
  [PREPARE_CONTEXT_TERMINAL]?: PrepareContextTerminalState;
};

interface PrepareContextRuntimeOptions {
  readonly querySource?: QuerySource;
  readonly taskBudget?: { readonly total: number };
  readonly reactiveCompact?: {
    readonly isReactiveCompactEnabled?: () => boolean;
  };
  readonly contextCollapse?: {
    readonly isContextCollapseEnabled?: () => boolean;
    readonly isEnabled?: () => boolean;
  };
}

function clearPrepareContextTerminal(state: TurnState): void {
  delete (state as TurnStateWithPrepareContextTerminal)[PREPARE_CONTEXT_TERMINAL];
}

function setPrepareContextTerminal(
  state: TurnState,
  message: string,
): void {
  (state as TurnStateWithPrepareContextTerminal)[PREPARE_CONTEXT_TERMINAL] = {
    terminal: { reason: "blocking_limit" },
    assistantMessage: {
      uuid: crypto.randomUUID(),
      role: "assistant",
      text: message,
      toolCalls: [],
      apiError: "prompt_too_long",
    },
  };
}

export function getPrepareContextTerminal(
  state: TurnState,
): PrepareContextTerminalState | undefined {
  return (state as TurnStateWithPrepareContextTerminal)[PREPARE_CONTEXT_TERMINAL];
}

function resolvePrepareContextRuntimeOptions(
  ctx: TurnContext,
  session: Session,
): Required<Pick<PrepareContextRuntimeOptions, "querySource">> &
  Omit<PrepareContextRuntimeOptions, "querySource"> {
  const fromCtx = ctx as TurnContext & PrepareContextRuntimeOptions;
  const fromSession = session as Session & {
    services?: PrepareContextRuntimeOptions;
  };
  return {
    querySource:
      fromCtx.querySource ??
      fromSession.services?.querySource ??
      "repl_main_thread",
    taskBudget: fromCtx.taskBudget ?? fromSession.services?.taskBudget,
    reactiveCompact:
      fromCtx.reactiveCompact ?? fromSession.services?.reactiveCompact,
    contextCollapse:
      fromCtx.contextCollapse ?? fromSession.services?.contextCollapse,
  };
}

function isContextCollapseEnabledForPrepareContext(
  runtimeOptions: ReturnType<typeof resolvePrepareContextRuntimeOptions>,
): boolean {
  const collapse = runtimeOptions.contextCollapse;
  if (!collapse) return false;
  if (typeof collapse.isContextCollapseEnabled === "function") {
    return collapse.isContextCollapseEnabled();
  }
  if (typeof collapse.isEnabled === "function") {
    return collapse.isEnabled();
  }
  return false;
}

function isReactiveCompactEnabledForPrepareContext(
  runtimeOptions: ReturnType<typeof resolvePrepareContextRuntimeOptions>,
): boolean {
  const reactiveCompact = runtimeOptions.reactiveCompact;
  if (!reactiveCompact) return false;
  if (typeof reactiveCompact.isReactiveCompactEnabled === "function") {
    return reactiveCompact.isReactiveCompactEnabled();
  }
  return false;
}

export async function prepareContext(
  state: TurnState,
  ctx: TurnContext,
  session: Session,
  _signal?: AbortSignal,
): Promise<TurnState> {
  clearPrepareContextTerminal(state);
  const runtimeOptions = resolvePrepareContextRuntimeOptions(ctx, session);

  // Stage 1: compact-boundary projection (openclaude query.ts:369).
  let messagesForQuery = getMessagesAfterCompactBoundary(state.messages);

  // Stages 2-7: compaction pipeline. Stages 3/4/6 dynamically import
  // into `runtime/src/llm/compact/**` via `safeCompactImport` so
  // tsup/esbuild traces each stage module into the runtime bundle.
  // A stage that fails to resolve returns `null` and becomes a no-op
  // for that turn; a stage that resolves but throws during load or
  // execution emits `warning:compact_stage_failed` with the stage
  // label.

  // Stage 2 — I-88-driven tool-result budgeting (ports
  // openclaude `query.ts:~369` + `toolResultStorage.ts`).
  // Byte-index source: `session.rolloutStore` (`RolloutStore` owns the
  // I-88 per-turn tally at `rollout-store.ts:76/82`). Falls back to
  // measuring tool-role messages in-place when the rollout store is
  // absent (degraded/no-rollout sessions, subagents without persistence).
  const persistReplacements =
    runtimeOptions.querySource.startsWith("agent:") ||
    runtimeOptions.querySource.startsWith("repl_main_thread");
  const skipToolNames = new Set(
    (session.services.registry?.tools ?? [])
      .filter(
        (tool) =>
          tool.maxResultBytes !== undefined &&
          !Number.isFinite(tool.maxResultBytes),
      )
      .map((tool) => tool.name),
  );
  const toolResultBudgetResult = await applyToolResultBudget(
    messagesForQuery as never,
    state.contentReplacementState as never,
    persistReplacements
      ? (records) => {
          void recordContentReplacement(records);
        }
      : undefined,
    skipToolNames,
  );
  messagesForQuery = toolResultBudgetResult.messages as LLMMessage[];

  // Stage 3: snip compaction.
  let snipTokensFreed = 0;
  const snipMod = await safeCompactImport<SnipCompactModule>(
    "snip_compact",
    () => import("../llm/compact/snip-compact.js"),
    session,
  );
  if (snipMod?.snipCompactIfNeeded) {
    try {
      const result = snipMod.snipCompactIfNeeded(messagesForQuery);
      messagesForQuery = result.messages;
      snipTokensFreed = result.tokensFreed;
      state.snipTokensFreed = snipTokensFreed;
    } catch (error) {
      // Real error emission (was silent in the pre-T4-gap helper).
      // Unified `compact_stage_failed` cause keeps every compaction
      // failure under one greppable event class — see the load-side
      // emission in `safeCompactImport`.
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "compact_stage_failed",
            message: `compact stage snip_compact threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        },
      });
    }
  }

  // Stage 4: microCompact.
  const runtimeQuerySource = runtimeOptions.querySource ?? "repl_main_thread";
  const compactRuntimeContext = createSessionBackedCompactContext(session, {
    querySource: runtimeQuerySource,
    turnContext: ctx,
    cwd: ctx.cwd,
    isNonInteractiveSession: false,
  });
  const microMod = await safeCompactImport<MicroCompactModule>(
    "micro_compact",
    () => import("../llm/compact/micro-compact.js"),
    session,
  );
  if (microMod?.microcompactMessages) {
    try {
      const result = await microMod.microcompactMessages(
        messagesForQuery,
        compactRuntimeContext,
        runtimeQuerySource,
      );
      messagesForQuery = result.messages;
    } catch (error) {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "compact_stage_failed",
            message: `compact stage micro_compact threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        },
      });
    }
  }

  // Stage 5: context-collapse projection. When the runtime service has
  // a staged snapshot for this session, project that collapsed view
  // before auto-compact so recovery-owned collapse can win without
  // forcing a full summary. Missing/disabled services fail closed.
  const contextCollapse =
    runtimeOptions.contextCollapse as
      | {
          readonly maybeCollapseContext?: (
            messages: ReadonlyArray<LLMMessage>,
            ctx?: { readonly session?: Session | null },
          ) => ReadonlyArray<LLMMessage>;
          readonly isContextCollapseEnabled?: () => boolean;
          readonly isEnabled?: () => boolean;
        }
      | undefined;
  if (isContextCollapseEnabledForPrepareContext(runtimeOptions)) {
    const project = contextCollapse?.maybeCollapseContext;
    if (typeof project === "function") {
      try {
        messagesForQuery = [...project(messagesForQuery, { session })];
      } catch (error) {
        session.emit({
          id: session.nextInternalSubId(),
          msg: {
            type: "warning",
            payload: {
              cause: "context_collapse_projection_failed",
              message: `context-collapse projection failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          },
        });
      }
    }
  }

  // Stage 6: autoCompactIfNeeded. Live caller-chain endpoint for
  // I-18 (docs/plan/invariants.md:592-619): when the token threshold
  // fires, `autoCompactIfNeeded` invokes `compactConversation`, which
  // calls `assertCompactionShrank` at the tail. A near-identity
  // summary throws `CompactionShrinkRatioError`; the inner catch in
  // `auto-compact.ts` increments `consecutiveFailures` on the
  // returned tracking state, and we thread that forward onto
  // `state.autoCompactTracking` below so the circuit breaker honours
  // `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES=3`.
  //
  // Double-compact gate: `run-turn.ts::runPreSamplingCompact` is the
  // canonical pre-turn compact dispatcher per codex (turn.rs:712-735)
  // and runs BEFORE the phase loop. If it already compacted this turn,
  // it stamps `state.autoCompactTracking` with compacted=true and
  // turnCounter=0 (see run-turn.ts:334-339). commit.ts bumps
  // turnCounter to 1 on the FIRST iteration's commit, so the freshly-
  // compacted signal (compacted=true, turnCounter===0) uniquely marks
  // "the pre-sampling site already ran this turn and commit hasn't
  // consumed the boundary yet." Skip Stage-6 in that case to preserve
  // the one-compact-per-turn contract. Stage-6 still fires on
  // continuation iterations (turnCounter > 0) when history has grown
  // past the threshold.
  const preSamplingAlreadyCompacted =
    state.autoCompactTracking?.compacted === true &&
    state.autoCompactTracking.turnCounter === 0;
  const autoMod = preSamplingAlreadyCompacted
    ? null
    : await safeCompactImport<AutoCompactModule>(
        "auto_compact",
        () => import("../llm/compact/auto-compact.js"),
        session,
      );
  let compactedThisIteration = false;
  if (autoMod?.autoCompactIfNeeded) {
    try {
      const cacheSafeParams = await buildCompactCacheSafeParams(
        compactRuntimeContext,
        messagesForQuery,
      );
      const result = await autoMod.autoCompactIfNeeded(
        messagesForQuery,
        compactRuntimeContext,
        cacheSafeParams,
        runtimeQuerySource,
        state.autoCompactTracking,
        snipTokensFreed,
      );
      if (result.wasCompacted && result.compactionResult) {
        compactedThisIteration = true;
        const compactResult =
          result.compactionResult as Parameters<typeof buildPostCompactMessages>[0];
        session.rolloutStore?.appendRollout(
          {
            type: "compacted",
            payload: buildCompactedRolloutItem(compactResult),
          },
          { durable: true },
        );
        if (runtimeOptions.taskBudget) {
          const preCompactContext =
            finalContextTokensFromLastResponse(messagesForQuery);
          state.taskBudgetRemaining = Math.max(
            0,
            (state.taskBudgetRemaining ?? runtimeOptions.taskBudget.total) -
              preCompactContext,
          );
        }
        // The post-compact messages replace messagesForQuery; the
        // boundary marker plus summary + attachments are authored by
        // compact.ts::buildPostCompactMessages. Persist the matching
        // `compacted` rollout item immediately, then splice the compacted
        // view into this iteration so the stream sees the same boundary.
        const compactedMessages = buildPostCompactMessages(compactResult);
        messagesForQuery = compactedMessages;
        // Also write state.messages so the NEXT prepareContext iteration's
        // Stage-1 `getMessagesAfterCompactBoundary(state.messages)` sees the
        // boundary that we just produced. Without this, openclaude's
        // query.ts invariant that the compacted view survives across
        // loop iterations (see openclaude/src/query.ts:541-620) is
        // violated in AgenC because `state.messages` is the long-lived
        // full history and Stage 1 re-derives `messagesForQuery` from it
        // each iteration. Mirrors the pre-sampling compact write-back in
        // run-turn.ts:runAutoCompact (state.messages = compacted).
        state.messages = [...compactedMessages];
        // Stamp auto-compact tracking so the commit phase emits the
        // boundary marker (runtime/src/phases/commit.ts).
        state.autoCompactTracking = {
          compacted: true,
          turnId: `auto-${Date.now().toString(36)}`,
          turnCounter: 0,
          consecutiveFailures: 0,
        };
      } else if (result.consecutiveFailures !== undefined) {
        state.autoCompactTracking = {
          ...(state.autoCompactTracking ?? {
            compacted: false,
            turnId: "",
            turnCounter: 0,
          }),
          consecutiveFailures: result.consecutiveFailures,
        };
      }
    } catch (error) {
      // Real error emission; unified cause with stages 3 & 4.
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "compact_stage_failed",
            message: `compact stage auto_compact threw: ${
              error instanceof Error ? error.message : String(error)
            }`,
          },
        },
      });
    }
  }

  // Stage 7: blocking-limit preempt (openclaude query.ts:596-679).
  // The phase port cannot yield directly, so it stores the typed local
  // terminal + synthetic assistant error message on TurnState for the
  // caller to consume before sampling.
  let collapseOwnsIt = false;
  if (isContextCollapseEnabledForPrepareContext(runtimeOptions)) {
    collapseOwnsIt = isAutoCompactEnabled();
  }
  const reactiveCompactEnabled =
    isReactiveCompactEnabledForPrepareContext(runtimeOptions);
  if (
    !compactedThisIteration &&
    runtimeOptions.querySource !== "compact" &&
    runtimeOptions.querySource !== "session_memory" &&
    !(reactiveCompactEnabled && isAutoCompactEnabled()) &&
    !collapseOwnsIt
  ) {
    const { isAtBlockingLimit } = calculateTokenWarningState(
      tokenCountWithEstimation(messagesForQuery) - snipTokensFreed,
      ctx.modelInfo.slug,
    );
    if (isAtBlockingLimit) {
      setPrepareContextTerminal(state, PROMPT_TOO_LONG_ERROR_MESSAGE);
    }
  }

  if (
    state.autoCompactTracking?.consecutiveFailures !== undefined &&
    state.autoCompactTracking.consecutiveFailures >= 3 &&
    isAutoCompactEnabled()
  ) {
    const tokenUsage =
      tokenCountWithEstimation(messagesForQuery) - snipTokensFreed;
    const { isAboveAutoCompactThreshold } = calculateTokenWarningState(
      tokenUsage,
      ctx.modelInfo.slug,
    );
    if (isAboveAutoCompactThreshold) {
      setPrepareContextTerminal(
        state,
        "The conversation has exceeded the context limit and automatic compaction has failed. Press esc twice to go up a few messages and try again, or start a new session with /new.",
      );
    }
  }

  state.messagesForQuery = messagesForQuery;
  return state;
}
