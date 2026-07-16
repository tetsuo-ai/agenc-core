import { describe, expect, test } from "vitest";
import { computeDocumentDigest } from "../../src/eval-contract/index.js";
import {
  PowerAnalysisValidationError,
  computePowerAnalysis,
  type PairedPilotBinaryOutcome,
  type PowerAnalysisInput,
} from "../../src/eval-power/index.js";

const CREATED_AT = "2026-07-16T08:00:00.000Z";

function makePilotOutcomes(): PairedPilotBinaryOutcome[] {
  const outcomes: PairedPilotBinaryOutcome[] = [];
  const comparisons = [
    { comparisonId: "versus-alpha", comparatorSystemId: "alpha" },
    { comparisonId: "versus-beta", comparatorSystemId: "beta" },
  ] as const;
  for (const comparison of comparisons) {
    for (let taskIndex = 0; taskIndex < 30; taskIndex += 1) {
      // Unequal repeat counts make a trial-weighted implementation observably
      // wrong while preserving paired seed slots across both comparisons.
      const repetitions = taskIndex === 0 ? 9 : taskIndex % 7 === 0 ? 4 : 3;
      for (let trialIndex = 0; trialIndex < repetitions; trialIndex += 1) {
        const primaryOutcome = ((taskIndex * 7 + trialIndex * 3) % 10 < 7 ? 1 : 0) as 0 | 1;
        const comparatorThreshold = comparison.comparisonId === "versus-alpha" ? 5 : 4;
        const comparatorOutcome = (
          (taskIndex * 5 + trialIndex * 7 + (comparison.comparisonId === "versus-alpha" ? 0 : 2)) % 10
            < comparatorThreshold
            ? 1
            : 0
        ) as 0 | 1;
        outcomes.push({
          comparisonId: comparison.comparisonId,
          comparatorSystemId: comparison.comparatorSystemId,
          taskId: `task-${String(taskIndex).padStart(2, "0")}`,
          repositoryId: `repo-${String(Math.floor(taskIndex / 3)).padStart(2, "0")}`,
          trialId: `seed-${trialIndex}`,
          primaryOutcome,
          comparatorOutcome,
        });
      }
    }
  }
  return outcomes;
}

function makeInput(overrides: Partial<PowerAnalysisInput> = {}): PowerAnalysisInput {
  return {
    analysisId: "pilot-power-2026-07",
    pilotId: "pilot-30-v1",
    createdAt: CREATED_AT,
    primarySystemId: "agenc-primary",
    outcomes: makePilotOutcomes(),
    candidateTaskCounts: [50, 100],
    confirmatoryRepositoryCount: 20,
    confirmatoryRepetitionsPerSystemTask: 3,
    planningEffectSize: 0.2,
    assumedEffectSizes: [0.1, 0.2],
    heterogeneityMultipliers: [1, 1.5],
    simulationReplications: 1_000,
    randomSeed: 0x5eed_1234,
    ...overrides,
  };
}

function taskWeightedDifference(outcomes: readonly PairedPilotBinaryOutcome[], comparisonId: string): number {
  const taskTrials = new Map<string, number[]>();
  for (const outcome of outcomes.filter((candidate) => candidate.comparisonId === comparisonId)) {
    const trials = taskTrials.get(outcome.taskId) ?? [];
    trials.push(outcome.primaryOutcome - outcome.comparatorOutcome);
    taskTrials.set(outcome.taskId, trials);
  }
  return [...taskTrials.values()]
    .map((trials) => trials.reduce((sum, value) => sum + value, 0) / trials.length)
    .reduce((sum, value) => sum + value, 0) / taskTrials.size;
}

describe("evaluation pilot power analysis", () => {
  test("produces a deterministic digest-bound clustered sensitivity analysis", () => {
    const input = makeInput();
    const document = computePowerAnalysis(input);
    const permuted = computePowerAnalysis({
      ...input,
      outcomes: [...input.outcomes].reverse(),
      candidateTaskCounts: [...input.candidateTaskCounts].reverse(),
      assumedEffectSizes: [...input.assumedEffectSizes].reverse(),
      heterogeneityMultipliers: [...input.heterogeneityMultipliers].reverse(),
    });

    expect(permuted).toEqual(document);
    expect(document.documentDigest).toBe(computeDocumentDigest(document));
    expect(document.documentDigest).toBe(
      "sha256:ed753df1c69a1a0c8d32db0c711185ee74a61accffb4efb21a6b507c24cdef86",
    );
    expect(document.pilot).toMatchObject({
      taskCount: 30,
      repositoryCount: 10,
      comparisonCount: 2,
      minimumRepetitionsPerTaskComparison: 3,
      maximumRepetitionsPerTaskComparison: 9,
      aggregation: "mean_within_task_then_equal_task_weight",
    });
    expect(document.design).toMatchObject({
      alpha: "0.05",
      targetPower: "0.80",
      minimumEffect: 0.1,
      planningEffectSize: 0.2,
      confirmatoryRepositoryCount: 20,
      confirmatoryRepetitionsPerSystemTask: 3,
      multipleComparators: "intersection_union",
      optionalStopping: false,
    });
    expect(document.sensitivityGrid).toHaveLength(8);
    expect(document.decision.status).toBe("adequately_powered");
    for (const cell of document.sensitivityGrid) {
      expect(cell.comparisonPower.map((entry) => entry.comparisonId)).toEqual([
        "versus-alpha",
        "versus-beta",
      ]);
      expect(cell.intersectionPower.estimate).toBeLessThanOrEqual(
        Math.min(...cell.comparisonPower.map((entry) => entry.power.estimate)),
      );
    }
    if (document.decision.confirmatoryPlan) {
      expect(document.decision.confirmatoryPlan).toMatchObject({
        repositoryCount: 20,
        repetitionsPerSystemTask: 3,
        stoppingRule: { kind: "fixed", interimLooks: 0, optionalStopping: false },
      });
      expect(document.decision.confirmatoryPlan.taskCount).toBeGreaterThanOrEqual(50);
    } else {
      expect(document.decision.status).toBe("no_candidate_meets_target");
    }
  });

  test("aggregates unequal repetitions within task before equal task weighting", () => {
    const input = makeInput();
    const document = computePowerAnalysis(input);
    const comparison = document.pilot.comparisons.find((entry) =>
      entry.comparisonId === "versus-alpha");
    const expected = taskWeightedDifference(input.outcomes, "versus-alpha");
    const rawTrials = input.outcomes.filter((outcome) => outcome.comparisonId === "versus-alpha");
    const incorrectlyTrialWeighted = rawTrials.reduce(
      (sum, outcome) => sum + outcome.primaryOutcome - outcome.comparatorOutcome,
      0,
    ) / rawTrials.length;

    expect(comparison?.pairedDifferenceTaskWeighted).toBeCloseTo(expected, 11);
    expect(comparison?.pairedDifferenceTaskWeighted).not.toBeCloseTo(incorrectlyTrialWeighted, 5);
  });

  test("increases power under a larger assumed effect with common random numbers", () => {
    const document = computePowerAnalysis(makeInput());
    for (const taskCount of [50, 100]) {
      for (const heterogeneityMultiplier of [1, 1.5]) {
        const minimumEffect = document.sensitivityGrid.find((cell) =>
          cell.taskCount === taskCount
          && cell.heterogeneityMultiplier === heterogeneityMultiplier
          && cell.assumedPairedDifference === 0.1);
        const largerEffect = document.sensitivityGrid.find((cell) =>
          cell.taskCount === taskCount
          && cell.heterogeneityMultiplier === heterogeneityMultiplier
          && cell.assumedPairedDifference === 0.2);
        expect(minimumEffect).toBeDefined();
        expect(largerEffect).toBeDefined();
        expect(largerEffect?.intersectionPower.estimate).toBeGreaterThanOrEqual(
          minimumEffect?.intersectionPower.estimate ?? 1,
        );
      }
    }
    for (const assumedPairedDifference of [0.1, 0.2]) {
      for (const heterogeneityMultiplier of [1, 1.5]) {
        const smallerSample = document.sensitivityGrid.find((cell) =>
          cell.taskCount === 50
          && cell.heterogeneityMultiplier === heterogeneityMultiplier
          && cell.assumedPairedDifference === assumedPairedDifference);
        const largerSample = document.sensitivityGrid.find((cell) =>
          cell.taskCount === 100
          && cell.heterogeneityMultiplier === heterogeneityMultiplier
          && cell.assumedPairedDifference === assumedPairedDifference);
        expect(largerSample?.intersectionPower.estimate).toBeGreaterThanOrEqual(
          smallerSample?.intersectionPower.estimate ?? 1,
        );
      }
    }
  });

  test("withholds a confirmatory plan when conservative power is below 80%", () => {
    const document = computePowerAnalysis(makeInput({
      planningEffectSize: 0.11,
      assumedEffectSizes: [0.1, 0.11],
    }));
    expect(document.decision).toMatchObject({
      status: "no_candidate_meets_target",
      confirmatoryPlan: null,
    });
  });

  test("fails closed on incomplete pairing, duplicate trials, and insufficient pilot coverage", () => {
    const outcomes = makePilotOutcomes();
    expect(() => computePowerAnalysis(makeInput({
      outcomes: outcomes.filter((outcome) => outcome.taskId !== "task-29"),
    }))).toThrow(/at least 30 distinct tasks/u);

    expect(() => computePowerAnalysis(makeInput({
      outcomes: outcomes.filter((outcome) => !(
        outcome.comparisonId === "versus-beta"
        && outcome.taskId === "task-01"
        && outcome.trialId === "seed-2"
      )),
    }))).toThrow(/same paired trial IDs|minimum is 3/u);

    expect(() => computePowerAnalysis(makeInput({
      outcomes: [...outcomes, outcomes[0]],
    }))).toThrow(/duplicate paired outcome/u);

    expect(() => computePowerAnalysis(makeInput({
      outcomes: outcomes.map((outcome) =>
        outcome.comparisonId === "versus-beta"
          && outcome.taskId === "task-01"
          && outcome.trialId === "seed-0"
          ? { ...outcome, primaryOutcome: (1 - outcome.primaryOutcome) as 0 | 1 }
          : outcome),
    }))).toThrow(/preserve primary outcomes across comparisons/u);
  });

  test("rejects designs that weaken confirmatory safeguards or hide unknown data", () => {
    const invalid = {
      ...makeInput(),
      candidateTaskCounts: [49, 50],
      confirmatoryRepositoryCount: 19,
      confirmatoryRepetitionsPerSystemTask: 2,
      assumedEffectSizes: [0.2, 0.3],
      heterogeneityMultipliers: [0.75, 1.25],
      simulationReplications: 999,
    } as PowerAnalysisInput;
    let error: unknown;
    try {
      computePowerAnalysis(invalid);
    } catch (candidate) {
      error = candidate;
    }
    expect(error).toBeInstanceOf(PowerAnalysisValidationError);
    expect((error as PowerAnalysisValidationError).issues.join("\n")).toMatch(/at least 1000|from 50|from 20|from 3|include the minimum effect 0\.10|include the unscaled value 1\.0/u);

    const outcomeWithUnknownField = {
      ...makePilotOutcomes()[0],
      unreviewedOverride: true,
    };
    expect(() => computePowerAnalysis(makeInput({
      outcomes: [
        outcomeWithUnknownField as PairedPilotBinaryOutcome,
        ...makePilotOutcomes().slice(1),
      ],
    }))).toThrow(/unknown property unreviewedOverride/u);

    expect(() => computePowerAnalysis(makeInput({
      outcomes: makePilotOutcomes().map((outcome, index) => index === 0
        ? { ...outcome, primaryOutcome: 2 as 0 | 1 }
        : outcome),
    }))).toThrow(/primaryOutcome must be binary/u);
  });
});
