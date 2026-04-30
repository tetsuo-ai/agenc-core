// Cherry-picked readFileInRange shim for the wholesale-ported
// GlobalSearchDialog preview pane.
//
// openclaude src/utils/readFileInRange.ts (~383 LOC) reads file
// chunks with caching + ANSI-safe truncation + line-count tracking.
// AgenC has its own file-read tooling at runtime/src/tools/system/.
// This shim provides the openclaude API surface (returns a Promise
// resolving to null on missing) so the dialog compiles; wire to
// AgenC's real read path when the dialog becomes production.

import { readFileSync, existsSync } from "node:fs";

export interface ReadFileInRangeResult {
  readonly content: string;
  readonly lineCount: number;
  readonly truncated: boolean;
}

export async function readFileInRange(
  filePath: string,
  startLine: number,
  lineCount: number,
  _maxBytes?: number,
  _signal?: AbortSignal,
): Promise<ReadFileInRangeResult | null> {
  if (!existsSync(filePath)) return null;
  try {
    const all = readFileSync(filePath, "utf8");
    const lines = all.split(/\r?\n/);
    const slice = lines.slice(
      Math.max(0, startLine - 1),
      Math.max(0, startLine - 1) + lineCount,
    );
    return {
      content: slice.join("\n"),
      lineCount: lines.length,
      truncated: false,
    };
  } catch {
    return null;
  }
}
