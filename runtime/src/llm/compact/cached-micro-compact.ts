// @ts-nocheck
// Stub - cachedMicrocompact is a feature-gated openclaude module whose full
// source is not in the upstream snapshot. The `feature('CACHED_MICROCOMPACT')`
// branch resolves to `false` in AgenC via the `bun:bundle` shim, so every
// consumer below is dead code at runtime. The extra `any`-typed exports exist
// only so `micro-compact.ts`'s `typeof import('./cached-micro-compact.js')`
// references type-resolve cleanly.
export function isCachedMicrocompactEnabled(): boolean {
  return false;
}

export function isModelSupportedForCacheEditing(_model: string): boolean {
  return false;
}

export function getCachedMCConfig(): { triggerThreshold: number; keepRecent: number } {
  return { triggerThreshold: 0, keepRecent: 0 };
}

export type CachedMCState = any;
export type CacheEditsBlock = any;
export type PinnedCacheEdits = any;

export function createCachedMCState(): CachedMCState {
  return {} as any;
}

export function markToolsSentToAPI(_state: CachedMCState): void {}

export function resetCachedMCState(_state: CachedMCState): void {}

export function registerToolResult(
  _state: CachedMCState,
  _toolUseId: string,
): void {}

export function registerToolMessage(
  _state: CachedMCState,
  _groupIds: string[],
): void {}

export function getToolResultsToDelete(_state: CachedMCState): string[] {
  return [];
}

export function createCacheEditsBlock(
  _state: CachedMCState,
  _toolsToDelete: string[],
): CacheEditsBlock {
  return {} as any;
}
