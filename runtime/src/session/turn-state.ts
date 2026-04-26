/**
 * TurnState — mutable working set carried across phase-machine iterations.
 *
 * Hand-port of openclaude `src/query.ts`'s `State` type (query.ts:203) plus
 * the 22 loop-local variables the body destructures/re-assigns each iteration
 * (query.ts:315-339). Every field below cites its exact openclaude source
 * line per `docs/plan/translation-conventions.md` "full-port with citations"
 * rule. Forward-dep types (StreamingToolExecutor, MemoryPrefetch, etc.)
 * whose real implementations land in T7/T8/T10 get placeholder `unknown`
 * typings with named-tranche TODOs.
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
import type { TurnContext } from "./turn-context.js";
import { provisionContentReplacementState } from "./_deps/tool-result-storage.js";

/**
 * Continue — the 8 recovery re-entry reasons captured at each
 * openclaude query.ts continue site. Used on `TurnState.transition`
 * so the phase machine can route correctly on the next iteration
 * and so tests can assert which recovery path fired without peeking
 * at message contents. Mirrors openclaude `Continue` from
 * `src/query/transitions.ts` (source exists in upstream head; cited
 * as per transition literal sites in query.ts).
 *
 * Sites (openclaude query.ts line → reason):
 *   981  → collapse_drain_retry (implied by context-collapse retry)
 *   1142 → collapse_drain_retry
 *   1195 → reactive_compact_retry
 *   1251 → max_output_tokens_escalate
 *   1281 → max_output_tokens_recovery
 *   1338 → stop_hook_blocking
 *   1375 → token_budget_continuation
 *   1457 → continuation_nudge
 * Plus codex model-fallback site → model_fallback.
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
 * Terminal — why the run-turn generator returned. Mirrors openclaude
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
  | "cancelled";

export interface Terminal {
  readonly reason: TerminalReason;
  readonly error?: unknown;
}

// ─────────────────────────────────────────────────────────────────────
// Forward-dep placeholder types. Real impls land in the named tranche;
// we use `unknown` (with a narrow structural alias) instead of the real
// type so TS typechecks without pulling in deps that aren't ported yet.
// ─────────────────────────────────────────────────────────────────────

/**
 * openclaude `AutoCompactTrackingState` from the compaction pipeline.
 * Real import lands when `src/llm/compact/**` is lifted from tsconfig
 * exclude (T5b/T6). Structural shape documented here; runtime matches
 * codex/openclaude schema.
 */
export interface AutoCompactTrackingState {
  readonly compacted: boolean;
  readonly turnId: string;
  readonly turnCounter: number;
  readonly consecutiveFailures: number;
}

/**
 * openclaude `ToolUseSummaryMessage` (services/tools/StreamingToolExecutor).
 * T7 wires real type. Used as a pending promise whose resolution is
 * awaited before the next phase iteration.
 */
export type ToolUseSummaryMessage = {
  readonly type: "tool_use_summary";
  readonly uuid: string;
  readonly content: string;
};

/**
 * openclaude `StreamingToolExecutor` instance. T7 wires real class.
 * Held loop-local so the next iteration can await pending executor
 * completion before re-entering streamModel.
 */
export type StreamingToolExecutor = unknown;

/**
 * Memory prefetch handle. T10 (memory subsystem) wires real impl.
 * Uses `using` / Symbol.dispose semantics at the session level.
 */
export interface MemoryPrefetch {
  readonly settledAt?: number;
  [Symbol.dispose]?: () => void;
}

/**
 * Skill prefetch handle. T10 (skills) wires real impl. Consumed
 * post-tools alongside the memory prefetch.
 */
export interface SkillPrefetch {
  readonly settledAt?: number;
  [Symbol.dispose]?: () => void;
}

/**
 * Content-replacement state (tool-result budget enforcement). Real
 * impl in `utils/toolResultStorage.ts` (openclaude). T7 wires real
 * type; carried on TurnState so iteration-to-iteration sees persisted
 * replacements.
 */
export interface ContentReplacementState {
  readonly replacements: Map<string, unknown>;
}

/**
 * Single assistant message (one model turn's output). T7 wires real
 * shape from provider adapter. Structurally: role="assistant" LLMMessage
 * plus parsed tool-use blocks.
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
 * Single tool-result user message. T7 wires real shape. openclaude
 * query.ts:562 collects these alongside AttachmentMessage into
 * `toolResults`.
 */
export interface UserMessage {
  readonly uuid: string;
  readonly role: "user";
  readonly content: string | LLMMessage["content"];
  readonly toolCallId?: string;
  readonly toolName?: string;
}

/**
 * Single attachment-injection message (skills, memory, system
 * reminders, etc.). T10 wires real shape. Appears in `toolResults`
 * to be sent with the next request.
 */
export interface AttachmentMessage {
  readonly uuid: string;
  readonly role: "user";
  readonly kind: "attachment";
  readonly content: string | LLMMessage["content"];
}

/**
 * Parsed tool-use block extracted from an assistant message. T7 wires
 * real shape. Exists as a separate type on TurnState because openclaude
 * uses non-empty `toolUseBlocks` as the sole loop-exit signal (stop_reason
 * is unreliable). See query.ts:564-567.
 */
export interface ToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/**
 * Token-budget decision for mid-stream continuation (I-22).
 * T8 wires real implementation. Pending decision is captured during
 * stream phase and acted on at continuation-nudge.
 */
export type TokenBudgetDecision =
  | { readonly kind: "continue"; readonly remaining: number }
  | { readonly kind: "stop"; readonly reason: string };

// ─────────────────────────────────────────────────────────────────────
// TurnState — the mutable working set carried across phase iterations.
// ─────────────────────────────────────────────────────────────────────

/**
 * TurnState carries mutable cross-iteration data for the phase machine.
 *
 * Field groups follow openclaude query.ts:
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
 * Field-name mapping to openclaude `query.ts:315` destructure:
 *   toolUseContext    → handled via TurnContext + streamingToolExecutor
 *   tracking          → autoCompactTracking (renamed for clarity)
 *   (all other 20 names map 1:1 — see openclaude-inventory.md §1)
 */
export interface TurnState {
  // ── Phase 1 — prepare context (openclaude query.ts:268-459) ───────
  /** Full conversation history including user + assistant + tool turns.
   *  openclaude query.ts:272 (State.messages).
   *  Updated at commit phase (openclaude query.ts:1192) with new
   *  assistant message + tool results. */
  messages: LLMMessage[];

  /** Post-compact/post-snip/post-microcompact projection of `messages`
   *  used for the actual model request. Rebuilt each iteration from
   *  `getMessagesAfterCompactBoundary(messages)` then mutated by
   *  compaction pipeline. openclaude query.ts:369. */
  messagesForQuery: LLMMessage[];

  /** Auto-compact tracking (turn counter since last compact, consecutive
   *  failure count for circuit breaker). openclaude query.ts:371, 531.
   *  Reset on every successful compact so `turnsSincePreviousCompact`
   *  reflects the most recent compaction event. */
  autoCompactTracking: AutoCompactTrackingState | undefined;

  /** task_budget.remaining tracking across compaction boundaries.
   *  Undefined until first compact fires. openclaude query.ts:295, 521.
   *  Cumulative: each compaction subtracts the final context at that
   *  compact's trigger point. */
  taskBudgetRemaining: number | undefined;

  /** Tokens freed by the HISTORY_SNIP pass this iteration. Plumbed to
   *  autocompact threshold check so it reflects post-snip size.
   *  openclaude query.ts:410. */
  snipTokensFreed: number;

  /** Memory prefetch handle started once per turn (query.ts:305).
   *  Awaited in executeTools phase; `using`-managed for disposal on
   *  all exit paths. T10 wires real impl. */
  pendingMemoryPrefetch: MemoryPrefetch | undefined;

  /** Skill discovery prefetch (query.ts:335) — per-iteration, replaces
   *  the blocking assistant_turn path in getAttachmentMessages. Awaited
   *  post-tools. T10 wires real impl. */
  pendingSkillPrefetch: SkillPrefetch | undefined;

  /** Content-replacement state for per-message tool-result budget
   *  enforcement. openclaude query.ts:383-404. T7 wires real type. */
  contentReplacementState: ContentReplacementState | undefined;

  // ── Phase 2 — stream model (openclaude query.ts:561-1082) ─────────
  /** Assistant messages produced this iteration (typically one, but
   *  recovery paths can emit multiples). openclaude query.ts:561. */
  assistantMessages: AssistantMessage[];

  /** Tool-use blocks parsed from the assistant stream. Non-empty value
   *  is the sole reliable loop-continue signal — `stop_reason`
   *  ('tool_use' etc.) is unreliable. openclaude query.ts:564-567. */
  toolUseBlocks: ToolUseBlock[];

  /** Set true during streaming when a tool_use block arrives; false
   *  after streaming means we're done (modulo stop-hook retry).
   *  openclaude query.ts:568. */
  needsFollowUp: boolean;

  /** Tool results (user messages) + attachment messages to send with
   *  the next request. openclaude query.ts:562. */
  toolResults: Array<UserMessage | AttachmentMessage>;

  // ── Phase 3 — post-sample recovery (openclaude query.ts:1082-1299) ─
  /** Whether reactive compact has already fired this turn. Prevents
   *  infinite compact-retry loop when context stays over threshold.
   *  openclaude query.ts:1189. Wired in T8. */
  hasAttemptedReactiveCompact: boolean;

  /** One-shot override for maxOutputTokens on next request (used by
   *  recovery escalation). openclaude query.ts:1246. */
  maxOutputTokensOverride: number | undefined;

  /** Consecutive max-output-tokens recovery attempts. Cap at
   *  MAX_OUTPUT_TOKENS_RECOVERY_LIMIT=3 (query.ts:162) before giving
   *  up. openclaude query.ts:1273. */
  maxOutputTokensRecoveryCount: number;

  /** Count of recovery re-entries this turn. Enforces I-42 (recovery
   *  re-entry cap). Wired in T8 — incremented at each recovery
   *  continue site, checked before re-entering stream. */
  recoveryReentryCount: number;

  // ── Phase 4 — continuation nudge (openclaude query.ts:1300-1465) ──
  /** Consecutive continuation-nudge count. Cap at MAX_CONTINUATION_NUDGES=3
   *  (query.ts:163) to prevent infinite nudge loops when the model
   *  matches continuation signals without emitting tool calls.
   *  openclaude query.ts:1456. */
  continuationNudgeCount: number;

  // ── Phase 5 — execute tools (openclaude query.ts:572, 1467-1635) ──
  /** Streaming tool executor instance (T7). Kept loop-local so the
   *  next iteration can await pending executor completion before
   *  re-entering streamModel. openclaude query.ts:572. */
  streamingToolExecutor: StreamingToolExecutor | null;

  /** Pending tool-use summary promise — resolved before next iteration
   *  can proceed. openclaude query.ts:1577. */
  pendingToolUseSummary: Promise<ToolUseSummaryMessage | null> | undefined;

  /** Cached token-budget decision captured mid-stream (I-22). Acted on
   *  in commit phase to decide continuation vs terminate. */
  pendingBudgetDecision: TokenBudgetDecision | undefined;

  /** Provider-reported usage from the most recent streamModel call.
   *  Threaded into SamplingRequestResult.usage so the outer runTurn
   *  loop can accumulate real token consumption for downstream
   *  auto-compact + budget decisions. Cleared at iteration start by
   *  resetIterationFields. */
  lastResponseUsage: LLMUsage | undefined;

  // ── Phase 6 — commit (openclaude query.ts:1192-1465) ──────────────
  /** Number of model turns consumed this session. Compared against
   *  `ctx.configSnapshot.maxTurns` for I-7 terminal abort.
   *  openclaude query.ts:279. */
  turnCount: number;

  // ── Recovery transition (I-7 + I-42 + I-17) ───────────────────────
  /** Why the previous iteration continued. Undefined on first
   *  iteration. Lets tests assert recovery paths fired without
   *  inspecting message contents. openclaude query.ts:1140, 219. */
  transition: Continue | undefined;

  /** Stop-hook "blocking" state from prior iteration. Whether the
   *  most recent stop-hook returned a blocking result that should
   *  suppress the next continuation attempt. openclaude query.ts:211. */
  stopHookActive: boolean | undefined;

  /** Consecutive stop-hook blocking iterations. Enforces I-17
   *  (stop-hook blocking cap). Wired in T8; incremented each time a
   *  stop hook returns blocking, reset on success. */
  stopHookBlockingCount: number;

  /** Plan-mode guard retries after a provider ignores the tool-only
   *  contract and returns plain assistant text. */
  planToolRequiredRetryCount: number;
}

// I-30 (per-turn config snapshot) lives on `TurnContext.configSnapshot`
// (see session/turn-context.ts). Phases read the frozen config from
// `ctx.configSnapshot`, never from `session.state` directly. TurnState
// does not duplicate the snapshot — there is exactly one immutable
// snapshot per turn, on the TurnContext, mirroring codex's pattern.

// ─────────────────────────────────────────────────────────────────────
// Builder
// ─────────────────────────────────────────────────────────────────────

/**
 * Initial-state builder. Mirrors openclaude query.ts:268-283 (the
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
    // Phase 3
    hasAttemptedReactiveCompact: false,
    maxOutputTokensOverride: opts?.initialMaxOutputTokensOverride,
    maxOutputTokensRecoveryCount: 0,
    recoveryReentryCount: 0,
    // Phase 4
    continuationNudgeCount: 0,
    // Phase 5
    streamingToolExecutor: null,
    pendingToolUseSummary: undefined,
    pendingBudgetDecision: undefined,
    lastResponseUsage: undefined,
    // Phase 6
    turnCount: 1,
    // Recovery transition
    transition: undefined,
    stopHookActive: undefined,
    stopHookBlockingCount: 0,
    planToolRequiredRetryCount: 0,
  };
}

/**
 * Phase entry helper: reset iteration-scoped fields that must not
 * carry into the next iteration. Called by run-turn.ts at the top of
 * every phase loop iteration after a continue-site returned. Keeps
 * the cross-iteration bookkeeping (turnCount, compact tracking,
 * nudge counts) intact while clearing per-iteration accumulators.
 *
 * Matches openclaude's implicit re-allocation of `assistantMessages`,
 * `toolUseBlocks`, `toolResults`, `needsFollowUp` at query.ts:561-568
 * on every iteration.
 */
export function resetIterationFields(state: TurnState): void {
  state.assistantMessages = [];
  state.toolUseBlocks = [];
  state.toolResults = [];
  state.needsFollowUp = false;
  state.snipTokensFreed = 0;
  state.pendingBudgetDecision = undefined;
  state.lastResponseUsage = undefined;
  // pendingToolUseSummary + streamingToolExecutor intentionally NOT
  // cleared here — they are awaited in executeTools and cleared by
  // commit phase after their resolution.
}
