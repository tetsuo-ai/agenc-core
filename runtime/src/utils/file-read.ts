/**
 * Central file-read helper — I-81 UTF-8 BOM strip + I-80 line-ending
 * normalization on every utf8 `fs.readFile` call.
 *
 * Port of openclaude `utils/jsonRead.ts::stripBOM` (line 14) plus the
 * unconditional `EOL = '\n'` pattern from `utils/markdown.ts`.
 *
 * Why a shared helper:
 *   - Windows-edited files often save with BOM (`\uFEFF`); leaving it in
 *     breaks YAML/JSON parsing, first-key matching, dedup hashing.
 *   - Mixed CRLF/LF in tool output + file input confuses the model and
 *     breaks YAML frontmatter matching in AGENTS.md / memory loader.
 *
 * Every utf8 file read in AgenC should route through `readTextFile` (or
 * `stripBOM`/`normalizeLineEndings` directly when already holding a
 * string). T10 (memory + config + AGENTS.md loader) consumes this
 * helper; T7 tool outputs normalize via a per-boundary call.
 *
 * @module
 */

import { readFile as fsReadFile } from "node:fs/promises";
import { normalizeLineEndings } from "./text.js";

const BOM = "\uFEFF";

/**
 * I-81: strip a leading UTF-8 BOM if present. Port of openclaude
 * `utils/jsonRead.ts:14`.
 */
export function stripBOM(content: string): string {
  if (content.length > 0 && content.charCodeAt(0) === 0xfeff) {
    return content.slice(1);
  }
  return content;
}

export interface ReadTextFileOptions {
  /** Skip line-ending normalization (I-80). Useful when you need the
   *  exact bytes (e.g. binary-through-text pipelines). Default false. */
  readonly preserveLineEndings?: boolean;
  /** Skip BOM strip (I-81). Default false. */
  readonly preserveBOM?: boolean;
}

/**
 * Central utf8 file read: `fs.readFile(path, 'utf8')` + BOM strip +
 * LF normalization. Unless caller opts out explicitly via options.
 *
 * Errors propagate unchanged — callers decide how to react (most
 * boundary callsites treat ENOENT as "resource absent" + continue).
 */
export async function readTextFile(
  path: string,
  options?: ReadTextFileOptions,
): Promise<string> {
  let text = await fsReadFile(path, "utf8");
  if (!options?.preserveBOM) text = stripBOM(text);
  if (!options?.preserveLineEndings) text = normalizeLineEndings(text);
  return text;
}

/**
 * Apply BOM strip + line-ending normalization to a string already in
 * memory (tool stdout, network response body, MCP result). Cheap to
 * call on every external-boundary text injection.
 */
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

export { BOM };
