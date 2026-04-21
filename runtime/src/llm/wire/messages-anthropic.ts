/**
 * Anthropic Messages API wire shim.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMMessage,
  LLMResponse,
  LLMTool,
  LLMToolCall,
} from "../types.js";
import {
  coerceUsage,
  collectRequestMetrics,
  messageTextContent,
  normalizeFinishReason,
  normalizeToolCalls,
  parseAnthropicToolChoice,
  prepareMessagesForWire,
  toAnthropicMessageContent,
  toAnthropicToolResultContent,
  toAnthropicTools,
  withEndpointMarkers,
  withSerializedMetrics,
} from "./shared.js";

export interface AnthropicMessagesRequestOptions {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly options?: LLMChatOptions;
  readonly maxTokens?: number;
}

export function buildAnthropicMessagesRequest(
  input: AnthropicMessagesRequestOptions,
): Record<string, unknown> {
  const messages = prepareMessagesForWire(input.messages);
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => messageTextContent(message.content))
    .join("\n\n");

  const body: Record<string, unknown> = {
    model: input.model,
    messages: messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        if (message.role === "assistant" && message.toolCalls?.length) {
          const anthropicContent = toAnthropicMessageContent(message.content);
          const assistantContent =
            typeof anthropicContent === "string"
              ? anthropicContent.length > 0
                ? [{
                  type: "text",
                  text: anthropicContent,
                }]
                : []
              : anthropicContent;
          return {
            role: "assistant",
            content: [
              ...assistantContent,
              ...message.toolCalls.map((toolCall) => ({
                type: "tool_use",
                id: toolCall.id,
                name: toolCall.name,
                input: JSON.parse(toolCall.arguments || "{}"),
              })),
            ],
          };
        }
        if (message.role === "tool") {
          return {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: message.toolCallId,
              content: toAnthropicToolResultContent(message.content),
            }],
          };
        }
        return {
          role: message.role,
          content: toAnthropicMessageContent(message.content),
        };
      }),
    max_tokens: input.maxTokens ?? 4096,
  };

  if (system.length > 0) body.system = system;
  if (input.tools.length > 0) body.tools = toAnthropicTools(input.tools);
  if (input.options?.toolChoice !== undefined) {
    const toolChoice = parseAnthropicToolChoice(input.options.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
  }
  if (input.options?.reasoningEffort !== undefined) {
    body.thinking = {
      type: "enabled",
      budget_tokens:
        input.options.reasoningEffort === "high" ||
          input.options.reasoningEffort === "xhigh"
          ? 4096
          : 2048,
    };
  }
  return body;
}

export function parseAnthropicMessagesResponse(
  model: string,
  response: Record<string, unknown>,
  request: AnthropicMessagesRequestOptions,
): LLMResponse {
  const contentBlocks = Array.isArray(response.content)
    ? (response.content as Array<Record<string, unknown>>)
    : [];
  const toolCalls = normalizeToolCalls(
    contentBlocks
      .filter((block) => block.type === "tool_use")
      .map(
        (block): LLMToolCall => ({
          id: String(block.id ?? ""),
          name: String(block.name ?? ""),
          arguments: JSON.stringify(block.input ?? {}),
        }),
      ),
  );
  const content = contentBlocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => String(block.text))
    .join("");
  const usageRecord =
    response.usage && typeof response.usage === "object"
      ? (response.usage as Record<string, unknown>)
      : {};
  const preparedMessages = prepareMessagesForWire(request.messages);
  const requestMetrics = withSerializedMetrics(
    collectRequestMetrics(preparedMessages, request.tools),
    buildAnthropicMessagesRequest(request),
    request.options,
  );

  return {
    content,
    toolCalls,
    usage: coerceUsage({
      promptTokens: usageRecord.input_tokens,
      completionTokens: usageRecord.output_tokens,
      totalTokens: undefined,
    }),
    model:
      typeof response.model === "string" ? response.model : model,
    finishReason: normalizeFinishReason(response.stop_reason),
    requestMetrics: withEndpointMarkers(requestMetrics, "/messages", response),
  };
}
