/**
 * xAI Responses API wire shim.
 *
 * This keeps the Grok adapter's request-shaping rules separate from provider
 * orchestration. xAI uses the Responses family, but its documented contract
 * differs enough from the neighboring provider contract that it needs
 * its own narrow shim.
 *
 * @module
 */

import type {
  LLMChatOptions,
  LLMMessage,
  LLMToolChoice,
} from "../types.js";
import {
  buildStructuredOutputTextFormat,
  supportsXaiReasoningEffortParam,
} from "../structured-output.js";
import { documentFallbackText, readDocumentPayload } from "./shared.js";
import { encodeMcpToolNameForWire } from "./mcp-tool-naming.js";
export { toXaiResponsesTools } from "./tools.js";

export const XAI_ENCRYPTED_REASONING_INCLUDE =
  "reasoning.encrypted_content";

export interface XaiResponsesInputBuildResult {
  readonly input: Record<string, unknown>[];
  readonly hasImages: boolean;
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function normalizeXaiResponsesToolChoice(
  toolChoice: LLMToolChoice | undefined,
): string | Record<string, unknown> | undefined {
  if (toolChoice === undefined || typeof toolChoice === "string") {
    return toolChoice;
  }

  // `tools[]` ships MCP names in the bijective wire encoding
  // (mcp-tool-naming.ts); a named tool_choice must reference that
  // encoded entry, not the dotted internal name the provider never saw.
  const directName = typeof toolChoice.name === "string"
    ? toolChoice.name.trim()
    : "";
  if (toolChoice.type === "function" && directName.length > 0) {
    return {
      type: "function",
      function: { name: encodeMcpToolNameForWire(directName) },
    };
  }

  const legacyName = typeof (toolChoice as { function?: { name?: unknown } }).function
      ?.name === "string"
    ? (toolChoice as { function?: { name?: string } }).function!.name!.trim()
    : "";
  if (toolChoice.type === "function" && legacyName.length > 0) {
    return {
      type: "function",
      function: { name: encodeMcpToolNameForWire(legacyName) },
    };
  }

  return toolChoice;
}

export function resolveXaiResponsesToolChoice(
  toolChoice: LLMToolChoice | undefined,
): string | Record<string, unknown> | undefined {
  // xAI documents `required` as a first-class tool_choice mode. Preserve it
  // instead of tightening it into a named-function selection.
  return normalizeXaiResponsesToolChoice(toolChoice);
}

export function buildXaiResponsesInputItems(
  messages: readonly LLMMessage[],
): XaiResponsesInputBuildResult {
  const mapped: Record<string, unknown>[] = [];
  const pendingImages: Array<{
    type: "image_url";
    image_url: { url: string };
  }> = [];

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;

    if (message.role === "tool" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "image_url") {
          pendingImages.push({
            type: "image_url",
            image_url: part.image_url,
          });
        }
      }
    }

    mapped.push(toXaiOpenAIMessage(message));

    if (pendingImages.length > 0) {
      const nextMessage = messages[i + 1];
      if (!nextMessage || nextMessage.role !== "tool") {
        mapped.push({
          role: "user",
          content: [
            {
              type: "text",
              text: "Here is the screenshot from the tool result above.",
            },
            ...pendingImages.map((image) => ({
              type: image.type,
              image_url: image.image_url,
            })),
          ],
        });
        pendingImages.length = 0;
      }
    }
  }

  return {
    input: mapped.flatMap((message) => toXaiResponseInputItems(message)),
    hasImages: mapped.some((message) =>
      hasXaiImageContent(message.content)
    ),
  };
}

export function buildXaiResponsesRequest(input: {
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly Record<string, unknown>[];
  readonly store?: boolean;
  readonly options?: Pick<
    LLMChatOptions,
    | "promptCacheKey"
    | "maxOutputTokens"
    | "reasoningEffort"
    | "includeEncryptedReasoning"
    | "toolChoice"
    | "structuredOutput"
  > & {
    readonly maxTurns?: number;
    readonly parallelToolCalls?: boolean;
    readonly temperature?: number;
    readonly structuredOutputsStrict?: boolean;
  };
}): Record<string, unknown> {
  const built = buildXaiResponsesInputItems(input.messages);
  const params: Record<string, unknown> = {
    model: input.model,
    input: built.input,
    store: input.store ?? false,
  };
  if (input.options?.promptCacheKey) {
    params.prompt_cache_key = input.options.promptCacheKey;
  }
  if (input.options?.temperature !== undefined) {
    params.temperature = input.options.temperature;
  }
  const maxOutputTokens = positiveInteger(input.options?.maxOutputTokens);
  if (maxOutputTokens !== undefined) {
    params.max_output_tokens = maxOutputTokens;
  }
  if (
    typeof input.options?.maxTurns === "number" &&
    Number.isFinite(input.options.maxTurns) &&
    input.options.maxTurns > 0
  ) {
    params.max_turns = Math.floor(input.options.maxTurns);
  }
  // Send the Responses API `reasoning.effort` shape only for documented
  // models; strip it from unknown Grok variants rather than letting xAI
  // reject the request.
  if (
    input.options?.reasoningEffort &&
    supportsXaiReasoningEffortParam(input.model)
  ) {
    params.reasoning = { effort: input.options.reasoningEffort };
  }
  if (input.options?.includeEncryptedReasoning) {
    params.include = [XAI_ENCRYPTED_REASONING_INCLUDE];
  }
  if (input.tools && input.tools.length > 0) {
    params.tools = input.tools;
    if (input.options?.parallelToolCalls !== undefined) {
      params.parallel_tool_calls = input.options.parallelToolCalls;
    }
    const toolChoice = resolveXaiResponsesToolChoice(
      input.options?.toolChoice,
    );
    if (toolChoice !== undefined) {
      params.tool_choice = toolChoice;
    }
  }
  const structuredFormat = buildStructuredOutputTextFormat(
    input.options?.structuredOutput,
    input.options?.structuredOutputsStrict ?? true,
  );
  if (structuredFormat) {
    params.text = {
      format: structuredFormat,
    };
  }
  return params;
}

function hasXaiImageContent(content: unknown): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((part) => {
    if (!part || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    return record.type === "image_url";
  });
}

function toXaiOpenAIMessage(message: LLMMessage): Record<string, unknown> {
  if (
    message.role === "assistant" &&
    message.toolCalls &&
    message.toolCalls.length > 0
  ) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: message.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          // The xAI responses API enforces the same strict
          // `^[a-zA-Z0-9_-]{1,64}$` function-name regex as the other
          // commercial providers. Encode dotted MCP names so the
          // model can echo them back through the strict validator.
          name: encodeMcpToolNameForWire(toolCall.name),
          arguments: toolCall.arguments,
        },
      })),
    };
  }

  if (message.role === "tool") {
    let content: string;
    if (Array.isArray(message.content)) {
      content =
        message.content
          .filter((part) => part.type === "text")
          .map((part) => (part as { type: "text"; text: string }).text)
          .join("\n") || "Tool executed successfully.";
    } else {
      content = message.content;
    }
    return {
      role: "tool",
      content,
      tool_call_id: message.toolCallId,
    };
  }

  return {
    role: message.role === "developer" ? "system" : message.role,
    content: message.content,
  };
}

function toXaiResponseInputItems(
  message: Record<string, unknown>,
): Record<string, unknown>[] {
  const role = String(message.role ?? "");
  const content = message.content;

  if (role === "tool") {
    const toolCallId = String(message.tool_call_id ?? "").trim();
    if (!toolCallId) return [];
    let output: string;
    if (typeof content === "string") {
      output = content;
    } else {
      try {
        output = JSON.stringify(content);
      } catch {
        output = String(content ?? "");
      }
    }
    return [
      {
        type: "function_call_output",
        call_id: toolCallId,
        output,
      },
    ];
  }

  if (role === "assistant") {
    const toolCalls = Array.isArray(message.tool_calls)
      ? (message.tool_calls as Array<Record<string, unknown>>)
      : [];
    const items: Record<string, unknown>[] = [];
    const normalizedContent = normalizeXaiResponseMessageContent(content);
    if (normalizedContent !== undefined) {
      items.push({
        role,
        content: normalizedContent,
      });
    }
    for (const toolCall of toolCalls) {
      const functionData =
        (toolCall.function as Record<string, unknown> | undefined) ?? {};
      const callId = String(toolCall.id ?? "").trim();
      const name = String(functionData.name ?? "").trim();
      const args = String(functionData.arguments ?? "");
      if (!callId || !name) continue;
      items.push({
        type: "function_call",
        call_id: callId,
        name,
        arguments: args,
      });
    }
    return items;
  }

  if (role === "system" || role === "user") {
    const normalizedContent = normalizeXaiResponseMessageContent(content);
    if (normalizedContent === undefined) return [];
    return [{ role, content: normalizedContent }];
  }

  const normalizedContent = normalizeXaiResponseMessageContent(content);
  if (normalizedContent === undefined) return [];
  return [{ role, content: normalizedContent }];
}

function normalizeXaiResponseMessageContent(
  content: unknown,
): string | Array<Record<string, unknown>> | undefined {
  if (typeof content === "string") {
    if (content.length === 0) return undefined;
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const parts: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const entry = part as Record<string, unknown>;
    const document = readDocumentPayload(entry);
    if (entry.type === "text") {
      const text = String(entry.text ?? "");
      if (text.length > 0) {
        parts.push({ type: "input_text", text });
      }
    } else if (entry.type === "image_url") {
      const image = (entry.image_url as Record<string, unknown> | undefined) ?? {};
      const url = String(image.url ?? "");
      if (url.length > 0) {
        parts.push({ type: "input_image", image_url: url });
      }
    } else if (document) {
      if (document.fileId || document.fileUrl) {
        parts.push({
          type: "input_file",
          ...(document.fileId ? { file_id: document.fileId } : {}),
          ...(document.fileUrl ? { file_url: document.fileUrl } : {}),
        });
      } else if (document.fallbackText !== undefined) {
        parts.push({
          type: "input_text",
          text: documentFallbackText(entry),
        });
      } else if (document.fallbackTextError !== undefined) {
        parts.push({
          type: "input_text",
          text: documentFallbackText(entry),
        });
      } else {
        parts.push({
          type: "input_text",
          text: `[document: ${document.mediaType}]`,
        });
      }
    } else if (entry.type === "document") {
      parts.push({ type: "input_text", text: "[document]" });
    }
  }
  if (parts.length === 0) return undefined;
  return parts;
}
