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
import {
  FIXED_TIME,
  digest,
  makeHoldoutDescriptor,
  makeOperatorTask,
  makePreregistration,
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
  readonly powerAnalysisDigest: `sha256:${string}`;
} {
  const suite = makeSuite(50, "private_holdout");
  const descriptor = makeHoldoutDescriptor(suite);
  const base = makePreregistration(suite, descriptor);
  const seedSlots = [101, 202, 303];
  const powerAnalysisDigest = digest("reviewed-superiority-power-analysis");
  const preregistration = withDocumentDigest<PreregistrationDocument>({
    ...base,
    experimentId: "superiority-clean",
    claim: "superiority",
    trialDesign: {
      ...base.trialDesign,
      repetitionsPerSystemTask: seedSlots.length,
      seedSlots,
      plannedExecutionOrderDigest: computePlannedExecutionOrderDigest({
        systemIds: base.systems.map((system) => system.systemId),
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
  return { suite, descriptor, preregistration, powerAnalysisDigest };
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

  test("accepts a sealed superiority plan only with its independently reviewed power digest", () => {
    const { suite, descriptor, preregistration, powerAnalysisDigest } = makeSuperiorityPlan();
    const validated = validateEvaluationPlan({
      suite,
      preregistration,
      holdoutDescriptor: descriptor,
      expectedPowerAnalysisDigest: powerAnalysisDigest,
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
    })).toThrow(/independently supplied power-analysis digest/u);
    expect(() => validateEvaluationPlan({
      suite,
      preregistration,
      holdoutDescriptor: descriptor,
      expectedPowerAnalysisDigest: digest("different-power-analysis"),
    })).toThrow(/power-analysis digest differs/u);
    expect(() => validateEvaluationPlan({
      suite,
      preregistration,
      expectedPowerAnalysisDigest: powerAnalysisDigest,
    })).toThrow(/private holdout plan requires its public descriptor/u);
  });

  test("binds superiority descriptor counts, commitments, and lifecycle ordering", () => {
    const { suite, descriptor, preregistration, powerAnalysisDigest } = makeSuperiorityPlan();
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
      expectedPowerAnalysisDigest: powerAnalysisDigest,
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
      expectedPowerAnalysisDigest: powerAnalysisDigest,
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
      expectedPowerAnalysisDigest: powerAnalysisDigest,
    })).toThrow(/created, sealed, and then preregistered/u);
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
