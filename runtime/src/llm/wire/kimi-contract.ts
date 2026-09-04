import { Buffer } from "node:buffer";

import type { LLMMessage } from "../types.js";

const MAX_KIMI_REQUEST_PAYLOAD_BYTES = 100_000_000;
const KIMI_INLINE_IMAGE =
  /^data:image\/(?:jpe?g|png|webp|gif|bmp|heic|heif);base64,([a-z0-9+/]*={0,2})$/iu;
const KIMI_FILE_REFERENCE = /^ms:\/\/[^\s]+$/u;

function isValidInlineImage(reference: string): boolean {
  const match = KIMI_INLINE_IMAGE.exec(reference);
  const payload = match?.[1];
  if (
    payload === undefined ||
    payload.length === 0 ||
    payload.length % 4 === 1
  ) {
    return false;
  }
  const paddingIndex = payload.indexOf("=");
  if (paddingIndex !== -1 && payload.length % 4 !== 0) return false;
  const decoded = Buffer.from(payload, "base64");
  return decoded.length > 0 &&
    decoded.toString("base64").replace(/=+$/u, "") ===
      payload.replace(/=+$/u, "");
}

/**
 * Moonshot's current Kimi models do not accept public image URLs. Keep local payload authority on
 * the caller by forwarding only inline base64 or an already-uploaded ms:// id;
 * this layer never downloads or dereferences an arbitrary URL.
 */
export function applyKimiImageInputContract(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "image_url") continue;
      const url = part.image_url.url;
      if (
        url === url.trim() &&
        (isValidInlineImage(url) || KIMI_FILE_REFERENCE.test(url))
      ) {
        continue;
      }
      throw new TypeError(
        "Kimi does not support public image URLs; provide inline base64 JPG, PNG, WebP, GIF, BMP, HEIC, or HEIF image data, or an ms:// file reference",
      );
    }
  }
  return messages;
}

/** Fail before HTTP when Moonshot's final encoded request exceeds 100 MB. */
export function assertKimiRequestPayloadSize(
  request: Record<string, unknown>,
): void {
  if (
    Buffer.byteLength(JSON.stringify(request), "utf8") >
    MAX_KIMI_REQUEST_PAYLOAD_BYTES
  ) {
    throw new TypeError(
      "Kimi requests must not exceed the 100 MB total payload limit",
    );
  }
}
