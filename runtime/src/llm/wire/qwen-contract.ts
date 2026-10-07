import type { LLMMessage } from "../types.js";

/** Alibaba's Beijing direct Kimi route accepts remote URLs, but no inline images. */
export function applyQwenKimiImageInputContract(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "image_url") continue;
      const reference = part.image_url.url;
      let url: URL | undefined;
      try { url = new URL(reference); } catch { /* Report the contract below. */ }
      if (reference === reference.trim() && url &&
        (url.protocol === "https:" || url.protocol === "http:") &&
        url.username === "" && url.password === "") continue;
      throw new TypeError(
        "Qwen's direct Kimi route requires a public HTTP(S) image URL; inline base64 and file references are unsupported",
      );
    }
  }
  return messages;
}
