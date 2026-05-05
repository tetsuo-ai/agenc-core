/**
 * Post-compact cleanup callbacks.
 *
 * Source snapshot: `src/services/compact/postCompactCleanup.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 */

import type { CompactCleanupDeps } from "./types.js";

export type PostCompactCleanupDeps = CompactCleanupDeps;

export function runPostCompactCleanup(deps: PostCompactCleanupDeps = {}): void {
  deps.clearReadFileState?.();
  deps.clearProviderResponseId?.();
  deps.clearSearchIndexes?.();
  deps.clearToolIndexes?.();
  deps.resetMicrocompactState?.();
}
