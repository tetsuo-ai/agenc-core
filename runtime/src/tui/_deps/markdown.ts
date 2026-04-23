/**
 * Re-exports the markdown display-line builders from the watch module.
 *
 * The gut TUI uses these to turn markdown text into a stream of "display
 * lines" with mode tags (`code`, `code-meta`, `plain`, etc.). The full
 * implementation lives at `runtime/src/watch/agenc-watch-markdown-*.mjs`
 * and is treated as an aesthetic lock — we only re-export it through this
 * shim so the TUI never reaches across into the openclaude tree.
 */

import * as watchMarkdown from "../../watch/agenc-watch-markdown-core.mjs";

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
  readonly width?: number;
  readonly targetWidth?: number;
  readonly tableTargetWidth?: number;
  readonly fillWidth?: boolean;
  readonly fillTables?: boolean;
  readonly [key: string]: unknown;
}

interface WatchMarkdownModule {
  readonly stripTerminalControlSequences: (value: unknown) => string;
  readonly buildMarkdownDisplayLines: (
    value: string,
    options?: BuildMarkdownOptions,
  ) => MarkdownDisplayLine[];
  readonly buildStreamingMarkdownDisplayLines: (
    value: string,
    options?: BuildMarkdownOptions,
  ) => MarkdownDisplayLine[];
}

const watch = watchMarkdown as unknown as WatchMarkdownModule;

export const stripTerminalControlSequences = watch.stripTerminalControlSequences;
export const buildMarkdownDisplayLines = watch.buildMarkdownDisplayLines;
export const buildStreamingMarkdownDisplayLines =
  watch.buildStreamingMarkdownDisplayLines;
