/**
 * Streaming event vocabulary for the async-generator executor
 * (Phase D of the 16-phase refactor in TODO.MD).
 *
 * These types define the shape of events that `executeChat()`
 * (Phase C) will yield out of its loop. Phase D lands the vocabulary
 * and a legacy-callback bridge; no production code consumes these
 * types yet. Phase C wires them into the new async-generator entry
 * point, and Phase E migrates the 10 production callers to
 * `for await (const event of executeChat(...))`.
 *
 * The shapes mirror `/home/tetsuo/git/claude_code/types/message.ts`
 * with AgenC-specific extensions (trace correlation, compaction
 * boundary reasons, subagent lineage) inlined where they diverge.
 *
 * @module
 */

import type {
  LLMMessage,
  LLMToolCall,
  LLMUsage,
} from "./types.js";
import type { LLMPipelineStopReason } from "./policy.js";
import type {
  ChatExecutorResult,
  ToolCallRecord,
} from "./chat-executor-types.js";

/**
 * Emitted at the top of every provider call iteration, before the
 * compaction chain runs and before the request is serialized to the
 * provider. Carries the unique request ID assigned to this iteration
 * and the 0-based turn index within the current `executeChat()`
 * invocation.
 */
export interface RequestStartEvent {
  readonly type: "request_start";
  readonly requestId: string;
  readonly turnIndex: number;
  readonly timestamp: number;
}

/**
 * Incremental stream chunk from the provider. Produced as the
 * provider streams assistant content and/or tool-call deltas. `done`
 * flips to `true` on the final chunk of a single provider call.
 * Re-emits the AgenC `LLMStreamChunk` shape so the legacy callback
 * bridge can pass chunks straight through without repacking.
 */
export interface StreamEvent {
  readonly type: "stream_chunk";
  readonly requestId: string;
  readonly content: string;
  readonly toolCalls?: readonly LLMToolCall[];
  readonly done: boolean;
}

/**
 * Emitted once per assistant message produced by the provider.
 * Carries the full finalized content, any tool calls, usage stats,
 * and the stop reason for this provider call (not the overall
 * terminal — that's the generator's return value).
 */
export interface AssistantMessage {
  readonly type: "assistant";
  readonly uuid: string;
  readonly content: string | readonly LLMMessageContentPart[];
  readonly toolCalls?: readonly LLMToolCall[];
  readonly usage?: LLMUsage;
  readonly stopReason?: LLMPipelineStopReason;
}

/**
 * A narrow type for content parts. Re-exported for consumers that
 * don't want to import `LLMMessage` directly.
 */
export type LLMMessageContentPart = Exclude<
  LLMMessage["content"],
  string
>[number];

/**
 * Emitted after a single tool call completes. Includes the
 * tool_call_id (used by the provider to correlate back to the
 * originating assistant message), the stringified tool result, an
 * error flag, and the dispatch duration in milliseconds.
 */
export interface ToolResultMessage {
  readonly type: "tool_result";
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly isError: boolean;
  readonly durationMs: number;
}

/**
 * Emitted by the per-iteration compaction chain when a layer fires.
 * The `reason` distinguishes which layer produced the tombstone,
 * `tokensFreed` reports the approximate token savings, and
 * `markedAt` is the wall-clock timestamp in ms. This is the
 * Phase D equivalent of the `compaction_triggered` trace event
 * wired in Phase A — callers can consume either the trace event
 * (synchronous) or this yield (generator-style) depending on their
 * migration status.
 */
export interface TombstoneMessage {
  readonly type: "tombstone";
  readonly reason:
    | "snip"
    | "microcompact"
    | "autocompact"
    | "reactive_compact";
  readonly tokensFreed: number;
  readonly markedAt: number;
  readonly boundary?: string;
}

/**
 * Emitted after a subagent (Phase K) finishes. Carries the set of
 * tool_call_ids the subagent invoked and a terse summary of what it
 * accomplished. Used by the parent stream to show a collapsed
 * "subagent completed" card rather than relaying every child event.
 */
export interface ToolUseSummaryMessage {
  readonly type: "tool_use_summary";
  readonly toolCallIds: readonly string[];
  readonly summary: string;
  readonly sessionId: string;
}

/**
 * The return value of the `executeChat()` async generator. Carries
 * the final reason the loop exited, the accumulated final content,
 * every tool call that ran, aggregated token usage, wall-clock
 * duration, and (on error paths) the originating Error.
 *
 * Consumers that haven't migrated to the generator yet can
 * reconstruct the legacy `ChatExecutorResult` shape from a Terminal
 * plus the yielded events via `buildChatExecutorResultFromEvents()`.
 */
export interface Terminal {
  readonly reason:
    | "stop_reason_end_turn"
    | "max_turns_reached"
    | "max_tool_rounds_exceeded"
    | "token_budget_exceeded"
    | "user_abort"
    | "provider_fallback_exhausted"
    | "recovery_exhausted"
    | "context_compaction_failed";
  readonly finalContent: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly tokenUsage: LLMUsage;
  readonly durationMs: number;
  readonly error?: Error;
  /**
   * Phase E transitional carry-through: the full `ChatExecutorResult`
   * produced by the underlying class-based `execute()` call. Present
   * only while Phase C's `executeChat()` is an adapter that delegates
   * to the class. Callers that migrated in Phase E can read
   * `terminal.legacyResult` to preserve field reads like
   * `toolRoutingSummary`, `plannerSummary`, `statefulSummary` that
   * are not carried on the event-derived shape.
   *
   * Phase F deletes the adapter and this field goes away — the
   * generator will own those fields directly via new event types
   * or extended Terminal fields at that point.
   */
  readonly legacyResult?: ChatExecutorResult;
}

/**
 * The yield-type union for `executeChat()`. Phase C's generator
 * yields any of these values per iteration step, then returns a
 * `Terminal` when the loop exits.
 */
export type ExecuteChatYield =
  | RequestStartEvent
  | StreamEvent
  | AssistantMessage
  | ToolResultMessage
  | TombstoneMessage
  | ToolUseSummaryMessage;
