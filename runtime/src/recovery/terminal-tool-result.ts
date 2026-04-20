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

import type { LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult } from "../tool-registry.js";

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
