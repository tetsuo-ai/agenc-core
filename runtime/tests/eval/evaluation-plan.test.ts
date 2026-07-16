import { describe, expect, test } from "vitest";
import {
  EVAL_CONTRACT_VERSION,
  computePlannedExecutionOrderDigest,
  digestCanonicalJson,
  withDocumentDigest,
  type HoldoutDescriptorDocument,
  type OperatorTaskDocument,
  type PreregistrationDocument,
  type SuiteManifestDocument,
} from "../../src/eval-contract/index.js";
import {
  EvaluationPlanValidationError,
  validateEvaluationPlan,
  type EvaluationPlanInput,
} from "../../src/eval-contract/evaluation-plan.js";
import type { PowerAnalysisDocument } from "../../src/eval-power/index.js";
import {
  FIXED_TIME,
  digest,
  makeHoldoutDescriptor,
  makeOperatorTask,
  makePreregistration,
  makeSystem,
} from "./evaluation-contract-fixtures.js";

function makeSuite(
  taskCount: number,
  split: "development" | "private_holdout" = "development",
): SuiteManifestDocument {
  const tasks = Array.from({ length: taskCount }, (_, index) => makeOperatorTask(index, split));
  return withDocumentDigest<SuiteManifestDocument>({
    kind: "agenc.eval.suite-manifest",
    contractVersion: EVAL_CONTRACT_VERSION,
    suiteId: split === "development" ? "competitive-pilot" : "competitive-superiority",
    suiteVersion: "1.0.0",
    split,
    createdAt: FIXED_TIME,
    repositoryFamilies: tasks.map((task) => ({
      cluster: task.repository.cluster,
      canonicalRepositoryUri: task.repository.uri,
      memberRepositoryUris: [task.repository.uri],
    })),
    tasks,
  });
}

function makePilotPreregistration(suite = makeSuite(30)): PreregistrationDocument {
  const preregistration = makePreregistration(suite);
  return withDocumentDigest<PreregistrationDocument>({
    ...preregistration,
    experimentId: "pilot-clean",
    claim: "pilot",
    samplePlan: {
      minimumTasks: 30,
      maximumTasks: 30,
      minimumRepositories: 30,
      stoppingRule: { kind: "fixed", taskCount: 30 },
    },
  });
}

function makeSuperiorityPlan(): {
  readonly suite: SuiteManifestDocument;
  readonly descriptor: HoldoutDescriptorDocument;
  readonly preregistration: PreregistrationDocument;
  readonly powerAnalysis: PowerAnalysisDocument;
} {
  const suite = makeSuite(50, "private_holdout");
  const descriptor = makeHoldoutDescriptor(suite);
  const base = makePreregistration(suite, descriptor);
  const secondComparator = makeSystem("comparator-two");
  const systems = [...base.systems, secondComparator];
  const comparisons = [
    ...base.comparisons,
    {
      comparisonId: "agenc-vs-two",
      primarySystemId: base.primarySystemId,
      comparatorSystemId: secondComparator.systemId,
    },
  ];
  const seedSlots = [101, 202, 303];
  const powerAnalysisDigest = digest("reviewed-superiority-power-analysis");
  const preregistration = withDocumentDigest<PreregistrationDocument>({
    ...base,
    experimentId: "superiority-clean",
    claim: "superiority",
    systems,
    comparisons,
    trialDesign: {
      ...base.trialDesign,
      repetitionsPerSystemTask: seedSlots.length,
      seedSlots,
      plannedExecutionOrderDigest: computePlannedExecutionOrderDigest({
        systemIds: systems.map((system) => system.systemId),
        taskIds: suite.tasks.map((task) => task.taskId),
        seedSlots,
        orderSeed: base.trialDesign.orderSeed,
      }),
    },
    inference: { ...base.inference, powerAnalysisDigest },
    samplePlan: {
      minimumTasks: 50,
      maximumTasks: 50,
      minimumRepositories: 50,
      stoppingRule: { kind: "fixed", taskCount: 50 },
    },
  });
  const repositoryTaskCounts = Array.from({ length: 50 }, () => 1);
  const powerAnalysis = withDocumentDigest<PowerAnalysisDocument>({
    kind: "agenc.eval.power-analysis",
    analysisVersion: "1.0.0",
    analysisId: "reviewed-superiority-power-analysis",
    pilotId: "pilot-30-v1",
    createdAt: "2026-07-15T10:00:00.000Z",
    primarySystemId: comparisons[0].primarySystemId,
    pilot: {
      inputDigest: digest("pilot-input"),
      taskCount: 30,
      repositoryCount: 30,
      comparisonCount: comparisons.length,
      minimumRepetitionsPerTaskComparison: 3,
      maximumRepetitionsPerTaskComparison: 3,
      contractMinimumRepetitionsPerTaskComparison: 3,
      recommendedRepetitionsPerTaskComparison: 5,
      repetitionRecommendation: "accepted_contract_minimum_below_recommended",
      aggregation: "mean_within_task_then_equal_task_weight",
      repositoryTaskCounts: Array.from({ length: 30 }, (_, index) => ({
        repositoryId: `pilot-repo-${String(index).padStart(2, "0")}`,
        taskCount: 1,
      })),
      comparisons: comparisons.map((comparison) => ({
        comparisonId: comparison.comparisonId,
        comparatorSystemId: comparison.comparatorSystemId,
        primaryTaskMeanSuccessRate: 0.8,
        comparatorTaskMeanSuccessRate: 0.5,
        pairedDifferenceTaskWeighted: 0.3,
        pairedDifferenceRepositoryWeighted: 0.3,
        repositoryBetweenVariance: 0.01,
        withinRepositoryVariance: 0.02,
        empiricalRepositoryVarianceShare: 0.333333333333,
      })),
    },
    design: {
      alpha: "0.05",
      targetPower: "0.80",
      minimumEffect: 0.1,
      primaryMetric: "paired_binary_success_rate_difference",
      inference: "repository_clustered_paired_percentile_bootstrap",
      interval: "two_sided_percentile",
      quantileMethod: "linear_type_7",
      inferenceUnit: "task_mean_after_repetition_aggregation",
      clusteringUnit: "repository",
      multipleComparators: "intersection_union",
      successRule: "point_at_least_minimum_effect_and_two_sided_lower_bound_above_zero_for_every_comparator",
      planningEffectSize: 0.2,
      assumedEffectSizes: [0.1, 0.2],
      heterogeneityMultipliers: [1, 1.5],
      confirmatorySuiteId: suite.suiteId,
      confirmatorySuiteVersion: suite.suiteVersion,
      confirmatoryExperimentId: "superiority-clean",
      candidateRepositoryTaskAllocations: [repositoryTaskCounts],
      confirmatoryRepetitionsPerSystemTask: 3,
      confirmatoryInferenceResamples: base.inference.resamples,
      confirmatoryInferenceRandomSeed: base.inference.randomSeed,
      confirmatoryRepositoryCapPercent: 10,
      optionalStopping: false,
    },
    simulation: {
      method: "hierarchical_repository_task_joint_attempt_bootstrap",
      attemptModel: "empirical_joint_multinomial_with_minimal_marginal_transport",
      sensitivityModel: "bounded_location_shift_of_paired_attempt_means",
      outcomeDependence: "shared_primary_and_joint_comparator_attempt_resampling",
      repetitionAggregation: "mean_within_task_before_repository_inference",
      repositorySampling: "uniform_with_replacement",
      taskSamplingWithinRepository: "uniform_with_replacement",
      commonRandomNumbersAcrossSensitivityCells: true,
      simulationReplications: 100,
      randomSeed: 1234,
      randomStream: "sha256_domain_seeded_xorshift32_rejection_sampling_v1",
      confirmatoryInference: "production_repository_clustered_percentile_bootstrap",
      powerDecisionInterval: "two_sided_wilson_95",
    },
    sensitivityGrid: [0.1, 0.2].flatMap((assumedPairedDifference) => [1, 1.5].map((heterogeneityMultiplier) => ({
      assumedPairedDifference,
      heterogeneityMultiplier,
      taskCount: 50,
      repositoryCount: 50,
      comparisonPower: comparisons.map((comparison) => ({
        comparisonId: comparison.comparisonId,
        power: {
          successes: 95,
          replications: 100,
          estimate: 0.95,
          monteCarloStandardError: 0.021794494718,
          wilsonLower95: 0.888249530768,
          wilsonUpper95: 0.978456320846,
        },
      })),
      intersectionPower: {
        successes: 90,
        replications: 100,
        estimate: 0.9,
        monteCarloStandardError: 0.03,
        wilsonLower95: 0.825634338495,
        wilsonUpper95: 0.94477086294,
      },
    }))),
    decision: {
      status: "adequately_powered",
      rule: "smallest_fixed_n_whose_intersection_power_wilson_lower_95_meets_target_at_planning_effect_across_heterogeneity_grid",
      confirmatoryPlan: {
        suiteId: suite.suiteId,
        suiteVersion: suite.suiteVersion,
        experimentId: "superiority-clean",
        taskCount: 50,
        repositoryCount: 50,
        repositoryTaskCounts,
        repetitionsPerSystemTask: 3,
        inferenceResamples: base.inference.resamples,
        inferenceRandomSeed: base.inference.randomSeed,
        stoppingRule: { kind: "fixed", taskCount: 50, interimLooks: 0, optionalStopping: false },
      },
    },
  });
  const boundPreregistration = withDocumentDigest<PreregistrationDocument>({
    ...preregistration,
    inference: { ...preregistration.inference, powerAnalysisDigest: powerAnalysis.documentDigest },
  });
  return { suite, descriptor, preregistration: boundPreregistration, powerAnalysis };
}

function pilotInput(
  suite = makeSuite(30),
  preregistration = makePilotPreregistration(suite),
): EvaluationPlanInput {
  return { suite, preregistration };
}

function replaceTask(
  suite: SuiteManifestDocument,
  index: number,
  mutate: (task: OperatorTaskDocument) => Omit<OperatorTaskDocument, "documentDigest">,
): SuiteManifestDocument {
  const replacement = withDocumentDigest<OperatorTaskDocument>(mutate(suite.tasks[index]));
  return withDocumentDigest<SuiteManifestDocument>({
    ...suite,
    tasks: suite.tasks.map((task, taskIndex) => taskIndex === index ? replacement : task),
  });
}

describe("pre-run evaluation plan validation", () => {
  test("accepts and freezes an exact 30-task public pilot plan", () => {
    const validated = validateEvaluationPlan(pilotInput());

    expect(validated).toMatchObject({
      taskCount: 30,
      repositoryCount: 30,
      maximumTasksPerRepository: 1,
    });
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated.suite)).toBe(true);
    expect(Object.isFrozen(validated.suite.tasks[0])).toBe(true);
    expect(Object.isFrozen(validated.preregistration)).toBe(true);
  });

  test("binds suite identity and the exact fixed sample before any run", () => {
    const suite = makeSuite(30);
    const preregistration = makePilotPreregistration(suite);
    const wrongSuite = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      suite: { ...preregistration.suite, manifestDigest: digest("another-suite") },
    });
    expect(() => validateEvaluationPlan(pilotInput(suite, wrongSuite))).toThrow(
      /suite identity, version, digest, or split/u,
    );

    const wrongCount = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      samplePlan: {
        minimumTasks: 31,
        maximumTasks: 31,
        minimumRepositories: 30,
        stoppingRule: { kind: "fixed", taskCount: 31 },
      },
    });
    expect(() => validateEvaluationPlan(pilotInput(suite, wrongCount))).toThrow(
      /selected task count.*fixed preregistered sample/u,
    );

    const tooManyRepositories = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      samplePlan: { ...preregistration.samplePlan, minimumRepositories: 31 },
    });
    expect(() => validateEvaluationPlan(pilotInput(suite, tooManyRepositories))).toThrow(
      /fewer repository families than preregistered/u,
    );
  });

  test("binds repository families, task resets, and the randomized matrix digest", () => {
    const suite = makeSuite(30);
    const preregistration = makePilotPreregistration(suite);
    const wrongFamilies = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      suite: { ...preregistration.suite, repositoryFamilyMapDigest: digest("wrong-family-map") },
    });
    expect(() => validateEvaluationPlan(pilotInput(suite, wrongFamilies))).toThrow(
      /repository family map digest/u,
    );

    const wrongReset = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      resetPolicy: {
        ...preregistration.resetPolicy,
        id: "different-reset",
        digest: digest("different-reset"),
      },
    });
    expect(() => validateEvaluationPlan(pilotInput(suite, wrongReset))).toThrow(
      /reset recipe differs/u,
    );

    const wrongOrder = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      trialDesign: {
        ...preregistration.trialDesign,
        plannedExecutionOrderDigest: digest("wrong-execution-order"),
      },
    });
    expect(() => validateEvaluationPlan(pilotInput(suite, wrongOrder))).toThrow(
      /planned execution-order digest/u,
    );
  });

  test("rejects unused repository families and duplicated oracle identities", () => {
    const suite = makeSuite(30);
    const unusedUri = "https://example.invalid/repositories/unused";
    const withUnusedFamily = withDocumentDigest<SuiteManifestDocument>({
      ...suite,
      repositoryFamilies: [
        ...suite.repositoryFamilies,
        {
          cluster: "unused-repo",
          canonicalRepositoryUri: unusedUri,
          memberRepositoryUris: [unusedUri],
        },
      ],
    });
    expect(() => validateEvaluationPlan(pilotInput(
      withUnusedFamily,
      makePilotPreregistration(withUnusedFamily),
    ))).toThrow(/repository family is declared but unused/u);

    const duplicatedGold = replaceTask(suite, 1, (task) => ({
      ...task,
      referenceSolution: {
        ...task.referenceSolution,
        patch: suite.tasks[0].referenceSolution.patch,
      },
    }));
    expect(() => validateEvaluationPlan(pilotInput(
      duplicatedGold,
      makePilotPreregistration(duplicatedGold),
    ))).toThrow(/reference-solution patch digests must be unique/u);
  });

  test("requires exactly 30 public, non-synthetic development tasks for a pilot", () => {
    const thirtyOne = makeSuite(31);
    const thirtyOneBase = makePreregistration(thirtyOne);
    const thirtyOnePreregistration = withDocumentDigest<PreregistrationDocument>({
      ...thirtyOneBase,
      claim: "pilot",
      samplePlan: {
        minimumTasks: 31,
        maximumTasks: 31,
        minimumRepositories: 31,
        stoppingRule: { kind: "fixed", taskCount: 31 },
      },
    });
    expect(() => validateEvaluationPlan({
      suite: thirtyOne,
      preregistration: thirtyOnePreregistration,
    })).toThrow(/pilot requires exactly 30 tasks/u);

    const suite = makeSuite(30);
    const privateAuthored = replaceTask(suite, 0, (task) => ({
      ...task,
      provenance: { ...task.provenance, sourceType: "private_authored" },
    }));
    expect(() => validateEvaluationPlan(pilotInput(
      privateAuthored,
      makePilotPreregistration(privateAuthored),
    ))).toThrow(/pilot tasks must be public real-repository issues/u);

    const synthetic = replaceTask(suite, 0, (task) => ({
      ...task,
      provenance: { ...task.provenance, sourceType: "synthetic_diagnostic" },
    }));
    expect(() => validateEvaluationPlan(pilotInput(
      synthetic,
      makePilotPreregistration(synthetic),
    ))).toThrow(/pilot tasks must be public real-repository issues|must not be synthetic/u);
  });

  test("accepts a sealed superiority plan only with its complete reviewed power document", () => {
    const { suite, descriptor, preregistration, powerAnalysis } = makeSuperiorityPlan();
    const validated = validateEvaluationPlan({
      suite,
      preregistration,
      holdoutDescriptor: descriptor,
      powerAnalysis,
    });

    expect(validated).toMatchObject({
      taskCount: 50,
      repositoryCount: 50,
      maximumTasksPerRepository: 1,
    });
    expect(validated.holdoutDescriptor?.documentDigest).toBe(descriptor.documentDigest);

    expect(() => validateEvaluationPlan({
      suite,
      preregistration,
      holdoutDescriptor: descriptor,
    })).toThrow(/complete independently supplied power-analysis document/u);
    expect(() => validateEvaluationPlan({
      suite,
      preregistration,
      holdoutDescriptor: descriptor,
      powerAnalysis: withDocumentDigest<PowerAnalysisDocument>({
        ...powerAnalysis,
        analysisId: "different-power-analysis",
      }),
    })).toThrow(/power-analysis digest differs/u);
    expect(() => validateEvaluationPlan({
      suite,
      preregistration,
      powerAnalysis,
    })).toThrow(/private holdout plan requires its public descriptor/u);
  });

  test("rejects falsey non-document holdout and power artifacts", () => {
    const { suite, descriptor, preregistration, powerAnalysis } = makeSuperiorityPlan();
    expect(() => validateEvaluationPlan({
      suite,
      preregistration,
      holdoutDescriptor: false,
      powerAnalysis,
    } as unknown as EvaluationPlanInput)).toThrow(
      /holdout descriptor must be a document object when supplied/u,
    );
    expect(() => validateEvaluationPlan({
      suite,
      preregistration,
      holdoutDescriptor: descriptor,
      powerAnalysis: false,
    } as unknown as EvaluationPlanInput)).toThrow(
      /power analysis must be a document object when supplied/u,
    );
  });

  test("binds superiority descriptor counts, commitments, and lifecycle ordering", () => {
    const { suite, descriptor, preregistration, powerAnalysis } = makeSuperiorityPlan();
    const wrongCountDescriptor = withDocumentDigest<HoldoutDescriptorDocument>({
      ...descriptor,
      taskCount: 51,
    });
    const wrongCountPreregistration = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      suite: {
        ...preregistration.suite,
        holdoutDescriptorDigest: wrongCountDescriptor.documentDigest,
      },
    });
    expect(() => validateEvaluationPlan({
      suite,
      preregistration: wrongCountPreregistration,
      holdoutDescriptor: wrongCountDescriptor,
      powerAnalysis,
    })).toThrow(/holdout descriptor counts/u);

    const wrongCommitmentDescriptor = withDocumentDigest<HoldoutDescriptorDocument>({
      ...descriptor,
      taskManifestCommitment: {
        ...descriptor.taskManifestCommitment,
        digest: digest("different-task-selection"),
      },
    });
    const wrongCommitmentPreregistration = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      suite: {
        ...preregistration.suite,
        holdoutDescriptorDigest: wrongCommitmentDescriptor.documentDigest,
      },
    });
    expect(() => validateEvaluationPlan({
      suite,
      preregistration: wrongCommitmentPreregistration,
      holdoutDescriptor: wrongCommitmentDescriptor,
      powerAnalysis,
    })).toThrow(/task-manifest commitment differs/u);

    const lateSealDescriptor = withDocumentDigest<HoldoutDescriptorDocument>({
      ...descriptor,
      sealedAt: "2026-07-15T12:00:01Z",
    });
    const lateSealPreregistration = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      suite: {
        ...preregistration.suite,
        holdoutDescriptorDigest: lateSealDescriptor.documentDigest,
      },
    });
    expect(() => validateEvaluationPlan({
      suite,
      preregistration: lateSealPreregistration,
      holdoutDescriptor: lateSealDescriptor,
      powerAnalysis,
    })).toThrow(/created, sealed, and then preregistered/u);

    const latePowerAnalysis = withDocumentDigest<PowerAnalysisDocument>({
      ...powerAnalysis,
      createdAt: "2026-07-15T12:00:01.000Z",
    });
    const latePowerPreregistration = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      inference: {
        ...preregistration.inference,
        powerAnalysisDigest: latePowerAnalysis.documentDigest,
      },
    });
    expect(() => validateEvaluationPlan({
      suite,
      preregistration: latePowerPreregistration,
      holdoutDescriptor: descriptor,
      powerAnalysis: latePowerAnalysis,
    })).toThrow(/power analysis must be created before or at preregistration/u);
  });

  test("rejects underpowered, malformed, and differently allocated reviewed artifacts", () => {
    const { suite, descriptor, preregistration, powerAnalysis } = makeSuperiorityPlan();
    const underpowered = withDocumentDigest<PowerAnalysisDocument>({
      ...powerAnalysis,
      decision: {
        ...powerAnalysis.decision,
        status: "no_candidate_meets_target",
        confirmatoryPlan: null,
      },
    });
    const underpoweredPreregistration = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      inference: { ...preregistration.inference, powerAnalysisDigest: underpowered.documentDigest },
    });
    expect(() => validateEvaluationPlan({
      suite,
      preregistration: underpoweredPreregistration,
      holdoutDescriptor: descriptor,
      powerAnalysis: underpowered,
    })).toThrow(/not adequately powered|smallest adequately powered/u);

    const wrongVector = [...Array.from({ length: 48 }, () => 1), 2];
    const wrongAllocation = withDocumentDigest<PowerAnalysisDocument>({
      ...powerAnalysis,
      design: {
        ...powerAnalysis.design,
        candidateRepositoryTaskAllocations: [wrongVector],
      },
      sensitivityGrid: powerAnalysis.sensitivityGrid.map((cell) => ({
        ...cell,
        repositoryCount: 49,
      })),
      decision: {
        ...powerAnalysis.decision,
        confirmatoryPlan: {
          ...(powerAnalysis.decision.confirmatoryPlan as NonNullable<typeof powerAnalysis.decision.confirmatoryPlan>),
          repositoryCount: 49,
          repositoryTaskCounts: wrongVector,
        },
      },
    });
    const wrongAllocationPreregistration = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      inference: { ...preregistration.inference, powerAnalysisDigest: wrongAllocation.documentDigest },
    });
    expect(() => validateEvaluationPlan({
      suite,
      preregistration: wrongAllocationPreregistration,
      holdoutDescriptor: descriptor,
      powerAnalysis: wrongAllocation,
    })).toThrow(/fixed repository allocation differs/u);

    const malformed = withDocumentDigest<PowerAnalysisDocument>({
      ...powerAnalysis,
      design: {
        ...powerAnalysis.design,
        unexpectedOverride: true,
      } as PowerAnalysisDocument["design"],
    });
    expect(() => validateEvaluationPlan({
      suite,
      preregistration,
      holdoutDescriptor: descriptor,
      powerAnalysis: malformed,
    })).toThrow(/unknown property unexpectedOverride/u);

    const invalidRelationships = withDocumentDigest<PowerAnalysisDocument>({
      ...powerAnalysis,
      pilot: {
        ...powerAnalysis.pilot,
        aggregation: "trial_weighted" as PowerAnalysisDocument["pilot"]["aggregation"],
      },
      design: {
        ...powerAnalysis.design,
        assumedEffectSizes: [0.2, 0.1],
      },
    });
    const invalidRelationshipsPreregistration = withDocumentDigest<PreregistrationDocument>({
      ...preregistration,
      inference: {
        ...preregistration.inference,
        powerAnalysisDigest: invalidRelationships.documentDigest,
      },
    });
    expect(() => validateEvaluationPlan({
      suite,
      preregistration: invalidRelationshipsPreregistration,
      holdoutDescriptor: descriptor,
      powerAnalysis: invalidRelationships,
    })).toThrow(/fixed constants|sensitivity dimensions/u);
  });

  test("rejects a holdout descriptor on a development plan and unknown input fields", () => {
    const input = pilotInput();
    const privateDescriptor = makeHoldoutDescriptor(makeSuite(10, "private_holdout"));
    expect(() => validateEvaluationPlan({
      ...input,
      holdoutDescriptor: privateDescriptor,
    })).toThrow(/development plan must not include a holdout descriptor/u);
    expect(() => validateEvaluationPlan({
      ...input,
      powerAnalysis: { evil: true },
    } as unknown as EvaluationPlanInput)).toThrow(
      /non-superiority plan must not include a power-analysis document/u,
    );

    expect(() => validateEvaluationPlan({
      ...input,
      unexpected: true,
    } as EvaluationPlanInput)).toThrow(EvaluationPlanValidationError);
    expect(() => validateEvaluationPlan({
      ...input,
      unexpected: true,
    } as EvaluationPlanInput)).toThrow(/unknown property unexpected/u);
  });

  test("rejects accessor-backed inputs without executing them", () => {
    let getterCalls = 0;
    const input = {} as EvaluationPlanInput;
    Object.defineProperty(input, "suite", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return makeSuite(30);
      },
    });
    Object.defineProperty(input, "preregistration", {
      enumerable: true,
      value: makePilotPreregistration(),
    });

    expect(() => validateEvaluationPlan(input)).toThrow(/enumerable data property/u);
    expect(getterCalls).toBe(0);
  });

  test("uses the contract's exact repository-family digest domain", () => {
    const suite = makeSuite(30);
    const preregistration = makePilotPreregistration(suite);
    expect(preregistration.suite.repositoryFamilyMapDigest).toBe(
      digestCanonicalJson("agenc.eval.repository-family-map.v1", suite.repositoryFamilies),
    );
    expect(() => validateEvaluationPlan({ suite, preregistration })).not.toThrow();
  });
});
