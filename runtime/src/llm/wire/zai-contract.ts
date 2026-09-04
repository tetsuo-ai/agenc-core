/**
 * Z.AI multimodal request constraints that are stricter than the generic
 * OpenAI-compatible Chat Completions shape.
 *
 * @module
 */

import { Buffer } from "node:buffer";

import type { LLMMessage } from "../types.js";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 6_000;
const SUPPORTED_REMOTE_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);
const KNOWN_UNSUPPORTED_REMOTE_IMAGE_EXTENSIONS = new Set([
  ".avif",
  ".bmp",
  ".gif",
  ".heic",
  ".heif",
  ".svg",
  ".tif",
  ".tiff",
  ".webp",
]);

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

function pngDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  ) {
    return undefined;
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function jpegDimensions(bytes: Buffer): ImageDimensions | undefined {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  ) {
    return undefined;
  }

  // Walk marker segments until a Start Of Frame marker supplies dimensions.
  // Entropy-coded image data starts at SOS, so a missing SOF before it is not
  // a valid dimension-bearing JPEG for this preflight.
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return undefined;
    const marker = bytes[offset] ?? 0;
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    if (
      marker === 0x00 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (offset + 2 > bytes.length) return undefined;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return undefined;
    }
    const isStartOfFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isStartOfFrame) {
      if (segmentLength < 7) return undefined;
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    offset += segmentLength;
  }
  return undefined;
}

function validBase64Payload(payload: string): boolean {
  if (payload.length === 0 || payload.length % 4 === 1) return false;
  if (!/^[a-z0-9+/]*={0,2}$/iu.test(payload)) return false;
  const paddingIndex = payload.indexOf("=");
  return paddingIndex === -1 || payload.length % 4 === 0;
}

function inspectZaiImageUrl(url: string): boolean {
  const trimmed = url.trim();
  const dataUri = /^data:(image\/(?:png|jpe?g));base64,([a-z0-9+/]*={0,2})$/iu
    .exec(trimmed);
  if (dataUri) {
    const mimeType = dataUri[1]?.toLowerCase();
    const payload = dataUri[2] ?? "";
    if (!validBase64Payload(payload)) return false;

    // Reject before allocating another large buffer. Base64 expands source
    // bytes by roughly 4/3; exact decoded length is checked below as well.
    const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
    const estimatedBytes = Math.floor((payload.length * 3) / 4) - padding;
    if (estimatedBytes <= 0 || estimatedBytes >= MAX_IMAGE_BYTES) return false;
    const bytes = Buffer.from(payload, "base64");
    if (
      bytes.length !== estimatedBytes ||
      bytes.toString("base64").replace(/=+$/u, "") !==
        payload.replace(/=+$/u, "")
    ) {
      return false;
    }
    const dimensions = mimeType === "image/png"
      ? pngDimensions(bytes)
      : jpegDimensions(bytes);
    return dimensions !== undefined &&
      dimensions.width > 0 &&
      dimensions.height > 0 &&
      dimensions.width <= MAX_IMAGE_DIMENSION &&
      dimensions.height <= MAX_IMAGE_DIMENSION;
  }
  if (trimmed.toLowerCase().startsWith("data:")) return false;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    const lastDot = parsed.pathname.lastIndexOf(".");
    if (lastDot < 0) return true;
    const extension = parsed.pathname.slice(lastDot).toLowerCase();
    if (SUPPORTED_REMOTE_IMAGE_EXTENSIONS.has(extension)) return true;
    return !KNOWN_UNSUPPORTED_REMOTE_IMAGE_EXTENSIONS.has(extension);
  } catch {
    return false;
  }
}

/** Validate direct images and best-effort strip invalid tool images for Z.AI. */
export function applyZaiImageInputContract(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  for (const message of messages) {
    if (message.role === "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "image_url") continue;
      if (message.role !== "user") {
        throw new TypeError("Z.AI image input is supported only in user messages");
      }
      if (!inspectZaiImageUrl(part.image_url.url)) {
        throw new TypeError(
          "Z.AI image input must be a JPEG or PNG under 5 MiB with dimensions " +
            "no larger than 6000x6000",
        );
      }
    }
  }

  return messages.map((message): LLMMessage => {
    if (message.role !== "tool" || !Array.isArray(message.content)) {
      return message;
    }
    let changed = false;
    const content = message.content.filter((part) => {
      if (part.type !== "image_url") return true;
      if (inspectZaiImageUrl(part.image_url.url)) return true;
      changed = true;
      return false;
    });
    return changed ? { ...message, content } : message;
  });
}
