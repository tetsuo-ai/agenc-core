/**
 * Compaction for run-turn: the auto-compact dispatcher, the AgenC
 * compaction result projection, the previous-model inline compact,
 * pre-sampling compact and the token-limit gates. Pure move out of
 * run-turn.ts; the declarations are the originals byte for byte.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import { getSelectedProviderEnvironment } from "../utils/model/providers.js";
import type { CompactionResult } from "../services/compact/types.js";
import { getAutoCompactThreshold } from "../services/compact/autoCompact.js";
import { estimateMessagesTokens } from "../services/compact/_deps/runtime.js";
import {
  extractMessageText,
  fromAgenCRuntimeMessages,
  toAgenCRuntimeMessages,
  type AgenCRuntimeMessage,
} from "./runtime-message-conversion.js";
import { resetRelevantMemoryBudget } from "./attachment-state.js";
import { CompactionReconstructionRequiredError } from "../services/compact/transaction-types.js";
import {
  CompactionCleanupPendingError,
  finalizeCompactionTransaction,
} from "../services/compact/finalize-transaction.js";
import { runPostCompactCleanup } from "../services/compact/postCompactCleanup.js";
import { resetMicrocompactState } from "../services/compact/microCompact.js";
import type { CompactedItem } from "./rollout-item.js";
import type { Session } from "./session.js";
import {
  llmMessageToReplacementResponseItem,
  responseItemToLlmMessage,
} from "./message-history-conversion.js";
import {
  modelContextWindow,
  type ModelInfo,
  type TurnContext,
} from "./turn-context.js";
import type { TurnState } from "./turn-state.js";
import { buildAgenCToolUseContext } from "./agenc-tool-use-context.js";
import {
  excludeFromDurableHistory,
  finitePositive,
} from "./run-turn-messages.js";
import { sessionQuerySourceForTurn } from "./run-turn-queued-commands.js";
import { buildSamplingRequestContract } from "./run-turn-sampling-request.js";

const AUTOCOMPACT_NOTICE_BUFFER_TOKENS = 13_000;
const TRUTHY_ENV = new Set(["1", "true", "yes", "on"]);

interface AgenCAutoCompactResult {
  readonly wasCompacted: boolean;
  readonly compactionResult?: {
    readonly message: string;
    readonly replacementHistory: readonly LLMMessage[];
    readonly preCompactTokens?: number;
    readonly postCompactTokens?: number;
    readonly transaction?: CompactionResult["transaction"];
  };
  readonly consecutiveFailures?: number;
  /** Why an attempt declined to compact; surfaced to the turn. */
  readonly skippedReason?: string;
}

type AgenCCompactionResult = {
  readonly boundaryMarker?: AgenCRuntimeMessage;
  readonly summaryMessages?: readonly AgenCRuntimeMessage[];
  readonly messagesToKeep?: readonly AgenCRuntimeMessage[];
  readonly attachments?: readonly AgenCRuntimeMessage[];
  readonly userDisplayMessage?: string;
  readonly preCompactTokenCount?: number;
  readonly postCompactTokenCount?: number;
  readonly truePostCompactTokenCount?: number;
  readonly transaction?: CompactionResult["transaction"];
};

async function runAgenCAutoCompact(params: {
  readonly session?: Session;
  readonly ctx?: TurnContext;
  readonly state?: TurnState;
  /** Durable history offered to the transaction (see runAutoCompact). */
  readonly messages: readonly LLMMessage[];
  readonly querySource?: string;
  readonly reason?: string;
  readonly phase?: string;
  readonly initialContextInjection?: string;
  readonly force?: boolean;
}): Promise<AgenCAutoCompactResult> {
  if (!params.session || !params.ctx || !params.state) {
    return compactionNotRun();
  }
  try {
    const state = params.state;
    const messages = toAgenCRuntimeMessages(params.messages);
    const toolUseContext = buildAgenCToolUseContext(
      params.session,
      params.ctx,
      { querySource: params.querySource },
    );
    const cacheSafeParams = {
      systemPrompt: [],
      userContext: {},
      systemContext: {},
      toolUseContext,
      forkContextMessages: messages,
    };
    const { autoCompactIfNeeded } =
      await import("../services/compact/autoCompact.js");
    const result = await autoCompactIfNeeded(
      messages,
      toolUseContext,
      cacheSafeParams,
      params.querySource,
      state.autoCompactTracking,
      state.snipTokensFreed ?? 0,
      { force: params.force === true },
    );
    if (!result.wasCompacted || !result.compactionResult) {
      // The reason the attempt declined rides along: without it the caller
      // sees a bare "did not compact" and the turn ends mid-plan with
      // nothing in the rollout to act on.
      return compactionNotRun(result.consecutiveFailures, result.skippedReason);
    }
    const compactionResult = await toAgenCCompactionResult(
      result.compactionResult as AgenCCompactionResult,
    );
    return {
      wasCompacted: true,
      compactionResult,
      ...(result.consecutiveFailures !== undefined
        ? { consecutiveFailures: result.consecutiveFailures }
        : {}),
    };
  } catch (error) {
    throw error;
  }
}

function buildAgenCCompactedRolloutItem(
  result: NonNullable<AgenCAutoCompactResult["compactionResult"]>,
) {
  return buildCompactedRolloutPayload({
    message: result.message,
    replacementHistory: result.replacementHistory,
    preCompactTokens: result.preCompactTokens,
    postCompactTokens: result.postCompactTokens,
  });
}

function buildAgenCPostCompactMessages(result: CompactedItem): LLMMessage[] {
  return (result.replacementHistory ?? []).map(responseItemToLlmMessage);
}

function buildCompactedRolloutPayload(params: {
  readonly message: string;
  readonly replacementHistory?: readonly LLMMessage[];
  readonly preCompactTokens?: number;
  readonly postCompactTokens?: number;
}): CompactedItem {
  return {
    message: params.message,
    ...(params.replacementHistory !== undefined
      ? {
          replacementHistory: params.replacementHistory.map((message) =>
            llmMessageToReplacementResponseItem(message, "compacted"),
          ),
        }
      : {}),
    ...(params.preCompactTokens !== undefined
      ? { preCompactTokens: params.preCompactTokens }
      : {}),
    ...(params.postCompactTokens !== undefined
      ? { postCompactTokens: params.postCompactTokens }
      : {}),
  };
}

async function toAgenCCompactionResult(
  result: AgenCCompactionResult,
): Promise<NonNullable<AgenCAutoCompactResult["compactionResult"]>> {
  let replacementHistory: LLMMessage[];
  try {
    const { buildPostCompactMessages } =
      await import("../services/compact/compact.js");
    replacementHistory = fromAgenCRuntimeMessages(
      buildPostCompactMessages(
        toCompactServiceResult(result),
      ) as AgenCRuntimeMessage[],
    );
  } catch (error) {
    if (result.transaction !== undefined) {
      throw new CompactionReconstructionRequiredError(
        result.transaction.attempt_id,
        { cause: error },
      );
    }
    throw error;
  }
  const postCompactTokens =
    result.truePostCompactTokenCount ?? result.postCompactTokenCount;
  return {
    message:
      result.userDisplayMessage ??
      extractMessageText(result.summaryMessages?.at(-1)) ??
      "Conversation compacted",
    replacementHistory,
    ...(result.preCompactTokenCount !== undefined
      ? { preCompactTokens: result.preCompactTokenCount }
      : {}),
    ...(postCompactTokens !== undefined ? { postCompactTokens } : {}),
    ...(result.transaction !== undefined
      ? { transaction: result.transaction }
      : {}),
  };
}

/** @internal Regression seam for the turn-owned compaction projection. */
export async function projectTurnCompactionReplacementHistoryForTests(
  result: unknown,
): Promise<LLMMessage[]> {
  return [
    ...(await toAgenCCompactionResult(result as AgenCCompactionResult))
      .replacementHistory,
  ];
}

function toCompactServiceResult(
  result: AgenCCompactionResult,
): CompactionResult {
  if (!result.boundaryMarker) {
    throw new Error("Compaction result is missing its boundary marker");
  }
  return {
    boundaryMarker: result.boundaryMarker,
    summaryMessages: result.summaryMessages ?? [],
    attachments: result.attachments ?? [],
    ...(result.messagesToKeep !== undefined
      ? { messagesToKeep: result.messagesToKeep }
      : {}),
    ...(result.userDisplayMessage !== undefined
      ? { userDisplayMessage: result.userDisplayMessage }
      : {}),
    ...(result.preCompactTokenCount !== undefined
      ? { preCompactTokenCount: result.preCompactTokenCount }
      : {}),
    ...(result.postCompactTokenCount !== undefined
      ? { postCompactTokenCount: result.postCompactTokenCount }
      : {}),
    ...(result.truePostCompactTokenCount !== undefined
      ? { truePostCompactTokenCount: result.truePostCompactTokenCount }
      : {}),
    ...(result.transaction !== undefined
      ? { transaction: result.transaction }
      : {}),
  };
}

function compactionNotRun(
  consecutiveFailures?: number,
  skippedReason?: string,
): AgenCAutoCompactResult {
  return {
    wasCompacted: false,
    ...(consecutiveFailures !== undefined ? { consecutiveFailures } : {}),
    ...(skippedReason !== undefined ? { skippedReason } : {}),
  };
}

function getAutoCompactTokenLimit(ctx: TurnContext): number | undefined {
  if (!isAutoCompactEnabledForNotices()) return undefined;

  const explicit = finitePositive(
    (ctx.modelInfo as unknown as { autoCompactTokenLimit?: number })
      .autoCompactTokenLimit,
  );
  if (explicit !== undefined) return explicit;

  const effectiveWindow = finitePositive(modelContextWindow(ctx));
  if (effectiveWindow === undefined) return undefined;
  return Math.max(
    1,
    effectiveWindow > AUTOCOMPACT_NOTICE_BUFFER_TOKENS
      ? effectiveWindow - AUTOCOMPACT_NOTICE_BUFFER_TOKENS
      : effectiveWindow,
  );
}

function messageHasImageContent(message: LLMMessage | undefined): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.some(
    (part) => part.type === "image_url" && part.image_url.url.trim().length > 0,
  );
}

function isAutoCompactEnabledForNotices(): boolean {
  const raw = getSelectedProviderEnvironment().AGENC_DISABLE_AUTO_COMPACT;
  if (raw === undefined) return true;
  return !TRUTHY_ENV.has(raw.trim().toLowerCase());
}

// ─────────────────────────────────────────────────────────────────────
// agenc runtime port: compaction helpers
// ─────────────────────────────────────────────────────────────────────

/** Reason passed to runAutoCompact. Port of agenc runtime `CompactionReason`. */
export type CompactionReason =
  "context_limit" | "model_downshift" | "manual" | "reactive_recovery";

/** Phase passed to runAutoCompact. Port of agenc runtime `CompactionPhase`. */
export type CompactionPhase = "pre_turn" | "in_turn" | "post_turn";

/** Whether to inject the initial context on post-compact. Port of
 *  agenc runtime `InitialContextInjection`. */
export type InitialContextInjection =
  "before_last_user_message" | "do_not_inject";

interface RunAutoCompactOptions {
  readonly propagateErrors?: boolean;
  readonly querySource?: string;
  /**
   * How many leading `state.messages` the durable rollout already holds.
   * An in-turn compaction may only offer those to the transaction: it maps
   * every offered message onto canonical active history, and an assistant
   * message that has just asked for tools is not canonical yet. Whatever
   * lies past the count is dropped with the rest of the pre-compaction
   * history; the loop re-samples from the replacement, as it always did.
   * Absent, the whole history is offered (pre-turn compaction).
   */
  readonly durableMessageCount?: number;
  /**
   * Called after a compaction replaced the history, with its new length,
   * so the caller can move its persist cursor: everything in the
   * replacement is canonical already and must not be written again.
   */
  readonly onDurableHistoryReplaced?: (durableCount: number) => void;
}

/**
 * Structural shape of the resolved AgenC auto-compact export.
 * Kept loose so tests can inject a compact dispatcher without depending
 * on the full provider request graph.
 */
export interface AutoCompactResult {
  readonly wasCompacted: boolean;
  readonly compactionResult?: AgenCAutoCompactResult["compactionResult"];
  readonly consecutiveFailures?: number;
  readonly skippedReason?: string;
}
export type AutoCompactImpl = (
  ...args: unknown[]
) => Promise<AutoCompactResult>;

// Test-only override — when set, `runAutoCompact` calls this instead of
// the normal compact pipeline. Lets unit tests assert the dispatcher was
// reached with the expected arguments without spinning up the full
// AgenC compact subsystem. Clear via
// `setAutoCompactImplForTests(null)` between tests.
type AutoCompactImplOverrideGlobal = typeof globalThis & {
  __agencRunTurnAutoCompactImplOverride?: AutoCompactImpl | null;
};

function autoCompactImplOverrideGlobal(): AutoCompactImplOverrideGlobal {
  return globalThis as AutoCompactImplOverrideGlobal;
}

function getAutoCompactImplOverride(): AutoCompactImpl | null {
  return (
    autoCompactImplOverrideGlobal().__agencRunTurnAutoCompactImplOverride ??
    null
  );
}

export function setAutoCompactImplForTests(impl: AutoCompactImpl | null): void {
  autoCompactImplOverrideGlobal().__agencRunTurnAutoCompactImplOverride = impl;
}

/**
 * Port of agenc runtime `run_auto_compact` (turn.rs:790-818). Dispatcher that
 * picks between inline and remote compact task based on provider info.
 * AgenC routes the inline path through the turn-owned compact pipeline.
 *
 * Behavior:
 *   - Resolves the compact implementation or test override.
 *   - Calls the compact pipeline with the session's current messages plus
 *     per-turn context. Threshold/circuit-breaker logic lives inside
 *     AgenC; the dispatcher only handles state splicing and telemetry.
 *   - When `state` is provided and compaction ran, splices the post-
 *     compact messages back into `state.messages` / `state.messagesForQuery`
 *     and stamps `state.autoCompactTracking` so the next phase sees the
 *     compacted view. (agenc runtime's pre-sampling compact runs before the
 *     first phase iteration; mutating state here is how we guarantee
 *     `prepareContext` reads the compacted view.)
 *   - Never swallows errors silently: emits `warning:auto_compact_failed`,
 *     then either returns false or rethrows for fail-closed callers.
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
  options: RunAutoCompactOptions = {},
): Promise<boolean> {
  // Editor interactions are one scoped model request over an immutable buffer
  // snapshot. Auto-compaction can read session memory, launch a second model
  // request, and durably rewrite the shared conversation before that request;
  // none of those Agent-side effects belong inside the Editor trust boundary.
  // Keep the guard at the common dispatcher so pre-turn, model-downshift,
  // mid-turn, and post-tool compaction all fail closed together.
  if (ctx.editorInteraction !== undefined) return false;

  // The compaction source is the durable history, never the query
  // projection. `messagesForQuery` is what the model sees: attachments are
  // inserted at its head, oversized tool results are swapped for pointers,
  // old ones are microcompacted. None of that exists in the canonical
  // rollout, and the durable transaction maps every offered message onto
  // canonical active history, so a source drawn from the projection failed
  // that mapping on every mid-turn attempt (observed live: a 1252-byte
  // attachment at position 1 that the rollout never stored). Offer the
  // persisted prefix of `state.messages` instead, minus the runtime-only
  // messages the rollout skips.
  const history = state?.messages ?? [];
  const durableCount = Math.max(
    0,
    Math.min(options.durableMessageCount ?? history.length, history.length),
  );
  const messages = history
    .slice(0, durableCount)
    .filter((message) => !excludeFromDurableHistory(message));
  const shouldKeepUnsentImageTurn =
    phase === "pre_turn" &&
    state !== undefined &&
    state.messagesForQuery.length === 0 &&
    messageHasImageContent(state.messages.at(-1));
  const querySource =
    reason === "model_downshift"
      ? "model_downshift"
      : sessionQuerySourceForTurn(session, options.querySource);
  const force = shouldForceAutoCompact(reason, phase);
  let committedAttemptId: string | undefined;
  try {
    const autoCompactImplOverride = getAutoCompactImplOverride();
    const result = autoCompactImplOverride
      ? await autoCompactImplOverride(
          messages,
          { session, ctx, querySource },
          state?.autoCompactTracking,
          state?.snipTokensFreed ?? 0,
          initialContextInjection,
          { force },
        )
      : await runAgenCAutoCompact({
          session,
          ctx,
          state,
          messages,
          querySource,
          reason,
          phase,
          initialContextInjection,
          force,
        });

    if (result.wasCompacted && state) {
      if (!result.compactionResult) {
        throw new Error(
          "autoCompactIfNeeded reported success without a compactionResult",
        );
      }
      const cr = result.compactionResult;
      committedAttemptId = cr.transaction?.attempt_id;
      const compactedRollout = buildAgenCCompactedRolloutItem(cr);
      // Honor the rollout-persistence suspension invariant. Every other
      // durable write in the turn engine is gated on this flag
      // (session.emit at session.ts, persistTurnRolloutBaseline /
      // persistNewResponseItems below). When a forked / background-agent
      // turn runs on the source session under
      // withRolloutPersistenceSuspended(), an auto-compact crossing the
      // token threshold MUST NOT leak the fork's `compacted`
      // replacementHistory into the source session's durable rollout —
      // doing so makes the fork's summarized history the baseline on a
      // later --resume and silently destroys the user's real conversation.
      if (
        cr &&
        cr.transaction === undefined &&
        !session.isRolloutPersistenceSuspended?.() &&
        session.rolloutStore !== null &&
        session.rolloutStore !== undefined
      ) {
        session.rolloutStore.appendRollout(
          { type: "compacted", payload: compactedRollout },
          { durable: true },
        );
      }
      const compacted =
        cr.transaction === undefined
          ? buildAgenCPostCompactMessages(compactedRollout)
          : cr.transaction.committed.replacement_history.map((message) =>
              responseItemToLlmMessage(message),
            );
      const unsentImageTurn =
        cr.transaction === undefined && shouldKeepUnsentImageTurn
          ? state.messages.at(-1)
          : undefined;
      const applyProjection = (): void => {
        // Replace both the full history view and the per-iteration
        // projection so `prepareContext` (next phase) sees the same
        // post-compact replacement history the rollout recorded.
        state.messages = unsentImageTurn
          ? [...compacted, { ...unsentImageTurn }]
          : compacted;
        state.messagesForQuery = [...compacted];
        if (unsentImageTurn) {
          state.messagesForQuery.push({ ...unsentImageTurn });
        }
        options.onDurableHistoryReplaced?.(compacted.length);
        // Stamp auto-compact tracking so the commit phase emits the
        // boundary marker (runtime/src/phases/commit.ts).
        state.autoCompactTracking = {
          compacted: true,
          turnId: `auto-${reason}-${phase}-${Date.now().toString(36)}`,
          turnCounter: 0,
          consecutiveFailures: 0,
        };
      };
      if (cr.transaction !== undefined) {
        const rolloutStore = session.rolloutStore;
        if (rolloutStore === null || rolloutStore === undefined) {
          throw new Error("transactional compaction lost its rollout owner");
        }
        const attemptId = cr.transaction.attempt_id;
        const cleanup = (): void => cleanupSessionAfterCompaction(session);
        try {
          await finalizeCompactionTransaction({
            store: rolloutStore,
            attemptId,
            applyProjection,
            cleanup,
          });
        } catch (error) {
          if (error instanceof CompactionCleanupPendingError) {
            session.registerCompactionCleanupRetry(attemptId, cleanup);
          }
          throw error;
        }
      } else {
        applyProjection();
        cleanupSessionAfterCompaction(session);
      }
      return true;
    }

    if (result.consecutiveFailures !== undefined && state) {
      const previousTracking = state.autoCompactTracking;
      state.autoCompactTracking = {
        compacted: previousTracking?.compacted ?? false,
        turnId:
          previousTracking?.turnId ??
          `auto-${reason}-${phase}-${Date.now().toString(36)}`,
        turnCounter: previousTracking?.turnCounter ?? 0,
        consecutiveFailures: result.consecutiveFailures,
      };
    }

    /*
     * A dispatcher that ran and declined still owes an explanation. Its
     * failure path catches the error, counts a strike and answers with a
     * bare "did not compact", so the turn loop could only report
     * `mid_turn_compact_skipped` — the reason was computed and then
     * dropped, leaving a turn that ended mid-plan with nothing to act on.
     */
    if (result.wasCompacted !== true && result.skippedReason !== undefined) {
      session.emit({
        id: session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "auto_compact_failed",
            message: `${reason}/${phase}: ${result.skippedReason}`,
          },
        },
      });
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
    if (
      committedAttemptId !== undefined ||
      error instanceof CompactionReconstructionRequiredError ||
      options.propagateErrors === true
    ) {
      throw error;
    }
    return false;
  }
}

function cleanupSessionAfterCompaction(session: Session): void {
  // Compaction dropped every recalled memory along with the history it was
  // attached to, so the cumulative recall budget starts over.
  resetRelevantMemoryBudget(session);
  const direct = session as unknown as {
    readonly readFileState?: { clear(): void };
    readonly clearSearchIndexes?: () => void;
    readonly clearToolIndexes?: () => void;
  };
  const state = session.state.unsafePeek() as unknown as {
    readonly readFileState?: { clear(): void };
  };
  runPostCompactCleanup({
    clearReadFileState: () =>
      (direct.readFileState ?? state.readFileState)?.clear(),
    clearProviderResponseId: () => session.clearProviderResponseId(),
    clearSearchIndexes: direct.clearSearchIndexes,
    clearToolIndexes: direct.clearToolIndexes,
    resetMicrocompactState,
  });
}

function shouldForceAutoCompact(
  reason: CompactionReason,
  phase: CompactionPhase,
): boolean {
  return reason === "context_limit" && phase === "in_turn";
}

/**
 * Port of agenc runtime `maybe_run_previous_model_inline_compact` (turn.rs:749-788).
 * When the user switches to a model with a smaller context window and
 * total token usage reaches the new auto-compact limit, compact
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
  // A1 fix: agenc runtime resolves the previous model's TurnContext via
  // `turn_context.with_model(previous_turn_settings.model, models_manager)`
  // and reads its context_window. AgenC has no models_manager yet, so
  // we accept an optional pre-resolved `contextWindow` (and/or
  // `modelInfo`) carried alongside `previousTurnSettings.model`. The
  // new context window always comes from the CURRENT turn's
  // `ctx.modelInfo`, not from the previous turn. This makes the
  // model-downshift branch reachable instead of comparing
  // `oldContextWindow > oldContextWindow`, which can never be true.
  const previousTurnSettings = (
    session.state as unknown as {
      unsafePeek?: () => {
        previousTurnSettings?: {
          model: string;
          contextWindow?: number;
          modelInfo?: Partial<ModelInfo> & {
            contextWindow?: number;
            effectiveContextWindowPercent?: number;
            autoCompactTokenLimit?: number;
          };
        };
      };
    }
  ).unsafePeek?.()?.previousTurnSettings;
  if (!previousTurnSettings) return false;
  const previousModel =
    typeof previousTurnSettings.model === "string" &&
    previousTurnSettings.model.length > 0
      ? previousTurnSettings.model
      : undefined;
  if (previousModel === undefined) return false;

  const newContextWindow = modelContextWindow(ctx);
  const oldContextWindow =
    effectivePreviousModelContextWindow(previousTurnSettings);
  if (oldContextWindow === undefined || newContextWindow === undefined) {
    return false;
  }
  const totalUsageTokens = _totalUsageTokens;
  const newAutoCompactLimit = getPreSamplingAutoCompactTokenLimit(ctx);
  const previousModelLimitReached =
    (newAutoCompactLimit !== undefined &&
      totalUsageTokens > newAutoCompactLimit) ||
    totalUsageTokens >= newContextWindow;
  const shouldRun =
    previousModelLimitReached &&
    previousModel !== ctx.modelInfo.slug &&
    oldContextWindow > newContextWindow;
  if (!shouldRun) return false;

  const previousModelContext = turnContextForPreviousModel(
    ctx,
    previousTurnSettings,
    previousModel,
  );
  return await runAutoCompact(
    session,
    previousModelContext,
    "do_not_inject",
    "model_downshift",
    "pre_turn",
    state,
    { propagateErrors: true },
  );
}

function turnContextForPreviousModel(
  ctx: TurnContext,
  previousTurnSettings: {
    readonly model: string;
    readonly contextWindow?: number;
    readonly modelInfo?: Partial<ModelInfo> & {
      readonly contextWindow?: number;
      readonly effectiveContextWindowPercent?: number;
      readonly autoCompactTokenLimit?: number;
    };
  },
  previousModel: string,
): TurnContext {
  const previousModelInfo = {
    ...(ctx.modelInfo as unknown as Record<string, unknown>),
    ...((previousTurnSettings.modelInfo ?? {}) as Record<string, unknown>),
    slug: previousModel,
    ...(previousTurnSettings.contextWindow !== undefined
      ? { contextWindow: previousTurnSettings.contextWindow }
      : {}),
  } as unknown as TurnContext["modelInfo"];
  return {
    ...ctx,
    modelInfo: previousModelInfo,
    collaborationMode: {
      ...ctx.collaborationMode,
      model: previousModel,
    },
  };
}

function effectivePreviousModelContextWindow(previousTurnSettings: {
  readonly contextWindow?: number;
  readonly modelInfo?: Partial<ModelInfo> & {
    readonly contextWindow?: number;
    readonly effectiveContextWindowPercent?: number;
  };
}): number | undefined {
  const contextWindow = finitePositive(
    previousTurnSettings.contextWindow ??
      previousTurnSettings.modelInfo?.contextWindow,
  );
  if (contextWindow === undefined) return undefined;
  const percent =
    finitePositive(
      previousTurnSettings.modelInfo?.effectiveContextWindowPercent,
    ) ?? 100;
  return Math.floor((contextWindow * percent) / 100);
}

/**
 * Port of agenc runtime `run_pre_sampling_compact` (turn.rs:712-741). Runs
 * (a) previous-model inline compact on model downshift and
 * (b) auto-compact when total-usage-tokens reaches the current
 * model's auto-compact limit.
 *
 * Returns true when any compaction ran.
 */
async function runPreSamplingCompact(
  session: Session,
  ctx: TurnContext,
  querySource: string,
  state?: TurnState,
): Promise<boolean> {
  const activeContextTokensBefore = getActiveContextTokenUsage(
    session,
    ctx,
    state,
  );
  let preSamplingCompacted = await maybeRunPreviousModelInlineCompact(
    session,
    ctx,
    activeContextTokensBefore,
    state,
  );
  const autoCompactLimit = getPreSamplingAutoCompactTokenLimit(ctx);
  if (
    autoCompactLimit !== undefined &&
    activeContextTokensBefore >= autoCompactLimit
  ) {
    const contextLimitCompacted = await runAutoCompact(
      session,
      ctx,
      "do_not_inject",
      "context_limit",
      "pre_turn",
      state,
      { propagateErrors: true, querySource },
    );
    preSamplingCompacted = preSamplingCompacted || contextLimitCompacted;
  }
  return preSamplingCompacted;
}

function getActiveContextTokenUsage(
  session: Session,
  ctx: TurnContext,
  state?: TurnState,
): number {
  if (state === undefined) {
    return getTotalTokenUsage(session);
  }
  const messages =
    state.messagesForQuery.length > 0 ? state.messagesForQuery : state.messages;
  if (messages.length === 0) return getTotalTokenUsage(session);
  // Pre-sampling compaction runs before query preparation, so
  // `messagesForQuery` may still be empty. Build a read-only projection with
  // the seed history in that slot, then use the same request constructor as
  // provider dispatch. This keeps durable system history, current
  // instructions, deferred-tool filtering, tool choice, context limits, and
  // output reservations aligned with the request admission will authorize.
  const accountingState =
    state.messagesForQuery.length > 0
      ? state
      : { ...state, messagesForQuery: [...messages] };
  const request = buildSamplingRequestContract(accountingState, session, ctx);
  return estimateMessagesTokens(toAgenCRuntimeMessages(request.input), {
    provider: ctx.provider ?? session.services.provider,
    options: {
      mainLoopModel: ctx.modelInfo.slug,
      ...(request.contextWindowTokens !== undefined
        ? { contextWindowTokens: request.contextWindowTokens }
        : {}),
      ...(request.maxOutputTokens !== undefined
        ? { maxOutputTokens: request.maxOutputTokens }
        : {}),
      ...(request.baseInstructions.length > 0
        ? { systemPrompt: request.baseInstructions }
        : {}),
      tools: request.tools,
      ...(request.toolChoice !== undefined
        ? { toolChoice: request.toolChoice }
        : {}),
    },
  });
}

function getPreSamplingAutoCompactTokenLimit(
  ctx: TurnContext,
): number | undefined {
  if (!isAutoCompactEnabledForNotices()) return undefined;
  const explicit = finitePositive(
    (ctx.modelInfo as unknown as { autoCompactTokenLimit?: number })
      .autoCompactTokenLimit,
  );
  if (explicit !== undefined) return explicit;
  const contextWindowTokens = finitePositive(modelContextWindow(ctx));
  if (contextWindowTokens === undefined) return undefined;
  return getAutoCompactThreshold({
    options: {
      mainLoopModel: ctx.modelInfo.slug,
      contextWindowTokens,
    },
  });
}

function getTotalTokenUsage(session: Session): number {
  const peek = (
    session.state as unknown as {
      unsafePeek?: () => {
        totalTokenUsage?: number | { totalTokens?: number };
      };
    }
  ).unsafePeek?.();
  const field = peek?.totalTokenUsage;
  if (typeof field === "number") return Number.isFinite(field) ? field : 0;
  const totalTokens = field?.totalTokens;
  return typeof totalTokens === "number" && Number.isFinite(totalTokens)
    ? totalTokens
    : 0;
}

// Shared with run-turn.ts and its sibling modules.
export {
  getAutoCompactTokenLimit,
  runAutoCompact,
  runPreSamplingCompact,
  getActiveContextTokenUsage,
  getPreSamplingAutoCompactTokenLimit,
};
