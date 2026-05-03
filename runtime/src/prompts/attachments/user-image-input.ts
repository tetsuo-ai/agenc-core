import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { LLMContentPart } from "../../llm/types.js";

export type NormalizedUserImageInput = {
  readonly kind: "local" | "remote" | "data";
  readonly source: string;
  readonly content: string;
  readonly mediaType?: string;
  readonly filename?: string;
  readonly sourcePath?: string;
};

const IMAGE_FILE_RE = /\.(?:png|jpe?g|gif|webp)$/iu;
const REMOTE_IMAGE_URL_RE =
  /^https?:\/\/\S+\.(?:png|jpe?g|gif|webp)(?:[?#]\S*)?$/iu;
const DATA_IMAGE_RE = /^data:(image\/(?:png|jpeg|gif|webp));base64,(\S+)$/iu;

function stripInputQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function mediaTypeForImagePath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".png":
    default:
      return "image/png";
  }
}

export function isSupportedUserImagePath(filePath: string): boolean {
  return IMAGE_FILE_RE.test(filePath);
}

function localImageDataUrl(filePath: string, mediaType: string): string | null {
  try {
    const bytes = readFileSync(filePath);
    if (bytes.byteLength === 0) return null;
    return `data:${mediaType};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

export function normalizeUserImageInput(
  input: string,
  cwd: string,
  home?: string,
): NormalizedUserImageInput | null {
  const normalized = stripInputQuotes(
    input.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n"),
  );
  if (normalized.length === 0 || /\n/u.test(normalized)) return null;

  const dataMatch = DATA_IMAGE_RE.exec(normalized);
  if (dataMatch) {
    const mediaType = dataMatch[1]!;
    return {
      kind: "data",
      source: normalized,
      content: normalized,
      mediaType,
      filename: `Pasted ${mediaType.replace(/^image\//u, "")} image`,
    };
  }

  if (REMOTE_IMAGE_URL_RE.test(normalized)) {
    return {
      kind: "remote",
      source: normalized,
      content: normalized,
      mediaType: mediaTypeForImagePath(normalized.split(/[?#]/u)[0] ?? ""),
      filename: "Remote image",
      sourcePath: normalized,
    };
  }

  let candidate = normalized;
  if (normalized.startsWith("file://")) {
    try {
      candidate = fileURLToPath(normalized);
    } catch {
      return null;
    }
  }
  if (candidate.startsWith("~/") && home) {
    candidate = path.join(home, candidate.slice(2));
  }

  const absolute = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(cwd, candidate);
  if (!IMAGE_FILE_RE.test(absolute)) return null;

  try {
    if (!existsSync(absolute) || !statSync(absolute).isFile()) return null;
  } catch {
    return null;
  }

  const mediaType = mediaTypeForImagePath(absolute);
  const content = localImageDataUrl(absolute, mediaType);
  if (content === null) return null;

  return {
    kind: "local",
    source: absolute,
    content,
    mediaType,
    filename: path.basename(absolute),
    sourcePath: absolute,
  };
}

export function userImageInputsToContentParts(
  images: readonly NormalizedUserImageInput[],
): LLMContentPart[] {
  return images.map((image) => ({
    type: "image_url",
    image_url: { url: image.content },
  }));
}
