/**
 * Tool-protocol mutation helpers extracted from chat-executor-tool-loop.
 *
 * These helpers own the Grok-specific tool-turn state machine:
 * - open a new tool-turn when the model emits tool_use blocks
 * - push tool result messages onto the conversation + ledger, and
 *   record the result against the pending tool-call
 * - note protocol violations / repairs and sync the runtime contract
 *   snapshot
 * - seal pending tool calls at finalization when the model failed to
 *   close the turn cleanly
 * - fail-closed when the provider returns `finish_reason: "tool_calls"`
 *   with no actual tool_use blocks
 *
 * The Grok adapter enforces `tool_calls` messages must precede their
 * matching `tool_result` messages with matching `tool_call_id`, so the
 * runtime tracks this state explicitly and surfaces violations to the
 * trace surface rather than relying on the model to self-correct.
 *
 * @module
 */

import type { LLMToolCall } from "./types.js";
import type { ExecutionContext } from "./chat-executor-types.js";
import type { ToolLoopCallbacks } from "./chat-executor-tool-loop.js";
import { updateRuntimeContractToolProtocolSnapshot } from "../runtime-contract/types.js";
import {
  getPendingToolProtocolCalls,
  hasPendingToolProtocol,
  noteToolProtocolRepair,
  noteToolProtocolViolation,
  openToolProtocolTurn,
  recordToolProtocolResult,
  responseHasMalformedToolFinish,
  responseHasToolCalls,
  type ToolProtocolRepairReason,
} from "./tool-protocol-state.js";
import { sanitizeToolCallsForReplay } from "./chat-executor-text.js";

/**
 * Internal constant for the protocol-repair synthetic error body sent
 * when the runtime closes an unresolved tool call at finalization.
 */
const TOOL_PROTOCOL_REPAIR_ERROR = "tool_protocol_repair";

/**
 * Project the mutable tool-protocol state onto the runtime contract
 * snapshot for tracing + status reporting. Called after every
 * protocol state mutation so consumers of the snapshot see a
 * consistent view.
 */
export function syncToolProtocolSnapshot(ctx: ExecutionContext): void {
  ctx.runtimeContractSnapshot = updateRuntimeContractToolProtocolSnapshot({
    snapshot: ctx.runtimeContractSnapshot,
    open: hasPendingToolProtocol(ctx.toolProtocolState),
    pendingToolCallIds: getPendingToolProtocolCalls(ctx.toolProtocolState).map(
      (toolCall) => toolCall.id,
    ),
    repairCount: ctx.toolProtocolState.repairCount,
    lastRepairReason: ctx.toolProtocolState.lastRepairReason,
    violationCount: ctx.toolProtocolState.violationCount,
    lastViolation: ctx.toolProtocolState.lastViolation,
  });
}

/**
 * Record a tool-protocol violation (e.g. finish_reason: "tool_calls"
 * with no tool_use blocks) and emit a trace event. Safe to call
 * multiple times per turn — each violation increments the counter.
 */
export function emitToolProtocolViolation(
  ctx: ExecutionContext,
  callbacks: ToolLoopCallbacks,
  reason: string,
  payload: Record<string, unknown> = {},
): void {
  noteToolProtocolViolation(ctx.toolProtocolState, reason);
  syncToolProtocolSnapshot(ctx);
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_protocol_violation",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      reason,
      ...payload,
    },
  });
}

/**
 * Append a tool-result message to the conversation history + tool-call
 * ledger, then record the result against the pending tool-call on the
 * protocol state. Emits a trace event documenting the recorded call.
 *
 * `synthetic: true` marks results the runtime fabricated (e.g. a
 * protocol-repair close-out message). `protocolRepairReason` stamps the
 * record for later analysis. `failureBudgetExempt: true` prevents the
 * failure counter from incrementing when this synthetic result is an
 * error (repair-closes shouldn't count against the model's budget).
 */
export function pushToolResultMessage(params: {
  readonly ctx: ExecutionContext;
  readonly callbacks: ToolLoopCallbacks;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly content: string;
  readonly args: Record<string, unknown>;
  readonly isError: boolean;
  readonly durationMs: number;
  readonly synthetic?: boolean;
  readonly protocolRepairReason?: ToolProtocolRepairReason;
  readonly failureBudgetExempt?: boolean;
}): void {
  const {
    ctx,
    callbacks,
    toolCallId,
    toolName,
    content,
    args,
    isError,
    durationMs,
    synthetic,
    protocolRepairReason,
  } = params;
  callbacks.pushMessage(
    ctx,
    {
      role: "tool",
      content,
      toolCallId,
      toolName,
    },
    "tools",
  );
  callbacks.appendToolRecord(ctx, {
    name: toolName,
    args,
    result: content,
    isError,
    durationMs,
    toolCallId,
    ...(synthetic ? { synthetic: true } : {}),
    ...(protocolRepairReason ? { protocolRepairReason } : {}),
    ...(params.failureBudgetExempt ? { failureBudgetExempt: true } : {}),
  });
  recordToolProtocolResult(ctx.toolProtocolState, toolCallId);
  syncToolProtocolSnapshot(ctx);
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_protocol_result_recorded",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      toolCallId,
      tool: toolName,
      synthetic: synthetic === true,
      pendingToolCallIds: getPendingToolProtocolCalls(ctx.toolProtocolState).map(
        (toolCall) => toolCall.id,
      ),
      ...(protocolRepairReason ? { protocolRepairReason } : {}),
    },
  });
}

/**
 * Materialize the current response's tool-call blocks into an open
 * tool-turn on the protocol state and return the tool-call list for
 * execution. Returns an empty array when there is nothing to run
 * (either the response has no tool calls or the protocol state is
 * already open from a prior partial step).
 *
 * Side effects: pushes the assistant commentary message onto the
 * history, calls openToolProtocolTurn on the protocol state, syncs the
 * snapshot, and emits a `tool_protocol_opened` trace event.
 */
export function materializeResponseToolCalls(
  ctx: ExecutionContext,
  callbacks: ToolLoopCallbacks,
): readonly LLMToolCall[] {
  if (!ctx.response || !responseHasToolCalls(ctx.response)) {
    return [];
  }
  if (hasPendingToolProtocol(ctx.toolProtocolState)) {
    return ctx.response.toolCalls;
  }

  callbacks.pushMessage(
    ctx,
    {
      role: "assistant",
      content: ctx.response.content,
      phase: "commentary",
      toolCalls: sanitizeToolCallsForReplay(ctx.response.toolCalls),
    },
    "assistant_runtime",
  );
  openToolProtocolTurn(ctx.toolProtocolState, ctx.response.toolCalls);
  syncToolProtocolSnapshot(ctx);
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_protocol_opened",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      toolCallIds: ctx.response.toolCalls.map((toolCall) => toolCall.id),
      toolNames: ctx.response.toolCalls.map((toolCall) => toolCall.name),
      finishReason: ctx.response.finishReason,
    },
  });
  return ctx.response.toolCalls;
}

/**
 * Close out any pending tool calls with a synthetic error result when
 * the runtime is about to return with unresolved tool state. Returns
 * true when at least one pending call was sealed, false when there was
 * nothing to seal.
 *
 * `reason` records why the runtime is closing the protocol (e.g.
 * finalization_guard, provider_reported_malformed_continuation).
 * Clears the assistant response content so finalization doesn't leak
 * partial text meant to precede tool output.
 */
export function sealPendingToolProtocol(
  ctx: ExecutionContext,
  callbacks: ToolLoopCallbacks,
  reason: ToolProtocolRepairReason,
): boolean {
  const pendingToolCalls = getPendingToolProtocolCalls(ctx.toolProtocolState);
  if (pendingToolCalls.length === 0) {
    return false;
  }

  for (const toolCall of pendingToolCalls) {
    pushToolResultMessage({
      ctx,
      callbacks,
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: JSON.stringify({
        error: "Runtime closed unresolved tool call before continuation",
        code: TOOL_PROTOCOL_REPAIR_ERROR,
        reason,
      }),
      args: {},
      isError: true,
      durationMs: 0,
      synthetic: true,
      protocolRepairReason: reason,
      failureBudgetExempt: true,
    });
  }

  noteToolProtocolRepair(ctx.toolProtocolState, reason);
  if (ctx.response && responseHasToolCalls(ctx.response)) {
    ctx.response = {
      ...ctx.response,
      content: "",
    };
  }
  syncToolProtocolSnapshot(ctx);
  callbacks.emitExecutionTrace(ctx, {
    type: "tool_protocol_repaired",
    phase: "tool_followup",
    callIndex: ctx.callIndex,
    payload: {
      reason,
      repairedToolCallIds: pendingToolCalls.map((toolCall) => toolCall.id),
      repairedToolNames: pendingToolCalls.map((toolCall) => toolCall.name),
    },
  });
  return true;
}

/**
 * Detect the pathological case where the provider returned
 * `finish_reason: "tool_calls"` but the response has no actual
 * tool_use blocks. Fails the turn with a validation_error instead of
 * continuing with an invalid tool-turn state.
 *
 * Returns true when the malformed continuation is detected (and
 * stop-reason has been set); false otherwise.
 */
export function failClosedOnMalformedToolContinuation(
  ctx: ExecutionContext,
  callbacks: ToolLoopCallbacks,
): boolean {
  if (!responseHasMalformedToolFinish(ctx.response)) {
    return false;
  }

  const detail =
    "Provider returned finishReason \"tool_calls\" without any tool calls; refusing to continue with an invalid tool-turn state.";
  emitToolProtocolViolation(ctx, callbacks, "missing_tool_calls_for_finish_reason", {
    finishReason: ctx.response?.finishReason,
    contentPreview: (ctx.response?.content ?? "").slice(0, 240),
  });
  callbacks.setStopReason(ctx, "validation_error", detail);
  if (ctx.response) {
    ctx.response = {
      ...ctx.response,
      content: "",
    };
  }
  return true;
}
