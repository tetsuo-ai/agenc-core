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

/**
 * True when `body` is canonical base64: well formed, and re-encoding the bytes
 * reproduces it exactly. The round-trip is the part that matters. Splicing a
 * redaction marker into a base64 payload leaves something that still looks
 * base64-ish but no longer round-trips, and that is what reaches a provider as
 * "Invalid base64 data".
 */
export function isCanonicalBase64Body(body: string): boolean {
  if (body.length === 0) return false;
  // A nested quantifier such as (?:[A-Za-z0-9+/]{4})* overflows the regex
  // stack on multi-megabyte payloads, well inside the inline budget, so the
  // shape check stays single level and the round trip below does the real work.
  if (body.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(body)) return false;
  return Buffer.from(body, "base64").toString("base64") === body;
}

/** The base64 body of a `data:<type>;base64,<body>` URL, or null. */
export function base64DataUrlBody(url: string): string | null {
  const match = /^data:[^;,]+;base64,(.*)$/s.exec(url);
  return match === null ? null : match[1]!;
}

/**
 * True when this content part carries validated binary whose bytes must reach
 * the provider intact: an inline base64 image, or a base64 PDF document. A
 * payload that merely claims to be binary but is not canonical base64 is NOT
 * media, so labelling plaintext `data:image/png;base64,` buys it nothing and
 * it stays subject to ordinary redaction.
 */
function imageCarrierBody(record: Record<string, unknown>): string | null {
  const image = record.image_url;
  if (!image || typeof image !== "object") return null;
  const url = (image as Record<string, unknown>).url;
  if (typeof url !== "string") return null;
  const body = base64DataUrlBody(url);
  return body !== null && isCanonicalBase64Body(body) ? body : null;
}

function documentCarrierBody(record: Record<string, unknown>): string | null {
  const source = record.source;
  if (!source || typeof source !== "object") return null;
  const fields = source as Record<string, unknown>;
  if (fields.type !== "base64" || typeof fields.data !== "string") return null;
  return isCanonicalBase64Body(fields.data) ? fields.data : null;
}

function runtimeImageCarrierBody(record: Record<string, unknown>): string | null {
  const source = record.source;
  if (!source || typeof source !== "object") return null;
  const fields = source as Record<string, unknown>;
  if (typeof fields.url === "string") {
    const body = base64DataUrlBody(fields.url);
    return body !== null && isCanonicalBase64Body(body) ? body : null;
  }
  if (fields.type === "base64" && typeof fields.data === "string") {
    return isCanonicalBase64Body(fields.data) ? fields.data : null;
  }
  return null;
}

export function validatedBinaryCarrierBody(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const record = part as Record<string, unknown>;
  // The same payload wears two shapes: `image_url` in a durable ResponseItem
  // and `image` with a `source` in a live RuntimeMessage. Recognising only one
  // makes the writer and the compaction projection disagree about which
  // carriers survive, which is what pin_failed reports.
  if (record.type === "image_url") return imageCarrierBody(record);
  if (record.type === "image") return runtimeImageCarrierBody(record);
  if (record.type === "document") return documentCarrierBody(record);
  return null;
}

/** The text that stands in for a carrier we refuse to persist or replay. */
export const OMITTED_BINARY_CARRIER_TEXT =
  "[omitted: secret redaction would have altered this binary payload]";

/**
 * Replace every validated binary carrier whose bytes `alters` reports as
 * changed with a text omission. One rule, used by durable persistence and by
 * the compaction projection: if the two ever disagree about which carriers
 * survive, a caller message can no longer match its own canonical record.
 */
export function omitAlteredBinaryCarriers(
  source: unknown,
  target: unknown,
  alters: (body: string) => boolean,
): { readonly content: unknown; readonly omitted: boolean } {
  if (!Array.isArray(source) || !Array.isArray(target)) {
    return { content: target, omitted: false };
  }
  if (source.length !== target.length) return { content: target, omitted: false };
  let omitted = false;
  // Eligibility is decided from `source` (the original, which still holds the
  // real bytes), but every surviving part comes from `target` (the redacted
  // content). Rebuilding from `source` would hand unredacted sibling text back
  // to the durable record.
  const kept = target.map((part, index) => {
    const body = validatedBinaryCarrierBody(source[index]);
    if (body === null || !alters(body)) return part;
    omitted = true;
    return { type: "text", text: OMITTED_BINARY_CARRIER_TEXT };
  });
  return omitted ? { content: kept, omitted } : { content: target, omitted: false };
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
