/**
 * Byte budget for inline images in the query projection.
 *
 * Tool results and pasted content carry screenshots as base64 data URLs.
 * Providers count an image as a few hundred tokens, so the token accounting
 * never sees a problem, but the wire body does: a GUI-driven session on
 * Terminal-Bench reached 54 screenshots (10.8 MB of a 11.1 MB request), and
 * every full-history resend after that was refused by the provider. The
 * durable history keeps every image; only what the model is shown on the
 * wire is bounded. Keep a contiguous suffix of the newest inline images up
 * to the full budget. Once an image does not fit, omit it and every older
 * inline image rather than showing an older screen in place of a newer one.
 * This stateless policy can change the retained prefix on every new image
 * at capacity; it does not promise prompt-cache hysteresis.
 *
 * @module
 */

import type { LLMContentPart, LLMMessage } from "../llm/types.js";

export const DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES = 6 * 1024 * 1024;
export const CONTEXT_IMAGE_BUDGET_ENV = "AGENC_CONTEXT_IMAGE_BUDGET_BYTES";
export const OMITTED_IMAGE_TEXT =
  "[image omitted: an earlier screenshot is no longer in context; capture or read it again if it is still needed]";
export const OVERSIZED_IMAGE_TEXT =
  "[image omitted: this image exceeds the inline image request limit; resize it or capture a smaller version before sending it again]";

/** `0` disables the budget; an unset or malformed value uses the default. */
export function resolveContextImageBudgetBytes(
  env: NodeJS.ProcessEnv,
): number {
  const raw = env[CONTEXT_IMAGE_BUDGET_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES;
  }
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES;
  }
  return Math.floor(parsed);
}

function inlineImageBytes(part: LLMContentPart): number {
  if (part.type !== "image_url") return 0;
  const url = part.image_url.url;
  return url.startsWith("data:") ? url.length : 0;
}

export interface BoundedImageQuery {
  readonly messages: LLMMessage[];
  /** Images replaced by the placeholder. */
  readonly omitted: number;
  /** Inline image bytes still on the wire. */
  readonly retainedBytes: number;
  /** Inline image bytes before bounding. */
  readonly totalBytes: number;
}

export function boundContextImageBytes(
  messages: readonly LLMMessage[],
  budgetBytes: number,
): BoundedImageQuery {
  let totalBytes = 0;
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) totalBytes += inlineImageBytes(part);
  }
  if (budgetBytes <= 0 || totalBytes <= budgetBytes) {
    return { messages: [...messages], omitted: 0, retainedBytes: totalBytes, totalBytes };
  }
  // Do not skip a newer image to fill leftover space with an older one.
  // The newest image can use the full budget on its own.
  let suffixFull = false;
  let retainedBytes = 0;
  let omitted = 0;
  const out: LLMMessage[] = new Array(messages.length);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (!Array.isArray(message.content)) {
      out[i] = message;
      continue;
    }
    let changed = false;
    const parts: LLMContentPart[] = new Array(message.content.length);
    for (let j = message.content.length - 1; j >= 0; j -= 1) {
      const part = message.content[j]!;
      const bytes = inlineImageBytes(part);
      if (bytes === 0) {
        parts[j] = part;
        continue;
      }
      if (!suffixFull && retainedBytes + bytes <= budgetBytes) {
        retainedBytes += bytes;
        parts[j] = part;
        continue;
      }
      suffixFull = true;
      parts[j] = {
        type: "text",
        text: bytes > budgetBytes ? OVERSIZED_IMAGE_TEXT : OMITTED_IMAGE_TEXT,
      };
      omitted += 1;
      changed = true;
    }
    out[i] = changed ? { ...message, content: parts } : message;
  }
  return { messages: out, omitted, retainedBytes, totalBytes };
}
