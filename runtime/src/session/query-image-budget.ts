/** Inline-image admission is replayed in chronological order. Once an image
 * or omission has been sent, later images cannot alter that prefix. Natural
 * compaction replaces history and starts a fresh budget. Images are already
 * normalized by their ingestion paths, never by this request projection.
 * @module
 */

import type { LLMContentPart, LLMMessage } from "../llm/types.js";
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
export const UNINSPECTED_IMAGE_TEXT =
  "[image not inspected: this newly attached image exceeds the remaining inline image budget. " +
  "Do not claim visual verification. Read or capture it again after context compaction, or use a smaller crop.]";

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

/** First-admission policy for an epoch. A later image can never evict an
 * earlier image or change an earlier omission. Natural compaction supplies
 * a new history and therefore a fresh budget without an extra summary call.
 */
export function admitContextImageBytes(
  messages: readonly LLMMessage[],
  budgetBytes: number,
): BoundedImageQuery {
  let retainedBytes = 0;
  let totalBytes = 0;
  let omitted = 0;
  const calls = new Map(messages.flatMap(message => message.toolCalls ?? []).map(call => [call.id, call]));
  const out = messages.map((message): LLMMessage => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const parts = message.content.map((part): LLMContentPart => {
      const bytes = inlineImageBytes(part);
      totalBytes += bytes;
      if (bytes === 0) return part;
      if (budgetBytes <= 0 || retainedBytes + bytes <= budgetBytes) {
        retainedBytes += bytes;
        return part;
      }
      omitted++;
      changed = true;
      let source = "this newly attached image";
      const call = message.toolCallId === undefined ? undefined : calls.get(message.toolCallId);
      if (call?.name === "FileRead") {
        try {
          const args: unknown = JSON.parse(call.arguments);
          if (args !== null && typeof args === "object" && "file_path" in args && typeof args.file_path === "string") source = JSON.stringify(args.file_path);
        } catch { /* The generic notice still identifies an unseen image. */ }
      }
      return withheldImagePlaceholder(part,
        `[image not inspected: ${source} exceeds the remaining inline image budget. ` +
        "Do not claim visual verification. Read or capture it again after context compaction, or use a smaller crop.]",
      );
    });
    return changed ? { ...message, content: parts } : message;
  });
  return { messages: out, omitted, retainedBytes, totalBytes };
}
