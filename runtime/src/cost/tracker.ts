/**
 * Process-level facade over AgenC's `CostSidecar`.
 *
 * The accounting engine stays in `runtime/src/session/cost.ts`; this module
 * only provides the process-level getters used by live TUI and
 * command surfaces while those surfaces finish moving to session-owned state.
 */

import {
  CostSidecar,
  formatDuration,
  formatTokenCount,
  formatUsdCost,
  type ModelUsage,
  type SessionCostRecord,
} from "../session/cost.js";

export type StoredCostState = {
  readonly totalCostUSD: number;
  readonly totalAPIDuration: number;
  readonly totalAPIDurationWithoutRetries: number;
  readonly totalToolDuration: number;
  readonly totalLinesAdded: number;
  readonly totalLinesRemoved: number;
  readonly lastDuration: number | undefined;
  readonly modelUsage: { readonly [modelName: string]: ModelUsage } | undefined;
};

export interface CostUsageLike {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly server_tool_use?: {
    readonly web_search_requests?: number;
  };
}

export type LegacyModelUsage = ModelUsage & {
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly costUSD: number;
  readonly contextWindow: number;
  readonly maxOutputTokens: number;
};

let activeCostSidecar: CostSidecar | null = null;
let detachedLinesAdded = 0;
let detachedLinesRemoved = 0;

export function bindActiveCostSidecar(
  sidecar: CostSidecar | null,
): () => void {
  activeCostSidecar = sidecar;
  if (sidecar !== null && (detachedLinesAdded > 0 || detachedLinesRemoved > 0)) {
    sidecar.addToTotalLinesChanged(detachedLinesAdded, detachedLinesRemoved);
    detachedLinesAdded = 0;
    detachedLinesRemoved = 0;
  }
  return () => {
    if (activeCostSidecar === sidecar) {
      activeCostSidecar = null;
    }
  };
}

export function getActiveCostSidecar(): CostSidecar | null {
  return activeCostSidecar;
}

export function getTotalCost(): number {
  return getTotalCostUSD();
}

export function getTotalCostUSD(): number {
  return activeCostSidecar?.getTotalCostUsd() ?? 0;
}

export function getTotalDuration(): number {
  return activeCostSidecar?.getTotalDurationMs() ?? 0;
}

export function getTotalAPIDuration(): number {
  return activeCostSidecar?.getTotalApiDurationMs() ?? 0;
}

export function getTotalAPIDurationWithoutRetries(): number {
  return activeCostSidecar?.getTotalApiDurationWithoutRetriesMs() ?? 0;
}

export function getTotalToolDuration(): number {
  return activeCostSidecar?.getTotalToolDurationMs() ?? 0;
}

export function getTotalInputTokens(): number {
  return activeCostSidecar?.getTotalInputTokens() ?? 0;
}

export function getTotalOutputTokens(): number {
  return activeCostSidecar?.getTotalOutputTokens() ?? 0;
}

export function getTotalCacheReadInputTokens(): number {
  return activeCostSidecar?.getTotalCachedInputTokens() ?? 0;
}

export function getTotalCacheCreationInputTokens(): number {
  return activeCostSidecar?.getTotalCacheCreationInputTokens() ?? 0;
}

export function getTotalWebSearchRequests(): number {
  return activeCostSidecar?.getTotalWebSearchRequests() ?? 0;
}

export function getTotalLinesAdded(): number {
  return activeCostSidecar?.getTotalLinesAdded() ?? detachedLinesAdded;
}

export function getTotalLinesRemoved(): number {
  return activeCostSidecar?.getTotalLinesRemoved() ?? detachedLinesRemoved;
}

export function addToTotalLinesChanged(added: number, removed: number): void {
  if (activeCostSidecar) {
    activeCostSidecar.addToTotalLinesChanged(added, removed);
    return;
  }
  if (Number.isFinite(added)) {
    detachedLinesAdded += Math.max(0, Math.trunc(added));
  }
  if (Number.isFinite(removed)) {
    detachedLinesRemoved += Math.max(0, Math.trunc(removed));
  }
}

export function addToTotalSessionCost(
  costUsd: number,
  usage: CostUsageLike,
  model: string,
): number {
  const inputTokens = normalizeCounter(usage.input_tokens);
  const outputTokens = normalizeCounter(usage.output_tokens);
  const cacheReadInputTokens = normalizeCounter(
    usage.cache_read_input_tokens,
  );
  const cacheCreationInputTokens = normalizeCounter(
    usage.cache_creation_input_tokens,
  );
  const webSearchRequests = normalizeCounter(
    usage.server_tool_use?.web_search_requests,
  );
  const totalTokens = inputTokens + outputTokens;
  activeCostSidecar?.addTokenUsage({
    model,
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    cachedInputTokens: cacheReadInputTokens,
    cacheCreationInputTokens,
    webSearchRequests,
    totalTokens,
    costUsd: normalizeCost(costUsd),
  });
  return normalizeCost(costUsd);
}

export function addToTotalDurationState(
  durationMs: number,
  durationWithoutRetriesMs: number,
): void {
  activeCostSidecar?.addToTotalApiDuration(durationMs);
  activeCostSidecar?.addToTotalApiDurationWithoutRetries(
    durationWithoutRetriesMs,
  );
}

export function addToTotalAPIDurationWithoutRetries(durationMs: number): void {
  activeCostSidecar?.addToTotalApiDurationWithoutRetries(durationMs);
}

export function addToToolDuration(durationMs: number): void {
  activeCostSidecar?.addToTotalToolDuration(durationMs);
}

export function hasUnknownModelCost(): boolean {
  return activeCostSidecar?.hasUnknownModelCost() ?? false;
}

export function getModelUsage(): {
  readonly [modelName: string]: LegacyModelUsage;
} {
  const out: Record<string, LegacyModelUsage> = {};
  const costsByKey = new Map(
    (activeCostSidecar?.getSessionModelUsage() ?? []).map((usage) => [
      usage.provider ? `${usage.provider}:${usage.model}` : usage.model,
      usage.costUsd,
    ]),
  );
  for (const usage of activeCostSidecar?.getPerModelUsage() ?? []) {
    const key = usage.provider ? `${usage.provider}:${usage.model}` : usage.model;
    out[key] = {
      ...usage,
      cacheReadInputTokens: usage.cachedInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      costUSD: costsByKey.get(key) ?? 0,
      contextWindow: 0,
      maxOutputTokens: 0,
    };
  }
  return out;
}

export function getUsageForModel(model: string): LegacyModelUsage | undefined {
  const modelUsage = getModelUsage();
  return modelUsage[model] ?? Object.values(modelUsage).find(
    (usage) => usage.model === model,
  );
}

export function resetCostState(): void {
  activeCostSidecar?.reset();
  detachedLinesAdded = 0;
  detachedLinesRemoved = 0;
}

export function resetStateForTests(): void {
  resetCostState();
  activeCostSidecar = null;
}

export function restoreCostStateForSession(sessionId: string): boolean {
  return activeCostSidecar?.restoreSessionCostsForSession(sessionId) ?? false;
}

export function getStoredSessionCosts(
  sessionId: string,
): StoredCostState | undefined {
  const record = activeCostSidecar?.getStoredSessionRecord(sessionId);
  return recordToStoredCostState(record);
}

export function saveCurrentSessionCosts(fpsMetrics?: {
  readonly averageFps?: number;
  readonly low1PctFps?: number;
}): Promise<void> {
  activeCostSidecar?.setFpsMetrics(fpsMetrics);
  return activeCostSidecar?.saveCurrentSessionCosts() ?? Promise.resolve();
}

export function formatCost(cost: number, maxDecimalPlaces = 4): string {
  return `$${cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(maxDecimalPlaces)}`;
}

export { formatDuration, formatTokenCount, formatUsdCost };

export function formatTotalCost(): string {
  if (activeCostSidecar) {
    return activeCostSidecar.formatTotalCost();
  }
  return [
    `Total cost: ${formatUsdCost(0)}`,
    `Total duration (API): ${formatDuration(0)}`,
    `Total duration (wall): ${formatDuration(0)}`,
    "Total code changes: 0 lines added, 0 lines removed",
    "Usage: 0 input, 0 output",
  ].join("\n");
}

function recordToStoredCostState(
  record: SessionCostRecord | undefined,
): StoredCostState | undefined {
  if (!record) return undefined;
  const modelUsage =
    record.modelUsage === undefined
      ? undefined
      : Object.fromEntries(
        record.modelUsage.map((usage) => [
          usage.provider ? `${usage.provider}:${usage.model}` : usage.model,
          {
            model: usage.model,
            ...(usage.provider !== undefined ? { provider: usage.provider } : {}),
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cachedInputTokens: usage.cacheReadTokens,
            cacheCreationInputTokens: usage.cacheCreationTokens,
            reasoningOutputTokens: usage.reasoningOutputTokens,
            webSearchRequests: usage.webSearchRequests,
            totalTokens: usage.totalTokens,
            turns: usage.turns,
          } satisfies ModelUsage,
        ]),
      );
  return {
    totalCostUSD: record.costUsd,
    totalAPIDuration: record.apiDurationMs ?? 0,
    totalAPIDurationWithoutRetries:
      record.apiDurationWithoutRetriesMs ?? record.apiDurationMs ?? 0,
    totalToolDuration: record.toolDurationMs ?? 0,
    totalLinesAdded: record.linesAdded ?? 0,
    totalLinesRemoved: record.linesRemoved ?? 0,
    lastDuration: record.durationMs,
    modelUsage,
  };
}

function normalizeCounter(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeCost(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function round(number: number, precision: number): number {
  return Math.round(number * precision) / precision;
}
