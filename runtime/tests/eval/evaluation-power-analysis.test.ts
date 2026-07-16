import { describe, expect, test } from "vitest";
import { computeDocumentDigest } from "../../src/eval-contract/index.js";
import {
  PowerAnalysisDocumentValidationError,
  PowerAnalysisValidationError,
  computeInterceptOnlyCr2Inference,
  computePowerAnalysis,
  validatePowerAnalysisDocument,
  type PairedPilotBinaryOutcome,
  type PowerAnalysisInput,
} from "../../src/eval-power/index.js";

const CREATED_AT = "2026-07-16T08:00:00.000Z";

function makeDeepUnknownObject(depth = 128): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let cursor = root;
  for (let index = 0; index < depth; index += 1) {
    const next: Record<string, unknown> = {};
    cursor[`level-${index}`] = next;
    cursor = next;
  }
  return root;
}

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
          repositoryId: `repo-${String(Math.floor(taskIndex / 2)).padStart(2, "0")}`,
          trialId: `seed-${trialIndex}`,
          primaryOutcome,
          comparatorOutcome,
        });
      }
    }
  }
  return outcomes;
}

function makeExtremeHeterogeneityOutcomes(): PairedPilotBinaryOutcome[] {
  const profiles = [
    ...Array.from({ length: 7 }, () => ({ primarySuccesses: 1, comparatorSuccesses: 0 })),
    ...Array.from({ length: 17 }, () => ({ primarySuccesses: 0, comparatorSuccesses: 0 })),
    ...Array.from({ length: 4 }, () => ({ primarySuccesses: 2, comparatorSuccesses: 0 })),
    { primarySuccesses: 0, comparatorSuccesses: 3 },
    { primarySuccesses: 3, comparatorSuccesses: 0 },
  ];
  return [
    { comparisonId: "versus-alpha", comparatorSystemId: "alpha" },
    { comparisonId: "versus-beta", comparatorSystemId: "beta" },
  ].flatMap((comparison) => profiles.flatMap((profile, taskIndex) =>
    Array.from({ length: 3 }, (_, trialIndex) => ({
      ...comparison,
      taskId: `task-${String(taskIndex).padStart(2, "0")}`,
      repositoryId: `repo-${String(Math.floor(taskIndex / 2)).padStart(2, "0")}`,
      trialId: `seed-${trialIndex}`,
      primaryOutcome: (trialIndex < profile.primarySuccesses ? 1 : 0) as 0 | 1,
      comparatorOutcome: (trialIndex < profile.comparatorSuccesses ? 1 : 0) as 0 | 1,
    }))));
}

function makeInput(overrides: Partial<PowerAnalysisInput> = {}): PowerAnalysisInput {
  return {
    analysisId: "pilot-power-2026-07",
    pilotId: "pilot-30-v1",
    createdAt: CREATED_AT,
    primarySystemId: "agenc-primary",
    outcomes: makePilotOutcomes(),
    confirmatorySuiteId: "competitive-superiority",
    confirmatorySuiteVersion: "1.0.0",
    confirmatoryExperimentId: "superiority-v1",
    candidateRepositoryTaskAllocations: [
      [...Array.from({ length: 10 }, () => 2), ...Array.from({ length: 10 }, () => 3)],
      Array.from({ length: 20 }, () => 5),
    ],
    confirmatoryRepetitionsPerSystemTask: 3,
    confirmatoryInferenceResamples: 10_000,
    confirmatoryInferenceRandomSeed: 123_456,
    planningEffectSize: 0.2,
    assumedEffectSizes: [0.1, 0.2],
    heterogeneityMultipliers: [1, 1.5],
    simulationReplications: 100,
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
      candidateRepositoryTaskAllocations: input.candidateRepositoryTaskAllocations
        .map((allocation) => [...allocation].reverse()),
      assumedEffectSizes: [...input.assumedEffectSizes].reverse(),
      heterogeneityMultipliers: [...input.heterogeneityMultipliers].reverse(),
    });

    expect(permuted).toEqual(document);
    expect(document.documentDigest).toBe(computeDocumentDigest(document));
    expect(document.documentDigest).toBe(
      "sha256:d1d2867e4461676c5867b25894e0377e45f34bec9fa711875143f65746f9b196",
    );
    expect(document.pilot).toMatchObject({
      taskCount: 30,
      repositoryCount: 15,
      comparisonCount: 2,
      minimumRepetitionsPerTaskComparison: 3,
      maximumRepetitionsPerTaskComparison: 9,
      contractMinimumRepetitionsPerTaskComparison: 3,
      recommendedRepetitionsPerTaskComparison: 5,
      repetitionRecommendation: "accepted_contract_minimum_below_recommended",
      aggregation: "mean_within_task_then_equal_task_weight",
    });
    expect(document.design).toMatchObject({
      alpha: "0.05",
      targetPower: "0.80",
      minimumEffect: 0.1,
      planningEffectSize: 0.2,
      confirmatoryRepetitionsPerSystemTask: 3,
      multipleComparators: "intersection_union",
      inference: "repository_clustered_paired_percentile_bootstrap",
      interval: "two_sided_percentile",
      quantileMethod: "linear_type_7",
      optionalStopping: false,
    });
    expect(document.simulation).toMatchObject({
      method: "hierarchical_repository_task_joint_attempt_bootstrap",
      attemptModel: "empirical_joint_multinomial_with_minimal_marginal_transport",
      outcomeDependence: "shared_primary_and_joint_comparator_attempt_resampling",
      repetitionAggregation: "mean_within_task_before_repository_inference",
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
        suiteId: "competitive-superiority",
        experimentId: "superiority-v1",
        repositoryCount: 20,
        repositoryTaskCounts: expect.any(Array),
        repetitionsPerSystemTask: 3,
        inferenceResamples: 10_000,
        inferenceRandomSeed: 123_456,
        stoppingRule: { kind: "fixed", interimLooks: 0, optionalStopping: false },
      });
      expect(document.decision.confirmatoryPlan.taskCount).toBeGreaterThanOrEqual(50);
    } else {
      expect(document.decision.status).toBe("no_candidate_meets_target");
    }
  }, 20_000);

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

  test("increases power under larger effects, samples, and repeat counts", () => {
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

    const fiveRepeatDocument = computePowerAnalysis(makeInput({
      confirmatoryRepetitionsPerSystemTask: 5,
    }));
    expect(fiveRepeatDocument.documentDigest).not.toBe(document.documentDigest);
    let strictRepeatPowerImprovements = 0;
    for (const taskCount of [50, 100]) {
      for (const heterogeneityMultiplier of [1, 1.5]) {
        const threeRepeatCell = document.sensitivityGrid.find((cell) =>
          cell.taskCount === taskCount
          && cell.heterogeneityMultiplier === heterogeneityMultiplier
          && cell.assumedPairedDifference === 0.2);
        const fiveRepeatCell = fiveRepeatDocument.sensitivityGrid.find((cell) =>
          cell.taskCount === taskCount
          && cell.heterogeneityMultiplier === heterogeneityMultiplier
          && cell.assumedPairedDifference === 0.2);
        expect(fiveRepeatCell?.intersectionPower.estimate).toBeGreaterThanOrEqual(
          threeRepeatCell?.intersectionPower.estimate ?? 1,
        );
        if (
          (fiveRepeatCell?.intersectionPower.estimate ?? 0)
            > (threeRepeatCell?.intersectionPower.estimate ?? 1)
        ) {
          strictRepeatPowerImprovements += 1;
        }
      }
    }
    expect(strictRepeatPowerImprovements).toBeGreaterThan(0);
  }, 20_000);

  test("matches the intercept-only CR2 and Satterthwaite closed forms", () => {
    const clusters = Array.from({ length: 20 }, (_, repositoryIndex) =>
      Array.from({ length: repositoryIndex < 10 ? 3 : 2 }, (_, taskIndex) =>
        ((repositoryIndex * 3 + taskIndex) % 7 - 3) / 3));
    const inference = computeInterceptOnlyCr2Inference(clusters);
    const taskCount = clusters.flat().length;
    const estimate = clusters.flat().reduce((sum, value) => sum + value, 0) / taskCount;
    const sizes = clusters.map((cluster) => cluster.length);
    const scores = clusters.map((cluster) =>
      cluster.reduce((sum, value) => sum + value - estimate, 0));
    const expectedVariance = scores.reduce((sum, score, index) =>
      sum + score ** 2 / (1 - sizes[index] / taskCount), 0) / taskCount ** 2;
    const dfDenominator = taskCount ** 2 * sizes.reduce(
      (sum, size) => sum + size ** 2 / (taskCount - size) ** 2,
      0,
    ) - 2 * taskCount * sizes.reduce(
      (sum, size) => sum + size ** 3 / (taskCount - size) ** 2,
      0,
    ) + sizes.reduce(
      (sum, size) => sum + size ** 2 / (taskCount - size),
      0,
    ) ** 2;
    const expectedDf = taskCount ** 2 / dfDenominator;

    expect(inference.estimate).toBeCloseTo(estimate, 14);
    expect(inference.standardError ** 2).toBeCloseTo(expectedVariance, 14);
    expect(inference.degreesOfFreedom).toBeCloseTo(expectedDf, 14);
    expect(inference.standardError).toBeCloseTo(0.1084061402917523, 14);
    expect(inference.degreesOfFreedom).toBeCloseTo(18.232654114005673, 14);
    expect(inference.lower95).toBeCloseTo(-0.25421133880089813, 12);
    expect(inference.upper95).toBeCloseTo(0.2008780054675648, 12);
    expect(inference.degreesOfFreedom).toBeLessThan(19);
    expect(inference.lower95).toBeLessThan(inference.estimate);
    expect(inference.upper95).toBeGreaterThan(inference.estimate);

    const equalClusters = Array.from({ length: 20 }, (_, repositoryIndex) => [
      (repositoryIndex % 5) / 5,
      ((repositoryIndex + 1) % 5) / 5,
      ((repositoryIndex + 2) % 5) / 5,
    ]);
    expect(computeInterceptOnlyCr2Inference(equalClusters).degreesOfFreedom).toBeCloseTo(19, 13);
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

  test("rejects effects that the pilot primary outcomes cannot attain", () => {
    expect(() => computePowerAnalysis(makeInput({
      outcomes: makePilotOutcomes().map((outcome) => ({
        ...outcome,
        primaryOutcome: 0,
        comparatorOutcome: 0,
      })),
    }))).toThrow(/assumed effect 0\.1 exceeds the pilot-supported maximum 0/u);
  });

  test("calibrates extreme heterogeneity beyond the former fixed offset bracket", () => {
    const document = computePowerAnalysis(makeInput({
      outcomes: makeExtremeHeterogeneityOutcomes(),
      heterogeneityMultipliers: [1, 2],
    }));
    const extremeCells = document.sensitivityGrid.filter((cell) =>
      cell.assumedPairedDifference === 0.2 && cell.heterogeneityMultiplier === 2);
    expect(extremeCells).toHaveLength(2);
    expect(document.documentDigest).toBe(
      "sha256:bab8a86951a46543d17c675d38db198347ca7982f9adc77c393d4c5f8d3f66c2",
    );
  }, 20_000);

  test("requires exact planning-effect membership before simulation", () => {
    const startedAt = performance.now();
    expect(() => computePowerAnalysis(makeInput({
      planningEffectSize: 0.2 + 5e-13,
    }))).toThrow(/planningEffectSize must be present in assumedEffectSizes/u);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });

  test("preserves high-precision sensitivity dimensions through revalidation", () => {
    const planningEffect = 0.2000000000001;
    const heterogeneity = 1.5000000000001;
    const document = computePowerAnalysis(makeInput({
      planningEffectSize: planningEffect,
      assumedEffectSizes: [0.1, planningEffect],
      heterogeneityMultipliers: [1, heterogeneity],
    }));
    expect(document.design.planningEffectSize).toBe(planningEffect);
    expect(document.design.assumedEffectSizes).toContain(planningEffect);
    expect(document.design.heterogeneityMultipliers).toContain(heterogeneity);
    expect(document.sensitivityGrid.filter((cell) =>
      cell.assumedPairedDifference === planningEffect
      && cell.heterogeneityMultiplier === heterogeneity)).toHaveLength(2);
    expect(validatePowerAnalysisDocument(document)).toEqual(document);
  }, 20_000);

  test("fails closed on incomplete pairing, duplicate trials, and insufficient pilot coverage", () => {
    const outcomes = makePilotOutcomes();
    expect(() => computePowerAnalysis(makeInput({
      outcomes: outcomes.filter((outcome) => outcome.taskId !== "task-29"),
    }))).toThrow(/at least 30 distinct tasks/u);

    expect(() => computePowerAnalysis(makeInput({
      outcomes: outcomes.map((outcome) => ({
        ...outcome,
        repositoryId: `repo-${Math.floor(Number(outcome.taskId.slice(-2)) / 3)}`,
      })),
    }))).toThrow(/at least 15 repositories/u);

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
      candidateRepositoryTaskAllocations: [Array.from({ length: 19 }, () => 2)],
      confirmatoryRepetitionsPerSystemTask: 2,
      confirmatoryInferenceResamples: 9_999,
      assumedEffectSizes: [0.2, 0.3],
      heterogeneityMultipliers: [0.75, 1.25],
      simulationReplications: 99,
    } as PowerAnalysisInput;
    let error: unknown;
    try {
      computePowerAnalysis(invalid);
    } catch (candidate) {
      error = candidate;
    }
    expect(error).toBeInstanceOf(PowerAnalysisValidationError);
    expect((error as PowerAnalysisValidationError).issues.join("\n")).toMatch(/at least 100|total 50|at least 20|from 3|from 10000|include the minimum effect 0\.10|include the unscaled value 1\.0/u);

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

  test("rejects oversized grids and aggregate bootstrap work before simulation", () => {
    const startedAt = performance.now();
    expect(() => computePowerAnalysis(makeInput({
      assumedEffectSizes: [0.1, 0.15, 0.2, 0.25, 0.3],
      planningEffectSize: 0.2,
      heterogeneityMultipliers: [0.5, 0.75, 1, 1.25],
      candidateRepositoryTaskAllocations: [
        [...Array.from({ length: 10 }, () => 2), ...Array.from({ length: 10 }, () => 3)],
        Array.from({ length: 20 }, () => 5),
      ],
      simulationReplications: 10_000,
      confirmatoryInferenceResamples: 1_000_000,
    }))).toThrow(/sensitivity grid cannot exceed|aggregate bootstrap work cannot exceed/u);
    expect(() => computePowerAnalysis(makeInput({
      candidateRepositoryTaskAllocations: [Array.from({ length: 20 }, () => 500)],
      confirmatoryRepetitionsPerSystemTask: 1_000,
    }))).toThrow(/aggregate synthetic attempt work cannot exceed/u);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  test("rejects oversized input and document collections with bounded diagnostics", () => {
    const row = makePilotOutcomes()[0];
    let startedAt = performance.now();
    expect(() => computePowerAnalysis(makeInput({
      outcomes: new Array(100_001).fill(row),
    }))).toThrow(/outcomes cannot exceed 100000 paired rows/u);
    expect(() => computePowerAnalysis(makeInput({
      assumedEffectSizes: new Array(33).fill(0.1),
    }))).toThrow(/assumedEffectSizes cannot exceed 32 values/u);
    expect(() => computePowerAnalysis(makeInput({
      outcomes: Array.from({ length: 129 }, (_, index) => ({
        ...row,
        comparisonId: `comparison-${index}`,
        comparatorSystemId: `comparator-${index}`,
      })),
    }))).toThrow(/cannot exceed 128 comparisons/u);
    expect(performance.now() - startedAt).toBeLessThan(500);

    const document = computePowerAnalysis(makeInput());
    startedAt = performance.now();
    expect(() => validatePowerAnalysisDocument({
      ...document,
      sensitivityGrid: new Array(33).fill(document.sensitivityGrid[0]),
    })).toThrow(/sensitivityGrid cannot exceed 32 entries/u);
    expect(() => validatePowerAnalysisDocument({
      ...document,
      pilot: {
        ...document.pilot,
        comparisons: new Array(129).fill(document.pilot.comparisons[0]),
      },
    })).toThrow(/pilot\.comparisons cannot exceed 128 entries/u);
    const excessiveBootstrapWork = {
      ...document,
      design: {
        ...document.design,
        candidateRepositoryTaskAllocations: [Array.from({ length: 20 }, () => 500)],
      },
    };
    const excessiveBootstrapWorkWithDigest = {
      ...excessiveBootstrapWork,
      documentDigest: computeDocumentDigest(excessiveBootstrapWork),
    };
    expect(() => validatePowerAnalysisDocument(excessiveBootstrapWorkWithDigest)).toThrow(
      /aggregate bootstrap work exceeds the synchronous ceiling/u,
    );
    expect(performance.now() - startedAt).toBeLessThan(500);

    let error: unknown;
    try {
      validatePowerAnalysisDocument({
        ...document,
        pilot: {
          ...document.pilot,
          comparisons: Array.from({ length: 128 }, () => ({})),
        },
      });
    } catch (candidate) {
      error = candidate;
    }
    expect(error).toBeInstanceOf(PowerAnalysisDocumentValidationError);
    expect((error as PowerAnalysisDocumentValidationError).issues.length).toBeLessThanOrEqual(100);
  }, 20_000);

  test("rejects accessors without invoking them during fail-fast preflight", () => {
    let getterCalls = 0;
    const inputWithAccessor = {
      ...makeInput(),
      get outcomes(): readonly PairedPilotBinaryOutcome[] {
        getterCalls += 1;
        return makePilotOutcomes();
      },
    };
    expect(() => computePowerAnalysis(inputWithAccessor)).toThrow(
      /input\.outcomes must be an own enumerable data property/u,
    );
    expect(getterCalls).toBe(0);

    const document = computePowerAnalysis(makeInput());
    const documentWithAccessor = {
      ...document,
      get sensitivityGrid(): typeof document.sensitivityGrid {
        getterCalls += 1;
        return document.sensitivityGrid;
      },
    };
    expect(() => validatePowerAnalysisDocument(documentWithAccessor)).toThrow(
      /document\.sensitivityGrid must be an own enumerable data property/u,
    );
    expect(getterCalls).toBe(0);
  }, 20_000);

  test("bounds nested unknown I-JSON before canonicalization without invoking accessors", () => {
    const outcomes = makePilotOutcomes();
    outcomes[0] = {
      ...outcomes[0],
      unknownPayload: makeDeepUnknownObject(),
    } as PairedPilotBinaryOutcome;
    let startedAt = performance.now();
    expect(() => computePowerAnalysis(makeInput({ outcomes }))).toThrow(
      /maximum I-JSON depth 64/u,
    );
    expect(performance.now() - startedAt).toBeLessThan(500);

    let getterCalls = 0;
    const accessorOutcomes = makePilotOutcomes();
    accessorOutcomes[0] = {
      ...accessorOutcomes[0],
      get unknownPayload(): unknown {
        getterCalls += 1;
        return makeDeepUnknownObject();
      },
    } as PairedPilotBinaryOutcome;
    expect(() => computePowerAnalysis(makeInput({ outcomes: accessorOutcomes }))).toThrow(
      /must be an own enumerable data property/u,
    );
    expect(getterCalls).toBe(0);

    const document = computePowerAnalysis(makeInput());
    const comparisons = [...document.pilot.comparisons];
    comparisons[0] = {
      ...comparisons[0],
      unknownPayload: makeDeepUnknownObject(),
    } as typeof comparisons[number];
    startedAt = performance.now();
    expect(() => validatePowerAnalysisDocument({
      ...document,
      pilot: { ...document.pilot, comparisons },
    })).toThrow(/maximum I-JSON depth 64/u);
    expect(performance.now() - startedAt).toBeLessThan(500);

    const accessorComparisons = [...document.pilot.comparisons];
    accessorComparisons[0] = {
      ...accessorComparisons[0],
      get unknownPayload(): unknown {
        getterCalls += 1;
        return makeDeepUnknownObject();
      },
    } as typeof accessorComparisons[number];
    expect(() => validatePowerAnalysisDocument({
      ...document,
      pilot: { ...document.pilot, comparisons: accessorComparisons },
    })).toThrow(/must be an own enumerable data property/u);
    expect(getterCalls).toBe(0);
  }, 20_000);
});
