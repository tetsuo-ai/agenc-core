/**
 * Post-compaction cleanup.
 *
 * The reference runtime clears `context.readFileState` and
 * `context.loadedNestedMemoryPaths` after compaction so that
 * post-compact tool calls get fresh file content instead of stale
 * `FILE_UNCHANGED_STUB` responses for files whose content was just
 * summarized away.
 *
 * @module
 */

import { clearSessionReadCache } from "../../tools/system/filesystem.js";

export function runPostCompactCleanup(sessionId: string): void {
  clearSessionReadCache(sessionId);
}
