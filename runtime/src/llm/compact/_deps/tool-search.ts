/**
 * Lean replacements for the tool-search helpers compact uses to
 * preserve discovered-tool knowledge across compaction. The gut
 * runtime does not implement openclaude's dynamic tool-search
 * subsystem yet; these stubs report no discovered tools and disabled
 * tool search.
 */

interface MessageLike {
  readonly type?: string;
  readonly content?: unknown;
}

export function extractDiscoveredToolNames(
  _messages: ReadonlyArray<MessageLike>,
): Set<string> {
  return new Set();
}

export async function isToolSearchEnabled(
  ..._args: unknown[]
): Promise<boolean> {
  return false;
}

export function isToolSearchEnabledOptimistic(): boolean {
  return false;
}
