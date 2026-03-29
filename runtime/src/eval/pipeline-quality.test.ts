import { describe, expect, it } from "vitest";
import {
  PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION,
  buildPipelineQualityArtifact,
  parsePipelineQualityArtifact,
  serializePipelineQualityArtifact,
} from "./pipeline-quality.js";

describe("pipeline-quality artifact", () => {
  it("builds derived context, replay, and delegation rollups", () => {
    const artifact = buildPipelineQualityArtifact({
      runId: "phase9-run",
      generatedAtMs: 1700000000000,
      contextGrowth: {
        promptTokenSeries: [100, 140, 150, 190],
      },
      toolTurn: {
        validCases: 3,
        validAccepted: 3,
        malformedCases: 4,
        malformedRejected: 4,
        malformedForwarded: 0,
      },
      desktopStability: {
        runSummaries: [
          {
            runId: "desktop-1",
            ok: true,
            timedOut: false,
            durationMs: 3200,
          },
          {
            runId: "desktop-2",
            ok: false,
            timedOut: true,
            durationMs: 5000,
            failedStep: 2,
          },
        ],
      },
      tokenEfficiency: {
        completedTasks: 4,
        totalPromptTokens: 400,
        totalCompletionTokens: 120,
        totalTokens: 520,
      },
      offlineReplay: {
        fixtures: [
          { fixtureId: "a", ok: true },
          { fixtureId: "b", ok: false, replayError: "bad transition" },
          {
            fixtureId: "c",
            ok: false,
            parseError: "invalid json",
            deterministicMismatch: true,
          },
        ],
      },
      delegation: {
        totalCases: 20,
        delegatedCases: 16,
        usefulDelegations: 12,
        harmfulDelegations: 4,
        unnecessaryDelegations: 4,
        plannerExecutionMismatches: 2,
        childTimeouts: 1,
        childFailures: 2,
        synthesisConflicts: 2,
        depthCapHits: 1,
        fanoutCapHits: 1,
        costDeltaVsBaseline: 0.34,
        latencyDeltaVsBaseline: -28,
        qualityDeltaVsBaseline: 0.2,
        passAtKDeltaVsBaseline: 0.1,
        passCaretKDeltaVsBaseline: 0.15,
        baselineScenarioId: "baseline_no_delegation",
        k: 2,
        scenarioSummaries: [
          {
            scenarioId: "baseline_no_delegation",
            mode: "no_delegation",
            runCount: 4,
            passRate: 0.5,
            passAtK: 0.833333,
            passCaretK: 0.75,
            meanLatencyMs: 157.5,
            meanCostUnits: 1.03,
            passAtKDeltaVsBaseline: 0,
            passCaretKDeltaVsBaseline: 0,
          },
        ],
      },
      orchestrationBaseline: {
        scenarios: [
          {
            scenarioId: "wrong_workspace_root",
            title: "Delegated child resolves PLAN.md against umbrella root",
            category: "workspace_root",
            sourceTraceId: "subagent:demo",
            passed: true,
            finalStatus: "failed",
            replayErrors: 0,
            replayWarnings: 0,
            policyViolations: 1,
            verifierVerdicts: 0,
            turns: 1,
            toolCalls: 1,
            fallbackCount: 0,
            spuriousSubagentCount: 1,
            approvalCount: 0,
            restartRecoverySuccess: false,
          },
        ],
      },
      liveCoding: {
        scenarioCount: 1,
        passingScenarios: 1,
        passRate: 1,
        tempRepoCount: 1,
        totalFileMutations: 2,
        totalShellMutations: 0,
        wrongRootIncidents: 0,
        unauthorizedWriteBlocks: 0,
        effectLedgerCompletenessRate: 1,
        scenarios: [
          {
            scenarioId: "workspace_scaffold_js_module",
            title: "Scaffold temp repo",
            passed: true,
            tempRepoPath: "/tmp/agenc-live-1",
            fileMutationCount: 2,
            shellMutationCount: 0,
            wrongRootIncident: false,
            unauthorizedWriteBlocked: false,
            effectLedgerComplete: true,
            exitCode: 0,
          },
        ],
      },
      safety: {
        scenarioCount: 1,
        blockedScenarios: 1,
        passingScenarios: 1,
        passRate: 1,
        promptInjectionBlocks: 1,
        maliciousRepoFileBlocks: 0,
        maliciousSkillMetadataBlocks: 0,
        marketplaceTaskPayloadBlocks: 0,
        unsafeShellBlocks: 0,
        unauthorizedArtifactWriteBlocks: 0,
        unsafeMutationAttempts: 1,
        approvalCorrectnessRate: 1,
        scenarios: [
          {
            scenarioId: "prompt-injection",
            title: "Prompt injection blocked",
            attackClass: "prompt_injection",
            passed: true,
            blocked: true,
            requiredApproval: true,
            denied: false,
            unsafeMutationAttempt: true,
            approvalCorrect: true,
          },
        ],
      },
      longHorizon: {
        scenarioCount: 1,
        passingScenarios: 1,
        passRate: 1,
        hundredStepRuns: 1,
        crashResumeRuns: 0,
        compactContinueRuns: 0,
        backgroundPersistenceRuns: 0,
        restartRecoverySuccessRate: 1,
        compactionContinuationRate: 1,
        backgroundPersistenceRate: 0,
        scenarios: [
          {
            scenarioId: "hundred-step",
            title: "Hundred step",
            category: "hundred_step",
            passed: true,
            stepCount: 120,
            resumed: true,
            compacted: true,
            persisted: true,
            restartRecoverySuccess: true,
          },
        ],
      },
      implementationGates: {
        scenarioCount: 1,
        mandatoryScenarioCount: 1,
        advisoryScenarioCount: 0,
        passingScenarios: 1,
        passRate: 1,
        mandatoryPassingScenarios: 1,
        mandatoryPassRate: 1,
        falseCompletedScenarios: 0,
        scenarios: [
          {
            scenarioId: "deterministic_impl_behavior_gap",
            title: "Deterministic implementation stays non-complete",
            category: "deterministic_false_completion",
            mandatory: true,
            executionMode: "temp_repo",
            passed: true,
            falseCompleted: false,
            observedOutcome: "partial",
            expectedOutcome: "partial",
          },
        ],
      },
      delegatedWorkspaceGates: {
        scenarioCount: 2,
        mandatoryScenarioCount: 2,
        advisoryScenarioCount: 0,
        passingScenarios: 2,
        passRate: 1,
        mandatoryPassingScenarios: 2,
        mandatoryPassRate: 1,
        falseCompletedScenarios: 0,
        scenarios: [
          {
            scenarioId: "canonical_scope_no_split_root_invariant",
            title: "Canonical delegated scope removes split-root ambiguity",
            category: "split_root_invariant",
            mandatory: true,
            executionMode: "runtime",
            passed: true,
            falseCompleted: false,
            observedOutcome: "canonical_host_root",
            expectedOutcome: "canonical_host_root",
          },
          {
            scenarioId: "fixture-delegated-workspace",
            title: "Fixture delegated workspace",
            category: "alias_migration_consistency",
            mandatory: true,
            executionMode: "runtime",
            passed: true,
            falseCompleted: false,
            observedOutcome: "canonicalized_once",
            expectedOutcome: "canonicalized_once",
          },
        ],
      },
      chaos: {
        scenarioCount: 1,
        passingScenarios: 1,
        passRate: 1,
        providerTimeoutRecoveryRate: 1,
        toolTimeoutContainmentRate: 1,
        persistenceSafeModeRate: 1,
        approvalStoreSafeModeRate: 1,
        childRunCrashContainmentRate: 1,
        daemonRestartRecoveryRate: 1,
        scenarios: [
          {
            scenarioId: "fixture-chaos",
            title: "Provider timeout recovered",
            category: "provider_timeout",
            passed: true,
            runtimeMode: "degraded",
            incidentCodes: ["provider_timeout"],
            resumed: true,
            safeModeEngaged: false,
          },
        ],
      },
    });

    expect(artifact.schemaVersion).toBe(
      PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION,
    );
    expect(artifact.contextGrowth.turns).toBe(4);
    expect(artifact.contextGrowth.tokenDeltas).toEqual([40, 10, 40]);
    expect(artifact.contextGrowth.maxDelta).toBe(40);
    expect(artifact.contextGrowth.slope).toBeCloseTo(30, 8);
    expect(artifact.desktopStability.runs).toBe(2);
    expect(artifact.desktopStability.failedRuns).toBe(1);
    expect(artifact.desktopStability.timedOutRuns).toBe(1);
    expect(artifact.desktopStability.maxDurationMs).toBe(5000);
    expect(artifact.tokenEfficiency.tokensPerCompletedTask).toBe(130);
    expect(artifact.offlineReplay.fixtureCount).toBe(3);
    expect(artifact.offlineReplay.parseFailures).toBe(1);
    expect(artifact.offlineReplay.replayFailures).toBe(1);
    expect(artifact.offlineReplay.deterministicMismatches).toBe(1);
    expect(artifact.delegation.delegationAttemptRate).toBeCloseTo(0.8, 8);
    expect(artifact.delegation.usefulDelegationRate).toBeCloseTo(0.75, 8);
    expect(artifact.delegation.harmfulDelegationRate).toBeCloseTo(0.25, 8);
    expect(artifact.delegation.childTimeoutRate).toBeCloseTo(0.0625, 8);
    expect(artifact.delegation.passAtKDeltaVsBaseline).toBeCloseTo(0.1, 8);
    expect(artifact.delegation.scenarioSummaries).toHaveLength(1);
    expect(artifact.orchestrationBaseline.scenarioCount).toBe(1);
    expect(artifact.orchestrationBaseline.passRate).toBe(1);
    expect(artifact.orchestrationBaseline.averageTurns).toBe(1);
    expect(artifact.orchestrationBaseline.spuriousSubagentCount).toBe(1);
    expect(artifact.liveCoding.passRate).toBe(1);
    expect(artifact.liveCoding.effectLedgerCompletenessRate).toBe(1);
    expect(artifact.safety.passRate).toBe(1);
    expect(artifact.longHorizon.passRate).toBe(1);
    expect(artifact.implementationGates.mandatoryPassRate).toBe(1);
    expect(artifact.delegatedWorkspaceGates.mandatoryPassRate).toBe(1);
    expect(artifact.chaos.passRate).toBe(1);
  });

  it("round-trips parse + serialization deterministically", () => {
    const built = buildPipelineQualityArtifact({
      runId: "phase9-roundtrip",
      generatedAtMs: 1700000000100,
      contextGrowth: {
        promptTokenSeries: [32, 44, 49],
      },
      toolTurn: {
        validCases: 2,
        validAccepted: 2,
        malformedCases: 2,
        malformedRejected: 2,
        malformedForwarded: 0,
      },
      desktopStability: {
        runSummaries: [
          {
            runId: "desktop-ok",
            ok: true,
            timedOut: false,
            durationMs: 1000,
          },
        ],
      },
      tokenEfficiency: {
        completedTasks: 2,
        totalPromptTokens: 90,
        totalCompletionTokens: 30,
        totalTokens: 120,
      },
      offlineReplay: {
        fixtures: [{ fixtureId: "fixture-1", ok: true }],
      },
      delegation: {
        totalCases: 5,
        delegatedCases: 2,
        usefulDelegations: 2,
        harmfulDelegations: 0,
        unnecessaryDelegations: 0,
        plannerExecutionMismatches: 0,
        childTimeouts: 0,
        childFailures: 0,
        synthesisConflicts: 0,
        depthCapHits: 0,
        fanoutCapHits: 0,
        costDeltaVsBaseline: 0.2,
        latencyDeltaVsBaseline: -4,
        qualityDeltaVsBaseline: 0.1,
        passAtKDeltaVsBaseline: 0.1,
        passCaretKDeltaVsBaseline: 0.1,
        baselineScenarioId: "baseline_no_delegation",
        k: 2,
        scenarioSummaries: [
          {
            scenarioId: "baseline_no_delegation",
            mode: "no_delegation",
            runCount: 3,
            passRate: 0.66,
            passAtK: 1,
            passCaretK: 0.88,
            meanLatencyMs: 10,
            meanCostUnits: 1,
            passAtKDeltaVsBaseline: 0,
            passCaretKDeltaVsBaseline: 0,
          },
        ],
      },
      orchestrationBaseline: {
        scenarios: [
          {
            scenarioId: "allowlist_access_denied",
            title: "Delegated read blocked by stale allowed-directory scope",
            category: "allowlist",
            sourceTraceId: "subagent:allowlist",
            passed: true,
            finalStatus: "failed",
            replayErrors: 0,
            replayWarnings: 0,
            policyViolations: 1,
            verifierVerdicts: 0,
            turns: 1,
            toolCalls: 1,
            fallbackCount: 0,
            spuriousSubagentCount: 1,
            approvalCount: 0,
            restartRecoverySuccess: false,
          },
        ],
      },
      liveCoding: {
        scenarioCount: 1,
        passingScenarios: 1,
        passRate: 1,
        tempRepoCount: 1,
        totalFileMutations: 1,
        totalShellMutations: 0,
        wrongRootIncidents: 0,
        unauthorizedWriteBlocks: 0,
        effectLedgerCompletenessRate: 1,
        scenarios: [
          {
            scenarioId: "fixture-live",
            title: "Fixture live",
            passed: true,
            tempRepoPath: "/tmp/live",
            fileMutationCount: 1,
            shellMutationCount: 0,
            wrongRootIncident: false,
            unauthorizedWriteBlocked: false,
            effectLedgerComplete: true,
            exitCode: 0,
          },
        ],
      },
      safety: {
        scenarioCount: 1,
        blockedScenarios: 1,
        passingScenarios: 1,
        passRate: 1,
        promptInjectionBlocks: 0,
        maliciousRepoFileBlocks: 0,
        maliciousSkillMetadataBlocks: 0,
        marketplaceTaskPayloadBlocks: 0,
        unsafeShellBlocks: 1,
        unauthorizedArtifactWriteBlocks: 0,
        unsafeMutationAttempts: 1,
        approvalCorrectnessRate: 1,
        scenarios: [
          {
            scenarioId: "fixture-safety",
            title: "Fixture safety",
            attackClass: "unsafe_shell",
            passed: true,
            blocked: true,
            requiredApproval: false,
            denied: true,
            unsafeMutationAttempt: true,
            approvalCorrect: true,
          },
        ],
      },
      longHorizon: {
        scenarioCount: 1,
        passingScenarios: 1,
        passRate: 1,
        hundredStepRuns: 0,
        crashResumeRuns: 1,
        compactContinueRuns: 0,
        backgroundPersistenceRuns: 0,
        restartRecoverySuccessRate: 1,
        compactionContinuationRate: 0,
        backgroundPersistenceRate: 0,
        scenarios: [
          {
            scenarioId: "fixture-long",
            title: "Fixture long",
            category: "crash_resume",
            passed: true,
            stepCount: 14,
            resumed: true,
            compacted: false,
            persisted: true,
            restartRecoverySuccess: true,
          },
        ],
      },
      chaos: {
        scenarioCount: 1,
        passingScenarios: 1,
        passRate: 1,
        providerTimeoutRecoveryRate: 1,
        toolTimeoutContainmentRate: 1,
        persistenceSafeModeRate: 0,
        approvalStoreSafeModeRate: 0,
        childRunCrashContainmentRate: 0,
        daemonRestartRecoveryRate: 0,
        scenarios: [
          {
            scenarioId: "fixture-chaos",
            title: "Fixture chaos",
            category: "provider_timeout",
            passed: true,
            runtimeMode: "degraded",
            incidentCodes: ["provider_timeout"],
            resumed: true,
            safeModeEngaged: false,
          },
        ],
      },
    });

    const parsed = parsePipelineQualityArtifact(
      JSON.parse(serializePipelineQualityArtifact(built)) as unknown,
    );

    expect(parsed).toEqual(built);
    expect(serializePipelineQualityArtifact(parsed)).toBe(
      serializePipelineQualityArtifact(built),
    );
  });

  it("migrates schema v1 artifacts by defaulting delegation and orchestration metrics", () => {
    const parsed = parsePipelineQualityArtifact({
      schemaVersion: 1,
      runId: "legacy-v1",
      generatedAtMs: 1700000000100,
      contextGrowth: {
        promptTokenSeries: [12, 18],
      },
      toolTurn: {
        validCases: 1,
        validAccepted: 1,
        malformedCases: 1,
        malformedRejected: 1,
        malformedForwarded: 0,
      },
      desktopStability: {
        runSummaries: [],
      },
      tokenEfficiency: {
        completedTasks: 1,
        totalPromptTokens: 10,
        totalCompletionTokens: 5,
        totalTokens: 15,
      },
      offlineReplay: {
        fixtures: [],
      },
    });

    expect(parsed.schemaVersion).toBe(PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION);
    expect(parsed.delegation.totalCases).toBe(0);
    expect(parsed.delegation.delegationAttemptRate).toBe(0);
    expect(parsed.delegation.passAtKDeltaVsBaseline).toBe(0);
    expect(parsed.orchestrationBaseline.scenarioCount).toBe(0);
    expect(parsed.orchestrationBaseline.passRate).toBe(0);
    expect(parsed.liveCoding.scenarioCount).toBe(0);
    expect(parsed.safety.scenarioCount).toBe(0);
    expect(parsed.longHorizon.scenarioCount).toBe(0);
    expect(parsed.implementationGates.scenarioCount).toBe(0);
    expect(parsed.delegatedWorkspaceGates.scenarioCount).toBe(0);
    expect(parsed.chaos.scenarioCount).toBe(0);
  });

  it("migrates schema v2 artifacts by defaulting orchestration baseline", () => {
    const parsed = parsePipelineQualityArtifact({
      schemaVersion: 2,
      runId: "legacy-v2",
      generatedAtMs: 1700000000100,
      contextGrowth: {
        promptTokenSeries: [12, 18],
      },
      toolTurn: {
        validCases: 1,
        validAccepted: 1,
        malformedCases: 1,
        malformedRejected: 1,
        malformedForwarded: 0,
      },
      desktopStability: {
        runSummaries: [],
      },
      tokenEfficiency: {
        completedTasks: 1,
        totalPromptTokens: 10,
        totalCompletionTokens: 5,
        totalTokens: 15,
      },
      offlineReplay: {
        fixtures: [],
      },
      delegation: {
        totalCases: 0,
        delegatedCases: 0,
        usefulDelegations: 0,
        harmfulDelegations: 0,
        unnecessaryDelegations: 0,
        plannerExecutionMismatches: 0,
        childTimeouts: 0,
        childFailures: 0,
        synthesisConflicts: 0,
        depthCapHits: 0,
        fanoutCapHits: 0,
        costDeltaVsBaseline: 0,
        latencyDeltaVsBaseline: 0,
        qualityDeltaVsBaseline: 0,
        passAtKDeltaVsBaseline: 0,
        passCaretKDeltaVsBaseline: 0,
        baselineScenarioId: "baseline_no_delegation",
        k: 1,
        scenarioSummaries: [],
      },
    });

    expect(parsed.schemaVersion).toBe(PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION);
    expect(parsed.orchestrationBaseline.scenarioCount).toBe(0);
    expect(parsed.liveCoding.scenarioCount).toBe(0);
    expect(parsed.safety.scenarioCount).toBe(0);
    expect(parsed.longHorizon.scenarioCount).toBe(0);
    expect(parsed.implementationGates.scenarioCount).toBe(0);
    expect(parsed.delegatedWorkspaceGates.scenarioCount).toBe(0);
    expect(parsed.chaos.scenarioCount).toBe(0);
  });

  it("migrates schema v4 artifacts by defaulting chaos metrics", () => {
    const parsed = parsePipelineQualityArtifact({
      schemaVersion: 4,
      runId: "legacy-v4",
      generatedAtMs: 1700000000100,
      contextGrowth: {
        promptTokenSeries: [12, 18],
      },
      toolTurn: {
        validCases: 1,
        validAccepted: 1,
        malformedCases: 1,
        malformedRejected: 1,
        malformedForwarded: 0,
      },
      desktopStability: {
        runSummaries: [],
      },
      tokenEfficiency: {
        completedTasks: 1,
        totalPromptTokens: 10,
        totalCompletionTokens: 5,
        totalTokens: 15,
      },
      offlineReplay: {
        fixtures: [],
      },
      delegation: {
        totalCases: 0,
        delegatedCases: 0,
        usefulDelegations: 0,
        harmfulDelegations: 0,
        unnecessaryDelegations: 0,
        plannerExecutionMismatches: 0,
        childTimeouts: 0,
        childFailures: 0,
        synthesisConflicts: 0,
        depthCapHits: 0,
        fanoutCapHits: 0,
        costDeltaVsBaseline: 0,
        latencyDeltaVsBaseline: 0,
        qualityDeltaVsBaseline: 0,
        passAtKDeltaVsBaseline: 0,
        passCaretKDeltaVsBaseline: 0,
        baselineScenarioId: "baseline_no_delegation",
        k: 1,
        scenarioSummaries: [],
      },
      orchestrationBaseline: {
        scenarios: [],
      },
      liveCoding: {
        scenarioCount: 0,
        passingScenarios: 0,
        passRate: 0,
        tempRepoCount: 0,
        totalFileMutations: 0,
        totalShellMutations: 0,
        wrongRootIncidents: 0,
        unauthorizedWriteBlocks: 0,
        effectLedgerCompletenessRate: 0,
        scenarios: [],
      },
      safety: {
        scenarioCount: 0,
        blockedScenarios: 0,
        passingScenarios: 0,
        passRate: 0,
        promptInjectionBlocks: 0,
        maliciousRepoFileBlocks: 0,
        maliciousSkillMetadataBlocks: 0,
        marketplaceTaskPayloadBlocks: 0,
        unsafeShellBlocks: 0,
        unauthorizedArtifactWriteBlocks: 0,
        unsafeMutationAttempts: 0,
        approvalCorrectnessRate: 0,
        scenarios: [],
      },
      longHorizon: {
        scenarioCount: 0,
        passingScenarios: 0,
        passRate: 0,
        hundredStepRuns: 0,
        crashResumeRuns: 0,
        compactContinueRuns: 0,
        backgroundPersistenceRuns: 0,
        restartRecoverySuccessRate: 0,
        compactionContinuationRate: 0,
        backgroundPersistenceRate: 0,
        scenarios: [],
      },
    });

    expect(parsed.schemaVersion).toBe(PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION);
    expect(parsed.implementationGates.scenarioCount).toBe(0);
    expect(parsed.delegatedWorkspaceGates.scenarioCount).toBe(0);
    expect(parsed.chaos.scenarioCount).toBe(0);
    expect(parsed.chaos.passRate).toBe(0);
  });

  it("rejects unsupported schema versions", () => {
    expect(() =>
      parsePipelineQualityArtifact({
        schemaVersion: 99,
        runId: "bad",
        generatedAtMs: 1,
      }),
    ).toThrow(/schema version/i);
  });
});
