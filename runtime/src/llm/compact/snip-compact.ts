import type { LLMContentPart, LLMMessage } from "../types.js";
import { roughTokenCountEstimation } from "../../services/tokenEstimation.js";

const SNIP_CLEAR_MESSAGE = "[Old tool result content cleared]";
const SNIP_BOUNDARY_MESSAGE = "[snip] tool result content cleared";
const SNIP_CLEAR_THRESHOLD_BYTES = 8 * 1024;

function contentToText(content: LLMMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .filter((part): part is Extract<LLMContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("");
}

function contentBytes(content: LLMMessage["content"]): number {
  return Buffer.byteLength(contentToText(content), "utf8");
}

function clearToolMessage(message: LLMMessage): LLMMessage {
  return { ...message, content: SNIP_CLEAR_MESSAGE };
}

export function snipCompactIfNeeded(messages: readonly LLMMessage[]): {
  messages: LLMMessage[];
  tokensFreed: number;
  boundaryMessage?: LLMMessage;
} {
  const next = messages.slice();
  let tokensFreed = 0;
  let changed = false;

  for (let i = 0; i < next.length; i += 1) {
    const message = next[i];
    if (!message || message.role !== "tool") {
      continue;
    }
    if (typeof message.content === "string") {
      const bytes = contentBytes(message.content);
      if (bytes <= SNIP_CLEAR_THRESHOLD_BYTES) {
        continue;
      }
      tokensFreed += Math.max(
        0,
        roughTokenCountEstimation(message.content) -
          roughTokenCountEstimation(SNIP_CLEAR_MESSAGE),
      );
      next[i] = clearToolMessage(message);
      changed = true;
      continue;
    }
    const bytes = contentBytes(message.content);
    if (bytes <= SNIP_CLEAR_THRESHOLD_BYTES) {
      continue;
    }
    tokensFreed += Math.max(
      0,
      roughTokenCountEstimation(contentToText(message.content)) -
        roughTokenCountEstimation(SNIP_CLEAR_MESSAGE),
    );
    next[i] = clearToolMessage(message);
    changed = true;
  }

  if (!changed) {
    return { messages: messages as LLMMessage[], tokensFreed: 0 };
  }

  return {
    messages: next,
    tokensFreed,
    boundaryMessage: {
      role: "system",
      content: SNIP_BOUNDARY_MESSAGE,
    },
  };
}

export const snipCompact = snipCompactIfNeeded;

export function isSnipRuntimeEnabled(): boolean {
  return true;
}
