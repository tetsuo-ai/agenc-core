/**
 * Per-dir text-normalization helper for `runtime/src/agents/**`.
 *
 * Mirrors the openclaude-port `runtime/src/utils/file-read.ts`
 * `normalizeExternalText` helper that `role.ts` uses to clean external
 * agent-definition text. Carved as a local `_deps/` to cut the
 * gut→openclaude crossing.
 */

export interface NormalizeOptions {
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

export function normalizeExternalText(
  content: string,
  options?: NormalizeOptions,
): string {
  if (content.length === 0) return content;
  let text = content;
  if (!options?.preserveBOM) text = stripBOM(text);
  if (!options?.preserveLineEndings) text = normalizeLineEndings(text);
  return text;
}
