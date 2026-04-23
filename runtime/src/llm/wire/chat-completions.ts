/**
 * OpenAI Chat Completions wire shim.
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
  assistantTextFromContentBlocks,
  coerceUsage,
  collectRequestMetrics,
  messageTextContent,
  normalizeFinishReason,
  normalizeToolCalls,
  parseOpenAIToolChoice,
  prepareMessagesForWire,
  toOpenAIMessageContent,
  toOpenAIToolMessageContent,
  withEndpointMarkers,
  withSerializedMetrics,
} from "./shared.js";

export interface ChatCompletionsRequestOptions {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly options?: LLMChatOptions;
}

export function buildChatCompletionsRequest(
  input: ChatCompletionsRequestOptions,
): Record<string, unknown> {
  const messages = prepareMessagesForWire(input.messages);
  const body: Record<string, unknown> = {
    model: input.model,
    stream: false,
    messages: messages.map((message) => {
      if (message.role === "tool") {
        return {
          role: "tool",
          content: toOpenAIToolMessageContent(message.content),
          tool_call_id: message.toolCallId,
        };
      }
      if (message.role === "assistant" && message.toolCalls?.length) {
        return {
          role: "assistant",
          content: messageTextContent(message.content),
          tool_calls: message.toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments: toolCall.arguments,
            },
          })),
        };
      }
      return {
        role: message.role,
        content: toOpenAIMessageContent(message.content),
      };
    }),
  };

  if (input.tools.length > 0) body.tools = input.tools;
  if (input.options?.toolChoice !== undefined) {
    body.tool_choice = parseOpenAIToolChoice(input.options.toolChoice);
  }
  if (input.options?.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = input.options.parallelToolCalls;
  }
  if (input.options?.reasoningEffort !== undefined) {
    body.reasoning_effort = input.options.reasoningEffort;
  }
  if (input.options?.serviceTier !== undefined) {
    body.service_tier = input.options.serviceTier;
  }
  return body;
}

export function parseChatCompletionsResponse(
  model: string,
  response: Record<string, unknown>,
  request: ChatCompletionsRequestOptions,
): LLMResponse {
  const choices = Array.isArray(response.choices)
    ? (response.choices as Array<Record<string, unknown>>)
    : [];
  const choice = choices[0] ?? {};
  const message =
    choice.message && typeof choice.message === "object"
      ? (choice.message as Record<string, unknown>)
      : {};
  const toolCalls = Array.isArray(message.tool_calls)
    ? normalizeToolCalls(
      (message.tool_calls as Array<Record<string, unknown>>).map(
        (toolCall): LLMToolCall => ({
          id: String(toolCall.id ?? ""),
          name: String(
            (
              (toolCall.function as Record<string, unknown> | undefined) ?? {}
            ).name ?? "",
          ),
          arguments: String(
            (
              (toolCall.function as Record<string, unknown> | undefined) ?? {}
            ).arguments ?? "{}",
          ),
        }),
      ),
    )
    : [];
  const content =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? assistantTextFromContentBlocks(message.content)
        : typeof message.reasoning_content === "string"
          ? message.reasoning_content
          : "";
  const preparedMessages = prepareMessagesForWire(request.messages);
  const requestMetrics = withSerializedMetrics(
    collectRequestMetrics(preparedMessages, request.tools),
    buildChatCompletionsRequest(request),
    request.options,
  );

  return {
    content,
    toolCalls,
    usage: coerceUsage({
      promptTokens:
        (response.usage as Record<string, unknown> | undefined)?.prompt_tokens,
      completionTokens:
        (response.usage as Record<string, unknown> | undefined)
          ?.completion_tokens,
      totalTokens:
        (response.usage as Record<string, unknown> | undefined)?.total_tokens,
    }),
    model:
      typeof response.model === "string" ? response.model : model,
    finishReason: normalizeFinishReason(choice.finish_reason),
    requestMetrics: withEndpointMarkers(
      requestMetrics,
      "/chat/completions",
      response,
    ),
  };
}
