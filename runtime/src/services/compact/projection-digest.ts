import { fromRuntimeMessageContent } from "../../llm/content-conversion.js";
import type { CompactionProjectionMessageV1 } from "./transaction-types.js";

/** Canonical digest projection for already-persisted rollback messages. */
export function canonicalCompactionProjectionMessages(
  messages: readonly CompactionProjectionMessageV1[],
): readonly unknown[] {
  return messages.map((message) => ({
    role: message.role,
    content: fromRuntimeMessageContent(message.content),
    ...(message.toolCallId !== undefined
      ? { tool_call_id: message.toolCallId }
      : {}),
    ...(message.toolName !== undefined ? { tool_name: message.toolName } : {}),
    ...(message.toolCalls !== undefined
      ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? "",
          })),
        }
      : {}),
    ...(message.toolResultIntegrity !== undefined
      ? { tool_result_integrity: message.toolResultIntegrity }
      : {}),
    ...(message.agentInvocation !== undefined
      ? { agent_invocation: message.agentInvocation }
      : {}),
  }));
}
