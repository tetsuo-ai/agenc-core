/**
 * Re-export the watch diff display-line builder for TUI transcript renderers.
 */

import * as watchDiff from "../../watch/agenc-watch-diff-render.mjs";

export interface DiffDisplayLine {
  readonly text: string;
  readonly plainText: string;
  readonly mode: string;
  readonly language?: string;
  readonly [key: string]: unknown;
}

interface WatchDiffModule {
  readonly buildDiffDisplayLines: (
    event: unknown,
    options?: { readonly cwd?: string; readonly maxPathChars?: number },
  ) => DiffDisplayLine[];
}

const watch = watchDiff as unknown as WatchDiffModule;

export const buildDiffDisplayLines = watch.buildDiffDisplayLines;
