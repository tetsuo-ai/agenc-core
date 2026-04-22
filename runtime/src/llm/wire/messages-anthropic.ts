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
  readonly contextManagement?: Record<string, unknown>;
}

function hasEphemeralCacheControl(message: LLMMessage): boolean {
  return (message as { cacheControl?: unknown }).cacheControl === "ephemeral";
}

function withEphemeralCacheControl(
  blocks: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  if (blocks.length === 0) {
    return [
      {
        type: "text",
        text: "",
        cache_control: { type: "ephemeral" },
      },
    ];
  }
  return blocks.map((block, index) =>
    index === blocks.length - 1
      ? {
        ...block,
        cache_control: { type: "ephemeral" },
      }
      : block,
  );
}

function normalizeAnthropicMessageContent(
  message: LLMMessage,
): string | Array<Record<string, unknown>> {
  const anthropicContent = toAnthropicMessageContent(message.content);
  if (!hasEphemeralCacheControl(message)) {
    return anthropicContent;
  }
  if (typeof anthropicContent === "string") {
    return withEphemeralCacheControl([
      {
        type: "text",
        text: anthropicContent,
      },
    ]);
  }
  return withEphemeralCacheControl(anthropicContent);
}

export function buildAnthropicMessagesRequest(
  input: AnthropicMessagesRequestOptions,
): Record<string, unknown> {
  const messages = prepareMessagesForWire(input.messages);
  const systemMessages = messages.filter((message) => message.role === "system");
  const systemBlocks = systemMessages.flatMap((message) => {
    const normalized = normalizeAnthropicMessageContent(message);
    if (typeof normalized === "string") {
      return normalized.length > 0
        ? [{
          type: "text",
          text: normalized,
        }]
        : [];
    }
    return normalized.filter((block) => block.type === "text");
  });
  const system =
    systemBlocks.length === 0
      ? ""
      : systemMessages.some((message) => hasEphemeralCacheControl(message))
      ? systemBlocks
      : systemBlocks.map((block) => String(block.text ?? "")).join("\n\n");

  const body: Record<string, unknown> = {
    model: input.model,
    messages: messages
      .filter((message) => message.role !== "system")
      .map((message) => {
        if (message.role === "assistant" && message.toolCalls?.length) {
          const anthropicContent = normalizeAnthropicMessageContent(message);
          const assistantContent =
            typeof anthropicContent === "string"
              ? anthropicContent.length > 0
                ? [{
                  type: "text",
                  text: anthropicContent,
                }]
                : []
              : anthropicContent;
          const toolUseBlocks = message.toolCalls.map((toolCall) => ({
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: JSON.parse(toolCall.arguments || "{}"),
          }));
          const content =
            hasEphemeralCacheControl(message)
              ? withEphemeralCacheControl([
                ...assistantContent,
                ...toolUseBlocks,
              ])
              : [
                ...assistantContent,
                ...toolUseBlocks,
              ];
          return {
            role: "assistant",
            content,
          };
        }
        if (message.role === "tool") {
          const toolResultBlock = {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: toAnthropicToolResultContent(message.content),
          };
          return {
            role: "user",
            content: hasEphemeralCacheControl(message)
              ? withEphemeralCacheControl([toolResultBlock])
              : [toolResultBlock],
          };
        }
        return {
          role: message.role,
          content: normalizeAnthropicMessageContent(message),
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
  if (input.contextManagement) {
    body.context_management = input.contextManagement;
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
