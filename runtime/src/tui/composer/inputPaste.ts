import {
  normalizeUserImageInput,
  type NormalizedUserImageInput,
} from "../../prompts/attachments/user-image-input.js";

/**
 * Paste-truncation helpers.
 *
 * Large pasted blobs are kept out of the live buffer so the renderer
 * stays responsive. The first/last `PREVIEW_LENGTH/2` characters stay
 * inline; the middle slab is replaced with a `[...Truncated text #N
 * +M lines...]` placeholder and stashed in `pastedContents`. Submission
 * inlines the stashed content back into the prompt before it leaves
 * the runtime.
 */

/**
 * Composer-side mirror of the upstream `PastedContent` row. Kept local
 * so this module does not depend on the runtime config schema.
 */
export type PastedContent = {
  readonly id: number;
  readonly type: "text" | "image";
  readonly content: string;
  readonly mediaType?: string;
  readonly filename?: string;
  readonly sourcePath?: string;
};

export type NormalizedPastedImageSource = NormalizedUserImageInput;

const TRUNCATION_THRESHOLD = 10000;
const PREVIEW_LENGTH = 1000;

type TruncatedMessage = {
  readonly truncatedText: string;
  readonly placeholderContent: string;
};

/**
 * `"line1\nline2\nline3"` is treated as `+2 lines` (newline count, not
 * line count) — matches the original Ink runtime's display and keeps
 * the placeholder string compatible with history entries written by
 * older sessions.
 */
export function getPastedTextRefNumLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g) ?? []).length;
}

export function formatPastedTextRef(id: number, numLines: number): string {
  if (numLines === 0) {
    return `[Pasted text #${id}]`;
  }
  return `[Pasted text #${id} +${numLines} lines]`;
}

export function formatImageRef(id: number): string {
  return `[Image #${id}]`;
}

/**
 * Resolve a pasted single-token image reference into concrete attachment
 * metadata. Supports local paths, file:// URLs, remote image URLs, and data
 * image URLs. Multi-line text returns null so regular paste handling can
 * preserve the text.
 */
export function normalizePastedImageSource(
  input: string,
  cwd: string,
  home?: string,
): NormalizedPastedImageSource | null {
  return normalizeUserImageInput(input, cwd, home);
}

export function nextPastedContentId(
  pastedContents: Record<number, PastedContent>,
): number {
  const existingIds = Object.keys(pastedContents).map(Number);
  return existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
}

export function imageReferenceIds(input: string): Set<number> {
  const ids = new Set<number>();
  const regex = /\[Image #(\d+)\]/gu;
  for (const match of input.matchAll(regex)) {
    const id = Number(match[1]);
    if (Number.isFinite(id)) ids.add(id);
  }
  return ids;
}

/**
 * Decide whether `text` exceeds the inline cap and, if so, return the
 * shortened buffer plus the slab that has to be stashed under
 * `nextPasteId`. Caller owns adding the stashed entry to the
 * `pastedContents` map.
 */
export function maybeTruncateMessageForInput(
  text: string,
  nextPasteId: number,
): TruncatedMessage {
  if (text.length <= TRUNCATION_THRESHOLD) {
    return {
      truncatedText: text,
      placeholderContent: "",
    };
  }

  const startLength = Math.floor(PREVIEW_LENGTH / 2);
  const endLength = Math.floor(PREVIEW_LENGTH / 2);

  const startText = text.slice(0, startLength);
  const endText = text.slice(-endLength);

  const placeholderContent = text.slice(startLength, -endLength);
  const truncatedLines = getPastedTextRefNumLines(placeholderContent);

  const placeholderRef = formatTruncatedTextRef(nextPasteId, truncatedLines);

  const truncatedText = startText + placeholderRef + endText;

  return {
    truncatedText,
    placeholderContent,
  };
}

function formatTruncatedTextRef(id: number, numLines: number): string {
  return `[...Truncated text #${id} +${numLines} lines...]`;
}

/**
 * Convenience wrapper around `maybeTruncateMessageForInput` that picks
 * the next available paste id from `pastedContents` and returns the
 * updated map.
 */
export function maybeTruncateInput(
  input: string,
  pastedContents: Record<number, PastedContent>,
): { newInput: string; newPastedContents: Record<number, PastedContent> } {
  const nextPasteId = nextPastedContentId(pastedContents);

  const { truncatedText, placeholderContent } = maybeTruncateMessageForInput(
    input,
    nextPasteId,
  );

  if (!placeholderContent) {
    return { newInput: input, newPastedContents: pastedContents };
  }

  return {
    newInput: truncatedText,
    newPastedContents: {
      ...pastedContents,
      [nextPasteId]: {
        id: nextPasteId,
        type: "text",
        content: placeholderContent,
      },
    },
  };
}
