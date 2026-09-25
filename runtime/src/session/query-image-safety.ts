/**
 * Images the model must not be sent, replaced in the query projection by a
 * short note that says what was left out and why.
 *
 * Three kinds of image never reach a provider:
 *
 *   - any image when the registry knows the selected model is text-only
 *     (`resolveImageInputSupport` returns `unsupported`),
 *   - a tool-result image whose bytes are not a complete PNG, JPEG, GIF or
 *     WebP image, whatever the model,
 *   - an image the same provider and model already refused earlier in this
 *     session. Another model, or a vision model the user switches to, still
 *     receives it.
 *
 * Tool results are replayed on every later request, so an image a provider
 * refuses once is refused again on every turn that follows. On 2026-09-22 a
 * 16-byte `fake.png` read by FileRead made DeepSeek answer HTTP 400 and every
 * later prompt in that session failed within two seconds. Durable history
 * keeps the original content, like the byte budget in query-image-budget.ts:
 * only what this request shows the model changes, and compaction of the
 * request projection gets the originals back (query-image-withheld.ts).
 *
 * @module
 */

import { createHash } from "node:crypto";

import type { ImageInputSupport } from "../llm/capabilities.js";
import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import {
  FILE_READ_TOOL_NAME,
  parseFileReadImageSummary,
} from "../tools/system/file-read.js";
import { formatFileSize } from "../utils/format.js";
import {
  dataUrlDecodedByteLength,
  dataUrlMediaType,
  imageFormatLabel,
  imageMediaTypeLabel,
  inspectImageDataUrl,
} from "../utils/image-validation.js";
import { withheldImagePlaceholder } from "./query-image-withheld.js";

/**
 * A provider's refusal of one image, kept while the image is in history and
 * applied only to requests that go to the same route.
 */
export interface ProviderImageRejection {
  /** Provider that refused the request, as the session names it. */
  readonly provider: string;
  /** One-line summary of the provider's error. */
  readonly reason: string;
}

export interface ModelImagePolicy {
  readonly imageInput: ImageInputSupport;
  /** `provider/model`, as shown to the model in the note. */
  readonly modelLabel: string;
  /** The route a refusal is scoped to; see {@link imageRoute}. */
  readonly route: string;
}

export interface ImageWithholding {
  readonly messages: LLMMessage[];
  /** Images left out because the model cannot view images. */
  readonly unsupported: number;
  /** Images left out because the provider refused them earlier. */
  readonly rejected: number;
}

const MAX_NOTE_URL_CHARS = 120;
const MAX_NOTE_REASON_CHARS = 240;

/** Per session: route, then image identity, to the refusal. */
const rejectedImagesBySession = new WeakMap<
  object,
  Map<string, Map<string, ProviderImageRejection>>
>();

/** Per turn: the route of the request most recently prepared. */
const requestRouteByTurn = new WeakMap<object, string>();

/**
 * The route a request goes to: the provider and model the stream phase
 * dispatches to. A refusal says something about that route only, so it is
 * never applied to a request for another model.
 */
export function imageRoute(provider: string, model: string): string {
  return `${provider.trim().toLowerCase()}/${model.trim().toLowerCase()}`;
}

/** Record the route of the request this turn is about to send. */
export function rememberRequestImageRoute(turnKey: object, route: string): void {
  requestRouteByTurn.set(turnKey, route);
}

/** The route of the request this turn sent last, if one was prepared. */
export function requestImageRoute(turnKey: object): string | undefined {
  return requestRouteByTurn.get(turnKey);
}

/** Content identity of an image part, independent of object identity. */
export function imageContentIdentity(url: string): string {
  return createHash("sha256").update(url.trim(), "utf8").digest("hex");
}

/**
 * Remember that the route refused these images. Returns how many were not
 * already recorded, so a caller can tell whether a retry changes anything.
 *
 * Nothing is evicted while its image can still be sent. Recovery ends only
 * because every retry grows this set; an eviction cap let a request with more
 * refused images than the cap restore one image for each it recorded, so the
 * turn never recovered. `pruneRejectedImages` forgets a refusal once its
 * image has left history, which bounds the records by the images history
 * holds.
 */
export function recordRejectedImages(
  sessionKey: object,
  route: string,
  urls: readonly string[],
  rejection: ProviderImageRejection,
): number {
  let routes = rejectedImagesBySession.get(sessionKey);
  if (routes === undefined) {
    routes = new Map();
    rejectedImagesBySession.set(sessionKey, routes);
  }
  let rejected = routes.get(route);
  if (rejected === undefined) {
    rejected = new Map();
    routes.set(route, rejected);
  }
  let added = 0;
  for (const url of urls) {
    const identity = imageContentIdentity(url);
    if (rejected.has(identity)) continue;
    rejected.set(identity, rejection);
    added += 1;
  }
  return added;
}

/**
 * Forget every refusal, on every route, whose image none of `messageLists`
 * carries. The caller passes the turn's history and the request about to be
 * sent, so a refusal is kept exactly as long as its image could reach a
 * provider again; one that leaves history (compacted away, or a new
 * session state) is dropped, and a long session does not accumulate them.
 * Returns how many were forgotten.
 */
export function pruneRejectedImages(
  sessionKey: object,
  messageLists: readonly (readonly LLMMessage[])[],
): number {
  const routes = rejectedImagesBySession.get(sessionKey);
  if (routes === undefined) return 0;
  const present = new Set<string>();
  for (const messages of messageLists) {
    for (const url of requestImageUrls(messages)) {
      present.add(imageContentIdentity(url));
    }
  }
  let forgotten = 0;
  for (const [route, rejected] of routes) {
    for (const identity of rejected.keys()) {
      if (present.has(identity)) continue;
      rejected.delete(identity);
      forgotten += 1;
    }
    if (rejected.size === 0) routes.delete(route);
  }
  if (routes.size === 0) rejectedImagesBySession.delete(sessionKey);
  return forgotten;
}

/** Images this route refused in this session, or `undefined` when none. */
export function rejectedImagesFor(
  sessionKey: object,
  route: string,
): ReadonlyMap<string, ProviderImageRejection> | undefined {
  const rejected = rejectedImagesBySession.get(sessionKey)?.get(route);
  return rejected !== undefined && rejected.size > 0 ? rejected : undefined;
}

/**
 * Replace every image the selected model cannot receive: all of them when
 * the model is text-only, and any image this route refused earlier (the
 * caller passes that route's refusals). Runs before the byte budget, so the
 * budget counts only images that are sent.
 */
export function withholdImagesForModel(
  messages: readonly LLMMessage[],
  policy: ModelImagePolicy,
  rejected: ReadonlyMap<string, ProviderImageRejection> | undefined,
): ImageWithholding {
  const textOnly = policy.imageInput === "unsupported";
  if (!textOnly && rejected === undefined) {
    return { messages: [...messages], unsupported: 0, rejected: 0 };
  }
  let unsupported = 0;
  let rejectedCount = 0;
  const projected = messages.map((message) =>
    replaceImageParts(message, (url, index) => {
      if (textOnly) {
        unsupported += 1;
        return unsupportedImageNote(policy.modelLabel, describeImage(message, index, url));
      }
      const rejection = rejected?.get(imageContentIdentity(url));
      if (rejection === undefined) return undefined;
      rejectedCount += 1;
      return rejectedImageNote(rejection, describeImage(message, index, url));
    }),
  );
  return { messages: projected, unsupported, rejected: rejectedCount };
}

/**
 * Replace tool-result images whose bytes are not a complete image. Runs after
 * the byte budget, so it decodes at most the images the request still sends.
 */
export function withholdUndecodableToolImages(
  messages: readonly LLMMessage[],
): { readonly messages: LLMMessage[]; readonly undecodable: number } {
  let undecodable = 0;
  const projected = messages.map((message) => {
    if (message.role !== "tool") return message;
    return replaceImageParts(message, (url, index) => {
      const inspection = inspectImageDataUrl(url);
      if (inspection === undefined || inspection.ok) return undefined;
      undecodable += 1;
      const format =
        inspection.format === undefined
          ? undefined
          : imageFormatLabel(inspection.format);
      return undecodableImageNote(
        describeImage(message, index, url),
        format,
        inspection.reason,
      );
    });
  });
  return { messages: projected, undecodable };
}

/**
 * Image URLs a request carries, oldest first. With `newestOnly`, only those
 * after the last assistant message: the images this request adds to what the
 * previous one sent.
 */
export function requestImageUrls(
  messages: readonly LLMMessage[],
  options: { readonly newestOnly?: boolean } = {},
): string[] {
  let start = 0;
  if (options.newestOnly === true) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "assistant") {
        start = index + 1;
        break;
      }
    }
  }
  const urls: string[] = [];
  for (const message of messages.slice(start)) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "image_url" && part.image_url.url.trim().length > 0) {
        urls.push(part.image_url.url);
      }
    }
  }
  return urls;
}

/** The note that stands in for an image a text-only model cannot view. */
export function unsupportedImageNote(
  modelLabel: string,
  description: string,
): string {
  return `[Image not shown: ${modelLabel} cannot view images, so the ${description} was left out.]`;
}

/** The note that stands in for image bytes that are not a valid image. */
export function undecodableImageNote(
  description: string,
  format: string | undefined,
  reason: string,
): string {
  const kind = format === undefined ? "an image" : `a valid ${format} image`;
  return `[Image not shown: the ${description} is not ${kind} (${reason}), so it was left out.]`;
}

/** The note that stands in for an image a provider refused earlier. */
export function rejectedImageNote(
  rejection: ProviderImageRejection,
  description: string,
): string {
  return `[Image not shown: ${rejection.provider} refused the ${description} in an earlier request, so it was left out. Provider message: ${rejection.reason}]`;
}

/** One-line, bounded summary of a provider error for the note. */
export function summarizeProviderReason(message: string): string {
  const oneLine = message.replace(/\s+/gu, " ").trim();
  return oneLine.length > MAX_NOTE_REASON_CHARS
    ? `${oneLine.slice(0, MAX_NOTE_REASON_CHARS - 3)}...`
    : oneLine;
}

function replaceImageParts(
  message: LLMMessage,
  replacement: (url: string, index: number) => string | undefined,
): LLMMessage {
  if (!Array.isArray(message.content)) return message;
  let changed = false;
  const parts = message.content.map((part, index): LLMContentPart => {
    if (part.type !== "image_url") return part;
    const text = replacement(part.image_url.url, index);
    if (text === undefined) return part;
    changed = true;
    return withheldImagePlaceholder(part, text);
  });
  return changed ? { ...message, content: parts } : message;
}

/**
 * "PNG image fake.png (image/png, 16 bytes) returned by FileRead": the file
 * name when FileRead's summary line precedes the image, then the type, the
 * size and the source.
 */
function describeImage(
  message: LLMMessage,
  partIndex: number,
  url: string,
): string {
  const mediaType = dataUrlMediaType(url);
  const source =
    message.role === "tool"
      ? ` returned by ${message.toolName?.trim() || "a tool"}`
      : " attached to this message";
  if (mediaType === undefined || !url.trim().toLowerCase().startsWith("data:")) {
    const shown =
      url.length > MAX_NOTE_URL_CHARS
        ? `${url.slice(0, MAX_NOTE_URL_CHARS - 3)}...`
        : url;
    return `image at ${shown}${source}`;
  }
  const bytes = dataUrlDecodedByteLength(url);
  const details =
    bytes === undefined ? mediaType : `${mediaType}, ${formatFileSize(bytes)}`;
  const name = fileReadImageName(message, partIndex);
  const named = name === undefined ? "" : ` ${name}`;
  return `${imageMediaTypeLabel(mediaType)} image${named} (${details})${source}`;
}

function fileReadImageName(
  message: LLMMessage,
  partIndex: number,
): string | undefined {
  if (message.role !== "tool" || message.toolName !== FILE_READ_TOOL_NAME) {
    return undefined;
  }
  if (!Array.isArray(message.content)) return undefined;
  const previous = message.content[partIndex - 1];
  return previous?.type === "text"
    ? parseFileReadImageSummary(previous.text)
    : undefined;
}
