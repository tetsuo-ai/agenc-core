/**
 * Shared wire helpers for provider request shaping.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMContentPart,
  LLMMessage,
  LLMTool,
  LLMToolCall,
  LLMToolChoice,
  LLMUsage,
} from "../types.js";
import { validateToolCall } from "../types.js";

export function coerceUsage(usage: {
  readonly promptTokens?: unknown;
  readonly completionTokens?: unknown;
  readonly totalTokens?: unknown;
}): LLMUsage {
  const promptTokens = toNumber(usage.promptTokens);
  const completionTokens = toNumber(usage.completionTokens);
  const totalTokens =
    toNumber(usage.totalTokens) ?? promptTokens + completionTokens;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

export function normalizeFinishReason(
  reason: unknown,
): "stop" | "tool_calls" | "length" | "content_filter" | "error" {
  switch (String(reason ?? "")) {
    case "tool_calls":
    case "tool_use":
      return "tool_calls";
    case "length":
    case "max_tokens":
      return "length";
    case "content_filter":
    case "refusal":
      return "content_filter";
    case "error":
      return "error";
    default:
      return "stop";
  }
}

export function messageTextContent(
  content: string | readonly LLMContentPart[],
): string {
  if (typeof content === "string") return content;
  return content
    .map((part) =>
      part.type === "text"
        ? part.text
        : `[image: ${part.image_url.url}]`
    )
    .join("\n");
}

export function toOpenAIMessageContent(
  content: string | readonly LLMContentPart[],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "image_url",
      image_url: { url: part.image_url.url },
    };
  });
}

export function toAnthropicMessageContent(
  content: string | readonly LLMContentPart[],
): Array<Record<string, unknown>> | string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return {
      type: "text",
      text: `[image: ${part.image_url.url}]`,
    };
  });
}

export function parseOpenAIToolChoice(
  toolChoice: LLMToolChoice | undefined,
): unknown {
  if (toolChoice === undefined) return undefined;
  if (
    toolChoice === "auto" ||
    toolChoice === "required" ||
    toolChoice === "none"
  ) {
    return toolChoice;
  }
  return {
    type: "function",
    function: {
      name: toolChoice.name,
    },
  };
}

export function parseAnthropicToolChoice(
  toolChoice: LLMToolChoice | undefined,
): unknown {
  if (toolChoice === undefined || toolChoice === "auto") return undefined;
  if (toolChoice === "required") return { type: "any" };
  if (toolChoice === "none") return undefined;
  return {
    type: "tool",
    name: toolChoice.name,
  };
}

export function toAnthropicTools(tools: readonly LLMTool[]): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

export function normalizeToolCalls(
  toolCalls: readonly LLMToolCall[],
): LLMToolCall[] {
  return toolCalls
    .map((toolCall) => validateToolCall(toolCall))
    .filter((toolCall): toolCall is LLMToolCall => toolCall !== null);
}

export function collectRequestMetrics(messages: readonly LLMMessage[], tools: readonly LLMTool[]) {
  let systemMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;
  let totalContentChars = 0;
  let maxMessageChars = 0;
  let textParts = 0;
  let imageParts = 0;

  for (const message of messages) {
    if (message.role === "system") systemMessages += 1;
    if (message.role === "user") userMessages += 1;
    if (message.role === "assistant") assistantMessages += 1;
    if (message.role === "tool") toolMessages += 1;

    const contentLength = messageTextContent(message.content).length;
    totalContentChars += contentLength;
    maxMessageChars = Math.max(maxMessageChars, contentLength);

    if (typeof message.content === "string") {
      textParts += 1;
    } else {
      for (const part of message.content) {
        if (part.type === "text") textParts += 1;
        if (part.type === "image_url") imageParts += 1;
      }
    }
  }

  return {
    messageCount: messages.length,
    systemMessages,
    userMessages,
    assistantMessages,
    toolMessages,
    totalContentChars,
    maxMessageChars,
    textParts,
    imageParts,
    toolCount: tools.length,
    toolNames: tools.map((tool) => tool.function.name),
    toolChoice: undefined,
    toolSchemaChars: JSON.stringify(tools).length,
    serializedChars: 0,
    store: undefined,
    parallelToolCalls: undefined,
    stream: undefined,
  };
}

export function assistantTextFromContentBlocks(
  content: readonly unknown[],
): string {
  const pieces: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record.type === "output_text" && typeof record.text === "string") {
      pieces.push(record.text);
      continue;
    }
    if (record.type === "text" && typeof record.text === "string") {
      pieces.push(record.text);
      continue;
    }
    if (
      record.type === "output_text" &&
      record.text &&
      typeof record.text === "object" &&
      typeof (record.text as Record<string, unknown>).value === "string"
    ) {
      pieces.push(String((record.text as Record<string, unknown>).value));
    }
  }
  return pieces.join("");
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function withSerializedMetrics(
  metrics: ReturnType<typeof collectRequestMetrics>,
  body: unknown,
  options: LLMChatOptions | undefined,
) {
  const serialized = JSON.stringify(body);
  return {
    ...metrics,
    serializedChars: serialized.length,
    toolChoice:
      typeof options?.toolChoice === "string"
        ? options.toolChoice
        : options?.toolChoice?.name,
    parallelToolCalls: options?.parallelToolCalls,
    stream: undefined,
  };
}
