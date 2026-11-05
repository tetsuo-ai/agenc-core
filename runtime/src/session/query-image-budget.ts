/**
 * Byte budget for inline images in the query projection.
 *
 * Tool results and pasted content carry screenshots as base64 data URLs.
 * Providers count an image as a few hundred tokens, so the token accounting
 * never sees a problem, but the wire body does: a GUI-driven session on
 * Terminal-Bench reached 54 screenshots (10.8 MB of a 11.1 MB request), and
 * every full-history resend after that was refused by the provider. The
 * durable history keeps every image; only what the model is shown on the
 * wire is bounded. Images are already normalized by their ingestion paths,
 * never by this projection.
 *
 * Which images are left out is decided by replaying the history's images
 * from oldest to newest, so every projection of one append-only history
 * agrees byte for byte. Images are admitted in order while they fit, and an
 * admitted image stays unchanged. When a new image does not fit, the oldest
 * are left out in one batch, down to half the budget, and the new image is
 * admitted. Between two batches nothing moves, so the provider's cached
 * prefix breaks once per batch instead of on every new image, as it did when
 * each request kept the newest images up to the full budget. An image larger
 * than the whole budget is left out with every older image rather than
 * showing an older screen in place of a newer one.
 *
 * `boundContextImageBytes` applies exactly that and keeps a contiguous suffix
 * of the newest images. Providers whose cached prompt depends on unchanged
 * earlier content use `admitContextImageBytes`: the same batches, and the
 * current turn's own images (those sent with the request that started the
 * turn, and those of the latest tool results) are never left out while they
 * fit the budget together; older images go first.
 *
 * @module
 */

import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import { preservesQueryPrefix } from "./query-prefix-providers.js";
import { withheldImagePlaceholder } from "./query-image-withheld.js";

// Only the previous admitted image set is retained, bounded by the wire
// budget. A session key avoids mixing concurrent conversations or turns.
const sentImages = new WeakMap<object, ReadonlySet<string>>();

function contextImageUrls(messages: readonly LLMMessage[]): Set<string> {
  return new Set(messages.flatMap(message => Array.isArray(message.content)
    ? message.content.flatMap(part => part.type === "image_url" ? [part.image_url.url] : []) : []));
}

export function rememberSentContextImages(session: object, messages: readonly LLMMessage[]): void {
  sentImages.set(session, contextImageUrls(messages));
}

export function resetSentContextImages(session: object): void {
  sentImages.delete(session);
}

/** A durable replacement can omit a new image before the model sees it. */
export function unseenImageSourcesRemovedByCompaction(
  session: object,
  prepared: readonly LLMMessage[],
  replacement: readonly LLMMessage[],
): string[] {
  const retained = contextImageUrls(replacement);
  const missing = new Set([...contextImageUrls(prepared)].filter(url =>
    !sentImages.get(session)?.has(url) && !retained.has(url),
  ));
  const calls = new Map(prepared.flatMap(message => message.toolCalls ?? []).map(call => [call.id, call]));
  const sources: string[] = [];
  for (const message of prepared) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type !== "image_url" || !missing.delete(part.image_url.url)) continue;
      const call = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
      let source = "the newly attached image";
      if (call?.name === "FileRead") {
        try {
          const args: unknown = JSON.parse(call.arguments);
          if (args !== null && typeof args === "object" && "file_path" in args && typeof args.file_path === "string") {
            source = JSON.stringify(args.file_path);
          }
        } catch { /* A missing source still needs a read-again notice. */ }
      }
      sources.push(source);
    }
  }
  return sources;
}

export const DEFAULT_CONTEXT_IMAGE_BUDGET_BYTES = 6 * 1024 * 1024;
export const CONTEXT_IMAGE_BUDGET_ENV = "AGENC_CONTEXT_IMAGE_BUDGET_BYTES";
export const OMITTED_IMAGE_TEXT =
  "[image omitted: an earlier screenshot is no longer in context; capture or read it again if it is still needed]";
export const OVERSIZED_IMAGE_TEXT =
  "[image omitted: this image exceeds the inline image request limit; resize it or capture a smaller version before sending it again]";

/** A new image that the request cannot carry next to its newer images. */
export function unfitImageText(source: string): string {
  return `[image not inspected: ${source} does not fit in the inline image budget together with the newer images of this request. ` +
    "Do not claim visual verification. Read or capture it again on its own, or use a smaller crop.]";
}

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

type AdmissionVerdict = "kept" | "evicted" | "unfit" | "oversized";

interface AdmittedImage {
  /** Position among the history's inline images, oldest first. */
  readonly index: number;
  readonly bytes: number;
  readonly batch: number;
}

/**
 * The verdict for every inline image, oldest first. A batch is what one
 * request adds: the messages after an assistant message. A batch after an
 * assistant message without tool calls (or the first batch) starts a turn.
 * The images of the turn's first batch and of the newest batch belong to the
 * current turn. Only the messages up to an image decide its verdict, so an
 * appended message never changes an earlier one.
 */
function replayAdmission(
  messages: readonly LLMMessage[],
  budgetBytes: number,
): { readonly verdicts: readonly AdmissionVerdict[]; readonly retainedBytes: number } {
  const target = Math.floor(budgetBytes / 2);
  const verdicts: AdmissionVerdict[] = [];
  const admitted: AdmittedImage[] = [];
  let retainedBytes = 0;
  let batch = 0;
  let turnBatch = 0;
  const leaveOut = (position: number): void => {
    const [image] = admitted.splice(position, 1);
    retainedBytes -= image!.bytes;
    // An image of an earlier batch was sent with it; one of this batch was not.
    verdicts[image!.index] = image!.batch === batch ? "unfit" : "evicted";
  };
  for (const message of messages) {
    if (message.role === "assistant") {
      batch += 1;
      if (message.toolCalls === undefined || message.toolCalls.length === 0) turnBatch = batch;
    }
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      const bytes = inlineImageBytes(part);
      if (bytes === 0) continue;
      const index = verdicts.length;
      const ownedByTurn = (image: AdmittedImage): boolean => image.batch === batch || image.batch === turnBatch;
      if (bytes > budgetBytes) {
        for (let position = 0; position < admitted.length;) {
          if (ownedByTurn(admitted[position]!)) position += 1;
          else leaveOut(position);
        }
        verdicts.push("oversized");
        continue;
      }
      if (retainedBytes + bytes > budgetBytes) {
        // One batch: the oldest images outside the current turn, down to half.
        for (let position = 0; position < admitted.length && retainedBytes + bytes > target;) {
          if (ownedByTurn(admitted[position]!)) position += 1;
          else leaveOut(position);
        }
        // The current turn's images alone exceed the budget: the newest stay.
        while (retainedBytes + bytes > budgetBytes) leaveOut(0);
      }
      verdicts.push("kept");
      admitted.push({ index, bytes, batch });
      retainedBytes += bytes;
    }
  }
  return { verdicts, retainedBytes };
}

function imageSource(message: LLMMessage, calls: ReadonlyMap<string, { readonly name: string; readonly arguments: string }>): string {
  const call = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
  if (call?.name === "FileRead") {
    try {
      const args: unknown = JSON.parse(call.arguments);
      if (args !== null && typeof args === "object" && "file_path" in args && typeof args.file_path === "string") {
        return JSON.stringify(args.file_path);
      }
    } catch { /* The generic notice still identifies an unseen image. */ }
  }
  return "this newly attached image";
}

/** The image budget for providers that cache unchanged earlier content. */
export function admitContextImageBytes(
  messages: readonly LLMMessage[],
  budgetBytes: number,
): BoundedImageQuery {
  const totalBytes = inlineImageSizes(messages).reduce((total, bytes) => total + bytes, 0);
  if (budgetBytes <= 0 || totalBytes <= budgetBytes) {
    return { messages: [...messages], omitted: 0, retainedBytes: totalBytes, totalBytes };
  }
  const { verdicts, retainedBytes } = replayAdmission(messages, budgetBytes);
  const calls = new Map(messages.flatMap(message => message.toolCalls ?? []).map(call => [call.id, call]));
  let next = 0;
  let omitted = 0;
  const out = messages.map((message): LLMMessage => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const parts = message.content.map((part): LLMContentPart => {
      if (inlineImageBytes(part) === 0) return part;
      const verdict = verdicts[next++];
      if (verdict === "kept") return part;
      omitted++;
      changed = true;
      return withheldImagePlaceholder(part, verdict === "evicted" ? OMITTED_IMAGE_TEXT
        : verdict === "oversized" ? OVERSIZED_IMAGE_TEXT
          : unfitImageText(imageSource(message, calls)));
    });
    return changed ? { ...message, content: parts } : message;
  });
  return { messages: out, omitted, retainedBytes, totalBytes };
}

/** The image budget this provider's request projection applies. */
export function boundContextImagesForProvider(
  messages: readonly LLMMessage[],
  budgetBytes: number,
  provider: string | undefined,
): BoundedImageQuery {
  return preservesQueryPrefix(provider)
    ? admitContextImageBytes(messages, budgetBytes)
    : boundContextImageBytes(messages, budgetBytes);
}
