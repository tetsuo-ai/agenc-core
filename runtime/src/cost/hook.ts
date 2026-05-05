/**
 * React-compatible cost summary hook for AgenC's sidecar-managed tracker.
 *
 * Bootstrap owns the live exit summary through `CostSidecar.exitSummary`; this
 * hook registers a fallback listener only when no active sidecar is bound.
 */

import { useEffect } from "react";
import {
  bindCostFpsMetricsProvider,
  formatTotalCost,
  getActiveCostSidecar,
} from "./tracker.js";

export type CostFpsMetrics = {
  readonly averageFps?: number;
  readonly low1PctFps?: number;
};

export interface CostSummaryProcessLike {
  readonly stdout: { write: (value: string) => unknown };
  on(event: "exit", listener: () => void): unknown;
  off(event: "exit", listener: () => void): unknown;
}

export interface CostSummaryFallbackOptions {
  readonly processLike?: CostSummaryProcessLike;
  readonly shouldPrint?: () => boolean;
}

export function registerCostSummaryFallbackOnExit(
  getFpsMetrics?: () => CostFpsMetrics | undefined,
  options: CostSummaryFallbackOptions = {},
): () => void {
  const disposeFpsMetricsProvider = bindCostFpsMetricsProvider(
    getFpsMetrics ?? null,
  );
  if (getActiveCostSidecar() !== null) {
    return disposeFpsMetricsProvider;
  }

  const processLike = options.processLike ?? process;
  const shouldPrint = options.shouldPrint ?? (() => false);
  const onExit = (): void => {
    if (getActiveCostSidecar() !== null) return;
    if (shouldPrint()) {
      processLike.stdout.write(`\n${formatTotalCost()}\n`);
    }
  };
  processLike.on("exit", onExit);
  return () => {
    disposeFpsMetricsProvider();
    processLike.off("exit", onExit);
  };
}

export function useCostSummary(
  getFpsMetrics?: () => CostFpsMetrics | undefined,
): void {
  useEffect(() => registerCostSummaryFallbackOnExit(getFpsMetrics), []);
}
