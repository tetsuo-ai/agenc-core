import type { LLMContentPart, LLMMessage } from "../../llm/types.js";
import type { CompactedItem, ResponseItem } from "../../session/rollout-item.js";

export type AgenCMessageRole = "system" | "user" | "assistant" | "tool";

export interface AgenCMessage {
  readonly role: AgenCMessageRole;
  readonly content: string | readonly LLMContentPart[];
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly phase?: string;
}

export function toAgenCMessage(message: LLMMessage): AgenCMessage {
  return {
    role: message.role,
    content: cloneContent(message.content),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
  };
}

export function toAgenCMessages(
  messages: readonly LLMMessage[],
): AgenCMessage[] {
  return messages.map(toAgenCMessage);
}

export function fromAgenCMessage(message: AgenCMessage): LLMMessage {
  return {
    role: message.role,
    content: cloneContent(message.content),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase === "commentary" || message.phase === "final_answer"
      ? { phase: message.phase }
      : {}),
  };
}

export function toResponseItem(message: LLMMessage): ResponseItem {
  return {
    role: message.role,
    content: cloneContent(message.content),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
  };
}

export function fromResponseItem(item: ResponseItem): LLMMessage {
  return {
    role: item.role,
    content: cloneContent(item.content as string | readonly LLMContentPart[]),
    ...(item.toolCallId !== undefined ? { toolCallId: item.toolCallId } : {}),
    ...(item.toolName !== undefined ? { toolName: item.toolName } : {}),
    ...(item.phase === "commentary" || item.phase === "final_answer"
      ? { phase: item.phase }
      : {}),
  };
}

export function buildCompactedRolloutPayload(params: {
  readonly message: string;
  readonly replacementHistory?: readonly LLMMessage[];
  readonly preCompactTokens?: number;
  readonly postCompactTokens?: number;
}): CompactedItem {
  return {
    message: params.message,
    ...(params.replacementHistory !== undefined
      ? { replacementHistory: params.replacementHistory.map(toResponseItem) }
      : {}),
    ...(params.preCompactTokens !== undefined
      ? { preCompactTokens: params.preCompactTokens }
      : {}),
    ...(params.postCompactTokens !== undefined
      ? { postCompactTokens: params.postCompactTokens }
      : {}),
  };
}

export function compactedReplacementHistory(
  item: CompactedItem,
): LLMMessage[] {
  return item.replacementHistory?.map(fromResponseItem) ?? [
    { role: "user", content: item.message },
  ];
}

function cloneContent(
  content: string | readonly LLMContentPart[],
): string | LLMContentPart[] {
  return typeof content === "string"
    ? content
    : content.map((part) => ({ ...part }));
}
