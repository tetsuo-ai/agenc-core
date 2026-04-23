/**
 * Local stub for openclaude `watch/agenc-watch-markdown-*.mjs`.
 *
 * The gut TUI uses these to turn markdown text into a stream of
 * "display lines" with mode tags (`code`, `code-meta`, `plain`, etc.).
 * The full upstream implementation runs `markdown-it` plus a custom
 * diff renderer; that pipeline lives in the openclaude tree we are
 * trying to disconnect from.
 *
 * This shim provides a degraded passthrough: every input line becomes
 * a `plain` display line. UI rendering correctness is not the goal of
 * this cleanup, only removing the openclaude crossing.
 */

export interface MarkdownDisplayLine {
  readonly text: string;
  readonly plainText: string;
  readonly mode: string;
  readonly language?: string;
  readonly [key: string]: unknown;
}

export interface BuildMarkdownOptions {
  readonly cwd?: string;
  readonly maxPathChars?: number;
  readonly [key: string]: unknown;
}

const TERMINAL_CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|[\x00-\x08\x0b-\x1f\x7f]/g;

export function stripTerminalControlSequences(value: unknown): string {
  return String(value ?? "").replace(TERMINAL_CONTROL_RE, "");
}

function splitLines(value: string): string[] {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n");
}

function toPlainLine(line: string): MarkdownDisplayLine {
  const text = stripTerminalControlSequences(line);
  return {
    text,
    plainText: text,
    mode: "plain",
  };
}

export function buildMarkdownDisplayLines(
  value: string,
  _options: BuildMarkdownOptions = {},
): MarkdownDisplayLine[] {
  return splitLines(value).map(toPlainLine);
}

export function buildStreamingMarkdownDisplayLines(
  value: string,
  _options: BuildMarkdownOptions = {},
): MarkdownDisplayLine[] {
  return splitLines(value).map(toPlainLine);
}
