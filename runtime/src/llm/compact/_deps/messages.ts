/**
 * Lean message-helper surface compact uses. Mirrors the upstream
 * openclaude `utils/messages.ts` API for the helpers that compact
 * actually reaches for. The Message types in `runtime/src/types/message.ts`
 * are largely `any`-typed stubs in the gut tree; these helpers operate
 * on the duck-typed shape `{ type, content, ... }` exactly as upstream
 * compact does.
 */

import { randomUUID } from "node:crypto";
import type { SystemCompactBoundaryMessage } from "../../../types/message.js";

export type { SystemCompactBoundaryMessage };

interface MessageLike {
  readonly type?: string;
  readonly subtype?: string;
  readonly content?: unknown;
  readonly message?: { readonly content?: unknown; readonly role?: string };
  readonly role?: string;
  readonly uuid?: string;
}

export function createCompactBoundaryMessage(
  trigger: "manual" | "auto",
  preTokens: number,
  lastPreCompactMessageUuid?: string,
  userContext?: string,
  messagesSummarized?: number,
): SystemCompactBoundaryMessage {
  void lastPreCompactMessageUuid;
  return {
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: randomUUID(),
    level: "info",
    compactMetadata: {
      trigger,
      preTokens,
      ...(userContext !== undefined ? { userContext } : {}),
      ...(messagesSummarized !== undefined ? { messagesSummarized } : {}),
    },
  } as unknown as SystemCompactBoundaryMessage;
}

export function isCompactBoundaryMessage(
  message: MessageLike | null | undefined,
): boolean {
  if (!message) return false;
  return message.type === "system" && message.subtype === "compact_boundary";
}

export interface UserMessageInput {
  readonly content: unknown;
  readonly isMeta?: boolean;
  readonly isVisibleInTranscriptOnly?: boolean;
  readonly isVirtual?: boolean;
  readonly isCompactSummary?: boolean;
  readonly summarizeMetadata?: unknown;
}

export function createUserMessage(input: UserMessageInput): {
  type: "user";
  uuid: string;
  timestamp: string;
  message: { role: "user"; content: unknown };
  isMeta: boolean;
  isVisibleInTranscriptOnly: boolean;
  isVirtual: boolean;
  isCompactSummary: boolean;
  summarizeMetadata?: unknown;
} {
  return {
    type: "user",
    uuid: randomUUID(),
    timestamp: new Date().toISOString(),
    message: { role: "user", content: input.content },
    isMeta: input.isMeta ?? false,
    isVisibleInTranscriptOnly: input.isVisibleInTranscriptOnly ?? false,
    isVirtual: input.isVirtual ?? false,
    isCompactSummary: input.isCompactSummary ?? false,
    ...(input.summarizeMetadata !== undefined
      ? { summarizeMetadata: input.summarizeMetadata }
      : {}),
  };
}

export function getAssistantMessageText(message: MessageLike): string | null {
  if (message?.type !== "assistant") return null;
  const content = message.message?.content ?? message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          !!part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string",
      )
      .map((part) => part.text)
      .join("");
  }
  return null;
}

export function getLastAssistantMessage<T extends MessageLike>(
  messages: ReadonlyArray<T>,
): T | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.type === "assistant") return m;
  }
  return undefined;
}

function findLastCompactBoundaryIndex(
  messages: ReadonlyArray<MessageLike>,
): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isCompactBoundaryMessage(messages[i]!)) return i;
  }
  return -1;
}

export function getMessagesAfterCompactBoundary<T extends MessageLike>(
  messages: ReadonlyArray<T>,
  _options?: { includeSnipped?: boolean },
): T[] {
  const idx = findLastCompactBoundaryIndex(messages);
  if (idx < 0) return [...messages];
  return messages.slice(idx + 1) as T[];
}

export function normalizeMessagesForAPI(
  messages: ReadonlyArray<MessageLike>,
  _tools: unknown[] = [],
): MessageLike[] {
  return messages.filter(
    (m) => m.type === "user" || m.type === "assistant",
  ) as MessageLike[];
}
