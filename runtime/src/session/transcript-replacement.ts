import { randomUUID } from "node:crypto";

import type { LLMMessage } from "../llm/types.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | {
  readonly [key: string]: JsonValue | undefined;
};
export interface RuntimeTranscriptMessage {
  readonly [key: string]: any;
}

export interface HistoryReplacedEvent {
  readonly id: string;
  readonly type: "history_replaced";
  readonly acceptedAt: string;
  readonly payload: {
    readonly reason: "partial_compact" | "rewind";
    readonly messages: readonly RuntimeTranscriptMessage[];
  };
}

const SYNTHETIC_MODEL = "agenc";
const COMPACT_BOUNDARY_PREFIX = "<compact>";
const COMPACT_SUMMARY_PREFIX =
  "This session is being continued from a previous conversation";

export function createHistoryReplacedEvent(params: {
  readonly replacementHistory: readonly LLMMessage[];
  readonly id?: string;
  readonly acceptedAt?: string;
  readonly reason?: HistoryReplacedEvent["payload"]["reason"];
}): HistoryReplacedEvent {
  const acceptedAt = params.acceptedAt ?? new Date().toISOString();
  return {
    id: params.id ?? `history-replaced-${randomUUID()}`,
    type: "history_replaced",
    acceptedAt,
    payload: {
      reason: params.reason ?? "partial_compact",
      messages: llmHistoryToRuntimeTranscriptMessages(params.replacementHistory),
    },
  };
}

export function llmHistoryToRuntimeTranscriptMessages(
  history: readonly LLMMessage[],
): RuntimeTranscriptMessage[] {
  return history.flatMap((message, index) =>
    llmMessageToRuntimeTranscriptMessages(message, index),
  );
}

function llmMessageToRuntimeTranscriptMessages(
  message: LLMMessage,
  index: number,
): RuntimeTranscriptMessage[] {
  switch (message.role) {
    case "system":
    case "developer":
      return [makeSystemMessage(contentToText(message.content), index)];
    case "user":
      return [makeUserMessage(message.content, index)];
    case "assistant": {
      const out: RuntimeTranscriptMessage[] = [];
      const content = assistantContent(message);
      if (content.length > 0) {
        out.push(makeAssistantMessage(content, index));
      }
      for (const call of message.toolCalls ?? []) {
        out.push(
          makeAssistantMessage(
            [{
              type: "tool_use",
              id: call.id,
              name: call.name,
              input: safeJson(call.arguments),
            }],
            index,
          ),
        );
      }
      return out;
    }
    case "tool":
      return [
        {
          type: "user",
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: message.toolCallId ?? `tool-${index}`,
              content: contentToText(message.content),
              is_error: false,
            }],
          },
          isMeta: true,
          uuid: `history-tool-${index}`,
          timestamp: new Date(0).toISOString(),
          toolUseResult: contentToText(message.content),
        },
      ];
  }
}

function makeUserMessage(
  content: LLMMessage["content"],
  index: number,
): RuntimeTranscriptMessage {
  const text = contentToText(content);
  const isCompactBoundary = text.startsWith(COMPACT_BOUNDARY_PREFIX);
  const isCompactSummary = text.startsWith(COMPACT_SUMMARY_PREFIX);
  return {
    type: "user",
    message: {
      role: "user",
      content: contentForRuntime(content),
    },
    ...(isCompactBoundary ? { isMeta: true } : {}),
    ...(isCompactSummary ? { isCompactSummary: true } : {}),
    uuid: `history-user-${index}`,
    timestamp: new Date(0).toISOString(),
  };
}

function makeAssistantMessage(
  content: readonly Record<string, unknown>[],
  index: number,
): RuntimeTranscriptMessage {
  return {
    type: "assistant",
    uuid: `history-assistant-${index}-${content.length}`,
    timestamp: new Date(0).toISOString(),
    message: {
      id: `history-assistant-message-${index}`,
      container: null,
      model: SYNTHETIC_MODEL,
      role: "assistant",
      stop_reason: "stop_sequence",
      stop_sequence: "",
      type: "message",
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      content,
      context_management: null,
    },
    requestId: undefined,
  };
}

function makeSystemMessage(content: string, index: number): RuntimeTranscriptMessage {
  return {
    type: "system",
    subtype: "informational",
    content,
    isMeta: false,
    timestamp: new Date(0).toISOString(),
    uuid: `history-system-${index}`,
    level: "info",
  };
}

function assistantContent(
  message: LLMMessage,
): readonly Record<string, unknown>[] {
  const text = contentToText(message.content);
  return text.trim().length > 0 ? [{ type: "text", text }] : [];
}

function contentForRuntime(content: LLMMessage["content"]): unknown {
  if (typeof content === "string") return content.length > 0 ? content : "(empty)";
  return content.map((part) => ({ ...part }));
}

function contentToText(content: LLMMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "document") return "[document]";
      return "[image]";
    })
    .filter((part) => part.trim().length > 0)
    .join("\n");
}

function safeJson(raw: string | undefined): unknown {
  if (raw === undefined || raw.trim().length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { input: raw };
  }
}
