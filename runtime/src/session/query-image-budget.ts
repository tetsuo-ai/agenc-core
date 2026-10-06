/**
 * Byte budget for inline images in the query projection.
 *
 * Tool results and pasted content carry screenshots as base64 data URLs.
 * Providers count an image as a few hundred tokens, so the token accounting
 * never sees a problem, but the wire body does: a GUI-driven session on
 * Terminal-Bench reached 54 screenshots (10.8 MB of a 11.1 MB request), and
 * every full-history resend after that was refused by the provider. The
 * durable history keeps every image; only what the model is shown on the
 * wire is bounded, to a contiguous suffix of the newest inline images.
 *
 * Which images are left out is decided by replaying the history's images
 * from oldest to newest, so every projection of one append-only history
 * agrees byte for byte. Images accumulate until they exceed the budget; the
 * oldest are then left out in one batch, down to half the budget, never the
 * newest image. Between two batches nothing moves, so the provider's cached
 * prefix breaks once per batch instead of on every new image, as it did when
 * each request kept the newest images up to the full budget. An image larger
 * than the whole budget is left out with every older image rather than
 * showing an older screen in place of a newer one.
 *
 * @module
 */

import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import { withheldImagePlaceholder } from "./query-image-withheld.js";

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

/** Sizes of the inline images, oldest first. */
function inlineImageSizes(messages: readonly LLMMessage[]): number[] {
  const sizes: number[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const bytes = inlineImageBytes(part);
      if (bytes > 0) sizes.push(bytes);
    }
  }
  return sizes;
}

/**
 * How many of the oldest images are left out, and the bytes of the rest,
 * replayed over `sizes` from oldest to newest as the module comment
 * describes.
 */
function replayImageBudget(
  sizes: readonly number[],
  budgetBytes: number,
): { readonly omitted: number; readonly retainedBytes: number } {
  const target = Math.floor(budgetBytes / 2);
  let omitted = 0;
  let retainedBytes = 0;
  for (const [index, bytes] of sizes.entries()) {
    if (bytes > budgetBytes) {
      omitted = index + 1;
      retainedBytes = 0;
      continue;
    }
    retainedBytes += bytes;
    if (retainedBytes <= budgetBytes) continue;
    while (omitted < index && retainedBytes > target) {
      retainedBytes -= sizes[omitted]!;
      omitted += 1;
    }
  }
  return { omitted, retainedBytes };
}

export function boundContextImageBytes(
  messages: readonly LLMMessage[],
  budgetBytes: number,
): BoundedImageQuery {
  const sizes = inlineImageSizes(messages);
  const totalBytes = sizes.reduce((total, bytes) => total + bytes, 0);
  if (budgetBytes <= 0 || totalBytes <= budgetBytes) {
    return { messages: [...messages], omitted: 0, retainedBytes: totalBytes, totalBytes };
  }
  const { omitted, retainedBytes } = replayImageBudget(sizes, budgetBytes);
  let toOmit = omitted;
  const out = messages.map((message): LLMMessage => {
    if (toOmit === 0 || !Array.isArray(message.content)) return message;
    let changed = false;
    const parts = message.content.map((part): LLMContentPart => {
      const bytes = inlineImageBytes(part);
      if (bytes === 0 || toOmit === 0) return part;
      toOmit -= 1;
      changed = true;
      return withheldImagePlaceholder(
        part,
        bytes > budgetBytes ? OVERSIZED_IMAGE_TEXT : OMITTED_IMAGE_TEXT,
      );
    });
    return changed ? { ...message, content: parts } : message;
  });
  return { messages: out, omitted, retainedBytes, totalBytes };
}
