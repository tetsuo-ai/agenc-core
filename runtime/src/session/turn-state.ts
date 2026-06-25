/**
 * TurnState — mutable working set carried across phase-machine iterations.
 *
 * Hand-port of agenc `src/query.ts`'s `State` type (query.ts:203) plus
 * the 22 loop-local variables the body destructures/re-assigns each iteration
 * (query.ts:315-339). Every field below cites its exact AgenC source
 * line per `docs/plan/translation-conventions.md` "full-port with citations".
 * Cross-subsystem fields are bound to the concrete in-tree contracts that
 * currently own those runtime surfaces.
 *
 * Invariants covered here (as data fields; wiring lands in the named
 * tranche):
 *   I-17 (stop-hook blocking cap — `stopHookBlockingCount`, wired in T8)
 *   I-22 (token-budget continuation — `taskBudgetRemaining` + `pendingBudgetDecision`)
 *   I-30 (per-turn config snapshot — `configSnapshot`, frozen at builder time)
 *   I-42 (recovery re-entry cap — `recoveryReentryCount`, wired in T8)
 *
 * @module
 */

import type { LLMMessage, LLMToolCall, LLMUsage } from "../llm/types.js";
import type { TokenBudgetDecision as BoundaryTokenBudgetDecision } from "../conversation/token-budget.js";
import type { StreamingToolExecutor } from "../tools/streaming-executor.js";
import type { TurnContext } from "./turn-context.js";
import {
  provisionContentReplacementState,
  type ContentReplacementState,
} from "./_deps/tool-result-storage.js";
import type {
  ProgressTrip,
  StepRecord,
} from "./behavioral-backstop.js";

/**
 * Continue — the 8 recovery re-entry reasons captured at each
 * AgenC query.ts continue site. Used on `TurnState.transition`
 * so the phase machine can route correctly on the next iteration
 * and so tests can assert which recovery path fired without peeking
 * at message contents. Mirrors agenc `Continue` from
 * `src/query/transitions.ts` (source exists in upstream head; cited
 * as per transition literal sites in query.ts).
 *
 * Sites (AgenC query.ts line → reason):
 *   981  → collapse_drain_retry (implied by context-collapse retry)
 *   1142 → collapse_drain_retry
 *   1195 → reactive_compact_retry
 *   1251 → max_output_tokens_escalate
 *   1281 → max_output_tokens_recovery
 *   1338 → stop_hook_blocking
 *   1375 → token_budget_continuation
 *   1457 → continuation_nudge
 * Plus agenc runtime model-fallback site → model_fallback.
 *
 * T8 disambiguation:
 *   - `model_fallback` is reserved for `onFallbackError` (FallbackTriggeredError
 *     from the provider/retry layer — primary model swapped for fallback).
 *   - `streaming_fallback_retry` is set by `onStreamingFallback` when the
 *     streaming adapter reports a mid-stream fallback that needs a tombstone
 *     + executor recreate without a cross-model swap. Downstream telemetry
 *     can now distinguish the two recovery causes.
 */
export type ContinueReason =
  | "model_fallback"
  | "streaming_fallback_retry"
  | "collapse_drain_retry"
  | "reactive_compact_retry"
  | "max_output_tokens_escalate"
  | "max_output_tokens_recovery"
  | "stop_hook_blocking"
  | "token_budget_continuation"
  | "plan_tool_required"
  | "continuation_nudge";

export interface Continue {
  readonly reason: ContinueReason;
}

/**
 * Terminal — why the run-turn generator returned. Mirrors agenc
 * query.ts terminal reasons: 'completed', 'blocking_limit',
 * 'prompt_too_long', 'image_error', 'model_error', 'aborted_streaming',
 * 'stop_hook_prevented', 'aborted_tools', 'hook_stopped', 'max_turns'.
 */
export type TerminalReason =
  | "completed"
  | "blocking_limit"
  | "prompt_too_long"
  | "image_error"
  | "model_error"
  | "aborted_streaming"
  | "aborted_tools"
  | "stop_hook_prevented"
  | "hook_stopped"
  | "max_turns"
  | "cancelled"
  | "no_progress"; // behavioral backstop (semantic non-termination, goal #3)

export interface Terminal {
  readonly reason: TerminalReason;
  readonly error?: unknown;
}

// ─────────────────────────────────────────────────────────────────────
// Turn-local contracts.
// These aliases describe the runtime objects carried between phases.
// Concrete behavior is owned by the imported subsystem modules.
// ─────────────────────────────────────────────────────────────────────

/**
 * agenc `AutoCompactTrackingState` from the compaction pipeline.
 * Structural shape documented here; runtime matches the AgenC compact
 * adapter schema.
 */
export interface AutoCompactTrackingState {
  readonly compacted: boolean;
  readonly turnId: string;
  readonly turnCounter: number;
  readonly consecutiveFailures: number;
}

/**
 * agenc `ToolUseSummaryMessage` (services/tools/StreamingToolExecutor).
 * Awaited before the next phase iteration.
 */
export type ToolUseSummaryMessage = {
  readonly type: "tool_use_summary";
  readonly uuid: string;
  readonly content: string;
};

/**
 * Memory prefetch handle owned by `utils/attachments.ts`.
 * Uses `using` / Symbol.dispose semantics at the session level.
 */
export interface MemoryPrefetch {
  readonly promise: Promise<unknown>;
  readonly settledAt: number | null;
  readonly consumedOnIteration: number;
  [Symbol.dispose](): void;
}

/**
 * Skill discovery prefetch handle. The live skill-search module is loaded
 * lazily from the upstream-compatible attachment path; this captures the
 * disposable contract carried by `TurnState`.
 */
export interface SkillPrefetch {
  readonly promise?: Promise<unknown>;
  readonly settledAt: number | null;
  readonly consumedOnIteration?: number;
  [Symbol.dispose](): void;
}

/**
 * Single assistant message (one model turn's output). Structurally:
 * role="assistant" `LLMMessage` plus parsed tool-use blocks.
 */
export interface AssistantMessage {
  readonly uuid: string;
  readonly role: "assistant";
  readonly text?: string;
  readonly toolCalls: readonly LLMToolCall[];
  /** Populated when the stream terminated with a provider-reported error. */
  readonly apiError?: string;
}

/**
 * Single tool-result user message. AgenC query.ts:562 collects these
 * alongside AttachmentMessage into `toolResults`.
 */
export interface UserMessage {
  readonly uuid: string;
  readonly role: "user";
  readonly content: string | LLMMessage["content"];
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface CompletedToolResultRecord {
  readonly callId: string;
  readonly toolName: string;
  readonly arguments: string;
  readonly content: string;
  readonly isError: boolean;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Single attachment-injection message (skills, memory, system reminders,
 * etc.). Appears in `toolResults` to be sent with the next request.
 */
export interface AttachmentMessage {
  readonly uuid: string;
  readonly role: "user";
  readonly kind: "attachment";
  readonly content: string | LLMMessage["content"];
}

/**
 * Parsed tool-use block extracted from an assistant message. Exists as a
 * separate type on TurnState because AgenC uses non-empty `toolUseBlocks`
 * as the sole loop-exit signal (stop_reason is unreliable). See
 * query.ts:564-567.
 */
export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Turn-state view of a token-budget continuation decision (I-22).
 * `conversation/token-budget.ts` owns the boundary decision; the phase ladder carries
 * a compact `kind/reason` envelope so recovery can inject the continuation
 * nudge without depending on the tracker instance.
 */
export type TokenBudgetDecision =
  | {
      readonly kind: "continue";
      readonly remaining: number;
      readonly boundary?: BoundaryTokenBudgetDecision;
    }
  | {
      readonly kind: "stop";
      readonly reason: string;
      readonly boundary?: BoundaryTokenBudgetDecision;
    };

// ─────────────────────────────────────────────────────────────────────
// TurnState — the mutable working set carried across phase iterations.
// ─────────────────────────────────────────────────────────────────────

/**
 * TurnState carries mutable cross-iteration data for the phase machine.
 *
 * Field groups follow AgenC query.ts:
 *   - Phase 1 (prepareContext): input messages, compact tracking, budget
 *   - Phase 2 (streamModel):    captured assistant output + tool-use blocks
 *   - Phase 3 (postSampleRecovery): recovery counters, token overrides
 *   - Phase 4 (continuationNudge):  nudge accumulator
 *   - Phase 5 (executeTools): streaming executor, pending summaries
 *   - Phase 6 (commit): turnCount, continue-site transition
 *
 * All fields mutate in place during a turn. The phase machine contract
 * is: phases take `(state, ctx, session, signal)` and return a
 * mutated-or-replaced TurnState. See `docs/plan/architecture.md` §Phase
 * Machine for the pure-phase-function invariant (I-89, proposed).
 *
 * Field-name mapping to agenc `query.ts:315` destructure:
 *   toolUseContext    → handled via TurnContext + streamingToolExecutor
 *   tracking          → autoCompactTracking (renamed for clarity)
 *   (all other 20 names map 1:1 — see AgenC-inventory.md §1)
 */
export interface TurnState {
  // ── Phase 1 — prepare context (AgenC query.ts:268-459) ───────
  /** Full conversation history including user + assistant + tool turns.
   *  AgenC query.ts:272 (State.messages).
   *  Updated at commit phase (AgenC query.ts:1192) with new
   *  assistant message + tool results. */
  messages: LLMMessage[];

  /** Post-compact/post-snip/post-microcompact projection of `messages`
   *  used for the actual model request. Rebuilt each iteration from
   *  `getMessagesAfterCompactBoundary(messages)` then mutated by
   *  compaction pipeline. AgenC query.ts:369. */
  messagesForQuery: LLMMessage[];

  /** Auto-compact tracking (turn counter since last compact, consecutive
   *  failure count for circuit breaker). AgenC query.ts:371, 531.
   *  Reset on every successful compact so `turnsSincePreviousCompact`
   *  reflects the most recent compaction event. */
  autoCompactTracking: AutoCompactTrackingState | undefined;

  /** task_budget.remaining tracking across compaction boundaries.
   *  Undefined until first compact fires. AgenC query.ts:295, 521.
   *  Cumulative: each compaction subtracts the final context at that
   *  compact's trigger point. */
  taskBudgetRemaining: number | undefined;

  /** Tokens freed by the HISTORY_SNIP pass this iteration. Plumbed to
   *  autocompact threshold check so it reflects post-snip size.
   *  AgenC query.ts:410. */
  snipTokensFreed: number;

  /** Memory prefetch handle started once per turn (query.ts:305).
   *  Awaited in executeTools phase; `using`-managed for disposal on
   *  all exit paths. */
  pendingMemoryPrefetch: MemoryPrefetch | undefined;

  /** Skill discovery prefetch (query.ts:335) — per-iteration, replaces
   *  the blocking assistant_turn path in getAttachmentMessages. Awaited
   *  post-tools. */
  pendingSkillPrefetch: SkillPrefetch | undefined;

  /** Content-replacement state for per-message tool-result budget
   *  enforcement. AgenC query.ts:383-404. */
  contentReplacementState: ContentReplacementState | undefined;

  // ── Phase 2 — stream model (AgenC query.ts:561-1082) ─────────
  /** Assistant messages produced this iteration (typically one, but
   *  recovery paths can emit multiples). AgenC query.ts:561. */
  assistantMessages: AssistantMessage[];

  /** Tool-use blocks parsed from the assistant stream. Non-empty value
   *  is the sole reliable loop-continue signal — `stop_reason`
   *  ('tool_use' etc.) is unreliable. AgenC query.ts:564-567. */
  toolUseBlocks: ToolUseBlock[];

  /** Set true during streaming when a tool_use block arrives; false
   *  after streaming means we're done (modulo stop-hook retry).
   *  AgenC query.ts:568. */
  needsFollowUp: boolean;

  /** Tool results (user messages) + attachment messages to send with
   *  the next request. AgenC query.ts:562. */
  toolResults: Array<UserMessage | AttachmentMessage>;

  /**
   * Runtime-only completed tool ledger for the current user turn. Unlike
   * `toolResults`, this preserves dispatch success/error metadata so
   * observers that run after tool execution can distinguish attempted
   * writes from successful writes without sending that metadata to the model.
   */
  completedToolResults: CompletedToolResultRecord[];

  // ── Phase 3 — post-sample recovery (AgenC query.ts:1082-1299) ─
  /** Whether reactive compact has already fired this turn. Prevents
   *  infinite compact-retry loop when context stays over threshold.
   *  AgenC query.ts:1189. Wired in T8. */
  hasAttemptedReactiveCompact: boolean;

  /** One-shot override for maxOutputTokens on next request (used by
   *  recovery escalation). AgenC query.ts:1246. */
  maxOutputTokensOverride: number | undefined;

  /** Carry fire-and-forget fork cache-write suppression into provider options. */
  skipCacheWrite: boolean | undefined;

  /** Consecutive max-output-tokens recovery attempts. Cap at
   *  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3 (query.ts:162) before giving
   *  up. AgenC query.ts:1273. */
  maxOutputTokensRecoveryCount: number;

  /** Count of recovery re-entries this turn. Enforces I-42 (recovery
   *  re-entry cap). Wired in T8 — incremented at each recovery
   *  continue site, checked before re-entering stream. */
  recoveryReentryCount: number;

  // ── Phase 4 — continuation nudge (AgenC query.ts:1300-1465) ──
  /** Consecutive continuation-nudge count. Cap at MAX_CONTINUATION_NUDGES=3
   *  (query.ts:163) to prevent infinite nudge loops when the model
   *  matches continuation signals without emitting tool calls.
   *  AgenC query.ts:1456. */
  continuationNudgeCount: number;

  // ── Phase 5 — execute tools (AgenC query.ts:572, 1467-1635) ──
  /** Streaming tool executor instance (T7). Kept loop-local so the
   *  next iteration can await pending executor completion before
   *  re-entering streamModel. AgenC query.ts:572. */
  streamingToolExecutor: StreamingToolExecutor | null;

  /** Pending tool-use summary promise — resolved before next iteration
   *  can proceed. AgenC query.ts:1577. */
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined;

  /** Tool hook requested keeping the completed result while ending the turn. */
  preventContinuation: boolean;

  /** Cached token-budget decision captured mid-stream (I-22). Acted on
   *  in commit phase to decide continuation vs terminate. */
  pendingBudgetDecision: TokenBudgetDecision | undefined;

  /** Provider-reported usage from the most recent streamModel call.
   *  Threaded into SamplingRequestResult.usage so the outer runTurn
   *  loop can accumulate real token consumption for downstream
   *  auto-compact + budget decisions. Cleared at iteration start by
   *  resetIterationFields. */
  lastResponseUsage: LLMUsage | undefined;

  // ── Phase 6 — commit (AgenC query.ts:1192-1465) ──────────────
  /** Number of model turns consumed this session. Compared against
   *  `ctx.configSnapshot.maxTurns` for I-7 terminal abort.
   *  AgenC query.ts:279. */
  turnCount: number;

  // ── Recovery transition (I-7 + I-42 + I-17) ───────────────────────
  /** Why the previous iteration continued. Undefined on first
   *  iteration. Lets tests assert recovery paths fired without
   *  inspecting message contents. AgenC query.ts:1140, 219. */
  transition: Continue | undefined;

  /** Stop-hook "blocking" state from prior iteration. Whether the
   *  most recent stop-hook returned a blocking result that should
   *  suppress the next continuation attempt. AgenC query.ts:211. */
  stopHookActive: boolean | undefined;

  /** Consecutive stop-hook blocking iterations. Enforces I-17
   *  (stop-hook blocking cap). Wired in T8; incremented each time a
   *  stop hook returns blocking, reset on success. */
  stopHookBlockingCount: number;

  /** Plan-mode guard retries after a provider ignores the tool-only
   *  contract and returns plain assistant text. */
  planToolRequiredRetryCount: number;

  // ── Behavioral backstop (semantic non-termination, goal #3) ───────
  // Turn-scoped, NOT iteration-scoped: like `turnCount`, these persist
  // across recovery/continuation iterations and are NOT cleared in
  // `resetIterationFields`. Initialized once in `buildInitialTurnState`.
  /** Bounded ring of recent step fingerprints (sig + resultHash). */
  behavioralStepHistory: StepRecord[];
  /** Consecutive low-information-gain steps. */
  behavioralLowGainStreak: number;
  /** One-shot soft-nudge latch (Wink >=3 course-correction reminder). */
  behavioralNudgeIssued: boolean;
  /** Novelty tracking — tool names seen this turn. */
  behavioralSeenToolNames: Set<string>;
  /** Tier-2 observer inbox (optional, polled never awaited). */
  behavioralObserverTrip?: ProgressTrip;
}

// I-30 (per-turn config snapshot) lives on `TurnContext.configSnapshot`
// (see session/turn-context.ts). Phases read the frozen config from
// `ctx.configSnapshot`, never from `session.state` directly. TurnState
// does not duplicate the snapshot — there is exactly one immutable
// snapshot per turn, on the TurnContext, mirroring agenc runtime's pattern.

// ─────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────

/**
 * Initial-state builder. Mirrors agenc query.ts:268-283 (the
 * `let state: State = {...}` block). Taking the TurnContext + seed
 * user message (serialized into a single LLMMessage) is sufficient
 * because all counters start at 0 and all tracking/override fields
 * are `undefined` until their recovery path first fires.
 *
 * Caller must pre-construct `userMessage` as the seed LLMMessage
 * (role "user", content block array). run-turn.ts constructs this
 * from the raw user input string before calling into the phase
 * machine.
 */
export function buildInitialTurnState(
  _ctx: TurnContext,
  userMessage: LLMMessage,
  opts?: {
    readonly priorMessages?: readonly LLMMessage[];
    readonly initialMaxOutputTokensOverride?: number;
    readonly initialSkipCacheWrite?: boolean;
  },
): TurnState {
  return {
    // Phase 1
    messages: [...(opts?.priorMessages ?? []), userMessage],
    messagesForQuery: [],
    autoCompactTracking: undefined,
    taskBudgetRemaining: undefined,
    snipTokensFreed: 0,
    pendingMemoryPrefetch: undefined,
    pendingSkillPrefetch: undefined,
    contentReplacementState: provisionContentReplacementState(
      opts?.priorMessages as never,
    ),
    // Phase 2
    assistantMessages: [],
    toolUseBlocks: [],
    needsFollowUp: false,
    toolResults: [],
    completedToolResults: [],
    // Phase 3
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: opts?.initialMaxOutputTokensOverride,
    skipCacheWrite: opts?.initialSkipCacheWrite,
    maxOutputTokensRecoveryCount: 0,
    recoveryReentryCount: 0,
    // Phase 4
    continuationNudgeCount: 0,
    // Phase 5
    streamingToolExecutor: null,
    pendingToolUseSummary: undefined,
    preventContinuation: false,
    pendingBudgetDecision: undefined,
    lastResponseUsage: undefined,
    // Phase 6
    turnCount: 1,
    // Recovery transition
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
    planToolRequiredRetryCount: 0,
    // Behavioral backstop (goal #3) — turn-scoped accumulators.
    behavioralStepHistory: [],
    behavioralLowGainStreak: 0,
    behavioralNudgeIssued: false,
    behavioralSeenToolNames: new Set(),
    behavioralObserverTrip: undefined,
  };
}

/**
 * Phase entry helper: reset iteration-scoped fields that must not
 * carry into the next iteration. Called by run-turn.ts at the top of
 * every phase loop iteration after a continue-site returned. Keeps
 * the cross-iteration bookkeeping (turnCount, compact tracking,
 * nudge counts) intact while clearing per-iteration accumulators.
 *
 * Matches AgenC's implicit re-allocation of `assistantMessages`,
 * `toolUseBlocks`, `toolResults`, `needsFollowUp` at query.ts:561-568
 * on every iteration.
 */
export function resetIterationFields(state: TurnState): void {
  state.assistantMessages = [];
  state.toolUseBlocks = [];
  state.toolResults = [];
  state.needsFollowUp = false;
  state.preventContinuation = false;
  state.snipTokensFreed = 0;
  state.pendingBudgetDecision = undefined;
  state.lastResponseUsage = undefined;
  // pendingToolUseSummary + streamingToolExecutor intentionally NOT
  // cleared here — they are awaited in executeTools and cleared by
  // commit phase after their resolution.
  //
  // behavioral* fields are also intentionally NOT cleared — they are
  // turn-scoped (like `turnCount`), not iteration-scoped. Clearing them
  // here would reset the no-progress detector every iteration and defeat
  // the whole backstop. (Asserted by the run-turn progress test suite.)
}
