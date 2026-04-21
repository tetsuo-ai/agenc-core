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
  messageTextContent,
  normalizeFinishReason,
  normalizeToolCalls,
  parseOpenAIToolChoice,
  prepareMessagesForWire,
  toResponsesToolOutput,
  withEndpointMarkers,
  withSerializedMetrics,
} from "./shared.js";

export interface OpenAIResponsesRequestOptions {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly options?: LLMChatOptions;
  readonly store?: boolean;
}

function normalizeFunctionCallId(toolCallId: string | undefined): {
  readonly id: string;
  readonly callId: string;
} {
  const value = (toolCallId ?? "").trim();
  if (!value) {
    return {
      id: "fc_unknown",
      callId: "call_unknown",
    };
  }
  if (value.startsWith("call_")) {
    return {
      id: `fc_${value.slice("call_".length)}`,
      callId: value,
    };
  }
  if (value.startsWith("fc_")) {
    return {
      id: value,
      callId: `call_${value.slice("fc_".length)}`,
    };
  }
  return {
    id: `fc_${value}`,
    callId: value,
  };
}

function toResponsesMessageParts(
  content: LLMMessage["content"],
  role: "user" | "assistant",
): Array<Record<string, unknown>> {
  const textType = role === "assistant" ? "output_text" : "input_text";
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: textType, text: content }] : [];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.length === 0) continue;
      parts.push({ type: textType, text: part.text });
      continue;
    }
    if (role === "assistant") continue;
    parts.push({
      type: "input_image",
      image_url: part.image_url.url,
    });
  }
  return parts;
}

function resolveResponsesFinishReason(
  response: Record<string, unknown>,
  toolCalls: readonly LLMToolCall[],
): LLMResponse["finishReason"] {
  if (toolCalls.length > 0) {
    return "tool_calls";
  }

  const status = String(response.status ?? "");
  if (status === "incomplete") {
    const details =
      response.incomplete_details &&
      typeof response.incomplete_details === "object"
        ? (response.incomplete_details as Record<string, unknown>)
        : {};
    const reason = String(details.reason ?? "");
    if (reason.includes("max_output_tokens") || reason.includes("max_tokens")) {
      return "length";
    }
    if (reason.includes("content_filter") || reason.includes("refusal")) {
      return "content_filter";
    }
    if (reason.includes("error")) {
      return "error";
    }
  }

  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  ) {
    return "error";
  }

  return normalizeFinishReason(status);
}

export function buildOpenAIResponsesRequest(
  input: OpenAIResponsesRequestOptions,
): Record<string, unknown> {
  const messages = prepareMessagesForWire(input.messages);
  const instructions = messages
    .filter((message) => message.role === "system")
    .map((message) => messageTextContent(message.content))
    .join("\n\n");
  const responseInput: Array<Record<string, unknown>> = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "assistant") {
      const content = toResponsesMessageParts(message.content, "assistant");
      if (content.length > 0) {
        responseInput.push({
          type: "message",
          role: "assistant",
          content,
        });
      }
      for (const toolCall of message.toolCalls ?? []) {
        const normalizedId = normalizeFunctionCallId(toolCall.id);
        responseInput.push({
          type: "function_call",
          id: normalizedId.id,
          call_id: normalizedId.callId,
          name: toolCall.name,
          arguments: toolCall.arguments,
        });
      }
      continue;
    }

    if (message.role === "tool") {
      responseInput.push({
        type: "function_call_output",
        call_id: normalizeFunctionCallId(message.toolCallId).callId,
        output: toResponsesToolOutput(message.content),
      });
      continue;
    }

    responseInput.push({
      type: "message",
      role: message.role,
      content: toResponsesMessageParts(message.content, "user"),
    });
  }

  if (responseInput.length === 0) {
    responseInput.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "" }],
    });
  }

  const body: Record<string, unknown> = {
    model: input.model,
    input: responseInput,
    stream: false,
    store: input.store ?? false,
  };

  if (instructions.length > 0) {
    body.instructions = instructions;
  }
  if (input.tools.length > 0) body.tools = input.tools;
  if (input.options?.toolChoice !== undefined) {
    body.tool_choice = parseOpenAIToolChoice(input.options.toolChoice);
  }
  if (input.options?.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = input.options.parallelToolCalls;
  }
  if (input.options?.promptCacheKey) {
    body.prompt_cache_key = input.options.promptCacheKey;
  }
  if (input.options?.includeEncryptedReasoning) {
    body.include = ["reasoning.encrypted_content"];
  }
  if (input.options?.reasoningEffort !== undefined) {
    body.reasoning = { effort: input.options.reasoningEffort };
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
  const preparedMessages = prepareMessagesForWire(request.messages);
  const requestMetrics = withSerializedMetrics(
    collectRequestMetrics(preparedMessages, request.tools),
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
    finishReason: resolveResponsesFinishReason(response, toolCalls),
    requestMetrics: withEndpointMarkers(requestMetrics, "/responses", response),
  };
}
