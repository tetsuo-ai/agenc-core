export type CachedMCConfig = {
  triggerThreshold: number;
  keepRecent: number;
  enabled: boolean;
  supportedModels: readonly string[];
  systemPromptSuggestSummaries: boolean;
};

export type CacheEditsBlock = {
  type: "cache_edits";
  edits: { type: "delete"; cache_reference: string }[];
};

export type PinnedCacheEdits = {
  userMessageIndex: number;
  block: CacheEditsBlock;
};

export type CachedMCState = {
  readonly triggerThreshold: number;
  readonly keepRecent: number;
  registeredTools: Set<string>;
  toolOrder: string[];
  deletedRefs: Set<string>;
  pinnedEdits: PinnedCacheEdits[];
};

export function isCachedMicrocompactEnabled(): boolean {
  return false;
}

export function isModelSupportedForCacheEditing(_model: string): boolean {
  return false;
}

export function getCachedMCConfig(): CachedMCConfig | null {
  return null;
}

export function createCachedMCState(): CachedMCState {
  return {
    triggerThreshold: 0,
    keepRecent: 0,
    registeredTools: new Set<string>(),
    toolOrder: [],
    deletedRefs: new Set<string>(),
    pinnedEdits: [],
  };
}

export function markToolsSentToAPI(_state: CachedMCState): void {}

export function resetCachedMCState(state: CachedMCState): void {
  state.registeredTools.clear();
  state.toolOrder = [];
  state.deletedRefs.clear();
  state.pinnedEdits = [];
}

export function registerToolResult(
  state: CachedMCState,
  toolUseId: string,
): void {
  if (!toolUseId || state.registeredTools.has(toolUseId)) {
    return;
  }
  state.registeredTools.add(toolUseId);
  state.toolOrder.push(toolUseId);
}

export function registerToolMessage(
  _state: CachedMCState,
  _groupIds: string[],
): void {}

export function getToolResultsToDelete(state: CachedMCState): string[] {
  void state;
  return [];
}

export function createCacheEditsBlock(
  _state: CachedMCState,
  _toolsToDelete: string[],
): CacheEditsBlock | null {
  return null;
}
