/**
 * Synthetic `tool_result` fallback for aborted / failed tool calls.
 *
 * When a tool is aborted (user interrupt, sibling error, timeout,
 * provider switch), the next request must still carry a `tool_result`
 * row paired with the model's `tool_use` block — otherwise the
 * provider returns 400 "missing tool result".
 *
 * This module builds the synthetic result shape. Cause is explicit
 * (`timeout`, `connection_lost`, `aborted`, `sibling_error`,
 * `mode_changed`, `user_interrupted`) so downstream consumers
 * (telemetry, post-compact logic) can filter.
 *
 * Invariants covered:
 *   I-7  (stream abort cascade) — every orphan `tool_use` without a
 *        matching result is filled here before returning to the
 *        phase machine.
 *
 * @module
 */

import type { LLMMessage, LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult } from "../tool-registry.js";
import type {
  AssistantMessage,
  ToolUseBlock,
  TurnState,
  UserMessage,
} from "../session/turn-state.js";

export type TerminalToolCause =
  | "timeout"
  | "connection_lost"
  | "aborted"
  | "sibling_error"
  | "mode_changed"
  | "user_interrupted"
  | "auth_failed"
  | "provider_switched"
  | "process_killed";

export interface TerminalToolResult extends ToolDispatchResult {
  readonly isError: true;
  readonly cause: TerminalToolCause;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly elapsedMs?: number;
}

const CAUSE_TEXT: Readonly<Record<TerminalToolCause, string>> = Object.freeze({
  timeout: "tool execution timed out",
  connection_lost: "network connection lost mid-execution",
  aborted: "tool aborted before completion",
  sibling_error: "sibling tool errored; this tool was cancelled",
  mode_changed: "permission mode changed mid-execution",
  user_interrupted: "user interrupted",
  auth_failed: "authentication failed",
  provider_switched: "provider switched mid-turn",
  process_killed: "process killed",
});

export function buildTerminalToolResult(opts: {
  readonly toolCall: LLMToolCall;
  readonly cause: TerminalToolCause;
  readonly elapsedMs?: number;
  readonly detail?: string;
}): TerminalToolResult {
  const baseText = CAUSE_TEXT[opts.cause];
  const detail = opts.detail ? ` — ${opts.detail}` : "";
  const content = JSON.stringify({
    tool_use_id: opts.toolCall.id,
    is_error: true,
    content: `<tool_use_error>${baseText}${detail}</tool_use_error>`,
  });
  return {
    content,
    isError: true,
    cause: opts.cause,
    toolCallId: opts.toolCall.id,
    toolName: opts.toolCall.name,
    ...(opts.elapsedMs !== undefined ? { elapsedMs: opts.elapsedMs } : {}),
  };
}

/**
 * Synthesize terminal results for a batch of orphan tool_use blocks.
 * Used by the post-sample-recovery + model-fallback paths to ensure
 * every `tool_use_id` has a matching `tool_result` before the next
 * request.
 */
export function synthesizeTerminalResults(
  orphanCalls: ReadonlyArray<LLMToolCall>,
  cause: TerminalToolCause,
  detail?: string,
): TerminalToolResult[] {
  return orphanCalls.map((toolCall) =>
    buildTerminalToolResult({
      toolCall,
      cause,
      ...(detail !== undefined ? { detail } : {}),
    }),
  );
}

function toolCallFromBlock(block: ToolUseBlock): LLMToolCall {
  return {
    id: block.id,
    name: block.name,
    arguments: JSON.stringify(block.input ?? {}),
  };
}

/**
 * Collect unresolved tool calls from the current assistant batch.
 *
 * Sources:
 *   - parsed assistant toolCalls (preferred)
 *   - raw `toolUseBlocks` fallback when the assistant batch was only
 *     partially materialized before an abort/recovery path fired
 *
 * Resolved calls are filtered out using both the turn-local
 * `state.toolResults` buffer and any already-appended `role:"tool"`
 * messages in `state.messages`, so repeated cleanup passes do not
 * duplicate synthetic terminal results.
 */
export function findOrphanToolCalls(
  state: Pick<TurnState, "assistantMessages" | "toolUseBlocks" | "toolResults" | "messages">,
): LLMToolCall[] {
  const completedIds = new Set<string>();

  for (const result of state.toolResults) {
    const rec = result as Partial<UserMessage>;
    if (typeof rec.toolCallId === "string" && rec.toolCallId.length > 0) {
      completedIds.add(rec.toolCallId);
    }
  }

  for (const message of state.messages) {
    if (
      message.role === "tool" &&
      typeof message.toolCallId === "string" &&
      message.toolCallId.length > 0
    ) {
      completedIds.add(message.toolCallId);
    }
  }

  const pendingById = new Map<string, LLMToolCall>();
  for (const msg of state.assistantMessages as readonly AssistantMessage[]) {
    for (const call of msg.toolCalls) {
      if (!completedIds.has(call.id)) {
        pendingById.set(call.id, call);
      }
    }
  }
  for (const block of state.toolUseBlocks) {
    if (!completedIds.has(block.id) && !pendingById.has(block.id)) {
      pendingById.set(block.id, toolCallFromBlock(block));
    }
  }

  return Array.from(pendingById.values());
}

/**
 * Append synthetic terminal tool results to both the next-request
 * message history (`state.messages`) and the turn-local `toolResults`
 * buffer before a cleanup path clears the assistant/tool-use batch.
 */
export function appendTerminalToolResults(
  state: Pick<TurnState, "assistantMessages" | "toolUseBlocks" | "toolResults" | "messages">,
  cause: TerminalToolCause,
  detail?: string,
): TerminalToolResult[] {
  const orphanCalls = findOrphanToolCalls(state);
  if (orphanCalls.length === 0) return [];

  const synthetic = synthesizeTerminalResults(orphanCalls, cause, detail);
  for (const syn of synthetic) {
    const userRecord: UserMessage = {
      uuid: crypto.randomUUID(),
      role: "user",
      toolCallId: syn.toolCallId,
      toolName: syn.toolName,
      content: syn.content,
    };
    state.toolResults.push(userRecord);
    const msg: LLMMessage = {
      role: "tool",
      toolCallId: syn.toolCallId,
      content: syn.content,
    };
    state.messages.push(msg);
  }

  return synthetic;
}
