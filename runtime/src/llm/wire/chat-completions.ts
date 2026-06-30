/**
 * Chat Completions wire shim.
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
  buildStructuredOutputTextFormat,
  parseStructuredOutputText,
} from "../structured-output.js";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../openai-compatible-token-limits.js";
import {
  assistantTextFromContentBlocks,
  coerceUsage,
  collectRequestMetrics,
  messageTextContent,
  normalizeFinishReason,
  normalizeToolCallsStrict,
  parseOpenAIToolChoice,
  prepareMessagesForWire,
  toOpenAIMessageContent,
  toOpenAIToolMessageContent,
  withEndpointMarkers,
  withSerializedMetrics,
} from "./shared.js";
import { toChatCompletionsTools } from "./tools.js";
import {
  decodeMcpToolNameFromWire,
  encodeMcpToolNameForWire,
} from "./mcp-tool-naming.js";
import type { ChatCompletionsCapabilityHints } from "./capability-gating.js";

export interface ChatCompletionsRequestOptions {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly LLMTool[];
  readonly options?: LLMChatOptions;
  readonly maxTokens?: number;
  readonly maxTokenField?: ChatCompletionsMaxTokenField;
  /**
   * Per-provider capability hints. Adapters populate this so the
   * wire builder can strip fields the destination provider rejects.
   * For example `service_tier` is recognized only by a single
   * upstream provider, and `reasoning_effort` only applies to a
   * handful of model families. Backward-compatible: when undefined,
   * current behavior is preserved (all caller-supplied fields are
   * sent).
   */
  readonly providerCapabilityHints?: ChatCompletionsCapabilityHints;
}

export type ChatCompletionsMaxTokenField =
  | "max_tokens"
  | "max_completion_tokens";

export interface ChatCompletionsRequestMetadata {
  readonly model: string;
  readonly messageCount: number;
  readonly roleSequence: readonly string[];
  readonly estimatedPromptTokens: number;
  readonly maxTokens?: number;
  readonly maxTokenField?: ChatCompletionsMaxTokenField;
  readonly toolsAttached: boolean;
  readonly toolCount: number;
}

const DEFAULT_CHAT_COMPLETIONS_MAX_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS;

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function systemPromptParts(
  messages: readonly LLMMessage[],
  options: LLMChatOptions | undefined,
): readonly string[] {
  const parts: string[] = [];
  const optionPrompt = options?.systemPrompt?.trim();
  if (optionPrompt) parts.push(optionPrompt);
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") continue;
    const text = messageTextContent(message.content).trim();
    if (text.length > 0) parts.push(text);
  }
  return parts;
}

function toChatCompletionsMessages(
  messages: readonly LLMMessage[],
  options: LLMChatOptions | undefined,
): Array<Record<string, unknown>> {
  const prepared = prepareMessagesForWire(messages);
  const systemPrompt = systemPromptParts(prepared, options).join("\n\n");
  const wireMessages: Array<Record<string, unknown>> = [];
  if (systemPrompt.length > 0) {
    wireMessages.push({ role: "system", content: systemPrompt });
  }
  for (const message of prepared) {
    if (message.role === "system" || message.role === "developer") continue;
    if (message.role === "tool") {
      wireMessages.push({
        role: "tool",
        content: toOpenAIToolMessageContent(message.content),
        tool_call_id: message.toolCallId,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      wireMessages.push({
        role: "assistant",
        content: messageTextContent(message.content),
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            // The internal registry uses `mcp.<server>.<tool>`; the
            // wire format requires a strict-regex-safe name. Encode
            // here so the model sees a name it can echo back without
            // hitting the provider's name-validator.
            name: encodeMcpToolNameForWire(toolCall.name),
            arguments: toolCall.arguments,
          },
        })),
      });
      continue;
    }
    wireMessages.push({
      role: message.role,
      content: toOpenAIMessageContent(message.content),
    });
  }
  return wireMessages;
}

export function buildChatCompletionsRequest(
  input: ChatCompletionsRequestOptions,
): Record<string, unknown> {
  const maxTokenField = input.maxTokenField ?? "max_tokens";
  const maxTokens =
    positiveInteger(input.maxTokens) ??
    positiveInteger(input.options?.maxOutputTokens) ??
    DEFAULT_CHAT_COMPLETIONS_MAX_TOKENS;
  const body: Record<string, unknown> = {
    model: input.model,
    stream: false,
    messages: toChatCompletionsMessages(input.messages, input.options),
    [maxTokenField]: maxTokens,
  };

  const tools = toChatCompletionsTools(input.tools);
  if (tools.length > 0) body.tools = tools;
  if (input.options?.toolChoice !== undefined) {
    body.tool_choice = parseOpenAIToolChoice(input.options.toolChoice);
  }
  if (input.options?.parallelToolCalls !== undefined) {
    body.parallel_tool_calls = input.options.parallelToolCalls;
  }
  if (input.options?.temperature !== undefined) {
    body.temperature = input.options.temperature;
  }
  if (
    input.options?.stopSequences !== undefined &&
    input.options.stopSequences.length > 0
  ) {
    body.stop = [...input.options.stopSequences];
  }
  // Strip fields the destination provider rejects. Hints are
  // adapter-populated; an undefined `acceptsX` flag preserves the
  // pre-hint behavior of "include if caller supplied a value", so
  // unmigrated callers don't regress.
  if (
    input.options?.reasoningEffort !== undefined &&
    input.providerCapabilityHints?.acceptsReasoningEffort !== false
  ) {
    body.reasoning_effort = input.options.reasoningEffort;
  }
  if (
    input.options?.serviceTier !== undefined &&
    input.providerCapabilityHints?.acceptsServiceTier !== false
  ) {
    body.service_tier = input.options.serviceTier;
  }
  const structuredFormat = buildStructuredOutputTextFormat(
    input.options?.structuredOutput,
  );
  if (structuredFormat) {
    const { type: _formatType, ...jsonSchema } = structuredFormat;
    body.response_format = {
      type: "json_schema",
      json_schema: jsonSchema,
    };
  }
  return body;
}

export function collectChatCompletionsRequestMetadata(
  request: Record<string, unknown>,
): ChatCompletionsRequestMetadata {
  const messages = Array.isArray(request.messages)
    ? (request.messages as Array<Record<string, unknown>>)
    : [];
  const tools = Array.isArray(request.tools)
    ? (request.tools as Array<Record<string, unknown>>)
    : [];
  const roleSequence = messages.map((message) =>
    typeof message.role === "string" ? message.role : "unknown",
  );
  const serializedPrompt = JSON.stringify({
    messages: request.messages ?? [],
    tools: request.tools ?? [],
  });
  const maxTokens =
    positiveInteger(request.max_tokens as number | undefined) ??
    positiveInteger(request.max_completion_tokens as number | undefined);
  const maxTokenField =
    positiveInteger(request.max_tokens as number | undefined) !== undefined
      ? "max_tokens"
      : positiveInteger(request.max_completion_tokens as number | undefined) !== undefined
        ? "max_completion_tokens"
        : undefined;
  return {
    model: typeof request.model === "string" ? request.model : "",
    messageCount: messages.length,
    roleSequence,
    estimatedPromptTokens: Math.ceil(serializedPrompt.length / 4),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(maxTokenField !== undefined ? { maxTokenField } : {}),
    toolsAttached: tools.length > 0,
    toolCount: tools.length,
  };
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
    ? normalizeToolCallsStrict(
      (message.tool_calls as Array<Record<string, unknown>>).map(
        (toolCall): LLMToolCall => ({
          id: String(toolCall.id ?? ""),
          // Decode the strict-regex wire name back to the
          // internal-registry form (`mcp.<server>.<tool>`) before
          // the dispatcher tries to look up the tool. Non-MCP names
          // pass through unchanged.
          name: decodeMcpToolNameFromWire(
            String(
              (
                (toolCall.function as Record<string, unknown> | undefined) ?? {}
              ).name ?? "",
            ),
          ),
          arguments: String(
            (
              (toolCall.function as Record<string, unknown> | undefined) ?? {}
            ).arguments ?? "{}",
          ),
        }),
      ),
      // branding-scan: allow real OpenAI provider identifier
      "OpenAI chat-completions response emitted invalid tool_call",
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
  const usageRecord =
    response.usage && typeof response.usage === "object"
      ? (response.usage as Record<string, unknown>)
      : {};
  const promptDetails =
    usageRecord.prompt_tokens_details &&
      typeof usageRecord.prompt_tokens_details === "object" &&
      !Array.isArray(usageRecord.prompt_tokens_details)
      ? (usageRecord.prompt_tokens_details as Record<string, unknown>)
      : {};
  const completionDetails =
    usageRecord.completion_tokens_details &&
      typeof usageRecord.completion_tokens_details === "object" &&
      !Array.isArray(usageRecord.completion_tokens_details)
      ? (usageRecord.completion_tokens_details as Record<string, unknown>)
      : {};
  const preparedMessages = prepareMessagesForWire(request.messages);
  const requestMetrics = withSerializedMetrics(
    collectRequestMetrics(preparedMessages, request.tools),
    buildChatCompletionsRequest(request),
    request.options,
  );

  const finishReason = normalizeFinishReason(choice.finish_reason);
  // gaphunt3 #20: a truncated/incomplete generation (finishReason 'length',
  // 'error', or 'content_filter') leaves partial JSON in `content`, which
  // parseStructuredOutputText would JSON.parse and throw on, failing the
  // whole turn instead of surfacing the recoverable truncation. Only attempt
  // structured-output parsing when the generation completed normally.
  const generationCompleted =
    finishReason === "stop" || finishReason === "tool_calls";

  return {
    content,
    toolCalls,
    usage: coerceUsage({
      promptTokens: usageRecord.prompt_tokens,
      completionTokens: usageRecord.completion_tokens,
      totalTokens: usageRecord.total_tokens,
      cachedInputTokens: promptDetails.cached_tokens,
      reasoningOutputTokens: completionDetails.reasoning_tokens,
    }),
    model:
      typeof response.model === "string" ? response.model : model,
    finishReason,
    requestMetrics: withEndpointMarkers(
      requestMetrics,
      "/chat/completions",
      response,
    ),
    structuredOutput:
      !generationCompleted ||
        request.options?.structuredOutput?.enabled === false ||
        !request.options?.structuredOutput?.schema ||
        content.trim().length === 0
        ? undefined
        : parseStructuredOutputText(
          content,
          request.options.structuredOutput.schema.name,
          request.options.structuredOutput.schema.schema,
        ),
  };
}
