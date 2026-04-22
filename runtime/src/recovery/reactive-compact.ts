/**
 * Reactive compaction — the second-level PTL recovery step.
 *
 * Hand-port of openclaude's reactive compact caller surface
 * caller surface (the module itself is feature-gated behind
 * `REACTIVE_COMPACT`; T8 ships the caller contract). When collapse-
 * drain can't release enough context (or isn't enabled), reactive-
 * compact summarizes older messages in-place by invoking the full
 * `compactConversation` pipeline and retries the request.
 *
 * The post-sample-recovery phase calls into this module after the
 * withhold-cascading gate routes the PTL message here. On success,
 * the state's `messagesForQuery` is replaced + the run-turn loop
 * transitions to `reactive_compact_retry`.
 *
 * Invariants covered:
 *   I-2  (previous_response_id cleared on any compaction) — cleanup
 *        is routed through `runPostCompactCleanup` with a session-
 *        backed context that carries `clearProviderResponseId`, and
 *        a `context_compacted` event is emitted via `session.emit()`
 *        so the session-level listener also clears the live
 *        `ProviderHttpClient.responsesContinuationState`.
 *   I-18 (compaction shrink assertion) — delegated to the underlying
 *        compact pipeline (compact.ts throws `CompactionShrinkRatioError`;
 *        the circuit breaker increments in autoCompactIfNeeded).
 *   I-40 (reactive-compact throw guard) — `tryReactiveCompact` can
 *        throw; we wrap in try/catch, emit `warning:'reactive_compact_threw'`,
 *        treat as failed outcome, increment circuit-breaker.
 *
 * Critical subtlety: `hasAttemptedReactiveCompact` is **preserved**
 * on stop-hook-blocking transitions (openclaude query.ts:1332 —
 * "Resetting caused infinite loop"). It's reset only on
 * token-budget-continuation (1369).
 *
 * @module
 */

import { emitWarning } from "../session/event-log.js";
import type { LLMMessage } from "../llm/types.js";
import type { Session } from "../session/session.js";
import type { AssistantMessage, TurnState } from "../session/turn-state.js";
import { runPostCompactCleanup } from "../llm/compact/post-compact-cleanup.js";
import type { CompactionResult } from "../llm/compact/compact.js";
import type { CompactRuntimeContext } from "../session/compact-runtime-context.js";
import { finalContextTokensFromLastResponse } from "../utils/tokens.js";
import {
  isMediaTooLargeMessage,
  isPromptTooLongMessage,
} from "./api-errors.js";

/**
 * Lazily import the compact pipeline so tests and bundlers that don't
 * drag in the full `compactConversation` graph (and its heavy
 * transitive dependencies like `utils/sessionStorage` → `axios`) still
 * load `reactive-compact.ts` cleanly. Mirrors openclaude's
 * feature-flagged `require('./services/compact/reactiveCompact.js')`
 * pattern.
 */
async function loadCompactPipeline(): Promise<
  typeof import("../llm/compact/compact.js")
> {
  return await import("../llm/compact/compact.js");
}

async function loadCompactContext(): Promise<
  typeof import("../session/compact-runtime-context.js")
> {
  return await import("../session/compact-runtime-context.js");
}

// ─────────────────────────────────────────────────────────────────────
// Driver surface — openclaude reactiveCompact.js or a future port
// ─────────────────────────────────────────────────────────────────────

export interface ReactiveCompactResult {
  readonly compactedMessages: ReadonlyArray<LLMMessage>;
  /** Summary of what was compacted (rollout stamping). */
  readonly summary?: string;
  /** Token count before / after — for I-18 shrink assertion. */
  readonly preCompactTokens?: number;
  readonly postCompactTokens?: number;
  /**
   * Present when the driver ran the real `compactConversation`
   * pipeline. `runReactiveCompact` uses this to stamp the rollout
   * and to build a faithful session-backed cleanup context that
   * matches what auto-compact/manual-compact pass into
   * `runPostCompactCleanup`.
   */
  readonly compactionResult?: CompactionResult;
}

export interface ReactiveCompactDriver {
  isReactiveCompactEnabled(): boolean;
  isWithheldPromptTooLong(msg: AssistantMessage): boolean;
  isWithheldMediaSizeError(msg: AssistantMessage): boolean;
  tryReactiveCompact(input: {
    readonly hasAttempted: boolean;
    readonly messages: ReadonlyArray<LLMMessage>;
    readonly lastMessage: AssistantMessage;
    readonly session: Session;
    readonly state: TurnState;
  }): Promise<ReactiveCompactResult | null>;
}

type SessionWithRecoveryServices = Session & {
  readonly services?: {
    readonly querySource?: string;
    readonly reactiveCompact?: ReactiveCompactDriver;
  };
};

function readRecoveryQuerySource(session: Session): string | undefined {
  return (session as SessionWithRecoveryServices).services?.querySource;
}

function estimateMessageTokens(message: LLMMessage): number {
  // Include a per-message envelope cost so short synthetic messages
  // still model provider-side role/content overhead realistically.
  let tokens = 6;
  const content = message.content;
  if (typeof content === "string") {
    tokens += Math.max(1, Math.ceil(content.length / 4));
  } else if (Array.isArray(content)) {
    for (const part of content) {
      if (part.type === "text") {
        tokens += Math.max(1, Math.ceil(part.text.length / 4));
      } else if (part.type === "image_url") {
        // Placeholder image cost for shrink estimation.
        tokens += 512;
      }
    }
  }
  if (message.toolCalls) {
    for (const call of message.toolCalls) {
      tokens += Math.max(1, Math.ceil((call.name.length + call.arguments.length) / 4));
    }
  }
  if (message.toolCallId) {
    tokens += Math.max(1, Math.ceil(message.toolCallId.length / 4));
  }
  if (message.toolName) {
    tokens += Math.max(1, Math.ceil(message.toolName.length / 4));
  }
  return tokens;
}

function estimateHistoryTokens(
  messages: ReadonlyArray<LLMMessage | Record<string, unknown>>,
): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message as LLMMessage);
  }
  return total;
}

function resolveReactiveCompactDriver(
  session: Session,
  explicitDriver?: ReactiveCompactDriver,
): ReactiveCompactDriver {
  if (explicitDriver) {
    return explicitDriver;
  }
  return (
    (session as SessionWithRecoveryServices).services?.reactiveCompact ??
    DEFAULT_REACTIVE_COMPACT_DRIVER
  );
}

/**
 * Build the session-backed compact runtime context used both as
 * the input to `compactConversation` and as the cleanup context
 * threaded into `runPostCompactCleanup`. Returns `null` when the
 * session cannot produce a workable context (e.g. stripped-down
 * stub sessions in tests); callers should fall back to the
 * minimal cleanup path in that case.
 */
async function tryBuildCompactRuntimeContext(
  session: Session,
): Promise<CompactRuntimeContext | null> {
  try {
    const { createSessionBackedCompactContext } = await loadCompactContext();
    return createSessionBackedCompactContext(session, {
      querySource: readRecoveryQuerySource(session) ?? "compact",
      isNonInteractiveSession: true,
      verbose: false,
    });
  } catch {
    return null;
  }
}

/**
 * Default driver: invokes the full `compactConversation` pipeline
 * the same way `autoCompactIfNeeded` does. This is a parity port
 * of openclaude's feature-gated reactive-compact path. The driver
 * builds a session-backed `CompactRuntimeContext`, runs the real
 * compaction, and exposes the resulting `CompactionResult` back to
 * `runReactiveCompact` so the caller can finalize cleanup + event
 * emission under I-2.
 */
export const DEFAULT_REACTIVE_COMPACT_DRIVER: ReactiveCompactDriver = Object.freeze({
  isReactiveCompactEnabled: () => true,
  isWithheldPromptTooLong: (msg: AssistantMessage) => isPromptTooLongMessage(msg),
  isWithheldMediaSizeError: (msg: AssistantMessage) => isMediaTooLargeMessage(msg),
  async tryReactiveCompact(input: {
    readonly hasAttempted: boolean;
    readonly messages: ReadonlyArray<LLMMessage>;
    readonly lastMessage: AssistantMessage;
    readonly session: Session;
    readonly state: TurnState;
  }): Promise<ReactiveCompactResult | null> {
    if (input.messages.length === 0) {
      return null;
    }
    const context = await tryBuildCompactRuntimeContext(input.session);
    if (!context) {
      return null;
    }
    const [compactPipeline, compactContextModule] = await Promise.all([
      loadCompactPipeline(),
      loadCompactContext(),
    ]);
    const { compactConversation, buildPostCompactMessages } = compactPipeline;
    const { buildCompactCacheSafeParams } = compactContextModule;
    const forkContextMessages = [...input.messages] as unknown as Parameters<
      typeof buildCompactCacheSafeParams
    >[1];
    const cacheSafeParams = await buildCompactCacheSafeParams(
      context,
      forkContextMessages,
    );
    const preCompactTokens = estimateHistoryTokens(input.messages);
    const compactionResult = await compactConversation(
      input.messages as unknown as Parameters<typeof compactConversation>[0],
      context,
      cacheSafeParams,
      /* suppressFollowUpQuestions */ true,
      /* customInstructions */ undefined,
      /* isAutoCompact */ true,
    );
    const compactedMessages = buildPostCompactMessages(
      compactionResult,
    ) as unknown as LLMMessage[];
    const postCompactTokens =
      compactionResult.truePostCompactTokenCount ??
      compactionResult.postCompactTokenCount ??
      estimateHistoryTokens(compactedMessages);
    return {
      compactedMessages,
      summary: compactionResult.userDisplayMessage,
      preCompactTokens:
        compactionResult.preCompactTokenCount ?? preCompactTokens,
      postCompactTokens,
      compactionResult,
    };
  },
});

// ─────────────────────────────────────────────────────────────────────
// runReactiveCompact — orchestrator with I-2 cleanup + I-40 throw guard
// ─────────────────────────────────────────────────────────────────────

export type ReactiveCompactOutcome =
  | { readonly kind: "compacted"; readonly result: ReactiveCompactResult }
  | { readonly kind: "noop"; readonly reason: string }
  | { readonly kind: "threw"; readonly error: unknown }
  | { readonly kind: "disabled" };

export interface RunReactiveCompactOpts {
  readonly session: Session;
  readonly state: TurnState;
  readonly lastMessage: AssistantMessage;
  readonly driver?: ReactiveCompactDriver;
  readonly taskBudgetTotal?: number;
}

type SessionWithEmit = Session & {
  readonly emit?: (event: {
    readonly id: string;
    readonly msg: {
      readonly type: string;
      readonly payload?: Record<string, unknown>;
    };
  }) => void;
  readonly clearProviderResponseId?: () => void;
};

function tryEmitContextCompacted(
  session: Session,
  summary: string | undefined,
): void {
  const s = session as SessionWithEmit;
  if (typeof s.emit !== "function") {
    // Stub session (no session-level listener). The explicit cleanup
    // context passed to runPostCompactCleanup above already cleared
    // the active ProviderHttpClient state; nothing more to do.
    return;
  }
  try {
    s.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "context_compacted",
        payload: {
          summary: summary ?? "reactive compact",
        },
      },
    });
  } catch {
    // Emitting is best-effort; the cleanup context call above is the
    // deterministic I-2 guarantee. Swallow emit failures so the
    // retry path can continue.
  }
}

function buildCleanupContext(
  session: Session,
): Pick<CompactRuntimeContext, "clearProviderResponseId"> {
  const s = session as SessionWithEmit;
  return {
    clearProviderResponseId: () => {
      if (typeof s.clearProviderResponseId === "function") {
        s.clearProviderResponseId();
      }
    },
  };
}

function emitThreadRolledBack(
  session: Session,
  numTurns: number,
): void {
  const event = {
    id: session.nextInternalSubId(),
    msg: {
      type: "thread_rolled_back",
      payload: {
        numTurns,
        reason: "reactive_compact",
      },
    },
  } as const;
  const s = session as SessionWithEmit;
  if (typeof s.emit === "function") {
    s.emit(event);
    return;
  }
  session.eventLog.emit(event);
}

function countUserTurnBoundaries(messages: ReadonlyArray<LLMMessage>): number {
  let count = 0;
  for (const message of messages) {
    if (message.role !== "user") continue;
    const content = message.content;
    if (typeof content !== "string") {
      count += 1;
      continue;
    }
    if (
      content.includes("<environment_context>") ||
      content.includes("<reference_context_item>")
    ) {
      continue;
    }
    count += 1;
  }
  return count;
}

/**
 * Run the reactive-compact step. I-40: wraps `tryReactiveCompact`
 * in try/catch; on throw emits `warning:'reactive_compact_threw'`,
 * increments the compaction circuit-breaker counter on state, and
 * returns `threw`. On success, mutates `state.messages` /
 * `state.messagesForQuery` + sets transition =
 * 'reactive_compact_retry'.
 *
 * I-2: runs `runPostCompactCleanup` synchronously with a session-
 * backed context that carries `clearProviderResponseId`, and emits
 * `context_compacted` via `session.emit()` so the session-level
 * listener also clears the live `ProviderHttpClient`
 * `responsesContinuationState`. Openclaude doesn't have this
 * concern because its ccrClient doesn't use `previous_response_id`;
 * AgenC does because xAI/OpenAI do.
 */
export async function runReactiveCompact(
  opts: RunReactiveCompactOpts,
): Promise<ReactiveCompactOutcome> {
  const driver = resolveReactiveCompactDriver(opts.session, opts.driver);
  if (!driver.isReactiveCompactEnabled()) {
    return { kind: "disabled" };
  }
  const supportsLastMessage =
    driver.isWithheldPromptTooLong(opts.lastMessage) ||
    driver.isWithheldMediaSizeError(opts.lastMessage);
  if (!supportsLastMessage) {
    return { kind: "noop", reason: "unsupported_last_message" };
  }

  // Skip when we've already tried + the flag is still set.
  // The flag is reset only by token-budget-continuation, preserved
  // across stop-hook-blocking (I-40 subtlety).
  if (state_hasAttemptedReactiveCompact(opts.state)) {
    return { kind: "noop", reason: "already_attempted_this_turn" };
  }

  let result: ReactiveCompactResult | null;
  try {
    result = await driver.tryReactiveCompact({
      hasAttempted: opts.state.hasAttemptedReactiveCompact,
      messages: opts.state.messagesForQuery,
      lastMessage: opts.lastMessage,
      session: opts.session,
      state: opts.state,
    });
    const preCompactTokens =
      result?.preCompactTokens ?? estimateHistoryTokens(opts.state.messagesForQuery);
    const postCompactTokens =
      result?.postCompactTokens ??
      (result ? estimateHistoryTokens(result.compactedMessages) : 0);
    if (
      result &&
      postCompactTokens >= preCompactTokens
    ) {
      throw new Error(
        `I-18 shrink assertion failed: input=${preCompactTokens} output=${postCompactTokens}`,
      );
    }
  } catch (err) {
    // I-40: throw guard. Emit warning, increment circuit-breaker
    // on the turn's autoCompactTracking, return `threw` outcome.
    emitWarning(
      opts.session.eventLog,
      opts.session.nextInternalSubId(),
      "reactive_compact_threw",
      err instanceof Error ? err.message : String(err),
    );
    opts.state.hasAttemptedReactiveCompact = true;
    const tracking = opts.state.autoCompactTracking;
    if (tracking) {
      opts.state.autoCompactTracking = {
        ...tracking,
        consecutiveFailures: (tracking.consecutiveFailures ?? 0) + 1,
      };
    }
    return { kind: "threw", error: err };
  }

  if (!result || result.compactedMessages.length === 0) {
    opts.state.hasAttemptedReactiveCompact = true;
    return { kind: "noop", reason: "driver_returned_null" };
  }

  // Success path — rewire the state and signal the run-turn loop.
  // I-2: clear `previous_response_id` on every compaction cleanup path
  // BEFORE exposing the compacted state back to the recovery ladder or
  // the phase machine. The cleanup context carries a real
  // `clearProviderResponseId` so the live `ProviderHttpClient`
  // `responsesContinuationState.lastResponseId` is cleared synchronously,
  // not just the grok IncrementalTracker registry.
  runPostCompactCleanup(
    readRecoveryQuerySource(opts.session),
    buildCleanupContext(opts.session),
  );

  const preCompactionMessages = [...opts.state.messagesForQuery];
  const compactedMessages = [...result.compactedMessages];
  opts.state.messages = compactedMessages;
  opts.state.messagesForQuery = [...compactedMessages];
  opts.state.hasAttemptedReactiveCompact = true;
  opts.state.autoCompactTracking = undefined;
  opts.state.maxOutputTokensOverride = undefined;
  opts.state.pendingToolUseSummary = undefined;
  opts.state.stopHookActive = undefined;
  opts.state.transition = { reason: "reactive_compact_retry" };
  if (opts.taskBudgetTotal !== undefined) {
    const preCompactContext =
      result.preCompactTokens ??
      finalContextTokensFromLastResponse(preCompactionMessages);
    opts.state.taskBudgetRemaining = Math.max(
      0,
      (opts.state.taskBudgetRemaining ?? opts.taskBudgetTotal) -
        preCompactContext,
    );
  }

  // I-2 belt-and-braces: emit `context_compacted` via session.emit so the
  // session-level listener (session.ts:1218-1223) also calls
  // `clearProviderResponseId`. This mirrors manual-compact's
  // `applyCompactedHistory` pattern.
  tryEmitContextCompacted(opts.session, result.summary);

  // T6 gap #119: emit `thread_rolled_back` here — reactive-compact
  // swaps `messagesForQuery` with a shorter history, which is the
  // closest live semantic to "thread rollback" in the current runtime.
  // T13/T-recovery will add the true rollback-ladder path; when that
  // lands it should emit here too rather than inventing a new variant.
  // Emitting through `session.eventLog` (same pattern used by
  // `emitWarning` a few lines above) keeps the existing `mkSession`
  // fixtures working — they don't need to mock `session.emit`.
  const numTurns = Math.max(
    0,
    countUserTurnBoundaries(preCompactionMessages) -
      countUserTurnBoundaries(compactedMessages),
  );
  emitThreadRolledBack(opts.session, numTurns);
  return { kind: "compacted", result };
}

// ─────────────────────────────────────────────────────────────────────
// hasAttemptedReactiveCompact accessors with preserve/reset semantics
// ─────────────────────────────────────────────────────────────────────

function state_hasAttemptedReactiveCompact(state: TurnState): boolean {
  return state.hasAttemptedReactiveCompact === true;
}

/**
 * Reset helper — openclaude query.ts:1369 token-budget-continuation
 * path. Only this entry clears the flag; stop-hook-blocking
 * (query.ts:1332) must PRESERVE it.
 */
export function resetHasAttemptedReactiveCompact(state: TurnState): void {
  state.hasAttemptedReactiveCompact = false;
}
