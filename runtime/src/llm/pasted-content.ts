import type { LLMContentPart, LLMMessage } from "./types.js";
import type { PastedContent } from "../utils/config.js";

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
