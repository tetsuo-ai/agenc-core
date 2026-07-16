import {
  canonicalizeJson,
  computeDocumentDigest,
} from "../eval-contract/canonical-json.js";
import {
  EVAL_POWER_ALPHA,
  EVAL_POWER_ANALYSIS_VERSION,
  EVAL_POWER_MAXIMUM_AGGREGATE_BOOTSTRAP_TASK_ADDITIONS,
  EVAL_POWER_MAXIMUM_CANDIDATE_DESIGNS,
  EVAL_POWER_MAXIMUM_COMPARISONS,
  EVAL_POWER_MAXIMUM_PILOT_ROWS,
  EVAL_POWER_MAXIMUM_REPOSITORIES_PER_DESIGN,
  EVAL_POWER_MAXIMUM_SENSITIVITY_GRID_CELLS,
  EVAL_POWER_MAXIMUM_SENSITIVITY_VALUES,
  EVAL_POWER_MAXIMUM_SYNTHETIC_ATTEMPT_COMPARISONS,
  EVAL_POWER_MAXIMUM_VALIDATION_ISSUES,
  EVAL_POWER_MINIMUM_CONFIRMATORY_REPOSITORIES,
  EVAL_POWER_MINIMUM_CONFIRMATORY_TASKS,
  EVAL_POWER_MINIMUM_EFFECT,
  EVAL_POWER_MINIMUM_PILOT_REPOSITORIES,
  EVAL_POWER_MINIMUM_PILOT_TASKS,
  EVAL_POWER_MINIMUM_REPETITIONS,
  EVAL_POWER_RECOMMENDED_PILOT_REPETITIONS,
  EVAL_POWER_TARGET,
  computeMaximumBootstrapTaskAdditionsPerResample,
  type FixedConfirmatoryPlan,
  type PowerAnalysisDocument,
} from "./types.js";
import { assertBoundedIJsonGraph } from "./ijson-preflight.js";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const UINT32_MAX = 0xffff_ffff;
const NORMAL_975 = 1.959963984540054;

function round(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 1e12) / 1e12;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function expectedPowerEstimate(successes: number, replications: number): {
  readonly estimate: number;
  readonly monteCarloStandardError: number;
  readonly wilsonLower95: number;
  readonly wilsonUpper95: number;
} {
  const estimate = successes / replications;
  const z2 = NORMAL_975 ** 2;
  const denominator = 1 + z2 / replications;
  const center = (estimate + z2 / (2 * replications)) / denominator;
  const halfWidth = NORMAL_975 * Math.sqrt(
    (estimate * (1 - estimate) + z2 / (4 * replications)) / replications,
  ) / denominator;
  return {
    estimate: round(estimate),
    monteCarloStandardError: round(Math.sqrt(estimate * (1 - estimate) / replications)),
    wilsonLower95: Math.floor(Math.max(0, center - halfWidth) * 1e12) / 1e12,
    wilsonUpper95: Math.ceil(Math.min(1, center + halfWidth) * 1e12) / 1e12,
  };
}

export class PowerAnalysisDocumentValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid evaluation power analysis document:\n- ${issues.join("\n- ")}`);
    this.name = "PowerAnalysisDocumentValidationError";
    this.issues = issues;
  }
}

class BoundedIssues extends Array<string> {
  override push(...items: string[]): number {
    const remaining = EVAL_POWER_MAXIMUM_VALIDATION_ISSUES - this.length;
    return remaining > 0 ? super.push(...items.slice(0, remaining)) : this.length;
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalOwnEnumerableDataProperty(
  value: object,
  key: string,
  label: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!("value" in descriptor) || !descriptor.enumerable) {
    throw new PowerAnalysisDocumentValidationError([
      `${label} must be an own enumerable data property`,
    ]);
  }
  return descriptor.value;
}

function assertArrayBound(
  value: unknown,
  maximum: number,
  label: string,
): asserts value is readonly unknown[] {
  if (Array.isArray(value) && value.length > maximum) {
    throw new PowerAnalysisDocumentValidationError([
      `${label} cannot exceed ${maximum} entries`,
    ]);
  }
}

function assertDocumentCollectionBounds(value: Record<string, unknown>): void {
  const pilot = optionalOwnEnumerableDataProperty(value, "pilot", "document.pilot");
  if (record(pilot)) {
    assertArrayBound(
      optionalOwnEnumerableDataProperty(
        pilot,
        "repositoryTaskCounts",
        "pilot.repositoryTaskCounts",
      ),
      EVAL_POWER_MAXIMUM_PILOT_ROWS,
      "pilot.repositoryTaskCounts",
    );
    assertArrayBound(
      optionalOwnEnumerableDataProperty(pilot, "comparisons", "pilot.comparisons"),
      EVAL_POWER_MAXIMUM_COMPARISONS,
      "pilot.comparisons",
    );
  }
  const design = optionalOwnEnumerableDataProperty(value, "design", "document.design");
  if (record(design)) {
    assertArrayBound(
      optionalOwnEnumerableDataProperty(
        design,
        "assumedEffectSizes",
        "design.assumedEffectSizes",
      ),
      EVAL_POWER_MAXIMUM_SENSITIVITY_VALUES,
      "design.assumedEffectSizes",
    );
    assertArrayBound(
      optionalOwnEnumerableDataProperty(
        design,
        "heterogeneityMultipliers",
        "design.heterogeneityMultipliers",
      ),
      EVAL_POWER_MAXIMUM_SENSITIVITY_VALUES,
      "design.heterogeneityMultipliers",
    );
    const candidateAllocations = optionalOwnEnumerableDataProperty(
      design,
      "candidateRepositoryTaskAllocations",
      "design.candidateRepositoryTaskAllocations",
    );
    assertArrayBound(
      candidateAllocations,
      EVAL_POWER_MAXIMUM_CANDIDATE_DESIGNS,
      "design.candidateRepositoryTaskAllocations",
    );
    if (Array.isArray(candidateAllocations)) {
      for (let index = 0; index < candidateAllocations.length; index += 1) {
        const allocation = optionalOwnEnumerableDataProperty(
          candidateAllocations,
          String(index),
          `design.candidateRepositoryTaskAllocations[${index}]`,
        );
        assertArrayBound(
          allocation,
          EVAL_POWER_MAXIMUM_REPOSITORIES_PER_DESIGN,
          `design.candidateRepositoryTaskAllocations[${index}]`,
        );
      }
    }
  }
  const sensitivityGrid = optionalOwnEnumerableDataProperty(
    value,
    "sensitivityGrid",
    "document.sensitivityGrid",
  );
  assertArrayBound(
    sensitivityGrid,
    EVAL_POWER_MAXIMUM_SENSITIVITY_GRID_CELLS,
    "sensitivityGrid",
  );
  if (Array.isArray(sensitivityGrid)) {
    for (let index = 0; index < sensitivityGrid.length; index += 1) {
      const cell = optionalOwnEnumerableDataProperty(
        sensitivityGrid,
        String(index),
        `sensitivityGrid[${index}]`,
      );
      if (record(cell)) {
        assertArrayBound(
          optionalOwnEnumerableDataProperty(
            cell,
            "comparisonPower",
            `sensitivityGrid[${index}].comparisonPower`,
          ),
          EVAL_POWER_MAXIMUM_COMPARISONS,
          `sensitivityGrid[${index}].comparisonPower`,
        );
      }
    }
  }
  const decision = optionalOwnEnumerableDataProperty(value, "decision", "document.decision");
  const confirmatoryPlan = record(decision)
    ? optionalOwnEnumerableDataProperty(
      decision,
      "confirmatoryPlan",
      "decision.confirmatoryPlan",
    )
    : undefined;
  if (record(confirmatoryPlan)) {
    assertArrayBound(
      optionalOwnEnumerableDataProperty(
        confirmatoryPlan,
        "repositoryTaskCounts",
        "decision.confirmatoryPlan.repositoryTaskCounts",
      ),
      EVAL_POWER_MAXIMUM_REPOSITORIES_PER_DESIGN,
      "decision.confirmatoryPlan.repositoryTaskCounts",
    );
  }
}

function exactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
  issues: string[],
): value is Record<string, unknown> {
  if (!record(value)) {
    issues.push(`${label} must be an object`);
    return false;
  }
  const actual = Object.keys(value);
  for (const key of actual) if (!expected.includes(key)) issues.push(`${label} contains unknown property ${key}`);
  for (const key of expected) if (!Object.hasOwn(value, key)) issues.push(`${label} is missing property ${key}`);
  return true;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) && new Date(epoch).toISOString() === value;
}

function validatePowerEstimate(value: unknown, label: string, issues: string[]): void {
  if (!exactKeys(value, [
    "successes", "replications", "estimate", "monteCarloStandardError", "wilsonLower95", "wilsonUpper95",
  ], label, issues)) return;
  if (!positiveInteger(value.replications)
    || !Number.isSafeInteger(value.successes)
    || (value.successes as number) < 0
    || (value.successes as number) > (value.replications as number)) {
    issues.push(`${label} has invalid success/replication counts`);
  }
  for (const key of ["estimate", "monteCarloStandardError", "wilsonLower95", "wilsonUpper95"] as const) {
    if (!finite(value[key]) || (value[key] as number) < 0 || (value[key] as number) > 1) {
      issues.push(`${label}.${key} must be a probability`);
    }
  }
  if (positiveInteger(value.replications) && Number.isSafeInteger(value.successes)
    && (value.successes as number) >= 0 && (value.successes as number) <= (value.replications as number)) {
    const expected = expectedPowerEstimate(value.successes as number, value.replications as number);
    if (Object.entries(expected).some(([key, expectedValue]) => value[key] !== expectedValue)) {
      issues.push(`${label} does not match its exact success/replication counts`);
    }
  }
}

function validateFixedPlan(value: unknown, issues: string[]): value is FixedConfirmatoryPlan {
  if (!exactKeys(value, [
    "suiteId", "suiteVersion", "experimentId", "taskCount", "repositoryCount",
    "repositoryTaskCounts", "repetitionsPerSystemTask", "inferenceResamples",
    "inferenceRandomSeed", "stoppingRule",
  ], "decision.confirmatoryPlan", issues)) return false;
  if (![value.suiteId, value.suiteVersion, value.experimentId].every(validIdentifier)) {
    issues.push("confirmatory plan suite and experiment identities must be portable identifiers");
  }
  if (!positiveInteger(value.taskCount) || value.taskCount < EVAL_POWER_MINIMUM_CONFIRMATORY_TASKS
    || !positiveInteger(value.repositoryCount) || value.repositoryCount < EVAL_POWER_MINIMUM_CONFIRMATORY_REPOSITORIES
    || !positiveInteger(value.repetitionsPerSystemTask) || value.repetitionsPerSystemTask < EVAL_POWER_MINIMUM_REPETITIONS
    || value.repetitionsPerSystemTask > 1_000
    || !positiveInteger(value.inferenceResamples) || value.inferenceResamples < 10_000
    || value.inferenceResamples > 1_000_000
    || !positiveInteger(value.inferenceRandomSeed) || value.inferenceRandomSeed > UINT32_MAX) {
    issues.push("confirmatory plan counts and inference settings are outside contract bounds");
  }
  if (!Array.isArray(value.repositoryTaskCounts)
    || value.repositoryTaskCounts.length !== value.repositoryCount
    || value.repositoryTaskCounts.some((count) => !positiveInteger(count))
    || value.repositoryTaskCounts.some((count, index, all) => index > 0 && count < all[index - 1])
    || value.repositoryTaskCounts.reduce((sum, count) => sum + (count as number), 0) !== value.taskCount
    || value.repositoryTaskCounts.some((count) => (count as number) * 100 > (value.taskCount as number) * 10)) {
    issues.push("confirmatory plan repository-size vector is not canonical or does not match its counts");
  }
  if (exactKeys(value.stoppingRule, ["kind", "taskCount", "interimLooks", "optionalStopping"], "confirmatory stopping rule", issues)) {
    if (value.stoppingRule.kind !== "fixed" || value.stoppingRule.taskCount !== value.taskCount
      || value.stoppingRule.interimLooks !== 0 || value.stoppingRule.optionalStopping !== false) {
      issues.push("confirmatory stopping rule must be the matching fixed no-interim rule");
    }
  }
  return true;
}

/** Strictly validates the digest, closed shape, constants, grid, and selected plan. */
export function validatePowerAnalysisDocument(value: unknown): PowerAnalysisDocument {
  const issues: string[] = new BoundedIssues();
  if (!exactKeys(value, [
    "kind", "analysisVersion", "documentDigest", "analysisId", "pilotId", "createdAt",
    "primarySystemId", "pilot", "design", "simulation", "sensitivityGrid", "decision",
  ], "document", issues) || issues.length > 0) {
    throw new PowerAnalysisDocumentValidationError(issues);
  }
  assertDocumentCollectionBounds(value);
  try {
    assertBoundedIJsonGraph(value, "$document");
    canonicalizeJson(value);
  } catch (error) {
    throw new PowerAnalysisDocumentValidationError([
      `document must be plain I-JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  if (value.kind !== "agenc.eval.power-analysis" || value.analysisVersion !== EVAL_POWER_ANALYSIS_VERSION) {
    issues.push("document kind or analysis version is unsupported");
  }
  if (typeof value.documentDigest !== "string" || !DIGEST.test(value.documentDigest)) {
    issues.push("documentDigest must be a lowercase SHA-256 digest");
  } else if (computeDocumentDigest(value) !== value.documentDigest) {
    issues.push("documentDigest does not match the canonical power-analysis document");
  }
  for (const key of ["analysisId", "pilotId", "primarySystemId"] as const) {
    if (!validIdentifier(value[key])) issues.push(`${key} must be a portable identifier`);
  }
  if (!validUtcTimestamp(value.createdAt)) issues.push("createdAt must be an exact UTC timestamp");

  if (exactKeys(value.pilot, [
    "inputDigest", "taskCount", "repositoryCount", "comparisonCount",
    "minimumRepetitionsPerTaskComparison", "maximumRepetitionsPerTaskComparison",
    "contractMinimumRepetitionsPerTaskComparison", "recommendedRepetitionsPerTaskComparison",
    "repetitionRecommendation", "aggregation", "repositoryTaskCounts", "comparisons",
  ], "pilot", issues)) {
    if (typeof value.pilot.inputDigest !== "string" || !DIGEST.test(value.pilot.inputDigest)) issues.push("pilot.inputDigest is invalid");
    for (const key of ["taskCount", "repositoryCount", "comparisonCount", "minimumRepetitionsPerTaskComparison", "maximumRepetitionsPerTaskComparison"] as const) {
      if (!positiveInteger(value.pilot[key])) issues.push(`pilot.${key} must be a positive integer`);
    }
    if ((value.pilot.taskCount as number) < EVAL_POWER_MINIMUM_PILOT_TASKS
      || (value.pilot.repositoryCount as number) < EVAL_POWER_MINIMUM_PILOT_REPOSITORIES
      || (value.pilot.comparisonCount as number) < 2
      || (value.pilot.minimumRepetitionsPerTaskComparison as number) < EVAL_POWER_MINIMUM_REPETITIONS
      || (value.pilot.maximumRepetitionsPerTaskComparison as number)
        < (value.pilot.minimumRepetitionsPerTaskComparison as number)
      || value.pilot.contractMinimumRepetitionsPerTaskComparison !== EVAL_POWER_MINIMUM_REPETITIONS
      || value.pilot.recommendedRepetitionsPerTaskComparison !== EVAL_POWER_RECOMMENDED_PILOT_REPETITIONS
      || value.pilot.aggregation !== "mean_within_task_then_equal_task_weight"
      || value.pilot.repetitionRecommendation !== (
        (value.pilot.minimumRepetitionsPerTaskComparison as number) >= EVAL_POWER_RECOMMENDED_PILOT_REPETITIONS
          ? "met"
          : "accepted_contract_minimum_below_recommended"
      )) {
      issues.push("pilot fixed constants, coverage, aggregation, or repetition recommendation are invalid");
    }
    if (!Array.isArray(value.pilot.repositoryTaskCounts) || !Array.isArray(value.pilot.comparisons)) {
      issues.push("pilot repository counts and comparisons must be arrays");
    } else {
      let previousRepositoryId = "";
      const repositoryIds = new Set<string>();
      for (const [index, entry] of value.pilot.repositoryTaskCounts.entries()) {
        if (!exactKeys(entry, ["repositoryId", "taskCount"], `pilot.repositoryTaskCounts[${index}]`, issues)
          || !validIdentifier(entry.repositoryId) || !positiveInteger(entry.taskCount)) {
          issues.push(`pilot.repositoryTaskCounts[${index}] is invalid`);
          continue;
        }
        if (repositoryIds.has(entry.repositoryId) || entry.repositoryId <= previousRepositoryId) {
          issues.push("pilot repository inventory must have unique, strictly sorted IDs");
        }
        repositoryIds.add(entry.repositoryId);
        previousRepositoryId = entry.repositoryId;
      }
      if (Array.isArray(value.pilot.repositoryTaskCounts)) {
        const total = value.pilot.repositoryTaskCounts.filter(record).reduce(
          (sum, entry) => sum + (positiveInteger(entry.taskCount) ? entry.taskCount : 0),
          0,
        );
        if (value.pilot.repositoryTaskCounts.length !== value.pilot.repositoryCount
          || total !== value.pilot.taskCount
          || value.pilot.repositoryTaskCounts.filter(record).some((entry) =>
            positiveInteger(entry.taskCount) && entry.taskCount * 100 > total * 10)) {
          issues.push("pilot repository-size inventory does not match pilot counts");
        }
      }
      const comparisonKeys = [
        "comparisonId", "comparatorSystemId", "primaryTaskMeanSuccessRate",
        "comparatorTaskMeanSuccessRate", "pairedDifferenceTaskWeighted",
        "pairedDifferenceRepositoryWeighted", "repositoryBetweenVariance",
        "withinRepositoryVariance", "empiricalRepositoryVarianceShare",
      ];
      let previousComparisonId = "";
      const comparisonIds = new Set<string>();
      const comparatorSystemIds = new Set<string>();
      for (const [index, entry] of value.pilot.comparisons.entries()) {
        if (!exactKeys(entry, comparisonKeys, `pilot.comparisons[${index}]`, issues)) continue;
        if (!validIdentifier(entry.comparisonId) || !validIdentifier(entry.comparatorSystemId)
          || !finite(entry.primaryTaskMeanSuccessRate) || entry.primaryTaskMeanSuccessRate < 0 || entry.primaryTaskMeanSuccessRate > 1
          || !finite(entry.comparatorTaskMeanSuccessRate) || entry.comparatorTaskMeanSuccessRate < 0 || entry.comparatorTaskMeanSuccessRate > 1
          || !finite(entry.pairedDifferenceTaskWeighted) || entry.pairedDifferenceTaskWeighted < -1 || entry.pairedDifferenceTaskWeighted > 1
          || !finite(entry.pairedDifferenceRepositoryWeighted) || entry.pairedDifferenceRepositoryWeighted < -1 || entry.pairedDifferenceRepositoryWeighted > 1
          || !finite(entry.repositoryBetweenVariance) || entry.repositoryBetweenVariance < 0
          || !finite(entry.withinRepositoryVariance) || entry.withinRepositoryVariance < 0
          || !finite(entry.empiricalRepositoryVarianceShare) || entry.empiricalRepositoryVarianceShare < 0 || entry.empiricalRepositoryVarianceShare > 1) {
          issues.push(`pilot.comparisons[${index}] contains invalid values`);
          continue;
        }
        if (comparisonIds.has(entry.comparisonId) || comparatorSystemIds.has(entry.comparatorSystemId)
          || entry.comparatorSystemId === value.primarySystemId
          || entry.comparisonId <= previousComparisonId) {
          issues.push("pilot comparisons must have unique systems and strictly sorted comparison IDs");
        }
        comparisonIds.add(entry.comparisonId);
        comparatorSystemIds.add(entry.comparatorSystemId);
        previousComparisonId = entry.comparisonId;
      }
      if (value.pilot.comparisons.length !== value.pilot.comparisonCount) {
        issues.push("pilot comparison inventory does not match comparisonCount");
      }
    }
  }

  const designKeys = [
    "alpha", "targetPower", "minimumEffect", "primaryMetric", "inference", "interval",
    "quantileMethod", "inferenceUnit", "clusteringUnit", "multipleComparators", "successRule",
    "planningEffectSize", "assumedEffectSizes", "heterogeneityMultipliers",
    "confirmatorySuiteId", "confirmatorySuiteVersion",
    "confirmatoryExperimentId", "candidateRepositoryTaskAllocations",
    "confirmatoryRepetitionsPerSystemTask", "confirmatoryInferenceResamples",
    "confirmatoryInferenceRandomSeed", "confirmatoryRepositoryCapPercent", "optionalStopping",
  ];
  if (exactKeys(value.design, designKeys, "design", issues)) {
    if (value.design.alpha !== EVAL_POWER_ALPHA || value.design.targetPower !== EVAL_POWER_TARGET
      || value.design.minimumEffect !== EVAL_POWER_MINIMUM_EFFECT
      || value.design.inference !== "repository_clustered_paired_percentile_bootstrap"
      || value.design.interval !== "two_sided_percentile" || value.design.quantileMethod !== "linear_type_7"
      || value.design.primaryMetric !== "paired_binary_success_rate_difference"
      || value.design.inferenceUnit !== "task_mean_after_repetition_aggregation"
      || value.design.clusteringUnit !== "repository"
      || value.design.multipleComparators !== "intersection_union"
      || value.design.successRule !== "point_at_least_minimum_effect_and_two_sided_lower_bound_above_zero_for_every_comparator"
      || value.design.optionalStopping !== false || value.design.confirmatoryRepositoryCapPercent !== 10) {
      issues.push("design changes a fixed contract-v1 inference constant");
    }
    if (!validIdentifier(value.design.confirmatorySuiteId)
      || !validIdentifier(value.design.confirmatorySuiteVersion)
      || !validIdentifier(value.design.confirmatoryExperimentId)
      || !finite(value.design.planningEffectSize)
      || value.design.planningEffectSize <= EVAL_POWER_MINIMUM_EFFECT
      || value.design.planningEffectSize > 0.5
      || !Number.isSafeInteger(value.design.confirmatoryRepetitionsPerSystemTask)
      || (value.design.confirmatoryRepetitionsPerSystemTask as number) < EVAL_POWER_MINIMUM_REPETITIONS
      || (value.design.confirmatoryRepetitionsPerSystemTask as number) > 1_000
      || !Number.isSafeInteger(value.design.confirmatoryInferenceResamples)
      || (value.design.confirmatoryInferenceResamples as number) < 10_000
      || (value.design.confirmatoryInferenceResamples as number) > 1_000_000
      || !Number.isSafeInteger(value.design.confirmatoryInferenceRandomSeed)
      || (value.design.confirmatoryInferenceRandomSeed as number) < 1
      || (value.design.confirmatoryInferenceRandomSeed as number) > UINT32_MAX) {
      issues.push("design identities, planning effect, repetitions, or inference settings are invalid");
    }
    if (!Array.isArray(value.design.assumedEffectSizes)
      || value.design.assumedEffectSizes.length < 2
      || !value.design.assumedEffectSizes.includes(EVAL_POWER_MINIMUM_EFFECT)
      || !value.design.assumedEffectSizes.includes(value.design.planningEffectSize)
      || value.design.assumedEffectSizes.some((effect, index, all) =>
        !finite(effect) || effect < EVAL_POWER_MINIMUM_EFFECT || effect > 0.5
        || (index > 0 && effect <= all[index - 1]))
      || !Array.isArray(value.design.heterogeneityMultipliers)
      || value.design.heterogeneityMultipliers.length < 2
      || !value.design.heterogeneityMultipliers.includes(1)
      || value.design.heterogeneityMultipliers.some((multiplier, index, all) =>
        !finite(multiplier) || multiplier < 0.5 || multiplier > 2
        || (index > 0 && multiplier <= all[index - 1]))) {
      issues.push("design sensitivity dimensions are incomplete or invalid");
    }
    if (!Array.isArray(value.design.candidateRepositoryTaskAllocations)
      || value.design.candidateRepositoryTaskAllocations.length === 0
      || value.design.candidateRepositoryTaskAllocations.length > EVAL_POWER_MAXIMUM_CANDIDATE_DESIGNS
      || value.design.candidateRepositoryTaskAllocations.some((allocation) =>
        !Array.isArray(allocation) || allocation.some((count) => !positiveInteger(count)))) {
      issues.push("design candidate repository allocations are invalid");
    } else {
      const allocationKeys = new Set<string>();
      let previousTotal = 0;
      for (const [index, allocation] of value.design.candidateRepositoryTaskAllocations.entries()) {
        const counts = allocation as number[];
        const total = counts.reduce((sum, count) => sum + count, 0);
        if (counts.length < 20 || total < 50 || total > 10_000
          || counts.some((count, countIndex) => countIndex > 0 && count < counts[countIndex - 1])
          || counts.some((count) => count * 100 > total * 10)) {
          issues.push(`design candidate allocation ${index} violates repository/task/cap constraints`);
        }
        const key = counts.join(",");
        if (allocationKeys.has(key) || total <= previousTotal) {
          issues.push("design candidate allocations must be unique with strictly increasing task totals");
        }
        allocationKeys.add(key);
        previousTotal = total;
      }
    }
  }

  if (exactKeys(value.simulation, [
    "method", "attemptModel", "sensitivityModel", "outcomeDependence", "repetitionAggregation",
    "repositorySampling", "taskSamplingWithinRepository", "commonRandomNumbersAcrossSensitivityCells",
    "simulationReplications", "randomSeed", "randomStream", "confirmatoryInference",
    "powerDecisionInterval",
  ], "simulation", issues)) {
    if (value.simulation.confirmatoryInference !== "production_repository_clustered_percentile_bootstrap"
      || value.simulation.powerDecisionInterval !== "two_sided_wilson_95"
      || value.simulation.method !== "hierarchical_repository_task_joint_attempt_bootstrap"
      || value.simulation.attemptModel !== "empirical_joint_multinomial_with_minimal_marginal_transport"
      || value.simulation.sensitivityModel !== "bounded_location_shift_of_paired_attempt_means"
      || value.simulation.outcomeDependence !== "shared_primary_and_joint_comparator_attempt_resampling"
      || value.simulation.repetitionAggregation !== "mean_within_task_before_repository_inference"
      || value.simulation.repositorySampling !== "uniform_with_replacement"
      || value.simulation.taskSamplingWithinRepository !== "uniform_with_replacement"
      || value.simulation.commonRandomNumbersAcrossSensitivityCells !== true
      || value.simulation.randomStream !== "sha256_domain_seeded_xorshift32_rejection_sampling_v1"
      || !Number.isSafeInteger(value.simulation.simulationReplications)
      || (value.simulation.simulationReplications as number) < 100
      || (value.simulation.simulationReplications as number) > 10_000
      || !Number.isSafeInteger(value.simulation.randomSeed)
      || (value.simulation.randomSeed as number) < 0
      || (value.simulation.randomSeed as number) > UINT32_MAX) {
      issues.push("simulation inference or replication settings are invalid");
    }
  }

  if (!Array.isArray(value.sensitivityGrid) || value.sensitivityGrid.length === 0) {
    issues.push("sensitivityGrid must be non-empty");
  } else {
    for (const [index, cell] of value.sensitivityGrid.entries()) {
      if (!exactKeys(cell, [
        "assumedPairedDifference", "heterogeneityMultiplier", "taskCount", "repositoryCount",
        "comparisonPower", "intersectionPower",
      ], `sensitivityGrid[${index}]`, issues)) continue;
      if (![cell.assumedPairedDifference, cell.heterogeneityMultiplier].every(finite)
        || !positiveInteger(cell.taskCount) || !positiveInteger(cell.repositoryCount)
        || !Array.isArray(cell.comparisonPower)) {
        issues.push(`sensitivityGrid[${index}] has invalid dimensions`);
        continue;
      }
      for (const [comparisonIndex, comparison] of cell.comparisonPower.entries()) {
        if (!exactKeys(comparison, ["comparisonId", "power"], `sensitivityGrid[${index}].comparisonPower[${comparisonIndex}]`, issues)
          || typeof comparison.comparisonId !== "string") continue;
        validatePowerEstimate(comparison.power, `sensitivityGrid[${index}].comparisonPower[${comparisonIndex}].power`, issues);
      }
      validatePowerEstimate(cell.intersectionPower, `sensitivityGrid[${index}].intersectionPower`, issues);
    }
  }

  if (exactKeys(value.decision, ["status", "rule", "confirmatoryPlan"], "decision", issues)) {
    if (value.decision.rule !== "smallest_fixed_n_whose_intersection_power_wilson_lower_95_meets_target_at_planning_effect_across_heterogeneity_grid") {
      issues.push("decision rule is invalid");
    }
    if (value.decision.status !== "adequately_powered" && value.decision.status !== "no_candidate_meets_target") {
      issues.push("decision status is invalid");
    }
    const planValid = value.decision.confirmatoryPlan === null
      ? false
      : validateFixedPlan(value.decision.confirmatoryPlan, issues);
    if ((value.decision.status === "adequately_powered") !== planValid) {
      issues.push("adequately_powered status must have exactly one valid fixed confirmatory plan");
    }
    if (planValid && record(value.design)) {
      const design = value.design;
      const plan = value.decision.confirmatoryPlan as unknown as FixedConfirmatoryPlan;
      const allocations = design.candidateRepositoryTaskAllocations;
      if (!Array.isArray(allocations)
        || !allocations.some((allocation) => canonicalizeJson(allocation) === canonicalizeJson(plan.repositoryTaskCounts))
        || plan.suiteId !== design.confirmatorySuiteId
        || plan.suiteVersion !== design.confirmatorySuiteVersion
        || plan.experimentId !== design.confirmatoryExperimentId
        || plan.repetitionsPerSystemTask !== design.confirmatoryRepetitionsPerSystemTask
        || plan.inferenceResamples !== design.confirmatoryInferenceResamples
        || plan.inferenceRandomSeed !== design.confirmatoryInferenceRandomSeed) {
        issues.push("selected confirmatory plan is not one of the exact reviewed designs");
      }
      const selectedCells = Array.isArray(value.sensitivityGrid)
        ? value.sensitivityGrid.filter((cell) => record(cell)
          && cell.taskCount === plan.taskCount
          && cell.assumedPairedDifference === design.planningEffectSize)
        : [];
      if (!Array.isArray(design.heterogeneityMultipliers)
        || selectedCells.length !== design.heterogeneityMultipliers.length
        || selectedCells.some((cell) => !record(cell.intersectionPower)
          || !finite(cell.intersectionPower.wilsonLower95)
          || cell.intersectionPower.wilsonLower95 < Number(EVAL_POWER_TARGET))) {
        issues.push("selected confirmatory plan does not meet target power across its heterogeneity grid");
      }
    }
    if (record(value.design)
      && Array.isArray(value.design.candidateRepositoryTaskAllocations)
      && Array.isArray(value.design.heterogeneityMultipliers)
      && Array.isArray(value.sensitivityGrid)) {
      const design = value.design;
      const allocations = design.candidateRepositoryTaskAllocations as unknown[];
      const heterogeneityMultipliers = design.heterogeneityMultipliers as unknown[];
      const sensitivityGrid = value.sensitivityGrid as unknown[];
      const qualifyingTaskCounts = allocations
        .filter((allocation): allocation is unknown[] => Array.isArray(allocation))
        .map((allocation: unknown[]) => allocation.reduce<number>(
          (sum, count) => sum + (typeof count === "number" ? count : 0),
          0,
        ))
        .filter((taskCount) => {
          const cells = sensitivityGrid.filter(record).filter((cell) =>
            cell.taskCount === taskCount
            && cell.assumedPairedDifference === design.planningEffectSize);
          return cells.length === heterogeneityMultipliers.length
            && cells.every((cell) => record(cell.intersectionPower)
              && finite(cell.intersectionPower.wilsonLower95)
              && cell.intersectionPower.wilsonLower95 >= Number(EVAL_POWER_TARGET));
        });
      const selectedTaskCount = record(value.decision.confirmatoryPlan)
        ? value.decision.confirmatoryPlan.taskCount
        : null;
      const expectedTaskCount = qualifyingTaskCounts.length > 0
        ? Math.min(...qualifyingTaskCounts)
        : null;
      if (selectedTaskCount !== expectedTaskCount) {
        issues.push("decision does not select the smallest adequately powered fixed design");
      }
    }
  }

  if (record(value.design) && Array.isArray(value.design.candidateRepositoryTaskAllocations)
    && Array.isArray(value.design.assumedEffectSizes)
    && Array.isArray(value.design.heterogeneityMultipliers)
    && Array.isArray(value.sensitivityGrid)) {
    const design = value.design;
    const allocations = design.candidateRepositoryTaskAllocations as unknown[];
    const assumedEffectSizes = design.assumedEffectSizes as unknown[];
    const heterogeneityMultipliers = design.heterogeneityMultipliers as unknown[];
    const sensitivityGrid = value.sensitivityGrid as unknown[];
    const expectedCells = allocations.length
      * assumedEffectSizes.length
      * heterogeneityMultipliers.length;
    if (expectedCells > EVAL_POWER_MAXIMUM_SENSITIVITY_GRID_CELLS) {
      issues.push("power-analysis sensitivity grid exceeds the synchronous work ceiling");
    }
    const cellKeys = sensitivityGrid.filter(record).map((cell) => {
      const matchingAllocation = allocations.find((allocation) =>
        Array.isArray(allocation)
        && allocation.reduce((sum, count) => sum + (typeof count === "number" ? count : 0), 0) === cell.taskCount
        && allocation.length === cell.repositoryCount);
      if (!matchingAllocation
        || !assumedEffectSizes.includes(cell.assumedPairedDifference)
        || !heterogeneityMultipliers.includes(cell.heterogeneityMultiplier)) {
        issues.push("sensitivity cell does not map to an exact reviewed allocation/effect/heterogeneity dimension");
      }
      return `${String(cell.taskCount)}\u0000${String(cell.repositoryCount)}\u0000${String(cell.assumedPairedDifference)}\u0000${String(cell.heterogeneityMultiplier)}`;
    });
    if (sensitivityGrid.length !== expectedCells || new Set(cellKeys).size !== expectedCells) {
      issues.push("sensitivityGrid is not the exact candidate/effect/heterogeneity Cartesian product");
    }

    if (record(value.pilot) && Array.isArray(value.pilot.comparisons) && record(value.simulation)) {
      const simulationReplications = value.simulation.simulationReplications;
      const expectedComparisonIds = value.pilot.comparisons.filter(record)
        .map((comparison) => comparison.comparisonId)
        .filter((comparisonId): comparisonId is string => typeof comparisonId === "string")
        .sort();
      if (Number.isSafeInteger(simulationReplications)
        && Number.isSafeInteger(design.confirmatoryInferenceResamples)
        && Number.isSafeInteger(design.confirmatoryRepetitionsPerSystemTask)) {
        const maximumTaskAdditionsPerResample =
          computeMaximumBootstrapTaskAdditionsPerResample(allocations);
        const totalTasks = allocations.reduce<number>((sum, allocation) => sum + (Array.isArray(allocation)
          ? allocation.reduce<number>((taskSum, count) => taskSum + (typeof count === "number" ? count : 0), 0)
          : 0), 0);
        const scenarioCount = assumedEffectSizes.length * heterogeneityMultipliers.length;
        const comparisonCount = expectedComparisonIds.length;
        const bootstrapWork = BigInt(simulationReplications as number)
          * BigInt(design.confirmatoryInferenceResamples as number)
          * BigInt(maximumTaskAdditionsPerResample)
          * BigInt(scenarioCount)
          * BigInt(comparisonCount);
        const syntheticWork = BigInt(simulationReplications as number)
          * BigInt(design.confirmatoryRepetitionsPerSystemTask as number)
          * BigInt(totalTasks)
          * BigInt(scenarioCount)
          * BigInt(comparisonCount);
        if (bootstrapWork > BigInt(EVAL_POWER_MAXIMUM_AGGREGATE_BOOTSTRAP_TASK_ADDITIONS)) {
          issues.push("power-analysis aggregate bootstrap work exceeds the synchronous ceiling");
        }
        if (syntheticWork > BigInt(EVAL_POWER_MAXIMUM_SYNTHETIC_ATTEMPT_COMPARISONS)) {
          issues.push("power-analysis aggregate synthetic attempt work exceeds the synchronous ceiling");
        }
      }
      for (const cell of sensitivityGrid.filter(record)) {
        const comparisonPower = Array.isArray(cell.comparisonPower)
          ? cell.comparisonPower.filter(record)
          : [];
        const actualIds = comparisonPower.map((comparison) => comparison.comparisonId)
          .filter((comparisonId): comparisonId is string => typeof comparisonId === "string")
          .sort();
        if (canonicalizeJson(actualIds) !== canonicalizeJson(expectedComparisonIds)) {
          issues.push("sensitivity cell comparison set differs from the pilot comparison set");
        }
        const estimates = comparisonPower.map((comparison) => record(comparison.power)
          && finite(comparison.power.estimate) ? comparison.power.estimate : -1);
        if (!record(cell.intersectionPower)
          || cell.intersectionPower.replications !== simulationReplications
          || comparisonPower.some((comparison) => !record(comparison.power)
            || comparison.power.replications !== simulationReplications)
          || !finite(cell.intersectionPower.estimate)
          || cell.intersectionPower.estimate > Math.min(...estimates)) {
          issues.push("sensitivity cell power counts or intersection probability are inconsistent");
        }
      }
    }
  }

  if (issues.length > 0) throw new PowerAnalysisDocumentValidationError([...new Set(issues)]);
  return JSON.parse(canonicalizeJson(value)) as PowerAnalysisDocument;
}
