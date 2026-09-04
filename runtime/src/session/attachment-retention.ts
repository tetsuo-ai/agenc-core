/**
 * Retained attachments: every system-reminder the model has seen stays at
 * the place it was first shown.
 *
 * Attachments are never persisted into canonical history: each sampling
 * request re-projects `messagesForQuery` from `state.messages` and runs the
 * producers again. That moved the prompt bytes twice per turn: one-shot
 * attachments (tool and agent listing deltas, the auto-mode note) vanished
 * after the request that carried them, and at the next turn every reminder of
 * the previous turn was gone, so the provider's prompt cache missed from the
 * first user message onwards. Measured on a two-step session before this
 * module: 0 of 10 consecutive requests kept an unchanged prefix.
 *
 * The ledger remembers each attachment block with the canonical message it
 * was anchored to (before the user message that opened the turn, or after the
 * history item it followed) and re-inserts it on every later projection. Within
 * a turn the projection is append-only: the first request anchors its
 * reminders before the prompt, later requests append theirs after the newest
 * history item. A block whose anchor left the history (compaction) is dropped
 * with it, which also lets one-shot producers speak again after compaction.
 *
 * @module
 */

import { createHash } from "node:crypto";

import type { LLMMessage } from "../llm/types.js";

export type RetainedPlacement = "before" | "after";

export interface RetainedAttachmentBlock {
  /** Fingerprint of the history message the block is attached to. */
  readonly anchorKey: string;
  /** Where the anchor sat when the block was recorded; breaks ties only. */
  readonly anchorIndexHint: number;
  readonly placement: RetainedPlacement;
  readonly messages: readonly LLMMessage[];
}

export interface AttachmentRetentionLedger {
  blocks: RetainedAttachmentBlock[];
}

export function createAttachmentRetentionLedger(): AttachmentRetentionLedger {
  return { blocks: [] };
}

/** Attachment messages render as user-channel context, never as history. */
export function isAttachmentMessage(message: LLMMessage): boolean {
  return (
    message.role === "user" &&
    message.runtimeOnly?.mergeBoundary === "user_context"
  );
}

function contentText(message: LLMMessage): string {
  return typeof message.content === "string"
    ? message.content
    : JSON.stringify(message.content) ?? "";
}

/**
 * A history message's identity across projections. Tool results are keyed by
 * their call id because later projections may shorten their bodies; other
 * roles are keyed by content and tool-call ids, which projections never edit.
 */
export function attachmentAnchorKey(message: LLMMessage): string {
  if (message.role === "tool" && message.toolCallId) {
    return `tool:${message.toolCallId}`;
  }
  const ids = message.toolCalls?.map((call) => call.id).join(",") ?? "";
  const digest = createHash("sha256")
    .update(contentText(message))
    .digest("hex")
    .slice(0, 16);
  return `${message.role}:${digest}:${ids}`;
}

function resolveAnchor(
  positions: ReadonlyMap<string, readonly number[]>,
  block: RetainedAttachmentBlock,
): number {
  const candidates = positions.get(block.anchorKey);
  if (candidates === undefined || candidates.length === 0) return -1;
  let best = candidates[0] as number;
  for (const index of candidates) {
    if (
      Math.abs(index - block.anchorIndexHint) <
      Math.abs(best - block.anchorIndexHint)
    ) {
      best = index;
    }
  }
  return best;
}

/**
 * Re-insert every retained block around its anchor in `base`, the freshly
 * projected history without attachments. Blocks whose anchor is gone are
 * removed from the ledger; the count is returned for diagnostics.
 */
export function projectRetainedAttachments(
  base: ReadonlyArray<LLMMessage>,
  ledger: AttachmentRetentionLedger,
): { readonly messages: LLMMessage[]; readonly dropped: number } {
  if (ledger.blocks.length === 0) return { messages: [...base], dropped: 0 };
  const positions = new Map<string, number[]>();
  base.forEach((message, index) => {
    if (isAttachmentMessage(message)) return;
    const key = attachmentAnchorKey(message);
    const list = positions.get(key);
    if (list === undefined) positions.set(key, [index]);
    else list.push(index);
  });
  const before = new Map<number, LLMMessage[]>();
  const after = new Map<number, LLMMessage[]>();
  const kept: RetainedAttachmentBlock[] = [];
  let dropped = 0;
  for (const block of ledger.blocks) {
    const index = resolveAnchor(positions, block);
    if (index < 0) {
      dropped += 1;
      continue;
    }
    kept.push(block);
    const slots = block.placement === "before" ? before : after;
    const slot = slots.get(index);
    if (slot === undefined) slots.set(index, [...block.messages]);
    else slot.push(...block.messages);
  }
  ledger.blocks = kept;
  const messages: LLMMessage[] = [];
  base.forEach((message, index) => {
    const pre = before.get(index);
    if (pre !== undefined) messages.push(...pre);
    messages.push(message);
    const post = after.get(index);
    if (post !== undefined) messages.push(...post);
  });
  return { messages, dropped };
}

/**
 * Remember `attachmentMessages` as attached to `messages[anchorIndex]`, which
 * must be a history message (never an attachment).
 */
export function recordRetainedAttachments(
  ledger: AttachmentRetentionLedger,
  messages: ReadonlyArray<LLMMessage>,
  anchorIndex: number,
  placement: RetainedPlacement,
  attachmentMessages: ReadonlyArray<LLMMessage>,
): void {
  const anchor = messages[anchorIndex];
  if (anchor === undefined || isAttachmentMessage(anchor)) return;
  if (attachmentMessages.length === 0) return;
  ledger.blocks.push({
    anchorKey: attachmentAnchorKey(anchor),
    anchorIndexHint: anchorIndex,
    placement,
    messages: [...attachmentMessages],
  });
}

/** Index of the user message that opened the current turn, or -1. */
export function currentUserMessageIndex(
  messages: ReadonlyArray<LLMMessage>,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message?.role === "user" &&
      message.runtimeOnly?.mergeBoundary === undefined &&
      message.runtimeOnly?.agentInvocation === undefined
    ) {
      return index;
    }
  }
  return -1;
}

/** Index of the newest history message (attachments skipped), or -1. */
export function lastHistoryMessageIndex(
  messages: ReadonlyArray<LLMMessage>,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && !isAttachmentMessage(message)) return index;
  }
  return -1;
}
