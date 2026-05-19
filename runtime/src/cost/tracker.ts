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
  formatUsdCost,
  type CostFpsMetrics,
} from "../session/cost.js";

export interface CostUsageLike {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cache_read_input_tokens?: number;
  readonly cache_creation_input_tokens?: number;
  readonly server_tool_use?: {
    readonly web_search_requests?: number;
  };
}

let activeCostSidecar: CostSidecar | null = null;
let detachedLinesAdded = 0;
let detachedLinesRemoved = 0;
let fpsMetricsProvider: (() => CostFpsMetrics | undefined) | null = null;
let disposeActiveFpsMetricsProvider: (() => void) | null = null;

export function bindActiveCostSidecar(
  sidecar: CostSidecar | null,
): () => void {
  disposeActiveFpsMetricsProvider?.();
  disposeActiveFpsMetricsProvider = null;
  activeCostSidecar = sidecar;
  if (sidecar !== null && fpsMetricsProvider !== null) {
    disposeActiveFpsMetricsProvider =
      sidecar.setFpsMetricsProvider(fpsMetricsProvider);
  }
  if (sidecar !== null && (detachedLinesAdded > 0 || detachedLinesRemoved > 0)) {
    sidecar.addToTotalLinesChanged(detachedLinesAdded, detachedLinesRemoved);
    detachedLinesAdded = 0;
    detachedLinesRemoved = 0;
  }
  return () => {
    if (activeCostSidecar === sidecar) {
      disposeActiveFpsMetricsProvider?.();
      disposeActiveFpsMetricsProvider = null;
      activeCostSidecar = null;
    }
  };
}

export function getActiveCostSidecar(): CostSidecar | null {
  return activeCostSidecar;
}

export function bindCostFpsMetricsProvider(
  provider: (() => CostFpsMetrics | undefined) | null,
): () => void {
  disposeActiveFpsMetricsProvider?.();
  disposeActiveFpsMetricsProvider = null;
  fpsMetricsProvider = provider;
  if (activeCostSidecar !== null && provider !== null) {
    disposeActiveFpsMetricsProvider =
      activeCostSidecar.setFpsMetricsProvider(provider);
  }
  return () => {
    if (fpsMetricsProvider === provider) {
      disposeActiveFpsMetricsProvider?.();
      disposeActiveFpsMetricsProvider = null;
      fpsMetricsProvider = null;
    }
  };
}

export function getTotalCost(): number {
  return getTotalCostUSD();
}

function getTotalCostUSD(): number {
  return activeCostSidecar?.getTotalCostUsd() ?? 0;
}

export function getTotalDuration(): number {
  return activeCostSidecar?.getTotalDurationMs() ?? 0;
}

export function getTotalAPIDuration(): number {
  return activeCostSidecar?.getTotalApiDurationMs() ?? 0;
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

export function addToToolDuration(durationMs: number): void {
  activeCostSidecar?.addToTotalToolDuration(durationMs);
}

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

function normalizeCounter(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function normalizeCost(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
}
