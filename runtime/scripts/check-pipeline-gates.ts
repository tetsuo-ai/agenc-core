#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  evaluatePipelineQualityGates,
  formatPipelineQualityGateEvaluation,
  parsePipelineQualityArtifact,
  type PipelineQualityGateThresholds,
} from "../src/eval/index.js";

interface CliOptions {
  artifactPath: string;
  dryRun: boolean;
  thresholds: Partial<PipelineQualityGateThresholds>;
}

function defaultArtifactPath(): string {
  return path.resolve(
    process.cwd(),
    "runtime/benchmarks/artifacts/pipeline-quality.ci.json",
  );
}

function parseThreshold(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid ${flag} value: ${value}`);
  }
  return parsed;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    artifactPath: defaultArtifactPath(),
    dryRun: false,
    thresholds: {},
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--artifact" && argv[i + 1]) {
      options.artifactPath = path.resolve(process.cwd(), argv[++i]!);
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--max-context-growth-slope" && argv[i + 1]) {
      options.thresholds.maxContextGrowthSlope = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-context-growth-delta" && argv[i + 1]) {
      options.thresholds.maxContextGrowthDelta = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-tokens-per-completed-task" && argv[i + 1]) {
      options.thresholds.maxTokensPerCompletedTask = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-malformed-tool-turn-forwarded" && argv[i + 1]) {
      options.thresholds.maxMalformedToolTurnForwarded = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-malformed-tool-turn-rejected-rate" && argv[i + 1]) {
      options.thresholds.minMalformedToolTurnRejectedRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--max-desktop-failed-runs" && argv[i + 1]) {
      options.thresholds.maxDesktopFailedRuns = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-desktop-timeout-runs" && argv[i + 1]) {
      options.thresholds.maxDesktopTimeoutRuns = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-offline-replay-failures" && argv[i + 1]) {
      options.thresholds.maxOfflineReplayFailures = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--min-delegation-attempt-rate" && argv[i + 1]) {
      options.thresholds.minDelegationAttemptRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-delegation-attempt-rate" && argv[i + 1]) {
      options.thresholds.maxDelegationAttemptRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--min-useful-delegation-rate" && argv[i + 1]) {
      options.thresholds.minUsefulDelegationRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-harmful-delegation-rate" && argv[i + 1]) {
      options.thresholds.maxHarmfulDelegationRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-planner-to-execution-mismatch-rate" && argv[i + 1]) {
      options.thresholds.maxPlannerToExecutionMismatchRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--max-child-timeout-rate" && argv[i + 1]) {
      options.thresholds.maxChildTimeoutRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-child-failure-rate" && argv[i + 1]) {
      options.thresholds.maxChildFailureRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-synthesis-conflict-rate" && argv[i + 1]) {
      options.thresholds.maxSynthesisConflictRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--max-depth-cap-hit-rate" && argv[i + 1]) {
      options.thresholds.maxDepthCapHitRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-fanout-cap-hit-rate" && argv[i + 1]) {
      options.thresholds.maxFanoutCapHitRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-cost-delta-vs-baseline" && argv[i + 1]) {
      options.thresholds.maxCostDeltaVsBaseline = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--max-latency-delta-vs-baseline" && argv[i + 1]) {
      options.thresholds.maxLatencyDeltaVsBaseline = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-quality-delta-vs-baseline" && argv[i + 1]) {
      options.thresholds.minQualityDeltaVsBaseline = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-pass-at-k-delta-vs-baseline" && argv[i + 1]) {
      options.thresholds.minPassAtKDeltaVsBaseline = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-pass-caret-k-delta-vs-baseline" && argv[i + 1]) {
      options.thresholds.minPassCaretKDeltaVsBaseline = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--fail-fast-harmful-delegation-rate" && argv[i + 1]) {
      options.thresholds.failFastHarmfulDelegationRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--fail-fast-runaway-cap-hit-rate" && argv[i + 1]) {
      options.thresholds.failFastRunawayCapHitRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-live-coding-pass-rate" && argv[i + 1]) {
      options.thresholds.minLiveCodingPassRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--min-orchestration-baseline-pass-rate" && argv[i + 1]) {
      options.thresholds.minOrchestrationBaselinePassRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-effect-ledger-completeness-rate" && argv[i + 1]) {
      options.thresholds.minEffectLedgerCompletenessRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-safety-pass-rate" && argv[i + 1]) {
      options.thresholds.minSafetyPassRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--min-safety-approval-correctness-rate" && argv[i + 1]) {
      options.thresholds.minSafetyApprovalCorrectnessRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-long-horizon-pass-rate" && argv[i + 1]) {
      options.thresholds.minLongHorizonPassRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--min-restart-recovery-success-rate" && argv[i + 1]) {
      options.thresholds.minRestartRecoverySuccessRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-compaction-continuation-rate" && argv[i + 1]) {
      options.thresholds.minCompactionContinuationRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-background-persistence-rate" && argv[i + 1]) {
      options.thresholds.minBackgroundPersistenceRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-implementation-gate-mandatory-pass-rate" && argv[i + 1]) {
      options.thresholds.minImplementationGateMandatoryPassRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (
      arg === "--max-implementation-gate-false-completed-scenarios" &&
      argv[i + 1]
    ) {
      options.thresholds.maxImplementationGateFalseCompletedScenarios =
        parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--min-chaos-pass-rate" && argv[i + 1]) {
      options.thresholds.minChaosPassRate = parseThreshold(argv[++i]!, arg);
      continue;
    }
    if (arg === "--min-provider-timeout-recovery-rate" && argv[i + 1]) {
      options.thresholds.minProviderTimeoutRecoveryRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-tool-timeout-containment-rate" && argv[i + 1]) {
      options.thresholds.minToolTimeoutContainmentRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-persistence-safe-mode-rate" && argv[i + 1]) {
      options.thresholds.minPersistenceSafeModeRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-approval-store-safe-mode-rate" && argv[i + 1]) {
      options.thresholds.minApprovalStoreSafeModeRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-child-run-crash-containment-rate" && argv[i + 1]) {
      options.thresholds.minChildRunCrashContainmentRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--min-daemon-restart-recovery-rate" && argv[i + 1]) {
      options.thresholds.minDaemonRestartRecoveryRate = parseThreshold(
        argv[++i]!,
        arg,
      );
      continue;
    }
    if (arg === "--help") {
      console.log(
        [
          "Usage: check-pipeline-gates --artifact <path> [threshold overrides]",
          "",
          "Threshold flags:",
          "  --max-context-growth-slope <float>",
          "  --max-context-growth-delta <float>",
          "  --max-tokens-per-completed-task <float>",
          "  --max-malformed-tool-turn-forwarded <float>",
          "  --min-malformed-tool-turn-rejected-rate <float>",
          "  --max-desktop-failed-runs <float>",
          "  --max-desktop-timeout-runs <float>",
          "  --max-offline-replay-failures <float>",
          "  --min-delegation-attempt-rate <float>",
          "  --max-delegation-attempt-rate <float>",
          "  --min-useful-delegation-rate <float>",
          "  --max-harmful-delegation-rate <float>",
          "  --max-planner-to-execution-mismatch-rate <float>",
          "  --max-child-timeout-rate <float>",
          "  --max-child-failure-rate <float>",
          "  --max-synthesis-conflict-rate <float>",
          "  --max-depth-cap-hit-rate <float>",
          "  --max-fanout-cap-hit-rate <float>",
          "  --max-cost-delta-vs-baseline <float>",
          "  --max-latency-delta-vs-baseline <float>",
          "  --min-quality-delta-vs-baseline <float>",
          "  --min-pass-at-k-delta-vs-baseline <float>",
          "  --min-pass-caret-k-delta-vs-baseline <float>",
          "  --fail-fast-harmful-delegation-rate <float>",
          "  --fail-fast-runaway-cap-hit-rate <float>",
          "  --min-live-coding-pass-rate <float>",
          "  --min-orchestration-baseline-pass-rate <float>",
          "  --min-effect-ledger-completeness-rate <float>",
          "  --min-safety-pass-rate <float>",
          "  --min-safety-approval-correctness-rate <float>",
          "  --min-long-horizon-pass-rate <float>",
          "  --min-restart-recovery-success-rate <float>",
          "  --min-compaction-continuation-rate <float>",
          "  --min-background-persistence-rate <float>",
          "  --min-implementation-gate-mandatory-pass-rate <float>",
          "  --max-implementation-gate-false-completed-scenarios <float>",
          "  --min-chaos-pass-rate <float>",
          "  --min-provider-timeout-recovery-rate <float>",
          "  --min-tool-timeout-containment-rate <float>",
          "  --min-persistence-safe-mode-rate <float>",
          "  --min-approval-store-safe-mode-rate <float>",
          "  --min-child-run-crash-containment-rate <float>",
          "  --min-daemon-restart-recovery-rate <float>",
          "",
          "Options:",
          "  --dry-run   Always exit 0, but print failures",
        ].join("\n"),
      );
      process.exit(0);
    }
  }

  return options;
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  const raw = await readFile(options.artifactPath, "utf8");
  const artifact = parsePipelineQualityArtifact(JSON.parse(raw) as unknown);
  const evaluation = evaluatePipelineQualityGates(artifact, options.thresholds);

  console.log(formatPipelineQualityGateEvaluation(evaluation));

  if (!evaluation.passed && !options.dryRun) {
    process.exit(1);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Pipeline gate evaluation failed: ${message}`);
  process.exit(1);
});
