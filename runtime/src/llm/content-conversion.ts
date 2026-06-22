import type { LLMContentPart, LLMMessage } from "./types.js";

function cloneDocumentContentPart(item: object): LLMContentPart | null {
  const record = item as Record<string, unknown>;
  if (record.type !== "document") return null;
  const source =
    record.source && typeof record.source === "object"
      ? (record.source as Record<string, unknown>)
      : null;
  if (
    source?.type !== "base64" ||
    source.media_type !== "application/pdf" ||
    typeof source.data !== "string" ||
    source.data.length === 0
  ) {
    return null;
  }
  return {
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: source.data,
    },
    ...(typeof record.title === "string" && record.title.length > 0
      ? { title: record.title }
      : {}),
    ...(typeof record.filename === "string" && record.filename.length > 0
      ? { filename: record.filename }
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

function openAiImageUrl(item: object): string | null {
  if (
    "type" in item &&
    item.type === "image_url" &&
    "image_url" in item &&
    item.image_url &&
    typeof item.image_url === "object" &&
    "url" in item.image_url &&
    typeof item.image_url.url === "string"
  ) {
    return item.image_url.url;
  }
  return null;
}

function runtimeImageUrl(item: object): string | null {
  if (
    "type" in item &&
    item.type === "image" &&
    "source" in item &&
    item.source &&
    typeof item.source === "object" &&
    "url" in item.source &&
    typeof item.source.url === "string"
  ) {
    return item.source.url;
  }
  return null;
}

export function cloneLlmContent(content: unknown): LLMMessage["content"] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: LLMContentPart[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const document = cloneDocumentContentPart(item);
      if (document !== null) {
        parts.push(document);
        continue;
      }
      const imageUrl = openAiImageUrl(item);
      if (imageUrl !== null) {
        parts.push({
          type: "image_url",
          image_url: { url: imageUrl },
        });
        continue;
      }
      if ("text" in item && typeof item.text === "string") {
        parts.push({ type: "text", text: item.text });
      }
    }
    return parts;
  }
  return "";
}

export function cloneLlmMessageSnapshot(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: cloneLlmContent(message.content),
    ...(message.toolCalls !== undefined
      ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
      : {}),
    ...(message.runtimeOnly !== undefined
      ? { runtimeOnly: { ...message.runtimeOnly } }
      : {}),
  };
}

export function toRuntimeMessageContent(content: unknown): unknown {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.map((item) => {
    if (!item || typeof item !== "object") return { type: "text", text: "" };
    const document = cloneDocumentContentPart(item);
    if (document !== null) return document;
    const imageUrl = openAiImageUrl(item);
    if (imageUrl !== null) {
      return {
        type: "image",
        source: { type: "url", url: imageUrl },
      };
    }
    if ("text" in item && typeof item.text === "string") {
      return { type: "text", text: item.text };
    }
    return { ...item };
  });
}

export function fromRuntimeMessageContent(
  content: unknown,
): LLMMessage["content"] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: LLMContentPart[] = [];
  let textOnly = true;
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const document = cloneDocumentContentPart(item);
    if (document !== null) {
      textOnly = false;
      parts.push(document);
      continue;
    }
    const runtimeUrl = runtimeImageUrl(item);
    if (runtimeUrl !== null) {
      textOnly = false;
      parts.push({
        type: "image_url",
        image_url: { url: runtimeUrl },
      });
      continue;
    }
    const imageUrl = openAiImageUrl(item);
    if (imageUrl !== null) {
      textOnly = false;
      parts.push({
        type: "image_url",
        image_url: { url: imageUrl },
      });
      continue;
    }
    if ("text" in item && typeof item.text === "string") {
      parts.push({ type: "text", text: item.text });
    }
  }
  if (textOnly) {
    return parts.map((part) => part.type === "text" ? part.text : "").join("\n");
  }
  return parts;
}
