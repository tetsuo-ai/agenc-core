/**
 * Results the runtime writes itself for tool calls a restart interrupted:
 * the one bootstrap replay seals for a call left without a result, and the
 * one a continued turn pairs with a call it does not retry. Their writers and
 * the checkpoint reader, which recognizes them, share these bodies.
 *
 * @module
 */
import { sideEffectHaltMessage } from "./durable-turns.js";

/** Model-facing body of a result synthesized for an interrupted tool call. */
export function interruptedToolCallResultContent(call: {
  readonly id: string;
  readonly name: string;
}): string {
  return JSON.stringify({
    tool_use_id: call.id,
    is_error: true,
    content: `<tool_use_error>interrupted: the runtime restarted before ${call.name} completed and no result was recorded; call it again if the result is still needed</tool_use_error>`,
  });
}

/**
 * Body of the result a continued turn pairs with a call it does not retry:
 * side-effecting calls are not re-dispatched, read-only ones may be.
 */
export function resumedToolCallResultContent(toolName: string, halt: boolean): string {
  return halt
    ? sideEffectHaltMessage(toolName)
    : `result not persisted before crash; the read-only tool ${toolName} was not retried automatically — safe to re-invoke if its result is needed.`;
}

/**
 * Whether a persisted response item is exactly one of those recovery results
 * for its own call: a tool result whose body is the fixed text for the call
 * id and tool name it carries. Nothing else in the body can vary.
 */
export function isRecoveryToolResult(item: {
  readonly role: string;
  readonly content: unknown;
  readonly toolCallId?: string;
  readonly toolName?: string;
}): boolean {
  if (
    item.role !== "tool" ||
    typeof item.toolCallId !== "string" ||
    typeof item.toolName !== "string" ||
    typeof item.content !== "string"
  ) {
    return false;
  }
  return (
    item.content ===
      interruptedToolCallResultContent({ id: item.toolCallId, name: item.toolName }) ||
    item.content === resumedToolCallResultContent(item.toolName, false) ||
    item.content === resumedToolCallResultContent(item.toolName, true)
  );
}
