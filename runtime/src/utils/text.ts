/**
 * Text normalization helpers — I-80 line-ending + related small
 * cross-cutting text utilities.
 *
 * Port of openclaude `utils/markdown.ts:14-17` (`EOL = '\n'`
 * unconditional) extended with an explicit normalizer callable from
 * every external boundary (file reads, tool stdout, network
 * responses, MCP results) per I-80.
 *
 * @module
 */

/**
 * Canonical intra-buffer line terminator. Use `\n` unconditionally:
 * `os.EOL` is `\r\n` on Windows, and the extra `\r` breaks downstream
 * parsers (YAML key matching, grep-style tooling, string equality
 * between source and tool output).
 */
export const EOL = "\n";

/**
 * I-80: normalize line endings to LF-only.
 *
 * Two-pass replace:
 *   1. `\r\n` → `\n` (Windows)
 *   2. standalone `\r` → `\n` (old Mac / malformed)
 *
 * Idempotent; safe to call on already-normalized strings.
 */
export function normalizeLineEndings(text: string): string {
  if (text.length === 0) return text;
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
