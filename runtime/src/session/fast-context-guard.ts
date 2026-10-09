import type { LLMChatOptions, LLMMessage } from "../llm/types.js";

/**
 * A deliberately early handoff, not a replacement tokenizer. This loop owns
 * its append-only message array; inspect only the newly appended suffix. At
 * half the context window (including reserved output), use the canonical
 * accounting and compaction path. Non-text content always uses that path.
 */
export function createFastContextGuard(options: LLMChatOptions): (messages: readonly LLMMessage[]) => boolean {
  let seen = 0;
  let bytes = 8_192 + Buffer.byteLength(options.systemPrompt ?? "", "utf8") +
    Buffer.byteLength(JSON.stringify(options.tools ?? []), "utf8");
  const window = options.contextWindowTokens;
  return messages => {
    if (typeof window !== "number" || !Number.isFinite(window) || window <= 0) return false;
    if (messages.length < seen) return false;
    for (; seen < messages.length; seen++) {
      const message = messages[seen]!;
      const content = message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type !== "text") return false;
          bytes += 32 + Buffer.byteLength(part.text, "utf8");
        }
      } else if (typeof content === "string" || content === null) {
        bytes += Buffer.byteLength(content ?? "", "utf8");
      } else return false;
      bytes += 64;
      bytes += Buffer.byteLength(message.providerReasoningContent ?? "", "utf8");
      if (message.toolCalls) bytes += Buffer.byteLength(JSON.stringify(message.toolCalls), "utf8");
    }
    return bytes + (options.maxOutputTokens ?? 8_192) < window * 0.5;
  };
}
