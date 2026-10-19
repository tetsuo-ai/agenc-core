import type { SessionSnapshotResult } from "../app-server/protocol/index.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";
import {
  getAutoCompactPolicyForEnvironment,
} from "../services/compact/thresholds.js";

export type ResidentContextBreakdown = NonNullable<SessionSnapshotResult["contextBreakdown"]>;

export function contextUsagePercentage(usedTokens: number, windowTokens: number): number {
  return windowTokens > 0 ? Math.min(100, Math.max(0, Math.round(usedTokens / windowTokens * 100))) : 0;
}

export function configuredContextWindow(config: {
  readonly model_provider?: string;
  readonly providers?: Readonly<Record<string, { readonly context_window_tokens?: number }>>;
} | undefined): number | undefined {
  const window = config?.model_provider ? config.providers?.[config.model_provider]?.context_window_tokens : undefined;
  return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
}

/** One resident-context estimate for the header and /context; API totals are separate. */
export function projectResidentContextUsage(
  resident: ResidentContextBreakdown,
  options: {
    readonly providerEnvironment: ProviderEnvironment;
    readonly model?: string;
    readonly contextWindowTokens?: number;
  },
) {
  // New daemons publish the exact pre-request compaction pressure. Older
  // daemons retain their explicitly estimated resident-history projection.
  const pressure = resident as ResidentContextBreakdown & {
    readonly compactionInputTokens?: number;
    readonly compactionWindowTokens?: number;
    readonly compactionThresholdTokens?: number;
    readonly compactionReservedOutputTokens?: number;
  };
  const authoritativeWindow = pressure.compactionWindowTokens ?? resident.effectiveWindowTokens;
  const hasAuthoritativeWindow = typeof authoritativeWindow === "number" && Number.isFinite(authoritativeWindow) && authoritativeWindow > 0;
  // The daemon already applied its effective model percentage and environment.
  // A client's local override must not apply that capacity policy a second time.
  const environment = hasAuthoritativeWindow
    ? { ...options.providerEnvironment, AGENC_AUTO_COMPACT_WINDOW: undefined }
    : options.providerEnvironment;
  const model = resident.model ?? options.model;
  const window = hasAuthoritativeWindow ? authoritativeWindow
    : resident.windowTokens > 0 ? resident.windowTokens : options.contextWindowTokens;
  const lookup = { options: { mainLoopModel: model, contextWindowTokens: window } };
  const policy = getAutoCompactPolicyForEnvironment(lookup, environment);
  const hardLimit = policy.effectiveWindowTokens;
  const authoritativeThreshold = pressure.compactionThresholdTokens;
  const hasAuthoritativeThreshold = hasAuthoritativeWindow && typeof authoritativeThreshold === "number" &&
    Number.isFinite(authoritativeThreshold) && authoritativeThreshold > 0;
  // The daemon publishes its disabled state as threshold == window. A client
  // attaching with different env must display the policy the daemon enforces.
  const compactionThreshold = hasAuthoritativeThreshold ? authoritativeThreshold : policy.compactionThresholdTokens;
  const autoCompactEnabled = hasAuthoritativeThreshold ? compactionThreshold < hardLimit : policy.autoCompactEnabled;
  const toolsTokens = resident.systemToolTokens + resident.mcpToolTokens;
  const requestInput = pressure.compactionInputTokens;
  // Reserved output is separate; subtracting it from the window would make
  // ctx% disagree with the threshold that decides whether to compact.
  const totalUsed = typeof requestInput === "number" && Number.isFinite(requestInput) && requestInput >= 0
    ? requestInput : resident.messageTokens + resident.systemPromptTokens + toolsTokens + resident.memoryFileTokens;
  return {
    hardLimit, autoCompactEnabled, compactionThreshold,
    messagesTokens: resident.messageTokens, toolsTokens,
    systemTokens: resident.systemPromptTokens, fileTokens: resident.memoryFileTokens,
    totalUsed, usedPercentage: contextUsagePercentage(totalUsed, hardLimit),
    freeUntilCompact: Math.max(0, compactionThreshold - totalUsed),
    freeUntilHardLimit: Math.max(0, hardLimit - totalUsed),
  };
}
