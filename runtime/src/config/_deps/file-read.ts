/**
 * Per-dir file-read helper for `runtime/src/config/**`.
 *
 * Mirrors the openclaude-port `runtime/src/utils/file-read.ts` behavior:
 *   - utf8 read
 *   - I-81 BOM strip
 *   - I-80 line-ending normalization
 *
 * Carved as a local `_deps/` to cut the gut→openclaude crossing.
 */

import { readFile as fsReadFile } from "node:fs/promises";

export interface ReadTextFileOptions {
  readonly preserveLineEndings?: boolean;
  readonly preserveBOM?: boolean;
}

function stripBOM(content: string): string {
  if (content.length > 0 && content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

function normalizeLineEndings(text: string): string {
  if (text.length === 0) return text;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export async function readTextFile(
  path: string,
  options?: ReadTextFileOptions,
): Promise<string> {
  let text = await fsReadFile(path, "utf8");
  if (!options?.preserveBOM) text = stripBOM(text);
  if (!options?.preserveLineEndings) text = normalizeLineEndings(text);
  return text;
}

export function normalizeExternalText(
  content: string,
  options?: ReadTextFileOptions,
): string {
  if (content.length === 0) return content;
  let text = content;
  if (!options?.preserveBOM) text = stripBOM(text);
  if (!options?.preserveLineEndings) text = normalizeLineEndings(text);
  return text;
}
