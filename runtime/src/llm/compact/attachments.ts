/**
 * Message-attachment helpers for the compact pipeline.
 *
 * Compaction layers are message-centric: if they have to drop a
 * message that carried multimodal content, the content is surfaced
 * here as an explicit side channel so the caller can preserve it
 * separately from the trimmed message list.
 *
 * @module
 */

import type { LLMContentPart, LLMMessage } from "../types.js";

export interface PreservedAttachment {
  readonly messageIndex: number;
  readonly role: LLMMessage["role"];
  readonly content: readonly LLMContentPart[];
}

export function collectPreservedAttachments(
  messages: readonly LLMMessage[],
  startIndex = 0,
): readonly PreservedAttachment[] {
  const preserved: PreservedAttachment[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message || !Array.isArray(message.content) || message.content.length === 0) {
      continue;
    }
    preserved.push({
      messageIndex: startIndex + i,
      role: message.role,
      content: message.content,
    });
  }
  return preserved;
}

export function collectPreservedMessages(
  messages: readonly LLMMessage[],
): readonly LLMMessage[] {
  const preserved: LLMMessage[] = [];
  for (const message of messages) {
    if (!message || !Array.isArray(message.content)) {
      continue;
    }
    preserved.push({
      ...message,
      content: message.content.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : { type: "image_url", image_url: { url: part.image_url.url } },
      ),
    });
  }
  return preserved;
}
