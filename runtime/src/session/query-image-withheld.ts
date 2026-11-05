/**
 * The image part behind every placeholder the query projection puts in a
 * request in place of an image: the byte budget's placeholders
 * (query-image-budget.ts) and the notes for images a model must not receive
 * (query-image-safety.ts).
 *
 * A 413 collapse compacts the request projection, and the compaction maps
 * each message it is offered onto canonical durable history. A user message
 * whose image the projection replaced has no canonical match (pin_failed),
 * and a placeholder meant for one request must never become durable.
 * Compaction therefore gets the original content back
 * (`restoreWithheldImages`).
 *
 * @module
 */

import type { LLMContentPart, LLMMessage } from "../llm/types.js";

/** Each placeholder part, to the image part it replaced. */
const withheldImageByPlaceholder = new WeakMap<object, LLMContentPart>();

/** A text part standing in for `image`, restorable by `restoreWithheldImages`. */
export function withheldImagePlaceholder(
  image: LLMContentPart,
  text: string,
): LLMContentPart {
  const placeholder: LLMContentPart = { type: "text", text };
  withheldImageByPlaceholder.set(placeholder, image);
  return placeholder;
}

/**
 * The same messages with every placeholder turned back into the image part
 * it stands for. Messages without one are returned as they are.
 */
export function restoreWithheldImages(
  messages: readonly LLMMessage[],
): LLMMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.content)) return message;
    let changed = false;
    const parts = message.content.map((part): LLMContentPart => {
      const original = withheldImageByPlaceholder.get(part);
      if (original === undefined) return part;
      changed = true;
      return original;
    });
    return changed ? { ...message, content: parts } : message;
  });
}
