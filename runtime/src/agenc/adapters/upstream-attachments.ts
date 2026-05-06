/**
 * Convert the upstream `<PromptInput>` `pastedContents` map into an
 * `LLMMessage` that AgenC's session can enqueue ahead of the text
 * submit. Without this conversion, pasted images and large text blocks
 * appear in the composer UI but are silently dropped on submit (the
 * runtime only sees the trimmed text value).
 *
 * The shape contract:
 *   - text entries become `{ type: "text", text: content }` parts
 *   - image entries become `{ type: "image_url", image_url: { url } }`
 *     parts where `url` is a `data:<mediaType>;base64,<content>` URL
 *   - parts are ordered by the `id` field (paste order)
 *   - returns `null` when the record has no entries (callers skip the
 *     enqueue path entirely in that case)
 *
 * @module
 */
import type { LLMContentPart, LLMMessage } from "../../llm/types.js";
import type { PastedContent } from "../../utils/config.js";

const DEFAULT_IMAGE_MEDIA_TYPE = "image/png";

export function pastedContentsToLLMMessage(
  pastedContents: Record<number, PastedContent>,
): LLMMessage | null {
  const ordered = Object.values(pastedContents).sort((a, b) => a.id - b.id);
  if (ordered.length === 0) return null;
  const parts: LLMContentPart[] = [];
  for (const item of ordered) {
    if (item.type === "text") {
      parts.push({ type: "text", text: item.content });
    } else if (item.type === "image") {
      const mediaType = item.mediaType ?? DEFAULT_IMAGE_MEDIA_TYPE;
      const url = `data:${mediaType};base64,${item.content}`;
      parts.push({ type: "image_url", image_url: { url } });
    }
  }
  if (parts.length === 0) return null;
  return { role: "user", content: parts };
}
