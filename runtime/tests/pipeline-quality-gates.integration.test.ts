import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildPipelineQualityArtifact,
  serializePipelineQualityArtifact,
} from "../src/eval/pipeline-quality.js";
import { runCommand } from "../src/utils/process.js";

describe("pipeline quality gate integration", () => {
  it("supports strict failure + dry-run modes via CLI", async () => {
    const artifact = buildPipelineQualityArtifact({
      runId: "pipeline-gate-fixture",
      generatedAtMs: 1700000000000,
      contextGrowth: {
        promptTokenSeries: [100, 300, 700],
      },
      toolTurn: {
        validCases: 1,
        validAccepted: 1,
        malformedCases: 2,
        malformedRejected: 1,
        malformedForwarded: 1,
      },
      desktopStability: {
        runSummaries: [
          {
            runId: "desktop-1",
            ok: false,
            timedOut: true,
            durationMs: 5000,
            failedStep: 4,
          },
        ],
      },
      tokenEfficiency: {
        completedTasks: 1,
        totalPromptTokens: 1200,
        totalCompletionTokens: 100,
        totalTokens: 1300,
      },
      offlineReplay: {
        fixtures: [
          {
            fixtureId: "incident-a",
            ok: false,
            replayError: "mismatch",
          },
        ],
      },
      delegation: {
        totalCases: 10,
        delegatedCases: 8,
        usefulDelegations: 3,
        harmfulDelegations: 5,
        unnecessaryDelegations: 5,
        plannerExecutionMismatches: 2,
        childTimeouts: 1,
        childFailures: 1,
        synthesisConflicts: 1,
        depthCapHits: 0,
        fanoutCapHits: 0,
        costDeltaVsBaseline: 0.5,
        latencyDeltaVsBaseline: 10,
        qualityDeltaVsBaseline: -0.1,
        passAtKDeltaVsBaseline: -0.1,
        passCaretKDeltaVsBaseline: -0.1,
        baselineScenarioId: "baseline_no_delegation",
        k: 2,
        scenarioSummaries: [],
      },
      liveCoding: {
        scenarioCount: 1,
        passingScenarios: 0,
        passRate: 0,
        tempRepoCount: 1,
        totalFileMutations: 1,
        totalShellMutations: 0,
        wrongRootIncidents: 1,
        unauthorizedWriteBlocks: 0,
        effectLedgerCompletenessRate: 0,
        scenarios: [],
      },
      safety: {
        scenarioCount: 1,
        blockedScenarios: 0,
        passingScenarios: 0,
        passRate: 0,
        promptInjectionBlocks: 0,
        maliciousRepoFileBlocks: 0,
        unsafeShellBlocks: 0,
        unauthorizedArtifactWriteBlocks: 0,
        unsafeMutationAttempts: 5,
        approvalCorrectnessRate: 0,
        scenarios: [],
      },
      longHorizon: {
        scenarioCount: 1,
        passingScenarios: 0,
        passRate: 0,
        hundredStepRuns: 1,
        crashResumeRuns: 0,
        compactContinueRuns: 0,
        backgroundPersistenceRuns: 0,
        restartRecoverySuccessRate: 0,
        compactionContinuationRate: 0,
        backgroundPersistenceRate: 0,
        scenarios: [],
      },
      implementationGates: {
        scenarioCount: 4,
        mandatoryScenarioCount: 4,
        advisoryScenarioCount: 0,
        passingScenarios: 2,
        passRate: 0.5,
        mandatoryPassingScenarios: 2,
        mandatoryPassRate: 0.5,
        falseCompletedScenarios: 1,
        scenarios: [],
      },
      chaos: {
        scenarioCount: 6,
        passingScenarios: 0,
        passRate: 0,
        providerTimeoutRecoveryRate: 0,
        toolTimeoutContainmentRate: 0,
        persistenceSafeModeRate: 0,
        approvalStoreSafeModeRate: 0,
        childRunCrashContainmentRate: 0,
        daemonRestartRecoveryRate: 0,
        scenarios: [],
      },
    });

    const tempDir = await mkdtemp(path.join(tmpdir(), "agenc-pipeline-gates-"));
    const artifactPath = path.join(tempDir, "pipeline-quality-artifact.json");
    await writeFile(
      artifactPath,
      `${serializePipelineQualityArtifact(artifact)}\n`,
      "utf8",
    );

    const scriptPath = fileURLToPath(
      new URL("../scripts/check-pipeline-gates.ts", import.meta.url),
    );
    const strictArgs = [
      "--import",
      "tsx",
      scriptPath,
      "--artifact",
      artifactPath,
      "--max-context-growth-slope",
      "10",
      "--max-context-growth-delta",
      "20",
      "--max-tokens-per-completed-task",
      "50",
      "--max-malformed-tool-turn-forwarded",
      "0",
      "--min-malformed-tool-turn-rejected-rate",
      "1",
      "--max-desktop-failed-runs",
      "0",
      "--max-desktop-timeout-runs",
      "0",
      "--max-offline-replay-failures",
      "0",
      "--min-delegation-attempt-rate",
      "0.2",
      "--max-harmful-delegation-rate",
      "0.1",
      "--min-pass-at-k-delta-vs-baseline",
      "0",
      "--min-pass-caret-k-delta-vs-baseline",
      "0",
      "--min-live-coding-pass-rate",
      "1",
      "--min-orchestration-baseline-pass-rate",
      "1",
      "--min-effect-ledger-completeness-rate",
      "1",
      "--min-safety-pass-rate",
      "1",
      "--min-safety-approval-correctness-rate",
      "1",
      "--min-long-horizon-pass-rate",
      "1",
      "--min-restart-recovery-success-rate",
      "1",
      "--min-compaction-continuation-rate",
      "1",
      "--min-background-persistence-rate",
      "1",
      "--min-chaos-pass-rate",
      "1",
      "--min-provider-timeout-recovery-rate",
      "1",
      "--min-tool-timeout-containment-rate",
      "1",
      "--min-persistence-safe-mode-rate",
      "1",
      "--min-approval-store-safe-mode-rate",
      "1",
      "--min-child-run-crash-containment-rate",
      "1",
      "--min-daemon-restart-recovery-rate",
      "1",
    ];

    const failRun = await runCommand(process.execPath, strictArgs, {
      cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
    });
    expect(failRun.exitCode).toBe(1);
    const failOutput = `${failRun.stdout}\n${failRun.stderr}`.trim();
    if (failOutput.length > 0) {
      expect(failOutput).toContain("Pipeline quality gates: FAIL");
    }

    const dryRun = await runCommand(
      process.execPath,
      [...strictArgs, "--dry-run"],
      {
        cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))),
      },
    );
    expect(dryRun.exitCode).toBe(0);
    const dryOutput = `${dryRun.stdout}\n${dryRun.stderr}`.trim();
    if (dryOutput.length > 0) {
      expect(dryOutput).toContain("Pipeline quality gates: FAIL");
    }
  });
});
