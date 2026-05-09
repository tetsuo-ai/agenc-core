/**
 * Messages API wire shim.
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
  ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
  parseStructuredOutputValue,
} from "../structured-output.js";
import {
  coerceUsage,
  collectRequestMetrics,
  normalizeFinishReason,
  normalizeToolCalls,
  parseAnthropicToolChoice,
  prepareMessagesForWire,
  toAnthropicMessageContent,
  toAnthropicToolResultContent,
  withEndpointMarkers,
  withSerializedMetrics,
} from "./shared.js";
import { toAnthropicTools } from "./tools.js";
import {
  decodeMcpToolNameFromWire,
  encodeMcpToolNameForWire,
} from "./mcp-tool-naming.js";

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

function isAnthropicStructuredOutputRequested(
  options: LLMChatOptions | undefined,
): boolean {
  return options?.structuredOutput?.enabled !== false &&
    options?.structuredOutput?.schema !== undefined;
}

function buildAnthropicStructuredOutputTool(
  options: LLMChatOptions | undefined,
): LLMTool | undefined {
  const schema = options?.structuredOutput?.schema;
  if (!isAnthropicStructuredOutputRequested(options) || !schema) {
    return undefined;
  }
  return {
    type: "function",
    function: {
      name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
      description: "Return the final response in the requested structured format.",
      parameters: schema.schema,
    },
  };
}

export function buildAnthropicMessagesRequest(
  input: AnthropicMessagesRequestOptions,
): Record<string, unknown> {
  const messages = prepareMessagesForWire(input.messages);
  const systemMessages = messages.filter((message) =>
    message.role === "system" || message.role === "developer"
  );
  const optionSystemPrompt = input.options?.systemPrompt?.trim();
  const systemMessageHasCacheControl = systemMessages.some((message) =>
    hasEphemeralCacheControl(message)
  );
  const systemBlocks = [
    ...(optionSystemPrompt
      ? [{
        type: "text",
        text: optionSystemPrompt,
        ...(!systemMessageHasCacheControl
          ? { cache_control: { type: "ephemeral" } }
          : {}),
      }]
      : []),
    ...systemMessages.flatMap((message) => {
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
    }),
  ];
  const systemHasCacheControl = systemBlocks.some((block) =>
    Object.prototype.hasOwnProperty.call(block, "cache_control")
  );
  const system =
    systemBlocks.length === 0
      ? ""
      : systemHasCacheControl
      ? systemBlocks
      : systemBlocks.map((block) => String(block.text ?? "")).join("\n\n");

  const body: Record<string, unknown> = {
    model: input.model,
    messages: messages
      .filter((message) =>
        message.role !== "system" && message.role !== "developer"
      )
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
            // The messages API enforces the strict
            // `^[a-zA-Z0-9_-]{1,64}$` function-name regex; encode the
            // dotted MCP form before sending. The response parser
            // decodes back to the internal-registry form.
            name: encodeMcpToolNameForWire(toolCall.name),
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
  const structuredOutputTool = buildAnthropicStructuredOutputTool(input.options);
  const tools = structuredOutputTool
    ? [...input.tools, structuredOutputTool]
    : [...input.tools];
  if (
    structuredOutputTool &&
    input.tools.some(
      (tool) =>
        tool.function.name === ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
    )
  ) {
    throw new Error(
      `tool name ${ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME} is reserved for structured output`,
    );
  }
  if (tools.length > 0) body.tools = toAnthropicTools(tools);
  if (input.options?.toolChoice !== undefined) {
    const toolChoice = parseAnthropicToolChoice(input.options.toolChoice);
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
  }
  if (structuredOutputTool && input.tools.length === 0) {
    body.tool_choice = {
      type: "tool",
      name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
    };
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
  const structuredSchema = request.options?.structuredOutput?.schema;
  const structuredOutputBlock =
    request.options?.structuredOutput?.enabled === false || !structuredSchema
      ? undefined
      : contentBlocks.find(
        (block) =>
          block.type === "tool_use" &&
          block.name === ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
      );
  const structuredOutput =
    structuredSchema &&
      structuredOutputBlock &&
      "input" in structuredOutputBlock
      ? parseStructuredOutputValue(
        structuredOutputBlock.input,
        structuredSchema.name,
        structuredSchema.schema,
      )
      : undefined;
  const toolCalls = normalizeToolCalls(
    contentBlocks
      .filter(
        (block) =>
          block.type === "tool_use" &&
          block.name !== ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
      )
      .map(
        (block): LLMToolCall => ({
          id: String(block.id ?? ""),
          // Decode the encoded `mcp__server__tool` form back to the
          // internal-registry `mcp.server.tool` form before dispatch.
          // Non-MCP names (e.g. `FileEdit`) pass through unchanged.
          name: decodeMcpToolNameFromWire(String(block.name ?? "")),
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
  const serverToolUse =
    usageRecord.server_tool_use &&
      typeof usageRecord.server_tool_use === "object" &&
      !Array.isArray(usageRecord.server_tool_use)
      ? (usageRecord.server_tool_use as Record<string, unknown>)
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
      cachedInputTokens: usageRecord.cache_read_input_tokens,
      cacheCreationInputTokens: usageRecord.cache_creation_input_tokens,
      reasoningOutputTokens: usageRecord.reasoning_output_tokens,
      webSearchRequests: serverToolUse.web_search_requests,
    }),
    model:
      typeof response.model === "string" ? response.model : model,
    finishReason:
      response.stop_reason === "tool_use" &&
        toolCalls.length === 0 &&
        structuredOutput
        ? "stop"
        : normalizeFinishReason(response.stop_reason),
    requestMetrics: withEndpointMarkers(requestMetrics, "/messages", response),
    ...(structuredOutput ? { structuredOutput } : {}),
  };
}
