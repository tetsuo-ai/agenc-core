import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import type { ResponseItem } from "./rollout-item.js";

type RolloutContentPart = Extract<
  ResponseItem["content"],
  ReadonlyArray<unknown>
>[number];

export function llmMessageToResponseItem(message: LLMMessage): ResponseItem {
  return {
    role: message.role,
    content: cloneContent(message.content),
    ...(message.toolCalls !== undefined
      ? {
          toolCalls: message.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments,
          })),
        }
      : {}),
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.phase !== undefined ? { phase: message.phase } : {}),
  };
}

export function responseItemToLlmMessage(item: ResponseItem): LLMMessage {
  return {
    role: item.role,
    content: cloneContent(item.content),
    ...(item.toolCalls !== undefined
      ? {
          toolCalls: item.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            arguments: call.arguments ?? "",
          })),
        }
      : {}),
    ...(item.phase === "commentary" || item.phase === "final_answer"
      ? { phase: item.phase }
      : {}),
    ...(item.toolCallId !== undefined ? { toolCallId: item.toolCallId } : {}),
    ...(item.toolName !== undefined ? { toolName: item.toolName } : {}),
  };
}

export function cloneLlmMessage(message: LLMMessage): LLMMessage {
  return {
    ...message,
    content: cloneContent(message.content),
    ...(message.toolCalls !== undefined
      ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
      : {}),
  };
}

function cloneContent(
  content: LLMMessage["content"] | ResponseItem["content"],
): LLMMessage["content"] {
  if (typeof content === "string") return content;
  const cloned: LLMContentPart[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const record = part as RolloutContentPart;
    if (record.type === "document") {
      const source =
        record.source && typeof record.source === "object"
          ? (record.source as Record<string, unknown>)
          : null;
      if (
        source?.type === "base64" &&
        source.media_type === "application/pdf" &&
        typeof source.data === "string"
      ) {
        cloned.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: source.data,
          },
          ...(typeof record.title === "string" ? { title: record.title } : {}),
          ...(typeof record.filename === "string"
            ? { filename: record.filename }
            : {}),
          ...(typeof record.fallbackText === "string"
            ? { fallbackText: record.fallbackText }
            : {}),
          ...(typeof record.fallbackTextTruncated === "boolean"
            ? { fallbackTextTruncated: record.fallbackTextTruncated }
            : {}),
          ...(typeof record.fallbackTextError === "string"
            ? { fallbackTextError: record.fallbackTextError }
            : {}),
        });
      }
      continue;
    }
    if (record.type === "image_url") {
      const image =
        record.image_url && typeof record.image_url === "object"
          ? (record.image_url as Record<string, unknown>)
          : null;
      if (typeof image?.url === "string") {
        cloned.push({
          type: "image_url",
          image_url: { url: image.url },
        });
      }
      continue;
    }
    if (typeof record.text === "string") {
      cloned.push({ type: "text", text: record.text });
    }
  }
  return cloned.length > 0 ? cloned : "";
}
