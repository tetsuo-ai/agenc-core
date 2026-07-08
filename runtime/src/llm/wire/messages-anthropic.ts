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

/**
 * gaphunt3 #5/#33: the system-prompt static/dynamic boundary marker.
 * Single-sourced in `wire/shared.ts` (task 5 extended the split to the
 * OpenAI/xAI wires); re-exported here for existing importers. The
 * gaphunt3 regression test still asserts it never diverges from
 * `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` in `src/prompts/system-prompt.ts`.
 */
export { SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER } from "./shared.js";
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER } from "./shared.js";

/**
 * Build the Anthropic `system` block(s) for the option-supplied system prompt.
 *
 * gaphunt3 #5/#33: the assembled system prompt embeds
 * {@link SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER} between its static
 * (cross-turn-stable) head and its volatile tail (env timestamp, git branch,
 * MCP servers, …). Previously the whole string was emitted as one
 * `cache_control: ephemeral` block, so the per-turn timestamp in the tail
 * changed the cached prefix and busted the prompt cache on every turn. We now
 * split on the marker and place the cache breakpoint on the static head ONLY,
 * with the volatile tail as a separate uncached block. When the marker is
 * absent (most callers / system-role messages), behaviour is unchanged: a
 * single block, cached iff `applyCacheControl`.
 */
function buildOptionSystemBlocks(
  optionSystemPrompt: string,
  applyCacheControl: boolean,
): Array<Record<string, unknown>> {
  const cacheControl = applyCacheControl
    ? { cache_control: { type: "ephemeral" } }
    : {};
  const markerIndex = optionSystemPrompt.indexOf(
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER,
  );
  if (markerIndex === -1) {
    return [{ type: "text", text: optionSystemPrompt, ...cacheControl }];
  }
  const staticHead = optionSystemPrompt.slice(0, markerIndex).trimEnd();
  const dynamicTail = optionSystemPrompt
    .slice(markerIndex + SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER.length)
    .trimStart();
  const blocks: Array<Record<string, unknown>> = [];
  if (staticHead.length > 0) {
    blocks.push({ type: "text", text: staticHead, ...cacheControl });
  }
  if (dynamicTail.length > 0) {
    blocks.push({ type: "text", text: dynamicTail });
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "", ...cacheControl });
  }
  return blocks;
}

export function buildAnthropicMessagesRequest(
  input: AnthropicMessagesRequestOptions,
): Record<string, unknown> {
  const messages = prepareMessagesForWire(input.messages, input.options);
  const systemMessages = messages.filter((message) =>
    message.role === "system" || message.role === "developer"
  );
  const optionSystemPrompt = input.options?.systemPrompt?.trim();
  const systemMessageHasCacheControl = systemMessages.some((message) =>
    hasEphemeralCacheControl(message)
  );
  const systemBlocks = [
    ...(optionSystemPrompt
      ? buildOptionSystemBlocks(
        optionSystemPrompt,
        !systemMessageHasCacheControl,
      )
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
          const toolUseBlocks = message.toolCalls.map((toolCall) => {
            // History tool-call arguments are not re-validated, so a
            // malformed JSON string must not throw here — that would
            // also break parseAnthropicMessagesResponse, which rebuilds
            // this request purely for metrics after a successful call.
            let parsedInput: unknown = {};
            try {
              parsedInput = JSON.parse(toolCall.arguments || "{}");
            } catch {
              parsedInput = {};
            }
            return {
              type: "tool_use",
              id: toolCall.id,
              // The messages API enforces the strict
              // `^[a-zA-Z0-9_-]{1,64}$` function-name regex; encode the
              // dotted MCP form before sending. The response parser
              // decodes back to the internal-registry form.
              name: encodeMcpToolNameForWire(toolCall.name),
              input: parsedInput,
            };
          });
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
  if (input.options?.temperature !== undefined) {
    body.temperature = input.options.temperature;
  }
  if (
    input.options?.stopSequences !== undefined &&
    input.options.stopSequences.length > 0
  ) {
    body.stop_sequences = [...input.options.stopSequences];
  }
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
  // gaphunt3 #1: the Messages API rejects a forced tool_choice
  // ({type:'any'}/{type:'tool'}) when extended thinking is enabled (it only
  // permits 'auto'/'none', returning a 400 otherwise). Mirror that constraint
  // by omitting any forced tool_choice (falling back to auto) whenever
  // thinking will be enabled on this request.
  const thinkingEnabled = input.options?.reasoningEffort !== undefined;
  if (input.options?.toolChoice !== undefined) {
    const toolChoice = parseAnthropicToolChoice(input.options.toolChoice);
    if (toolChoice !== undefined && !thinkingEnabled) {
      body.tool_choice = toolChoice;
    }
  }
  if (structuredOutputTool && input.tools.length === 0 && !thinkingEnabled) {
    body.tool_choice = {
      type: "tool",
      name: ANTHROPIC_STRUCTURED_OUTPUT_TOOL_NAME,
    };
  }
  if (thinkingEnabled) {
    body.thinking = {
      type: "enabled",
      budget_tokens:
        input.options?.reasoningEffort === "high" ||
          input.options?.reasoningEffort === "xhigh"
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
  const thinking = contentBlocks.flatMap((block) => {
    if (block.type === "thinking" && typeof block.thinking === "string") {
      return [{
        text: String(block.thinking),
        ...(typeof block.signature === "string"
          ? { signature: String(block.signature) }
          : {}),
        redacted: false,
        kind: "thinking" as const,
      }];
    }
    if (block.type === "redacted_thinking") {
      return [{
        text: typeof block.data === "string" ? String(block.data) : "",
        redacted: true,
        kind: "thinking" as const,
      }];
    }
    return [];
  });
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
  const preparedMessages = prepareMessagesForWire(
    request.messages,
    request.options,
  );
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
    ...(thinking.length > 0 ? { thinking } : {}),
  };
}
