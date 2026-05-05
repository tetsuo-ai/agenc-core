/**
 * Cached micro-compact disabled surface.
 *
 * Source snapshot: `src/services/compact/cachedMicrocompact.ts` at
 * `0ca43335375beec6e58711b797d5b0c4bb5019b8`.
 *
 * Cached micro-compact is feature-disabled in the gut runtime, but callers
 * still need stable no-op state helpers.
 */

export type CachedMicrocompactState = {
  readonly enabled: false;
  readonly pinnedEdits: readonly [];
};

export function isCachedMicrocompactEnabled(): false {
  return false;
}

export function createCachedMicrocompactState(): CachedMicrocompactState {
  return { enabled: false, pinnedEdits: [] };
}

export function getCachedMicrocompactState(): CachedMicrocompactState {
  return createCachedMicrocompactState();
}

export function resetCachedMicrocompactState(): void {}

export async function maybeRunCachedMicrocompact(): Promise<null> {
  return null;
}
