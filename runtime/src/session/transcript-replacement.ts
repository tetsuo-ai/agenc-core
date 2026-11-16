import { hasRuntimeHistoryWrapper, RUNTIME_NOTE_PLACEHOLDER, userFacingHistoryText } from "./user-facing-history-text.js";
import { randomUUID } from "node:crypto";

import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import { isHiddenGoalContinuation } from "./hidden-goal-history.js";
import { isAuthenticatedCompactionBoundary } from "./compaction-history-marker.js";

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
    readonly reason: "partial_compact" | "rewind" | "compaction_rollback";
    readonly messages: readonly RuntimeTranscriptMessage[];
  };
}

const SYNTHETIC_MODEL = "agenc";

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

function llmHistoryToRuntimeTranscriptMessages(
  history: readonly LLMMessage[],
): RuntimeTranscriptMessage[] {
  const boundaryIndex = history.findLastIndex(isAuthenticatedCompactionBoundary);
  return history.flatMap((message, index) => {
    const projected = llmMessageToRuntimeTranscriptMessages(message, index);
    return index <= boundaryIndex && message.role === "user"
      ? projected.map((row) => ({ ...row, isVisibleInTranscriptOnly: true })) : projected;
  });
}

function llmMessageToRuntimeTranscriptMessages(
  message: LLMMessage,
  index: number,
): RuntimeTranscriptMessage[] {
  if (isHiddenGoalContinuation(message)) return [];
  switch (message.role) {
    case "system":
    case "developer":
      return [makeSystemMessage(message, index)];
    case "user":
      return [makeUserMessage(message, index)];
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
              is_error: message.runtimeOnly?.toolResultIsError === true,
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
  source: LLMMessage,
  index: number,
): RuntimeTranscriptMessage {
  const content = source.content;
  const marker = source.runtimeOnly?.compactionHistory;
  const isCompactSummary = marker?.version === 1 && marker.kind === "summary";
  const isCompactBoundary = marker?.version === 1 && marker.kind === "boundary";
  // Runtime-written wrappers and injected user-role messages (a prompt
  // queued mid-turn inside <system-reminder>, the completion gate, nudges)
  // show as the user's own words, or as a short placeholder when there are
  // none. The row stays: rewind ordinals count one row per history item.
  const display = marker === undefined ? userFacingContent(content) : { content };
  return {
    type: "user",
    message: {
      role: "user",
      content: contentForRuntime(display.content),
    },
    ...(isCompactBoundary ? { isMeta: true } : {}),
    ...(isCompactSummary ? { isCompactSummary: true } : {}),
    ...(marker === undefined ? {} : { compactionHistory: marker }),
    uuid: `history-user-${index}`,
    ...(source.runtimeOnly?.responseItemId !== undefined
      ? { canonicalUserMessageId: source.runtimeOnly.responseItemId } : {}),
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

function makeSystemMessage(
  source: LLMMessage,
  index: number,
): RuntimeTranscriptMessage {
  const marker = source.runtimeOnly?.compactionHistory;
  const isCompactBoundary = marker?.version === 1 && marker.kind === "boundary";
  return {
    type: "system",
    subtype: "informational",
    content: contentToText(source.content),
    isMeta: isCompactBoundary,
    ...(marker === undefined ? {} : { compactionHistory: marker }),
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

function userFacingContent(content: LLMMessage["content"]): {
  readonly content: LLMMessage["content"];
} {
  if (typeof content === "string") {
    if (!hasRuntimeHistoryWrapper(content)) return { content };
    const text = userFacingHistoryText(content);
    return { content: text.length > 0 ? text : RUNTIME_NOTE_PLACEHOLDER };
  }
  let changed = false;
  let visible = false;
  const parts: LLMContentPart[] = [];
  for (const part of content) {
    if (part.type !== "text") {
      visible = true;
      parts.push(part);
      continue;
    }
    if (!hasRuntimeHistoryWrapper(part.text)) {
      if (part.text.trim().length > 0) visible = true;
      parts.push(part);
      continue;
    }
    changed = true;
    const text = userFacingHistoryText(part.text);
    if (text.length === 0) continue;
    visible = true;
    parts.push({ ...part, text });
  }
  if (!changed) return { content };
  return { content: visible ? parts : [{ type: "text", text: RUNTIME_NOTE_PLACEHOLDER }] };
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
