/**
 * Runtime SLO helpers derived from live telemetry and release-gate artifacts.
 *
 * @module
 */

import type { HistogramEntry } from "../task/metrics.js";
import type { PipelineQualityArtifact } from "../eval/pipeline-quality.js";
import type { TelemetrySnapshot } from "./types.js";

interface RuntimeSloSnapshot {
  readonly runCompletionRate?: number;
  readonly checkpointResumeSuccessRate?: number;
  readonly approvalResponseLatencyMs?: number;
  readonly effectLedgerCompletenessRate?: number;
  readonly safetyRegressionRate?: number;
}

function sumCounters(snapshot: TelemetrySnapshot | undefined, metric: string): number {
  if (!snapshot) return 0;
  return Object.entries(snapshot.counters)
    .filter(([key]) => key === metric || key.startsWith(`${metric}|`))
    .reduce((sum, [, value]) => sum + value, 0);
}

function meanHistogram(
  snapshot: TelemetrySnapshot | undefined,
  metric: string,
): number | undefined {
  const entries: HistogramEntry[] = snapshot?.histograms[metric] ?? [];
  if (entries.length === 0) return undefined;
  const total = entries.reduce((sum, entry) => sum + entry.value, 0);
  return total / entries.length;
}

export function computeRuntimeSloSnapshot(params: {
  telemetry?: TelemetrySnapshot;
  pipelineQualityArtifact?: PipelineQualityArtifact;
}): RuntimeSloSnapshot {
  const started = sumCounters(params.telemetry, "agenc.background_runs.started.total");
  const completed = sumCounters(params.telemetry, "agenc.background_runs.completed.total");
  const failed = sumCounters(params.telemetry, "agenc.background_runs.failed.total");
  const recovered = sumCounters(params.telemetry, "agenc.background_runs.recovered.total");
  const approvalLatency = meanHistogram(
    params.telemetry,
    "agenc.approval.response_latency_ms",
  );
  const denominator = started > 0 ? started : completed + failed;
  const restartDenominator = completed + failed > 0 ? completed + failed : recovered;
  return {
    runCompletionRate:
      denominator > 0 ? completed / denominator : undefined,
    checkpointResumeSuccessRate:
      restartDenominator > 0 ? recovered / restartDenominator : undefined,
    approvalResponseLatencyMs: approvalLatency,
    effectLedgerCompletenessRate:
      params.pipelineQualityArtifact?.liveCoding.effectLedgerCompletenessRate ??
      params.pipelineQualityArtifact?.orchestrationBaseline.effectLedgerCompletenessRate,
    safetyRegressionRate:
      params.pipelineQualityArtifact
        ? 1 - params.pipelineQualityArtifact.safety.passRate
        : undefined,
  };
}
