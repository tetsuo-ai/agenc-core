import { Buffer } from "node:buffer";

import type { LLMMessage, LLMUsage } from "../types.js";

/**
 * Writes are a subset of prompt_tokens, never an extra input charge. The
 * first write locks the TTL, so use response headers, not the requested TTL.
 * No cache objects, breakpoints, manual refresh or numeric block minimum are
 * documented: Moonshot performs implicit prefix matching and renews on hits.
 * https://platform.kimi.ai/docs/guide/context-caching
 */
export function kimiCacheWriteUsage(
  reportedWrites: unknown,
  headers?: Headers,
): Pick<LLMUsage, "cacheCreationInputTokens" | "cacheCreation1hInputTokens"> {
  const count = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  const headerCount = (name: string): number | undefined => {
    const value = headers?.get(name);
    return value !== undefined && value !== null && /^\d+$/u.test(value)
      ? count(Number(value)) : undefined;
  };
  const fiveMinutes = headerCount("Msh-Usage-Cache-Write-Tokens-5m");
  const oneHour = headerCount("Msh-Usage-Cache-Write-Tokens-1h");
  const total = count(reportedWrites) ??
    (fiveMinutes !== undefined && oneHour !== undefined ? fiveMinutes + oneHour : undefined);
  return {
    ...(total !== undefined ? { cacheCreationInputTokens: total } : {}),
    ...(total !== undefined && oneHour !== undefined
      ? { cacheCreation1hInputTokens: Math.min(total, oneHour) } : {}),
  };
}

const MAX_KIMI_REQUEST_PAYLOAD_BYTES = 100_000_000;
const KIMI_INLINE_IMAGE =
  /^data:image\/(?:jpe?g|png|webp|gif|bmp|heic|heif);base64,([a-z0-9+/]*={0,2})$/iu;
const KIMI_FILE_REFERENCE = /^ms:\/\/[^\s]+$/u;

function withoutBase64Padding(value: string): string {
  const paddingIndex = value.indexOf("=");
  return paddingIndex === -1 ? value : value.slice(0, paddingIndex);
}

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
    withoutBase64Padding(decoded.toString("base64")) ===
      withoutBase64Padding(payload);
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
