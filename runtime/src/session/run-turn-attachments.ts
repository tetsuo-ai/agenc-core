/**
 * Placement of per-request context and attachment messages in the query
 * projection, and the last-user-text extraction the attachments
 * orchestrator reads. Pure move out of run-turn.ts; the declarations are
 * the originals byte for byte.
 *
 * @module
 */

import type { LLMMessage } from "../llm/types.js";
import {
  currentUserMessageIndex,
  isAttachmentMessage,
  lastHistoryMessageIndex,
  recordRetainedAttachments,
  type AttachmentRetentionLedger,
} from "./attachment-retention.js";
import type { TurnState } from "./turn-state.js";

/**
 * Insert runtime context/attachment messages without moving the stable
 * system-prompt prefix into the middle of the API transcript. AgenC keeps
 * the system prompt separate from conversation messages; in AgenC the prompt
 * is represented as leading `role: "system"` messages before provider wiring,
 * so user-channel context belongs immediately after that leading prefix.
 */
/**
 * Place this request's attachments and remember them in the session ledger.
 * The turn's first request puts them before the prompt, as before; later
 * requests append them after the newest history item, so everything the
 * provider already received keeps its bytes and only new items follow.
 */
function placeRetainedAttachments(
  state: TurnState,
  ledger: AttachmentRetentionLedger,
  attachmentMessages: ReadonlyArray<LLMMessage>,
): LLMMessage[] {
  const messages = state.messagesForQuery;
  if (state.attachmentsAnchoredForTurn !== true) {
    const anchorIndex = currentUserMessageIndex(messages);
    if (anchorIndex < 0) {
      return insertContextMessagesAfterLeadingSystem(messages, attachmentMessages);
    }
    recordRetainedAttachments(ledger, messages, anchorIndex, "before", attachmentMessages);
    return [
      ...messages.slice(0, anchorIndex),
      ...attachmentMessages,
      ...messages.slice(anchorIndex),
    ];
  }
  const anchorIndex = lastHistoryMessageIndex(messages);
  if (anchorIndex < 0) {
    return insertContextMessagesAfterLeadingSystem(messages, attachmentMessages);
  }
  recordRetainedAttachments(ledger, messages, anchorIndex, "after", attachmentMessages);
  return [
    ...messages.slice(0, anchorIndex + 1),
    ...attachmentMessages,
    ...messages.slice(anchorIndex + 1),
  ];
}

export function insertContextMessagesAfterLeadingSystem(
  messages: ReadonlyArray<LLMMessage>,
  contextMessages: ReadonlyArray<LLMMessage>,
): LLMMessage[] {
  if (contextMessages.length === 0) return [...messages];
  let insertAt = 0;
  while (messages[insertAt]?.role === "system") {
    insertAt += 1;
  }
  return [
    ...messages.slice(0, insertAt),
    ...contextMessages,
    ...messages.slice(insertAt),
  ];
}

/**
 * Insert per-turn attachment messages immediately before the current human
 * message instead of right after the leading system prompt. Attachments
 * differ from one model call to the next (one-shot producers such as the
 * skills listing and memory recall appear on the first call of a turn only),
 * so a message at position two shifted every later item and left nothing but
 * the system prompt for the provider's prompt cache to reuse. Placed at the
 * tail, the whole prior history stays a stable, cacheable prefix; only the
 * tail changes. The human message itself is any user message that is not a
 * context attachment. Without one the leading-system placement is kept.
 */
export function insertContextMessagesBeforeCurrentUser(
  messages: ReadonlyArray<LLMMessage>,
  contextMessages: ReadonlyArray<LLMMessage>,
): LLMMessage[] {
  if (contextMessages.length === 0) return [...messages];
  let insertAt = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "user" &&
      message.runtimeOnly?.mergeBoundary === undefined &&
      message.runtimeOnly?.agentInvocation === undefined
    ) {
      insertAt = index;
      break;
    }
  }
  if (insertAt < 0) {
    return insertContextMessagesAfterLeadingSystem(messages, contextMessages);
  }
  return [
    ...messages.slice(0, insertAt),
    ...contextMessages,
    ...messages.slice(insertAt),
  ];
}

/**
 * Extract the most recent user-channel message text for the per-turn
 * attachments orchestrator. Walks backwards through the projected query
 * messages, returning the first user message's text or null if none
 * exist (e.g. opening-turn replays where the rolled-back projection is
 * empty).
 */
function extractLastUserText(
  messages: ReadonlyArray<LLMMessage>,
): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "user") continue;
    // Retained attachments are user-channel context, not what the user asked.
    if (isAttachmentMessage(message)) continue;
    if (typeof message.content === "string") {
      return message.content.length > 0 ? message.content : null;
    }
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: unknown }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          const text = (part as { text: string }).text;
          if (text.length > 0) return text;
        }
      }
    }
    return null;
  }
  return null;
}

// Shared with run-turn.ts and its sibling modules.
export {
  placeRetainedAttachments,
  extractLastUserText,
};
