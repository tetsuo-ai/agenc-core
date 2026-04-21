/**
 * OpenAI Responses API wire shim.
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
  normalizeFinishReason,
  normalizeToolCalls,
  parseOpenAIToolChoice,
  toOpenAIMessageContent,
  withSerializedMetrics,
} from "./shared.js";

export interface OpenAIResponsesRequestOptions {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly options?: LLMChatOptions;
  readonly store?: boolean;
}

function roleContent(message: LLMMessage): Array<Record<string, unknown>> {
  if (typeof message.content === "string") {
    return [{ type: "input_text", text: message.content }];
  }
  return (toOpenAIMessageContent(message.content) as Array<Record<string, unknown>>)
    .map((entry) => {
      if (entry.type === "text") return { type: "input_text", text: entry.text };
      return entry;
    });
}

export function buildOpenAIResponsesRequest(
  input: OpenAIResponsesRequestOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: input.model,
    input: input.messages.map((message) => {
      if (message.role === "assistant" && message.toolCalls?.length) {
        return {
          role: "assistant",
          content: roleContent(message),
          tool_calls: message.toolCalls.map((toolCall) => ({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.name,
            arguments: toolCall.arguments,
          })),
        };
      }
      if (message.role === "tool") {
        return {
          type: "function_call_output",
          call_id: message.toolCallId,
          output:
            typeof message.content === "string"
              ? message.content
              : JSON.stringify(message.content),
        };
      }
      return {
        role: message.role,
        content: roleContent(message),
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
  if (input.options?.includeEncryptedReasoning) {
    body.include = ["reasoning.encrypted_content"];
  }
  if (input.options?.reasoningEffort !== undefined) {
    body.reasoning = { effort: input.options.reasoningEffort };
  }
  if (input.store !== undefined) {
    body.store = input.store;
  }
  return body;
}

export function parseOpenAIResponsesResponse(
  model: string,
  response: Record<string, unknown>,
  request: OpenAIResponsesRequestOptions,
): LLMResponse {
  const output = Array.isArray(response.output)
    ? (response.output as Array<Record<string, unknown>>)
    : [];
  const toolCalls = normalizeToolCalls(
    output
      .filter((item) => item.type === "function_call")
      .map(
        (item): LLMToolCall => ({
          id: String(item.call_id ?? item.id ?? ""),
          name: String(item.name ?? ""),
          arguments: String(item.arguments ?? "{}"),
        }),
      ),
  );

  const content = output
    .filter((item) => item.type === "message")
    .map((item) => {
      const contentBlocks = Array.isArray(item.content)
        ? (item.content as readonly unknown[])
        : [];
      return assistantTextFromContentBlocks(contentBlocks);
    })
    .join("");

  const usageRecord =
    response.usage && typeof response.usage === "object"
      ? (response.usage as Record<string, unknown>)
      : {};
  const requestMetrics = withSerializedMetrics(
    collectRequestMetrics(request.messages, request.tools),
    buildOpenAIResponsesRequest(request),
    request.options,
  );

  return {
    content,
    toolCalls,
    usage: coerceUsage({
      promptTokens: usageRecord.input_tokens,
      completionTokens: usageRecord.output_tokens,
      totalTokens: usageRecord.total_tokens,
    }),
    model:
      typeof response.model === "string" ? response.model : model,
    finishReason: normalizeFinishReason(response.status),
    requestMetrics,
  };
}
