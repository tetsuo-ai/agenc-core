// Cherry-picked ripgrep stream shim for the wholesale-ported
// GlobalSearchDialog.
//
// openclaude src/utils/ripgrep.ts (~772 LOC) shells out to rg with
// glob/respect-gitignore handling, parses the streaming JSON output,
// caches results, and yields RipGrepMatch objects. AgenC has its own
// search tool surface; this shim provides openclaude's API shape
// (an async iterator of matches) as a no-op so the dialog compiles.
// Wire to AgenC's real search path when the dialog becomes
// production.

export interface RipGrepMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
}

export interface RipGrepStreamOptions {
  readonly query: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly maxResults?: number;
}

// eslint-disable-next-line require-yield
export async function* ripGrepStream(
  _opts: RipGrepStreamOptions,
): AsyncGenerator<RipGrepMatch> {
  // Empty stream by default. AgenC consumers replace the body to
  // shell out to rg or wire to AgenC's search tool.
  return;
}
