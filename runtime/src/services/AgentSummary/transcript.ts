/**
 * Converts AgenC native agent transcript events into the upstream-shaped
 * message blocks consumed by the AgentSummary fork.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC's child runner emits flat LLM messages plus separate tool
 *     progress events; the donor summary service reads upstream `Message`
 *     objects with paired `tool_use` / `tool_result` blocks.
 *
 * Cross-cuts deliberately NOT carried:
 *   - None; this is a local adapter for live AgenC transcript shape only.
 */

import type { LLMMessage, LLMToolCall, MessageRole } from "../../llm/types.js";
import type { RunAgentProgressEvent } from "../../agents/run-agent.js";
import {
  classifyUntrustedToolResult,
  frameUntrustedToolResultContent,
} from "../../tools/untrusted-tool-result-framing.js";
import type { Message } from "../../types/message.js";

const UNKNOWN_TOOL_NAME = "unknown_tool";

function messageRoleForSummary(role: MessageRole): MessageRole {
  return role === "tool" ? "user" : role;
}

function contentForSummary(message: LLMMessage): LLMMessage["content"] {
  if (message.role !== "tool") return message.content;
  const content: LLMMessage["content"] = [
    {
      type: "text",
      text: typeof message.content === "string"
        ? message.content
        : message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
    },
  ];
  const toolName = message.toolName ?? UNKNOWN_TOOL_NAME;
  return frameUntrustedToolResultContent(
    toolName,
    content,
    classifyUntrustedToolResult(toolName),
  );
}

function parseToolCallInput(toolCall: LLMToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(toolCall.arguments);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Preserve the raw argument string when the provider returned malformed JSON.
  }
  return { arguments: toolCall.arguments };
}

function assistantContentForSummary(message: LLMMessage): unknown[] {
  const content = typeof message.content === "string"
    ? message.content.trim()
      ? [{ type: "text", text: message.content }]
      : []
    : message.content.filter((part) => part.type === "text");
  const toolUses = (message.toolCalls ?? []).map((toolCall) => ({
    type: "tool_use",
    id: toolCall.id,
    name: toolCall.name,
    input: parseToolCallInput(toolCall),
  }));
  return [...content, ...toolUses];
}

function toolResultContentForSummary(message: LLMMessage): unknown[] | string {
  if (!message.toolCallId) return contentForSummary(message);
  return [
    {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: contentForSummary(message),
      ...(message.toolName !== undefined ? { name: message.toolName } : {}),
    },
  ];
}

export function llmMessageToAgentSummaryMessage(
  message: LLMMessage,
  index: number,
): Message {
  const role = messageRoleForSummary(message.role);
  const content = message.role === "assistant"
    ? assistantContentForSummary(message)
    : message.role === "tool"
      ? toolResultContentForSummary(message)
      : contentForSummary(message);
  return {
    type: role,
    uuid: `agent-summary-${index}`,
    timestamp: new Date(0).toISOString(),
    message: {
      role,
      content,
    },
  } as Message;
}

export function runAgentProgressEventToAgentSummaryMessage(
  event: RunAgentProgressEvent,
  index: number,
): Message | null {
  switch (event.kind) {
    case "message":
      return llmMessageToAgentSummaryMessage(event.message, index);
    case "tool_call":
      return {
        type: "assistant",
        uuid: `agent-summary-${index}`,
        timestamp: new Date(0).toISOString(),
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: event.callId,
              name: event.toolName,
              input: parseToolCallInput({
                id: event.callId,
                name: event.toolName,
                arguments: event.arguments ?? "{}",
              }),
            },
          ],
        },
      } as Message;
    case "tool_result": {
      const framedContent = frameUntrustedToolResultContent(
        event.toolName,
        event.result,
        classifyUntrustedToolResult(event.toolName),
      );
      return {
        type: "user",
        uuid: `agent-summary-${index}`,
        timestamp: new Date(0).toISOString(),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: event.callId,
              content: typeof framedContent === "string"
                ? [{ type: "text", text: framedContent }]
                : framedContent,
              name: event.toolName,
              is_error: event.isError,
            },
          ],
        },
      } as Message;
    }
    default:
      return null;
  }
}
