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

const DEFAULT_TRIGGER_THRESHOLD = 6;
const DEFAULT_KEEP_RECENT = 5;
const DEFAULT_SUPPORTED_MODELS = ["claude", "sonnet", "opus"];

function readPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function readTruthy(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return !/^(?:0|false|off|no)$/i.test(raw);
}

export function isCachedMicrocompactEnabled(): boolean {
  return !readTruthy("AGENC_DISABLE_CACHED_MICROCOMPACT", false);
}

export function isModelSupportedForCacheEditing(model: string): boolean {
  if (!model) return false;
  const rawList = process.env.AGENC_CACHED_MICROCOMPACT_SUPPORTED_MODELS;
  if (!rawList) return true;
  const supportedModels = rawList
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return supportedModels.length === 0
    ? true
    : supportedModels.some((pattern) => model.includes(pattern));
}

export function getCachedMCConfig(): CachedMCConfig {
  return {
    triggerThreshold: readPositiveInt(
      "AGENC_CACHED_MICROCOMPACT_TRIGGER_THRESHOLD",
      DEFAULT_TRIGGER_THRESHOLD,
    ),
    keepRecent: readPositiveInt(
      "AGENC_CACHED_MICROCOMPACT_KEEP_RECENT",
      DEFAULT_KEEP_RECENT,
    ),
    enabled: isCachedMicrocompactEnabled(),
    supportedModels: process.env.AGENC_CACHED_MICROCOMPACT_SUPPORTED_MODELS
      ? process.env.AGENC_CACHED_MICROCOMPACT_SUPPORTED_MODELS.split(",")
          .map((part) => part.trim())
          .filter(Boolean)
      : DEFAULT_SUPPORTED_MODELS,
    systemPromptSuggestSummaries: true,
  };
}

export function createCachedMCState(): CachedMCState {
  const config = getCachedMCConfig();
  return {
    triggerThreshold: config.triggerThreshold,
    keepRecent: config.keepRecent,
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
  const activeIds = state.toolOrder.filter((id) => !state.deletedRefs.has(id));
  if (activeIds.length <= state.triggerThreshold) {
    return [];
  }
  const deleteCount = Math.max(0, activeIds.length - state.keepRecent);
  return activeIds.slice(0, deleteCount);
}

export function createCacheEditsBlock(
  state: CachedMCState,
  toolsToDelete: string[],
): CacheEditsBlock {
  for (const toolId of toolsToDelete) {
    state.deletedRefs.add(toolId);
  }
  return {
    type: "cache_edits",
    edits: toolsToDelete.map((toolId) => ({
      type: "delete",
      cache_reference: toolId,
    })),
  };
}
