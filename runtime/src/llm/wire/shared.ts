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
import { normalizeMessagesForAPI } from "../messages.js";
import { validateToolCall, validateToolCallDetailed } from "../types.js";

function readContentPartRecord(part: unknown): Record<string, unknown> | null {
  return part && typeof part === "object" && !Array.isArray(part)
    ? (part as Record<string, unknown>)
    : null;
}

function normalizeAudioFormat(format: string): string {
  const normalized = format.trim().toLowerCase();
  return normalized.startsWith("audio/") ? normalized.slice("audio/".length) : normalized;
}

function parseAudioDataUrl(
  url: string,
): { readonly data: string; readonly format: string } | null {
  const match = /^data:audio\/([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/i.exec(
    url.trim(),
  );
  if (!match) return null;
  const format = normalizeAudioFormat(match[1] ?? "");
  const data = (match[2] ?? "").trim();
  if (!format || !data) return null;
  return { data, format };
}

function parseImageDataUrl(
  url: string,
): { readonly data: string; readonly mediaType: string } | null {
  const match = /^data:(image\/(?:png|jpe?g|gif|webp));base64,([\s\S]+)$/iu.exec(
    url.trim(),
  );
  if (!match) return null;
  const rawMediaType = (match[1] ?? "").trim().toLowerCase();
  // The non-standard `image/jpg` form is common; Anthropic expects
  // `image/jpeg`, so normalize it here.
  const mediaType = rawMediaType === "image/jpg" ? "image/jpeg" : rawMediaType;
  const data = (match[2] ?? "").replace(/\s+/gu, "");
  if (!mediaType || !data) return null;
  return { data, mediaType };
}

function toAnthropicImageSource(
  imageUrl: string,
): Record<string, unknown> | null {
  const dataImage = parseImageDataUrl(imageUrl);
  if (dataImage) {
    return {
      type: "base64",
      media_type: dataImage.mediaType,
      data: dataImage.data,
    };
  }
  if (/^data:image\//iu.test(imageUrl.trim())) return null;
  return {
    type: "url",
    url: imageUrl,
  };
}

/**
 * The system-prompt static/dynamic boundary marker. Must stay byte-equal
 * to `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` exported by
 * `src/prompts/system-prompt.ts` (the producer of `options.systemPrompt`);
 * a regression test asserts the two never diverge. Single-sourced here so
 * every wire can split without importing the prompt-assembly graph.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER = "<!-- dynamic-boundary -->";

/**
 * Split an assembled system prompt into its cross-turn-stable head and
 * its volatile tail (env timestamp, git branch, MCP servers, …).
 *
 * Prefix-caching providers (OpenAI, xAI) hash the leading bytes of the
 * request: sending the volatile tail at the FRONT (inside instructions
 * or a leading system message) makes every turn's prefix diverge, so
 * the growing conversation is never served from cache. Callers place
 * `staticPrefix` at the front and `dynamicSuffix` at the very end of
 * the request — both providers' documented best practice ("put variable
 * content at the end"; "never modify earlier messages — only append").
 *
 * When the marker is absent, the whole prompt is the static prefix
 * (unchanged legacy behaviour).
 */
export function splitSystemPromptOnDynamicBoundary(
  systemPrompt: string | undefined,
): { staticPrefix?: string; dynamicSuffix?: string } {
  const trimmed = systemPrompt?.trim();
  if (trimmed === undefined || trimmed.length === 0) return {};
  const markerIndex = trimmed.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER);
  if (markerIndex === -1) return { staticPrefix: trimmed };
  const staticPrefix = trimmed.slice(0, markerIndex).trimEnd();
  const dynamicSuffix = trimmed
    .slice(markerIndex + SYSTEM_PROMPT_DYNAMIC_BOUNDARY_MARKER.length)
    .trim();
  return {
    ...(staticPrefix.length > 0 ? { staticPrefix } : {}),
    ...(dynamicSuffix.length > 0 ? { dynamicSuffix } : {}),
  };
}

export function readDocumentPayload(part: unknown): {
  readonly data: string;
  readonly mediaType: string;
  readonly filename?: string;
  readonly title?: string;
  readonly fallbackText?: string;
  readonly fallbackTextTruncated?: boolean;
  readonly fallbackTextError?: string;
  readonly fileId?: string;
  readonly fileUrl?: string;
} | null {
  const record = readContentPartRecord(part);
  if (!record) return null;
  if (record.type === "document") {
    const source = readContentPartRecord(record.source);
    if (
      source?.type === "base64" &&
      typeof source.data === "string" &&
      source.data.trim().length > 0
    ) {
      const mediaType = String(
        source.media_type ?? source.mediaType ?? "application/pdf",
      );
      return {
        data: source.data.replace(/\s+/gu, ""),
        mediaType,
        ...(typeof record.filename === "string" && record.filename.length > 0
          ? { filename: record.filename }
          : {}),
        ...(typeof record.title === "string" && record.title.length > 0
          ? { title: record.title }
          : {}),
        ...(typeof record.fallbackText === "string"
          ? { fallbackText: record.fallbackText }
          : {}),
        ...(typeof record.fallbackTextTruncated === "boolean"
          ? { fallbackTextTruncated: record.fallbackTextTruncated }
          : {}),
        ...(typeof record.fallbackTextError === "string" &&
        record.fallbackTextError.length > 0
          ? { fallbackTextError: record.fallbackTextError }
          : {}),
      };
    }
  }
  if (record.type === "input_file") {
    const data =
      typeof record.file_data === "string" ? record.file_data.trim() : "";
    const fileId =
      typeof record.file_id === "string" ? record.file_id.trim() : "";
    const fileUrl =
      typeof record.file_url === "string" ? record.file_url.trim() : "";
    if (data.length === 0 && fileId.length === 0 && fileUrl.length === 0) {
      return null;
    }
    return {
      data,
      mediaType: "application/pdf",
      ...(typeof record.filename === "string" && record.filename.length > 0
        ? { filename: record.filename }
        : {}),
      ...(fileId.length > 0 ? { fileId } : {}),
      ...(fileUrl.length > 0 ? { fileUrl } : {}),
    };
  }
  return null;
}

export function documentFallbackText(part: unknown): string {
  const document = readDocumentPayload(part);
  if (document === null) return "[document]";
  const label = document.filename ?? document.title ?? "document.pdf";
  if (document.fallbackText !== undefined) {
    return [
      `<attached_pdf_text filename="${escapeAttribute(label)}" media_type="${escapeAttribute(
        document.mediaType,
      )}" truncated="${document.fallbackTextTruncated ? "true" : "false"}">`,
      escapePdfFallbackText(document.fallbackText),
      "</attached_pdf_text>",
    ].join("\n");
  }
  if (document.fallbackTextError !== undefined) {
    return `<attached_pdf_unavailable filename="${escapeAttribute(label)}" media_type="${escapeAttribute(
      document.mediaType,
    )}">${escapePdfFallbackText(document.fallbackTextError)}</attached_pdf_unavailable>`;
  }
  return `[document: ${document.mediaType}]`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapePdfFallbackText(value: string): string {
  return value
    .replace(/<\/attached_pdf_text>/giu, "<\\/attached_pdf_text>")
    .replace(
      /<\/attached_pdf_unavailable>/giu,
      "<\\/attached_pdf_unavailable>",
    );
}

export function readAudioPayload(
  part: unknown,
): { readonly data: string; readonly format: string } | null {
  const record = readContentPartRecord(part);
  if (!record) return null;
  const nested = readContentPartRecord(record.input_audio);
  if (
    typeof nested?.data === "string" &&
    nested.data.length > 0 &&
    typeof nested.format === "string" &&
    nested.format.length > 0
  ) {
    return {
      data: nested.data,
      format: normalizeAudioFormat(nested.format),
    };
  }
  const audioUrl = readContentPartRecord(record.audio_url);
  if (typeof audioUrl?.url === "string" && audioUrl.url.length > 0) {
    return parseAudioDataUrl(audioUrl.url);
  }
  return null;
}

export function hasOpaqueAudioReference(part: unknown): boolean {
  const record = readContentPartRecord(part);
  if (!record) return false;
  if (readAudioPayload(record)) return false;
  const type = typeof record.type === "string" ? record.type.toLowerCase() : "";
  if (type === "input_audio" || type === "audio_url") {
    return true;
  }
  const audioUrl = readContentPartRecord(record.audio_url);
  return typeof audioUrl?.url === "string" && audioUrl.url.trim().length > 0;
}

export function coerceUsage(usage: {
  readonly promptTokens?: unknown;
  readonly completionTokens?: unknown;
  readonly totalTokens?: unknown;
  readonly cachedInputTokens?: unknown;
  readonly cacheCreationInputTokens?: unknown;
  readonly reasoningOutputTokens?: unknown;
  readonly webSearchRequests?: unknown;
}): LLMUsage {
  const promptTokens = toOptionalNumber(usage.promptTokens) ?? 0;
  const completionTokens = toOptionalNumber(usage.completionTokens) ?? 0;
  const totalTokens =
    toOptionalNumber(usage.totalTokens) ?? promptTokens + completionTokens;
  const cachedInputTokens = toOptionalNumber(usage.cachedInputTokens);
  const cacheCreationInputTokens = toOptionalNumber(
    usage.cacheCreationInputTokens,
  );
  const reasoningOutputTokens = toOptionalNumber(usage.reasoningOutputTokens);
  const webSearchRequests = toOptionalNumber(usage.webSearchRequests);
  return {
    promptTokens,
    completionTokens,
    totalTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens }
      : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(webSearchRequests !== undefined ? { webSearchRequests } : {}),
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
    .map((part) => {
      const record = readContentPartRecord(part);
      const type = typeof record?.type === "string" ? record.type : "";
      if (type === "text") {
        return String(record?.text ?? "");
      }
      if (type === "image_url") {
        return `[image: ${String((record?.image_url as { url?: unknown } | undefined)?.url ?? "")}]`;
      }
      const audio = readAudioPayload(part);
      if (audio) {
        return `[audio:${audio.format}]`;
      }
      if (hasOpaqueAudioReference(part)) {
        return "[audio]";
      }
      if (readDocumentPayload(part)) {
        return documentFallbackText(part);
      }
      return `[${type || "content"}]`;
    })
    .join("\n");
}

export function toOpenAIMessageContent(
  content: string | readonly LLMContentPart[],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;
  return content.map((part) => {
    const record = readContentPartRecord(part) ?? {};
    if (record.type === "text") {
      return { type: "text", text: String(record.text ?? "") };
    }
    const audio = readAudioPayload(part);
    if (audio) {
      return {
        type: "input_audio",
        input_audio: {
          data: audio.data,
          format: audio.format,
        },
      };
    }
    if (hasOpaqueAudioReference(part)) {
      return { type: "text", text: "[audio]" };
    }
    if (readDocumentPayload(part) || record.type === "document") {
      return { type: "text", text: documentFallbackText(part) };
    }
    return {
      type: "image_url",
      image_url: {
        url: String(
          (record.image_url as { url?: unknown } | undefined)?.url ?? "",
        ),
      },
    };
  });
}

export function toOpenAIToolMessageContent(
  content: string | readonly LLMContentPart[],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;

  const parts = content.map((part) => {
    const record = readContentPartRecord(part) ?? {};
    if (record.type === "text") {
      return { type: "text", text: String(record.text ?? "") };
    }
    const audio = readAudioPayload(part);
    if (audio) {
      return {
        type: "input_audio",
        input_audio: {
          data: audio.data,
          format: audio.format,
        },
      };
    }
    if (hasOpaqueAudioReference(part)) {
      return { type: "text", text: "[audio]" };
    }
    if (readDocumentPayload(part) || record.type === "document") {
      return { type: "text", text: documentFallbackText(part) };
    }
    return {
      type: "image_url",
      image_url: {
        url: String(
          (record.image_url as { url?: unknown } | undefined)?.url ?? "",
        ),
      },
    };
  });

  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0]?.type === "text") {
    return String(parts[0].text ?? "");
  }
  return parts;
}

export function toAnthropicMessageContent(
  content: string | readonly LLMContentPart[],
): Array<Record<string, unknown>> | string {
  if (typeof content === "string") return content;
  return content.map((part) => {
    const record = readContentPartRecord(part) ?? {};
    if (record.type === "text") {
      return { type: "text", text: String(record.text ?? "") };
    }
    const document = readDocumentPayload(part);
    if (document && document.data.length > 0) {
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: document.mediaType,
          data: document.data,
        },
      };
    }
    if (document || record.type === "document" || record.type === "input_file") {
      return { type: "text", text: documentFallbackText(part) };
    }
    const imageUrl = String(
      (record.image_url as { url?: unknown } | undefined)?.url ?? "",
    );
    if (imageUrl.length > 0) {
      const source = toAnthropicImageSource(imageUrl);
      if (source === null) {
        return { type: "text", text: "[unsupported image]" };
      }
      return {
        type: "image",
        source,
      };
    }
    return {
      type: "text",
      text: messageTextContent([part] as unknown as readonly LLMContentPart[]),
    };
  });
}

export function toAnthropicToolResultContent(
  content: string | readonly LLMContentPart[],
): Array<Record<string, unknown>> | string {
  if (typeof content === "string") return content;

  const parts = content.map((part) => {
    const record = readContentPartRecord(part) ?? {};
    if (record.type === "text") {
      return { type: "text", text: String(record.text ?? "") };
    }
    const document = readDocumentPayload(part);
    if (document && document.data.length > 0) {
      return {
        type: "document",
        source: {
          type: "base64",
          media_type: document.mediaType,
          data: document.data,
        },
      };
    }
    if (document || record.type === "document" || record.type === "input_file") {
      return { type: "text", text: documentFallbackText(part) };
    }
    const imageUrl = String(
      (record.image_url as { url?: unknown } | undefined)?.url ?? "",
    );
    if (imageUrl.length > 0) {
      const source = toAnthropicImageSource(imageUrl);
      if (source === null) {
        return { type: "text", text: "[unsupported image]" };
      }
      return {
        type: "image",
        source,
      };
    }
    return {
      type: "text",
      text: messageTextContent([part] as unknown as readonly LLMContentPart[]),
    };
  });

  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0]?.type === "text") {
    return String(parts[0].text ?? "");
  }
  return parts;
}

export function toResponsesToolOutput(
  content: string | readonly LLMContentPart[],
): string | Array<Record<string, unknown>> {
  if (typeof content === "string") return content;

  const parts: Array<Record<string, unknown>> = [];
  let hasStructuredPart = false;
  for (const part of content) {
    const record = readContentPartRecord(part) ?? {};
    if (record.type === "text") {
      const text = String(record.text ?? "");
      if (text.length === 0) continue;
      parts.push({ type: "input_text", text });
      continue;
    }
    const audio = readAudioPayload(part);
    if (audio) {
      hasStructuredPart = true;
      parts.push({
        type: "input_audio",
        input_audio: {
          data: audio.data,
          format: audio.format,
        },
      });
      continue;
    }
    if (hasOpaqueAudioReference(part)) {
      parts.push({ type: "input_text", text: "[audio]" });
      continue;
    }
    if (readDocumentPayload(part) || record.type === "document") {
      parts.push({ type: "input_text", text: documentFallbackText(part) });
      continue;
    }
    hasStructuredPart = true;
    parts.push({
      type: "input_image",
      image_url: String(
        (record.image_url as { url?: unknown } | undefined)?.url ?? "",
      ),
    });
  }

  if (parts.length === 0) return "";
  if (!hasStructuredPart) {
    return parts
      .map((part) => String(part.text ?? ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return parts;
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

export function prepareMessagesForWire(
  messages: readonly LLMMessage[],
  options?: LLMChatOptions,
): readonly LLMMessage[] {
  return normalizeMessagesForAPI(messages, {
    ...(options?.skipCacheWrite !== undefined
      ? { skipCacheWrite: options.skipCacheWrite }
      : {}),
  });
}

export function normalizeToolCalls(
  toolCalls: readonly LLMToolCall[],
): LLMToolCall[] {
  return toolCalls
    .map((toolCall) => validateToolCall(toolCall))
    .filter((toolCall): toolCall is LLMToolCall => toolCall !== null);
}

export function normalizeToolCallsStrict(
  toolCalls: readonly LLMToolCall[],
  context: string,
): LLMToolCall[] {
  return toolCalls.map((toolCall) => {
    const result = validateToolCallDetailed(toolCall);
    if (result.toolCall) {
      return result.toolCall;
    }
    throw new Error(
      `${context}: ${result.failure?.message ?? "invalid tool call payload"}`,
    );
  });
}

export function collectRequestMetrics(
  messages: readonly LLMMessage[],
  tools: readonly LLMTool[],
) {
  let systemMessages = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolMessages = 0;
  let totalContentChars = 0;
  let maxMessageChars = 0;
  let textParts = 0;
  let imageParts = 0;

  for (const message of messages) {
    if (message.role === "system" || message.role === "developer") {
      systemMessages += 1;
    }
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

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function withSerializedMetrics(
  metrics: ReturnType<typeof collectRequestMetrics>,
  body: unknown,
  options: LLMChatOptions | undefined,
) {
  const serialized = JSON.stringify(body);
  const bodyRecord =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  return {
    ...metrics,
    serializedChars: serialized.length,
    toolChoice:
      typeof options?.toolChoice === "string"
        ? options.toolChoice
        : options?.toolChoice?.name,
    store:
      typeof bodyRecord.store === "boolean" ? bodyRecord.store : undefined,
    parallelToolCalls: options?.parallelToolCalls,
    stream:
      typeof bodyRecord.stream === "boolean" ? bodyRecord.stream : undefined,
  };
}

export function withEndpointMarkers<
  T extends ReturnType<typeof withSerializedMetrics>,
>(
  metrics: T,
  endpoint: string,
  response?: Record<string, unknown>,
): T & { endpoint: string; responseId?: string } {
  const responseId =
    typeof response?.id === "string" && response.id.trim().length > 0
      ? response.id.trim()
      : undefined;
  return {
    ...metrics,
    endpoint,
    responseId,
  };
}
