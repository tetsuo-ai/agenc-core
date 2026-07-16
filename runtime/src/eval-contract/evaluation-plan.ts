import {
  canonicalizeJson,
  digestCanonicalJson,
} from "./canonical-json.js";
import { computePlannedExecutionOrderDigest } from "./experiment-bundle.js";
import type {
  HoldoutDescriptorDocument,
  PreregistrationDocument,
  SuiteManifestDocument,
} from "./types.js";
import {
  compareUtcTimestamps,
  validateEvalContractDocument,
} from "./validation.js";
import {
  validatePowerAnalysisDocument,
} from "../eval-power/validation.js";
import type { PowerAnalysisDocument } from "../eval-power/types.js";

export interface EvaluationPlanInput {
  readonly suite: SuiteManifestDocument;
  readonly preregistration: PreregistrationDocument;
  readonly holdoutDescriptor?: HoldoutDescriptorDocument;
  /** The complete independently reviewed, digest-bound power artifact. */
  readonly powerAnalysis?: PowerAnalysisDocument;
}

export interface ValidatedEvaluationPlan {
  readonly suite: SuiteManifestDocument;
  readonly preregistration: PreregistrationDocument;
  readonly holdoutDescriptor?: HoldoutDescriptorDocument;
  readonly powerAnalysis?: PowerAnalysisDocument;
  readonly taskCount: number;
  readonly repositoryCount: number;
  readonly maximumTasksPerRepository: number;
}

export class EvaluationPlanValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`evaluation plan validation failed:\n- ${issues.join("\n- ")}`);
    this.name = "EvaluationPlanValidationError";
    this.issues = issues;
  }
}

function requirePlan(condition: unknown, issue: string, issues: string[]): void {
  if (!condition) issues.push(issue);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function canonicalSnapshot<T>(value: T, label: string): T {
  try {
    return deepFreeze(JSON.parse(canonicalizeJson(value)) as T);
  } catch (error) {
    throw new EvaluationPlanValidationError([
      `${label} is not canonical JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
}

function isDocumentObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPlanInput(value: EvaluationPlanInput): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EvaluationPlanValidationError(["evaluation plan input must be an object"]);
  }
  const allowed = new Set([
    "suite",
    "preregistration",
    "holdoutDescriptor",
    "powerAnalysis",
  ]);
  const issues = Object.keys(value).filter((key) => !allowed.has(key)).map(
    (key) => `evaluation plan input contains unknown property ${key}`,
  );
  requirePlan(
    isDocumentObject(value.suite),
    "evaluation plan suite must be a document object",
    issues,
  );
  requirePlan(
    isDocumentObject(value.preregistration),
    "evaluation plan preregistration must be a document object",
    issues,
  );
  requirePlan(
    value.holdoutDescriptor === undefined || isDocumentObject(value.holdoutDescriptor),
    "evaluation plan holdout descriptor must be a document object when supplied",
    issues,
  );
  requirePlan(
    value.powerAnalysis === undefined || isDocumentObject(value.powerAnalysis),
    "evaluation plan power analysis must be a document object when supplied",
    issues,
  );
  if (issues.length > 0) throw new EvaluationPlanValidationError(issues);
}

function validateDocumentKinds(
  suite: SuiteManifestDocument,
  preregistration: PreregistrationDocument,
  holdoutDescriptor: HoldoutDescriptorDocument | undefined,
): void {
  const issues: string[] = [];
  const validate = (value: unknown, expectedKind: string, label: string): void => {
    try {
      const document = validateEvalContractDocument(value);
      requirePlan(document.kind === expectedKind, `${label} has the wrong document kind`, issues);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  };
  validate(suite, "agenc.eval.suite-manifest", "suite");
  validate(preregistration, "agenc.eval.preregistration", "preregistration");
  if (holdoutDescriptor !== undefined) {
    validate(holdoutDescriptor, "agenc.eval.holdout-descriptor", "holdout descriptor");
  }
  if (issues.length > 0) throw new EvaluationPlanValidationError(issues);
}

function countRepositories(suite: SuiteManifestDocument): {
  readonly counts: ReadonlyMap<string, number>;
  readonly maximum: number;
} {
  const counts = new Map<string, number>();
  for (const task of suite.tasks) {
    counts.set(task.repository.cluster, (counts.get(task.repository.cluster) ?? 0) + 1);
  }
  return { counts, maximum: Math.max(...counts.values()) };
}

function assertNoUnusedFamilies(
  suite: SuiteManifestDocument,
  usedClusters: ReadonlyMap<string, number>,
  issues: string[],
): void {
  for (const family of suite.repositoryFamilies) {
    requirePlan(
      usedClusters.has(family.cluster),
      `${family.cluster}: repository family is declared but unused`,
      issues,
    );
  }
}

function assertUniqueSensitiveIdentities(
  suite: SuiteManifestDocument,
  issues: string[],
): void {
  const identityGroups: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["hidden-verifier bundle digests", suite.tasks.map((task) => task.hiddenVerifier.bundle.digest)],
    [
      "hidden-verifier commitment digests",
      suite.tasks.map((task) => task.hiddenVerifier.publicCommitment.digest),
    ],
    ["reference-solution patch digests", suite.tasks.map((task) => task.referenceSolution.patch.digest)],
    [
      "reference-solution validation-evidence digests",
      suite.tasks.map((task) => task.referenceSolution.validationEvidence.digest),
    ],
    [
      "contamination-audit digests",
      suite.tasks.map((task) => task.provenance.contaminationAuditDigest),
    ],
  ];
  for (const [label, identities] of identityGroups) {
    requirePlan(new Set(identities).size === identities.length, `${label} must be unique per task`, issues);
  }
}

function assertPilotPlan(
  suite: SuiteManifestDocument,
  preregistration: PreregistrationDocument,
  issues: string[],
): void {
  if (preregistration.claim !== "pilot") return;
  requirePlan(suite.split === "development", "pilot requires a development suite", issues);
  requirePlan(suite.tasks.length === 30, "pilot requires exactly 30 tasks", issues);
  for (const task of suite.tasks) {
    requirePlan(
      task.provenance.sourceType === "public_issue" &&
        task.provenance.repositoryWasPublic &&
        task.provenance.issueWasPublic,
      `${task.taskId}: pilot tasks must be public real-repository issues`,
      issues,
    );
    requirePlan(
      task.provenance.sourceType !== "synthetic_diagnostic",
      `${task.taskId}: pilot tasks must not be synthetic diagnostics`,
      issues,
    );
  }
}

function assertHoldoutPlan(
  suite: SuiteManifestDocument,
  preregistration: PreregistrationDocument,
  descriptor: HoldoutDescriptorDocument | undefined,
  powerAnalysis: PowerAnalysisDocument | undefined,
  repositoryCount: number,
  maximumTasksPerRepository: number,
  issues: string[],
): void {
  if (suite.split === "development") {
    requirePlan(descriptor === undefined, "development plan must not include a holdout descriptor", issues);
  } else {
    requirePlan(descriptor !== undefined, "private holdout plan requires its public descriptor", issues);
  }
  if (descriptor !== undefined) {
    requirePlan(
      descriptor.documentDigest === preregistration.suite.holdoutDescriptorDigest,
      "holdout descriptor digest does not match the preregistration",
      issues,
    );
    requirePlan(
      descriptor.suiteId === suite.suiteId &&
        descriptor.suiteVersion === suite.suiteVersion &&
        descriptor.status === "sealed",
      "holdout descriptor names a different suite/version or is not sealed",
      issues,
    );
    requirePlan(
      descriptor.taskCount === suite.tasks.length &&
        descriptor.repositoryCount === repositoryCount &&
        descriptor.maximumTasksPerRepository === maximumTasksPerRepository,
      "holdout descriptor counts do not match the selected suite",
      issues,
    );
    requirePlan(
      canonicalizeJson(descriptor.taskManifestCommitment) ===
        canonicalizeJson(preregistration.suite.taskSelectionCommitment),
      "holdout task-manifest commitment differs from the preregistered selection",
      issues,
    );
    requirePlan(
      descriptor.unsealPolicyDigest === preregistration.unblinding.policyDigest,
      "holdout unseal policy differs from the preregistered policy",
      issues,
    );
    requirePlan(
      compareUtcTimestamps(descriptor.createdAt, descriptor.sealedAt) <= 0 &&
        compareUtcTimestamps(descriptor.sealedAt, preregistration.createdAt) <= 0,
      "holdout descriptor must be created, sealed, and then preregistered in that order",
      issues,
    );
  }
  if (preregistration.claim !== "superiority") {
    requirePlan(
      powerAnalysis === undefined,
      "non-superiority plan must not include a power-analysis document",
      issues,
    );
  }
  if (preregistration.claim === "superiority") {
    requirePlan(
      powerAnalysis !== undefined,
      "superiority plan requires the complete independently supplied power-analysis document",
      issues,
    );
    if (powerAnalysis) {
      let validatedPower: PowerAnalysisDocument | undefined;
      try {
        validatedPower = validatePowerAnalysisDocument(powerAnalysis);
      } catch (error) {
        issues.push(error instanceof Error ? error.message : String(error));
      }
      if (validatedPower) {
        requirePlan(
          validatedPower.documentDigest === preregistration.inference.powerAnalysisDigest,
          "superiority power-analysis digest differs from the preregistration",
          issues,
        );
        requirePlan(
          compareUtcTimestamps(validatedPower.createdAt, preregistration.createdAt) <= 0,
          "power analysis must be created before or at preregistration",
          issues,
        );
        requirePlan(
          preregistration.comparisons.every((comparison) =>
            comparison.primarySystemId === validatedPower.primarySystemId)
            && canonicalizeJson(validatedPower.pilot.comparisons.map((comparison) => ({
              comparisonId: comparison.comparisonId,
              comparatorSystemId: comparison.comparatorSystemId,
            }))) === canonicalizeJson(preregistration.comparisons.map((comparison) => ({
              comparisonId: comparison.comparisonId,
              comparatorSystemId: comparison.comparatorSystemId,
            })).sort((left, right) => left.comparisonId < right.comparisonId ? -1 : 1)),
          "power-analysis primary/comparator identities differ from the preregistration",
          issues,
        );
        requirePlan(
          validatedPower.decision.status === "adequately_powered"
            && validatedPower.decision.confirmatoryPlan !== null,
          "superiority power analysis is not adequately powered",
          issues,
        );
        const plan = validatedPower.decision.confirmatoryPlan;
        if (plan) {
          const selectedRepositoryVector = [...suite.tasks.reduce((counts, task) => {
            counts.set(task.repository.cluster, (counts.get(task.repository.cluster) ?? 0) + 1);
            return counts;
          }, new Map<string, number>()).values()].sort((left, right) => left - right);
          requirePlan(
            plan.suiteId === suite.suiteId
              && plan.suiteVersion === suite.suiteVersion
              && plan.experimentId === preregistration.experimentId,
            "power-analysis suite/version/experiment identity differs from the selected plan",
            issues,
          );
          requirePlan(
            plan.taskCount === suite.tasks.length
              && plan.repositoryCount === repositoryCount
              && canonicalizeJson(plan.repositoryTaskCounts) === canonicalizeJson(selectedRepositoryVector),
            "power-analysis fixed repository allocation differs from the selected suite",
            issues,
          );
          requirePlan(
            plan.taskCount === preregistration.samplePlan.stoppingRule.taskCount
              && plan.repetitionsPerSystemTask === preregistration.trialDesign.repetitionsPerSystemTask
              && plan.inferenceResamples === preregistration.inference.resamples
              && plan.inferenceRandomSeed === preregistration.inference.randomSeed,
            "power-analysis fixed task/repetition/inference allocation differs from the preregistration",
            issues,
          );
        }
      }
    }
  }
}

/**
 * Validates all cross-document facts that are knowable before the first run.
 * The returned plan is a deep-frozen canonical snapshot, so callers cannot
 * mutate a successfully reviewed plan before execution.
 */
export function validateEvaluationPlan(input: EvaluationPlanInput): ValidatedEvaluationPlan {
  const snapshot = canonicalSnapshot(input, "evaluation plan input");
  assertPlanInput(snapshot);
  const { suite, preregistration, holdoutDescriptor, powerAnalysis } = snapshot;
  validateDocumentKinds(suite, preregistration, holdoutDescriptor);

  const issues: string[] = [];
  requirePlan(
    suite.documentDigest === preregistration.suite.manifestDigest &&
      suite.suiteId === preregistration.suite.suiteId &&
      suite.suiteVersion === preregistration.suite.suiteVersion &&
      suite.split === preregistration.suite.split,
    "suite identity, version, digest, or split does not match the preregistration",
    issues,
  );

  const taskCount = suite.tasks.length;
  const { counts: repositoryCounts, maximum: maximumTasksPerRepository } =
    countRepositories(suite);
  const repositoryCount = repositoryCounts.size;
  const stoppingRule = preregistration.samplePlan.stoppingRule;
  requirePlan(
    taskCount === preregistration.samplePlan.minimumTasks &&
      taskCount === preregistration.samplePlan.maximumTasks &&
      taskCount === stoppingRule.taskCount,
    "selected task count does not match the fixed preregistered sample",
    issues,
  );
  requirePlan(
    repositoryCount >= preregistration.samplePlan.minimumRepositories,
    "selected suite has fewer repository families than preregistered",
    issues,
  );

  const familyMapDigest = digestCanonicalJson(
    "agenc.eval.repository-family-map.v1",
    suite.repositoryFamilies,
  );
  requirePlan(
    preregistration.suite.repositoryFamilyMapDigest === familyMapDigest,
    "repository family map digest does not match the selected suite",
    issues,
  );
  for (const task of suite.tasks) {
    requirePlan(
      canonicalizeJson(task.resetRecipe) === canonicalizeJson(preregistration.resetPolicy),
      `${task.taskId}: reset recipe differs from the preregistration`,
      issues,
    );
  }

  const expectedExecutionOrderDigest = computePlannedExecutionOrderDigest({
    systemIds: preregistration.systems.map((system) => system.systemId),
    taskIds: suite.tasks.map((task) => task.taskId),
    seedSlots: preregistration.trialDesign.seedSlots,
    orderSeed: preregistration.trialDesign.orderSeed,
  });
  requirePlan(
    preregistration.trialDesign.plannedExecutionOrderDigest === expectedExecutionOrderDigest,
    "planned execution-order digest does not match the selected matrix and seed",
    issues,
  );

  assertNoUnusedFamilies(suite, repositoryCounts, issues);
  assertUniqueSensitiveIdentities(suite, issues);
  assertPilotPlan(suite, preregistration, issues);
  assertHoldoutPlan(
    suite,
    preregistration,
    holdoutDescriptor,
    powerAnalysis,
    repositoryCount,
    maximumTasksPerRepository,
    issues,
  );

  if (issues.length > 0) throw new EvaluationPlanValidationError(issues);
  return deepFreeze({
    suite,
    preregistration,
    ...(holdoutDescriptor ? { holdoutDescriptor } : {}),
    ...(powerAnalysis ? { powerAnalysis } : {}),
    taskCount,
    repositoryCount,
    maximumTasksPerRepository,
  });
}
