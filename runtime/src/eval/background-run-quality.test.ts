import { describe, expect, it } from "vitest";
import {
  buildBackgroundRunQualityArtifact,
  parseBackgroundRunQualityArtifact,
  serializeBackgroundRunQualityArtifact,
} from "./background-run-quality.js";
import {
  evaluateBackgroundRunQualityGates,
  formatBackgroundRunGateEvaluation,
} from "./background-run-gates.js";

describe("background-run-quality artifact", () => {
  it("builds rollups from scenario artifacts", () => {
    const artifact = buildBackgroundRunQualityArtifact({
      runId: "background-run-quality-test",
      generatedAtMs: 1_700_000_000_000,
      scenarios: [
        {
          scenarioId: "completion",
          category: "canary",
          ok: true,
          finalState: "completed",
          completionState: "completed",
          dependencyStateKind: "satisfied_terminal",
          dependencySatisfied: true,
          verifierClosed: true,
          resolutionSemantics: "normal",
          latencyMs: 120,
          timeToFirstAckMs: 10,
          timeToFirstVerifiedUpdateMs: 40,
          stopLatencyMs: undefined,
          falseCompletion: false,
          blockedWithoutNotice: false,
          recoverySucceeded: true,
          verifierAccurate: true,
          replayConsistent: true,
          transcriptScore: 1,
          toolTrajectoryScore: 1,
          endStateCorrectnessScore: 1,
          verifierCorrectnessScore: 1,
          restartRecoveryCorrectnessScore: 1,
          operatorUxCorrectnessScore: 1,
          tokenCount: 12,
          eventCount: 5,
        },
        {
          scenarioId: "blocked",
          category: "chaos",
          ok: true,
          finalState: "blocked",
          completionState: "blocked",
          dependencyStateKind: "unsatisfied_terminal",
          dependencySatisfied: false,
          verifierClosed: false,
          resolutionSemantics: "normal",
          latencyMs: 300,
          timeToFirstAckMs: 20,
          timeToFirstVerifiedUpdateMs: undefined,
          stopLatencyMs: undefined,
          falseCompletion: false,
          blockedWithoutNotice: false,
          recoverySucceeded: false,
          verifierAccurate: true,
          replayConsistent: true,
          transcriptScore: 1,
          toolTrajectoryScore: 1,
          endStateCorrectnessScore: 1,
          verifierCorrectnessScore: 1,
          restartRecoveryCorrectnessScore: 0,
          operatorUxCorrectnessScore: 1,
          tokenCount: 9,
          eventCount: 4,
        },
      ],
    });

    expect(artifact.runCount).toBe(2);
    expect(artifact.completedRuns).toBe(1);
    expect(artifact.blockedRuns).toBe(1);
    expect(artifact.falseCompletionRate).toBe(0);
    expect(artifact.meanLatencyMs).toBe(210);

    const reparsed = parseBackgroundRunQualityArtifact(
      JSON.parse(serializeBackgroundRunQualityArtifact(artifact)),
    );
    expect(reparsed).toEqual(artifact);
  });

  it("evaluates gates and formats failures", () => {
    const artifact = buildBackgroundRunQualityArtifact({
      runId: "background-run-quality-gates",
      generatedAtMs: 1_700_000_000_000,
      scenarios: [
        {
          scenarioId: "completion",
          category: "canary",
          ok: false,
          finalState: "completed",
          completionState: "completed",
          dependencyStateKind: "satisfied_terminal",
          dependencySatisfied: true,
          verifierClosed: true,
          resolutionSemantics: "normal",
          latencyMs: 10_000,
          timeToFirstAckMs: 5_000,
          timeToFirstVerifiedUpdateMs: 12_000,
          stopLatencyMs: 3_000,
          falseCompletion: true,
          blockedWithoutNotice: true,
          recoverySucceeded: false,
          verifierAccurate: false,
          replayConsistent: false,
          transcriptScore: 0,
          toolTrajectoryScore: 0,
          endStateCorrectnessScore: 0,
          verifierCorrectnessScore: 0,
          restartRecoveryCorrectnessScore: 0,
          operatorUxCorrectnessScore: 0,
          tokenCount: 5_000,
          eventCount: 3,
        },
      ],
    });
    const evaluation = evaluateBackgroundRunQualityGates(artifact);

    expect(evaluation.passed).toBe(false);
    expect(formatBackgroundRunGateEvaluation(evaluation)).toContain(
      "Background-run quality gates failed:",
    );
  });

  it("flags canonically satisfied but verifier-open runs in background-run gates", () => {
    const artifact = buildBackgroundRunQualityArtifact({
      runId: "background-run-quality-open-satisfied",
      generatedAtMs: 1_700_000_000_000,
      scenarios: [
        {
          scenarioId: "open-satisfied",
          category: "replay",
          ok: false,
          finalState: "completed",
          completionState: "needs_verification",
          dependencyStateKind: "satisfied_nonterminal",
          dependencySatisfied: true,
          verifierClosed: false,
          resolutionSemantics: "normal",
          latencyMs: 50,
          falseCompletion: false,
          blockedWithoutNotice: false,
          recoverySucceeded: true,
          verifierAccurate: true,
          replayConsistent: true,
          transcriptScore: 1,
          toolTrajectoryScore: 1,
          endStateCorrectnessScore: 1,
          verifierCorrectnessScore: 1,
          restartRecoveryCorrectnessScore: 1,
          operatorUxCorrectnessScore: 1,
          tokenCount: 10,
          eventCount: 3,
        },
      ],
    });

    const evaluation = evaluateBackgroundRunQualityGates(artifact);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          metric: "open_satisfied_runs",
          observed: 1,
          threshold: 0,
        }),
      ]),
    );
  });
});
