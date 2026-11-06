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

const omitsCarrier = (part: LLMContentPart): boolean =>
  part.type === "text" && part.text === OMITTED_BINARY_CARRIER_TEXT;

/** Who a message is across the durable round trip: a tool result's call id, a user message's id. */
function keptMessageIdentity(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const { role, toolCallId, runtimeOnly } = message as {
    readonly role?: unknown;
    readonly toolCallId?: unknown;
    readonly runtimeOnly?: { readonly userMessageId?: unknown; readonly responseItemId?: unknown };
  };
  if (role === "tool") return typeof toolCallId === "string" ? `tool:${toolCallId}` : undefined;
  const id = runtimeOnly?.userMessageId ?? runtimeOnly?.responseItemId;
  return role === "user" && typeof id === "string" ? `user:${id}` : undefined;
}

function partType(part: unknown): unknown {
  return part !== null && typeof part === "object" ? (part as { readonly type?: unknown }).type : undefined;
}

function shallowCarrierCopy(part: LLMContentPart): LLMContentPart {
  if (part.type === "image_url") return { ...part, image_url: { ...part.image_url } };
  if (part.type === "document") return { ...part, source: { ...part.source } };
  return { ...part };
}

/**
 * Put the live binary carriers back into the messages a compaction kept.
 *
 * A replacement history is read back from the durable record, where each
 * carrier that omitAlteredBinaryCarriers drops is a text omission. So every
 * such screenshot of the retained tail reached the model as that note after
 * a compaction, and a visual task lost the screens its kept analysis was
 * about (lt30 Flt30-5). The model was shown those images before the
 * compaction, so the in-memory history keeps them. The durable record keeps
 * its omission, and every projection of a kept message to its durable form
 * omits them again. A kept message is matched in `live`, the history the
 * compaction replaces, by its tool call id or its user message id, never by
 * position. Only a part that the replacement omits where the live message
 * holds a validated carrier changes, and only when every other part lines up
 * with the live message.
 */
export function restoreOmittedBinaryCarriers(
  replacement: readonly LLMMessage[],
  live: readonly unknown[],
): LLMMessage[] {
  if (!replacement.some((message) => Array.isArray(message.content) && message.content.some(omitsCarrier))) {
    return [...replacement];
  }
  // An identity seen twice restores nothing.
  const sources = new Map<string, unknown>();
  for (const message of live) {
    const key = keptMessageIdentity(message);
    if (key !== undefined) sources.set(key, sources.has(key) ? null : message);
  }
  return replacement.map((message) => {
    const content = message.content;
    if (!Array.isArray(content) || !content.some(omitsCarrier)) return message;
    const key = keptMessageIdentity(message);
    const source = key === undefined ? undefined : sources.get(key);
    const original = source !== null && typeof source === "object" ? (source as { readonly content?: unknown }).content : undefined;
    if (!Array.isArray(original) || original.length !== content.length) return message;
    if (content.some((part, index) => !omitsCarrier(part) && part.type !== partType(original[index]))) return message;
    let restored = false;
    const parts = content.map((part, index) => {
      const carrier: unknown = original[index];
      const type = partType(carrier);
      if (!omitsCarrier(part) || (type !== "image_url" && type !== "document") ||
        validatedBinaryCarrierBody(carrier) === null) return part;
      restored = true;
      return shallowCarrierCopy(carrier as LLMContentPart);
    });
    return restored ? { ...message, content: parts } : message;
  });
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
    ...(message.providerContextHistory !== undefined ? { providerContextHistory: structuredClone(message.providerContextHistory) } : {}),
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
