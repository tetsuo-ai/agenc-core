import { createHash } from "node:crypto";
import {
  canonicalizeJson,
  digestCanonicalJson,
  withDocumentDigest,
} from "../eval-contract/canonical-json.js";
import {
  computeRepositoryClusteredPercentileInterval,
} from "../eval-contract/experiment-bundle.js";
import {
  EVAL_POWER_ALPHA,
  EVAL_POWER_ANALYSIS_VERSION,
  EVAL_POWER_MINIMUM_CONFIRMATORY_REPOSITORIES,
  EVAL_POWER_MINIMUM_CONFIRMATORY_TASKS,
  EVAL_POWER_MINIMUM_EFFECT,
  EVAL_POWER_MINIMUM_PILOT_REPOSITORIES,
  EVAL_POWER_MINIMUM_PILOT_TASKS,
  EVAL_POWER_MINIMUM_REPETITIONS,
  EVAL_POWER_MAXIMUM_BOOTSTRAP_REPOSITORY_DRAWS,
  EVAL_POWER_MAXIMUM_SYNTHETIC_ATTEMPT_COMPARISONS,
  EVAL_POWER_RECOMMENDED_PILOT_REPETITIONS,
  EVAL_POWER_TARGET,
  type FixedConfirmatoryPlan,
  type InterceptOnlyCr2Inference,
  type PairedPilotBinaryOutcome,
  type PilotComparisonSummary,
  type PowerAnalysisDocument,
  type PowerAnalysisInput,
  type PowerEstimate,
  type SensitivityCell,
} from "./types.js";
import { validatePowerAnalysisDocument } from "./validation.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const MAX_SAFE_SEED = 0xffff_ffff;
const MINIMUM_SIMULATION_REPLICATIONS = 100;
const MAXIMUM_SIMULATION_REPLICATIONS = 10_000;
const MINIMUM_CONFIRMATORY_INFERENCE_RESAMPLES = 10_000;
const MAXIMUM_CONFIRMATORY_INFERENCE_RESAMPLES = 1_000_000;
const MAXIMUM_SENSITIVITY_GRID_CELLS = 32;
const MAXIMUM_CANDIDATE_DESIGNS = 8;
const EPSILON = 1e-12;
const NORMAL_975 = 1.959963984540054;

interface AggregatedTask {
  readonly taskId: string;
  readonly repositoryId: string;
  readonly trialIds: readonly string[];
  readonly primaryMean: number;
  readonly comparatorMean: number;
  readonly difference: number;
}

interface AggregatedComparison {
  readonly comparisonId: string;
  readonly comparatorSystemId: string;
  readonly tasks: ReadonlyMap<string, AggregatedTask>;
}

interface ValidatedPilot {
  readonly comparisons: readonly AggregatedComparison[];
  readonly repositoryIds: readonly string[];
  readonly taskIdsByRepository: ReadonlyMap<string, readonly string[]>;
  readonly minimumRepetitions: number;
  readonly maximumRepetitions: number;
  readonly normalizedOutcomes: readonly PairedPilotBinaryOutcome[];
  readonly jointAttemptsByTask: ReadonlyMap<string, readonly JointPilotAttempt[]>;
}

interface ScenarioModel {
  readonly assumedEffect: number;
  readonly heterogeneityMultiplier: number;
  readonly targetComparatorProbabilitiesByComparison: ReadonlyMap<
    string,
    ReadonlyMap<string, number>
  >;
}

interface JointPilotAttempt {
  readonly primaryOutcome: 0 | 1;
  readonly comparatorOutcomes: ReadonlyMap<string, 0 | 1>;
}

interface SyntheticAttemptDraw {
  readonly jointAttemptIndex: number;
  readonly adjustmentUniforms: readonly number[];
}

interface SyntheticTaskDraw {
  readonly taskId: string;
  readonly attempts: readonly SyntheticAttemptDraw[];
}

export class PowerAnalysisValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid evaluation power analysis input:\n- ${issues.join("\n- ")}`);
    this.name = "PowerAnalysisValidationError";
    this.issues = [...issues];
  }
}

function round(value: number, places = 12): number {
  const factor = 10 ** places;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function roundDownProbability(value: number): number {
  return Math.floor(Math.max(0, Math.min(1, value)) * 1e12) / 1e12;
}

function roundUpProbability(value: number): number {
  return Math.ceil(Math.max(0, Math.min(1, value)) * 1e12) / 1e12;
}

function average(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactKeys(
  value: object,
  expected: readonly string[],
  label: string,
  issues: string[],
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) issues.push(`${label} contains unknown property ${key}`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) issues.push(`${label} is missing property ${key}`);
  }
}

function assertIdentifier(value: unknown, label: string, issues: string[]): value is string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    issues.push(`${label} must be a non-empty portable identifier of at most 256 characters`);
    return false;
  }
  return true;
}

function isExactUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    return false;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function compareOutcome(left: PairedPilotBinaryOutcome, right: PairedPilotBinaryOutcome): number {
  return compareString(left.comparisonId, right.comparisonId)
    || compareString(left.taskId, right.taskId)
    || compareString(left.trialId, right.trialId);
}

function validateInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  issues: string[],
): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    issues.push(`${label} must be a safe integer from ${minimum} through ${maximum}`);
    return false;
  }
  return true;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateAndAggregate(input: PowerAnalysisInput): ValidatedPilot {
  const issues: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PowerAnalysisValidationError(["input must be a plain I-JSON object"]);
  }
  try {
    canonicalizeJson(input);
  } catch (error) {
    throw new PowerAnalysisValidationError([
      `input must be plain I-JSON: ${error instanceof Error ? error.message : String(error)}`,
    ]);
  }
  assertExactKeys(input, [
    "analysisId",
    "pilotId",
    "createdAt",
    "primarySystemId",
    "outcomes",
    "confirmatorySuiteId",
    "confirmatorySuiteVersion",
    "confirmatoryExperimentId",
    "candidateRepositoryTaskAllocations",
    "confirmatoryRepetitionsPerSystemTask",
    "confirmatoryInferenceResamples",
    "confirmatoryInferenceRandomSeed",
    "planningEffectSize",
    "assumedEffectSizes",
    "heterogeneityMultipliers",
    "simulationReplications",
    "randomSeed",
  ], "input", issues);
  assertIdentifier(input.analysisId, "analysisId", issues);
  assertIdentifier(input.pilotId, "pilotId", issues);
  assertIdentifier(input.primarySystemId, "primarySystemId", issues);
  assertIdentifier(input.confirmatorySuiteId, "confirmatorySuiteId", issues);
  assertIdentifier(input.confirmatorySuiteVersion, "confirmatorySuiteVersion", issues);
  assertIdentifier(input.confirmatoryExperimentId, "confirmatoryExperimentId", issues);
  if (!isExactUtcTimestamp(input.createdAt)) {
    issues.push("createdAt must be a real UTC timestamp with millisecond precision");
  }
  validateInteger(
    input.randomSeed,
    "randomSeed",
    0,
    MAX_SAFE_SEED,
    issues,
  );
  validateInteger(
    input.simulationReplications,
    "simulationReplications",
    MINIMUM_SIMULATION_REPLICATIONS,
    MAXIMUM_SIMULATION_REPLICATIONS,
    issues,
  );
  validateInteger(
    input.confirmatoryInferenceResamples,
    "confirmatoryInferenceResamples",
    MINIMUM_CONFIRMATORY_INFERENCE_RESAMPLES,
    MAXIMUM_CONFIRMATORY_INFERENCE_RESAMPLES,
    issues,
  );
  validateInteger(
    input.confirmatoryInferenceRandomSeed,
    "confirmatoryInferenceRandomSeed",
    1,
    MAX_SAFE_SEED,
    issues,
  );
  validateInteger(
    input.confirmatoryRepetitionsPerSystemTask,
    "confirmatoryRepetitionsPerSystemTask",
    EVAL_POWER_MINIMUM_REPETITIONS,
    1_000,
    issues,
  );

  if (
    !Array.isArray(input.candidateRepositoryTaskAllocations)
    || input.candidateRepositoryTaskAllocations.length === 0
    || input.candidateRepositoryTaskAllocations.length > MAXIMUM_CANDIDATE_DESIGNS
  ) {
    issues.push(`candidateRepositoryTaskAllocations must contain 1 through ${MAXIMUM_CANDIDATE_DESIGNS} exact designs`);
  } else {
    const seen = new Set<string>();
    let previousTaskCount = 0;
    for (const [designIndex, allocation] of input.candidateRepositoryTaskAllocations.entries()) {
      if (!Array.isArray(allocation) || allocation.length < EVAL_POWER_MINIMUM_CONFIRMATORY_REPOSITORIES) {
        issues.push(`candidateRepositoryTaskAllocations[${designIndex}] must contain at least ${EVAL_POWER_MINIMUM_CONFIRMATORY_REPOSITORIES} repositories`);
        continue;
      }
      const normalized = [...allocation].sort((left, right) => left - right);
      for (const [repositoryIndex, taskCount] of normalized.entries()) {
        validateInteger(
          taskCount,
          `candidateRepositoryTaskAllocations[${designIndex}][${repositoryIndex}]`,
          1,
          10_000,
          issues,
        );
      }
      const total = normalized.reduce((sum, count) => sum + count, 0);
      if (total < EVAL_POWER_MINIMUM_CONFIRMATORY_TASKS || total > 10_000) {
        issues.push(`candidateRepositoryTaskAllocations[${designIndex}] must total 50 through 10000 tasks`);
      }
      if (normalized.some((count) => count * 100 > total * 10)) {
        issues.push(`candidateRepositoryTaskAllocations[${designIndex}] exceeds the 10% repository cap`);
      }
      const key = normalized.join(",");
      if (seen.has(key)) issues.push(`candidateRepositoryTaskAllocations contains duplicate design ${key}`);
      seen.add(key);
      if (total <= previousTaskCount) {
        issues.push("candidateRepositoryTaskAllocations must be ordered by strictly increasing task count");
      }
      previousTaskCount = total;
    }
  }

  if (!Array.isArray(input.assumedEffectSizes) || input.assumedEffectSizes.length < 2) {
    issues.push("assumedEffectSizes must contain a sensitivity grid of at least two effects");
  } else {
    const seen = new Set<number>();
    for (const [index, effect] of input.assumedEffectSizes.entries()) {
      if (!Number.isFinite(effect) || effect < EVAL_POWER_MINIMUM_EFFECT || effect > 0.5) {
        issues.push(`assumedEffectSizes[${index}] must be from 0.10 through 0.50`);
      }
      if (seen.has(effect)) issues.push(`assumedEffectSizes contains duplicate ${effect}`);
      seen.add(effect);
    }
    if (!input.assumedEffectSizes.some((effect) => Math.abs(effect - EVAL_POWER_MINIMUM_EFFECT) < EPSILON)) {
      issues.push("assumedEffectSizes must include the minimum effect 0.10");
    }
  }
  if (
    !Number.isFinite(input.planningEffectSize)
    || input.planningEffectSize <= EVAL_POWER_MINIMUM_EFFECT
    || input.planningEffectSize > 0.5
  ) {
    issues.push("planningEffectSize must be greater than 0.10 and at most 0.50");
  } else if (
    !Array.isArray(input.assumedEffectSizes)
    || !input.assumedEffectSizes.some((effect) => Math.abs(effect - input.planningEffectSize) < EPSILON)
  ) {
    issues.push("planningEffectSize must be present in assumedEffectSizes");
  }

  if (!Array.isArray(input.heterogeneityMultipliers) || input.heterogeneityMultipliers.length < 2) {
    issues.push("heterogeneityMultipliers must contain a sensitivity grid of at least two values");
  } else {
    const seen = new Set<number>();
    for (const [index, multiplier] of input.heterogeneityMultipliers.entries()) {
      if (!Number.isFinite(multiplier) || multiplier < 0.5 || multiplier > 2) {
        issues.push(`heterogeneityMultipliers[${index}] must be from 0.5 through 2.0`);
      }
      if (seen.has(multiplier)) {
        issues.push(`heterogeneityMultipliers contains duplicate ${multiplier}`);
      }
      seen.add(multiplier);
    }
    if (!input.heterogeneityMultipliers.some((multiplier) => Math.abs(multiplier - 1) < EPSILON)) {
      issues.push("heterogeneityMultipliers must include the unscaled value 1.0");
    }
  }

  const candidateCount = Array.isArray(input.candidateRepositoryTaskAllocations)
    ? input.candidateRepositoryTaskAllocations.length
    : 0;
  const effectCount = Array.isArray(input.assumedEffectSizes) ? input.assumedEffectSizes.length : 0;
  const heterogeneityCount = Array.isArray(input.heterogeneityMultipliers)
    ? input.heterogeneityMultipliers.length
    : 0;
  const gridCells = candidateCount * effectCount * heterogeneityCount;
  if (gridCells > MAXIMUM_SENSITIVITY_GRID_CELLS) {
    issues.push(`sensitivity grid cannot exceed ${MAXIMUM_SENSITIVITY_GRID_CELLS} cells`);
  }

  if (!Array.isArray(input.outcomes) || input.outcomes.length === 0) {
    issues.push("outcomes must be a non-empty array");
  } else if (input.outcomes.length > 100_000) {
    issues.push("outcomes cannot exceed 100000 paired rows");
  }

  const validOutcomes: PairedPilotBinaryOutcome[] = [];
  const comparisonSystems = new Map<string, string>();
  const taskRepositories = new Map<string, string>();
  const cells = new Map<string, Map<string, PairedPilotBinaryOutcome>>();

  for (const [index, outcome] of (Array.isArray(input.outcomes) ? input.outcomes : []).entries()) {
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
      issues.push(`outcomes[${index}] must be an object`);
      continue;
    }
    assertExactKeys(outcome, [
      "comparisonId",
      "comparatorSystemId",
      "taskId",
      "repositoryId",
      "trialId",
      "primaryOutcome",
      "comparatorOutcome",
    ], `outcomes[${index}]`, issues);
    const comparisonValid = assertIdentifier(
      outcome.comparisonId,
      `outcomes[${index}].comparisonId`,
      issues,
    );
    const comparatorValid = assertIdentifier(
      outcome.comparatorSystemId,
      `outcomes[${index}].comparatorSystemId`,
      issues,
    );
    const taskValid = assertIdentifier(outcome.taskId, `outcomes[${index}].taskId`, issues);
    const repositoryValid = assertIdentifier(
      outcome.repositoryId,
      `outcomes[${index}].repositoryId`,
      issues,
    );
    const trialValid = assertIdentifier(outcome.trialId, `outcomes[${index}].trialId`, issues);
    if (outcome.primaryOutcome !== 0 && outcome.primaryOutcome !== 1) {
      issues.push(`outcomes[${index}].primaryOutcome must be binary 0 or 1`);
    }
    if (outcome.comparatorOutcome !== 0 && outcome.comparatorOutcome !== 1) {
      issues.push(`outcomes[${index}].comparatorOutcome must be binary 0 or 1`);
    }
    const primaryValid = outcome.primaryOutcome === 0 || outcome.primaryOutcome === 1;
    const outcomeComparatorValid = outcome.comparatorOutcome === 0 || outcome.comparatorOutcome === 1;
    if (!(comparisonValid
      && comparatorValid
      && taskValid
      && repositoryValid
      && trialValid
      && primaryValid
      && outcomeComparatorValid)) continue;
    validOutcomes.push(outcome);

    const knownComparator = comparisonSystems.get(outcome.comparisonId);
    if (knownComparator && knownComparator !== outcome.comparatorSystemId) {
      issues.push(`comparison ${outcome.comparisonId} maps to multiple comparator systems`);
    } else {
      comparisonSystems.set(outcome.comparisonId, outcome.comparatorSystemId);
    }
    if (outcome.comparatorSystemId === input.primarySystemId) {
      issues.push(`comparison ${outcome.comparisonId} cannot compare the primary system to itself`);
    }

    const knownRepository = taskRepositories.get(outcome.taskId);
    if (knownRepository && knownRepository !== outcome.repositoryId) {
      issues.push(`task ${outcome.taskId} maps to multiple repositories`);
    } else {
      taskRepositories.set(outcome.taskId, outcome.repositoryId);
    }

    const cellKey = `${outcome.comparisonId}\u0000${outcome.taskId}`;
    const trials = cells.get(cellKey) ?? new Map<string, PairedPilotBinaryOutcome>();
    if (trials.has(outcome.trialId)) {
      issues.push(
        `duplicate paired outcome for comparison ${outcome.comparisonId}, task ${outcome.taskId}, trial ${outcome.trialId}`,
      );
    } else {
      trials.set(outcome.trialId, outcome);
      cells.set(cellKey, trials);
    }
  }

  if (comparisonSystems.size < 2) {
    issues.push("pilot outcomes must contain at least two comparators for intersection-union power");
  }
  if (new Set(comparisonSystems.values()).size !== comparisonSystems.size) {
    issues.push("each comparisonId must identify a distinct comparator system");
  }
  if (taskRepositories.size < EVAL_POWER_MINIMUM_PILOT_TASKS) {
    issues.push(`pilot must contain at least ${EVAL_POWER_MINIMUM_PILOT_TASKS} distinct tasks`);
  }

  const repositoryTaskIds = new Map<string, string[]>();
  for (const [taskId, repositoryId] of taskRepositories) {
    const taskIds = repositoryTaskIds.get(repositoryId) ?? [];
    taskIds.push(taskId);
    repositoryTaskIds.set(repositoryId, taskIds);
  }
  if (repositoryTaskIds.size < EVAL_POWER_MINIMUM_PILOT_REPOSITORIES) {
    issues.push(`pilot must contain at least ${EVAL_POWER_MINIMUM_PILOT_REPOSITORIES} repositories`);
  }
  for (const [repositoryId, taskIds] of repositoryTaskIds) {
    if (taskIds.length * 100 > taskRepositories.size * 10) {
      issues.push(`pilot repository ${repositoryId} exceeds the 10% task cap`);
    }
  }

  const comparisonIds = [...comparisonSystems.keys()].sort();
  const allTaskIds = [...taskRepositories.keys()].sort();
  const comparisonTasks: AggregatedComparison[] = [];
  let minimumRepetitions = Number.POSITIVE_INFINITY;
  let maximumRepetitions = 0;
  let referenceTrialIds: Map<string, readonly string[]> | undefined;
  let referencePrimaryOutcomes: Map<string, readonly number[]> | undefined;

  for (const comparisonId of comparisonIds) {
    const tasks = new Map<string, AggregatedTask>();
    const currentTrialIds = new Map<string, readonly string[]>();
    const currentPrimaryOutcomes = new Map<string, readonly number[]>();
    for (const taskId of allTaskIds) {
      const trials = cells.get(`${comparisonId}\u0000${taskId}`);
      if (!trials) {
        issues.push(`comparison ${comparisonId} is missing task ${taskId}`);
        continue;
      }
      const sortedTrials = [...trials.values()].sort((left, right) =>
        compareString(left.trialId, right.trialId));
      if (sortedTrials.length < EVAL_POWER_MINIMUM_REPETITIONS) {
        issues.push(
          `comparison ${comparisonId}, task ${taskId} has ${sortedTrials.length} repetitions; minimum is ${EVAL_POWER_MINIMUM_REPETITIONS}`,
        );
      }
      minimumRepetitions = Math.min(minimumRepetitions, sortedTrials.length);
      maximumRepetitions = Math.max(maximumRepetitions, sortedTrials.length);
      const trialIds = sortedTrials.map((trial) => trial.trialId);
      currentTrialIds.set(taskId, trialIds);
      currentPrimaryOutcomes.set(taskId, sortedTrials.map((trial) => trial.primaryOutcome));
      const primaryMean = average(sortedTrials.map((trial) => trial.primaryOutcome));
      const comparatorMean = average(sortedTrials.map((trial) => trial.comparatorOutcome));
      tasks.set(taskId, {
        taskId,
        repositoryId: taskRepositories.get(taskId) as string,
        trialIds,
        primaryMean,
        comparatorMean,
        difference: primaryMean - comparatorMean,
      });
    }
    if (referenceTrialIds) {
      for (const taskId of allTaskIds) {
        if (!sameStrings(referenceTrialIds.get(taskId) ?? [], currentTrialIds.get(taskId) ?? [])) {
          issues.push(`task ${taskId} does not use the same paired trial IDs across comparisons`);
        }
        const expectedPrimary = referencePrimaryOutcomes?.get(taskId) ?? [];
        const actualPrimary = currentPrimaryOutcomes.get(taskId) ?? [];
        if (
          expectedPrimary.length !== actualPrimary.length
          || expectedPrimary.some((value, index) => value !== actualPrimary[index])
        ) {
          issues.push(`task ${taskId} does not preserve primary outcomes across comparisons`);
        }
      }
    } else {
      referenceTrialIds = currentTrialIds;
      referencePrimaryOutcomes = currentPrimaryOutcomes;
    }
    comparisonTasks.push({
      comparisonId,
      comparatorSystemId: comparisonSystems.get(comparisonId) as string,
      tasks,
    });
  }

  if (
    Number.isSafeInteger(input.simulationReplications)
    && Number.isSafeInteger(input.confirmatoryInferenceResamples)
    && Array.isArray(input.candidateRepositoryTaskAllocations)
  ) {
    const repositoryDrawsPerScenario = input.candidateRepositoryTaskAllocations.reduce(
      (sum, allocation) => sum + (Array.isArray(allocation) ? allocation.length : 0),
      0,
    );
    const aggregateWork = BigInt(input.simulationReplications)
      * BigInt(input.confirmatoryInferenceResamples)
      * BigInt(Math.max(1, comparisonSystems.size))
      * BigInt(Math.max(1, Array.isArray(input.assumedEffectSizes) ? input.assumedEffectSizes.length : 0))
      * BigInt(Math.max(1, Array.isArray(input.heterogeneityMultipliers)
        ? input.heterogeneityMultipliers.length
        : 0))
      * BigInt(repositoryDrawsPerScenario);
    if (aggregateWork > BigInt(EVAL_POWER_MAXIMUM_BOOTSTRAP_REPOSITORY_DRAWS)) {
      issues.push(
        `aggregate bootstrap work cannot exceed ${EVAL_POWER_MAXIMUM_BOOTSTRAP_REPOSITORY_DRAWS} repository draws`,
      );
    }
    if (Number.isSafeInteger(input.confirmatoryRepetitionsPerSystemTask)) {
      const totalCandidateTasks = input.candidateRepositoryTaskAllocations.reduce(
        (sum, allocation) => sum + (Array.isArray(allocation)
          ? allocation.reduce((allocationSum, count) =>
            allocationSum + (Number.isSafeInteger(count) ? count : 0), 0)
          : 0),
        0,
      );
      const syntheticWork = BigInt(input.simulationReplications)
        * BigInt(input.confirmatoryRepetitionsPerSystemTask)
        * BigInt(Math.max(1, comparisonSystems.size))
        * BigInt(Math.max(1, Array.isArray(input.assumedEffectSizes) ? input.assumedEffectSizes.length : 0))
        * BigInt(Math.max(1, Array.isArray(input.heterogeneityMultipliers)
          ? input.heterogeneityMultipliers.length
          : 0))
        * BigInt(totalCandidateTasks);
      if (syntheticWork > BigInt(EVAL_POWER_MAXIMUM_SYNTHETIC_ATTEMPT_COMPARISONS)) {
        issues.push(
          `aggregate synthetic attempt work cannot exceed ${EVAL_POWER_MAXIMUM_SYNTHETIC_ATTEMPT_COMPARISONS} attempt-comparisons`,
        );
      }
    }
  }

  if (issues.length > 0) throw new PowerAnalysisValidationError([...new Set(issues)]);

  const taskIdsByRepository = new Map<string, readonly string[]>();
  for (const [repositoryId, taskIds] of [...repositoryTaskIds].sort(([left], [right]) =>
    compareString(left, right))) {
    taskIdsByRepository.set(repositoryId, [...taskIds].sort(compareString));
  }
  const jointAttemptsByTask = new Map<string, readonly JointPilotAttempt[]>();
  const firstComparisonId = comparisonIds[0];
  for (const taskId of allTaskIds) {
    const trialIds = referenceTrialIds?.get(taskId) as readonly string[];
    const attempts = trialIds.map((trialId) => {
      const primaryOutcome = cells
        .get(`${firstComparisonId}\u0000${taskId}`)
        ?.get(trialId)?.primaryOutcome as 0 | 1;
      const comparatorOutcomes = new Map<string, 0 | 1>();
      for (const comparisonId of comparisonIds) {
        comparatorOutcomes.set(
          comparisonId,
          cells.get(`${comparisonId}\u0000${taskId}`)?.get(trialId)?.comparatorOutcome as 0 | 1,
        );
      }
      return { primaryOutcome, comparatorOutcomes };
    });
    jointAttemptsByTask.set(taskId, attempts);
  }
  return {
    comparisons: comparisonTasks,
    repositoryIds: [...taskIdsByRepository.keys()],
    taskIdsByRepository,
    minimumRepetitions,
    maximumRepetitions,
    normalizedOutcomes: validOutcomes.sort(compareOutcome),
    jointAttemptsByTask,
  };
}

function repositoryWeightedMean(
  tasks: ReadonlyMap<string, AggregatedTask>,
  taskIdsByRepository: ReadonlyMap<string, readonly string[]>,
): number {
  return average([...taskIdsByRepository.values()].map((taskIds) =>
    average(taskIds.map((taskId) => (tasks.get(taskId) as AggregatedTask).difference))));
}

function summarizeComparison(
  comparison: AggregatedComparison,
  taskIdsByRepository: ReadonlyMap<string, readonly string[]>,
): PilotComparisonSummary {
  const tasks = [...comparison.tasks.values()];
  const repositoryMeans = [...taskIdsByRepository.values()].map((taskIds) =>
    average(taskIds.map((taskId) => (comparison.tasks.get(taskId) as AggregatedTask).difference)));
  const repositoryMean = average(repositoryMeans);
  const repositoryBetweenVariance = average(
    repositoryMeans.map((value) => (value - repositoryMean) ** 2),
  );
  const withinRepositoryVariance = average([...taskIdsByRepository.values()].map((taskIds) => {
    const values = taskIds.map((taskId) => (comparison.tasks.get(taskId) as AggregatedTask).difference);
    const mean = average(values);
    return average(values.map((value) => (value - mean) ** 2));
  }));
  const totalVariance = repositoryBetweenVariance + withinRepositoryVariance;
  return {
    comparisonId: comparison.comparisonId,
    comparatorSystemId: comparison.comparatorSystemId,
    primaryTaskMeanSuccessRate: round(average(tasks.map((task) => task.primaryMean))),
    comparatorTaskMeanSuccessRate: round(average(tasks.map((task) => task.comparatorMean))),
    pairedDifferenceTaskWeighted: round(average(tasks.map((task) => task.difference))),
    pairedDifferenceRepositoryWeighted: round(repositoryMean),
    repositoryBetweenVariance: round(repositoryBetweenVariance),
    withinRepositoryVariance: round(withinRepositoryVariance),
    empiricalRepositoryVarianceShare: round(totalVariance === 0 ? 0 : repositoryBetweenVariance / totalVariance),
  };
}

function clampProbability(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function createTargetComparatorProbabilities(
  comparison: AggregatedComparison,
  taskIdsByRepository: ReadonlyMap<string, readonly string[]>,
  assumedEffect: number,
  heterogeneityMultiplier: number,
): ReadonlyMap<string, number> {
  const observedMean = repositoryWeightedMean(comparison.tasks, taskIdsByRepository);
  const rawDesiredEffects = new Map<string, number>();
  for (const task of comparison.tasks.values()) {
    rawDesiredEffects.set(
      task.taskId,
      assumedEffect + heterogeneityMultiplier * (task.difference - observedMean),
    );
  }
  const meanForOffset = (offset: number): number => average(
    [...taskIdsByRepository.values()].map((taskIds) => average(
      taskIds.map((taskId) => {
        const task = comparison.tasks.get(taskId) as AggregatedTask;
        const targetComparatorProbability = clampProbability(
          task.primaryMean - ((rawDesiredEffects.get(taskId) as number) + offset),
        );
        return task.primaryMean - targetComparatorProbability;
      }),
    )),
  );

  // This monotone correction keeps the requested repository-population effect
  // exact while respecting the feasible comparator probability [0, 1].
  let low = -2;
  let high = 2;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const midpoint = (low + high) / 2;
    if (meanForOffset(midpoint) < assumedEffect) low = midpoint;
    else high = midpoint;
  }
  const offset = (low + high) / 2;
  return new Map([...rawDesiredEffects].map(([taskId, desiredEffect]) => {
    const task = comparison.tasks.get(taskId) as AggregatedTask;
    return [
      taskId,
      clampProbability(task.primaryMean - (desiredEffect + offset)),
    ];
  }));
}

function createScenarioModels(input: PowerAnalysisInput, pilot: ValidatedPilot): readonly ScenarioModel[] {
  const effects = [...input.assumedEffectSizes].sort((left, right) => left - right);
  const multipliers = [...input.heterogeneityMultipliers].sort((left, right) => left - right);
  return effects.flatMap((assumedEffect) => multipliers.map((heterogeneityMultiplier) => ({
    assumedEffect,
    heterogeneityMultiplier,
    targetComparatorProbabilitiesByComparison: new Map(pilot.comparisons.map((comparison) => [
      comparison.comparisonId,
      createTargetComparatorProbabilities(
        comparison,
        pilot.taskIdsByRepository,
        assumedEffect,
        heterogeneityMultiplier,
      ),
    ])),
  })));
}

class DeterministicRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed === 0 ? 0x9e37_79b9 : seed >>> 0;
  }

  private nextUint32(): number {
    let value = this.state;
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    this.state = value >>> 0;
    return this.state;
  }

  nextInteger(exclusiveMaximum: number): number {
    if (!Number.isSafeInteger(exclusiveMaximum) || exclusiveMaximum <= 0 || exclusiveMaximum > 0x1_0000_0000) {
      throw new RangeError("exclusiveMaximum must be an integer from 1 through 2^32");
    }
    const limit = Math.floor(0x1_0000_0000 / exclusiveMaximum) * exclusiveMaximum;
    let value = this.nextUint32();
    while (value >= limit) value = this.nextUint32();
    return value % exclusiveMaximum;
  }

  nextUnitInterval(): number {
    return (this.nextUint32() + 0.5) / 0x1_0000_0000;
  }
}

function deriveRandomSeed(randomSeed: number, taskCount: number, replication: number): number {
  const digest = createHash("sha256")
    .update(`agenc.eval.power.simulation.v1\u0000${randomSeed}\u0000${taskCount}\u0000${replication}`, "utf8")
    .digest();
  return digest.readUInt32BE(0);
}

function deriveAttemptSeed(replicationSeed: number, repositoryIndex: number, taskIndex: number): number {
  // The replication seed is SHA-256 domain separated above. This avalanche
  // mix cheaply derives per-task xorshift streams without
  // making configured repeat counts perturb repository/task selection.
  let value = replicationSeed
    ^ Math.imul(repositoryIndex + 1, 0x9e37_79b1)
    ^ Math.imul(taskIndex + 1, 0x85eb_ca6b);
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb_352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846c_a68b);
  value ^= value >>> 16;
  return value >>> 0;
}

function sampleSyntheticRepositories(
  pilot: ValidatedPilot,
  repositoryTaskCounts: readonly number[],
  repetitions: number,
  replicationSeed: number,
  random: DeterministicRandom,
): readonly (readonly SyntheticTaskDraw[])[] {
  return repositoryTaskCounts.map((count, repositoryIndex) => {
    const sourceRepository = pilot.repositoryIds[random.nextInteger(pilot.repositoryIds.length)];
    const sourceTasks = pilot.taskIdsByRepository.get(sourceRepository) as readonly string[];
    return Array.from({ length: count }, (_, taskIndex): SyntheticTaskDraw => {
      const taskId = sourceTasks[random.nextInteger(sourceTasks.length)];
      const jointAttempts = pilot.jointAttemptsByTask.get(taskId) as readonly JointPilotAttempt[];
      // Attempt streams are independent of the requested repetition count, so
      // a five-repeat design extends the exact three-repeat prefix.
      const attemptRandom = new DeterministicRandom(deriveAttemptSeed(
        replicationSeed,
        repositoryIndex,
        taskIndex,
      ));
      return {
        taskId,
        attempts: Array.from({ length: repetitions }, () => ({
          jointAttemptIndex: attemptRandom.nextInteger(jointAttempts.length),
          adjustmentUniforms: pilot.comparisons.map(() => attemptRandom.nextUnitInterval()),
        })),
      };
    });
  });
}

function studentTCritical975(degreesOfFreedom: number): number {
  // Cornish-Fisher through O(df^-4); under the enforced balanced 20+-cluster
  // design its error is below 1e-6 and it is platform deterministic.
  const z = NORMAL_975;
  const z2 = z * z;
  const z3 = z2 * z;
  const z5 = z3 * z2;
  const z7 = z5 * z2;
  const z9 = z7 * z2;
  const df = degreesOfFreedom;
  return z
    + (z3 + z) / (4 * df)
    + (5 * z5 + 16 * z3 + 3 * z) / (96 * df ** 2)
    + (3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / (384 * df ** 3)
    + (79 * z9 + 776 * z7 + 1_482 * z5 - 1_920 * z3 - 945 * z) / (92_160 * df ** 4);
}

function computeInterceptOnlyCr2Raw(
  clusters: readonly (readonly number[])[],
): InterceptOnlyCr2Inference {
  const taskCount = clusters.reduce((sum, cluster) => sum + cluster.length, 0);
  const point = clusters.reduce(
    (sum, cluster) => sum + cluster.reduce((clusterSum, value) => clusterSum + value, 0),
    0,
  ) / taskCount;
  const clusterScores = clusters.map((cluster) =>
    cluster.reduce((sum, value) => sum + value - point, 0));
  const clusterSizes = clusters.map((cluster) => cluster.length);
  const variance = clusterScores.reduce((sum, score, index) => {
    const leverage = clusterSizes[index] / taskCount;
    return sum + score ** 2 / (1 - leverage);
  }, 0) / taskCount ** 2;

  // Bell-McCaffrey Satterthwaite df for an intercept-only OLS model. This is
  // the closed form independently exercised by clubSandwich's reference tests
  // and follows Pustejovsky & Tipton (2018), doi:10.1080/07350015.2016.1247004.
  const firstDfTerm = clusterSizes.reduce(
    (sum, size) => sum + size ** 2 / (taskCount - size) ** 2,
    0,
  );
  const secondDfTerm = clusterSizes.reduce(
    (sum, size) => sum + size ** 3 / (taskCount - size) ** 2,
    0,
  );
  const thirdDfTerm = clusterSizes.reduce(
    (sum, size) => sum + size ** 2 / (taskCount - size),
    0,
  );
  const dfDenominator = taskCount ** 2 * firstDfTerm
    - 2 * taskCount * secondDfTerm
    + thirdDfTerm ** 2;
  const degreesOfFreedom = taskCount ** 2 / dfDenominator;
  const standardError = Math.sqrt(Math.max(0, variance));
  const criticalValue = studentTCritical975(degreesOfFreedom);
  return {
    estimate: point,
    standardError,
    degreesOfFreedom,
    lower95: point - criticalValue * standardError,
    upper95: point + criticalValue * standardError,
  };
}

/**
 * Diagnostic-only bias-reduced CR2/Satterthwaite sensitivity for an
 * intercept-only task effect clustered by repository. It never drives the
 * confirmatory power decision, which uses the production percentile bootstrap.
 */
export function computeInterceptOnlyCr2Inference(
  clusters: readonly (readonly number[])[],
): InterceptOnlyCr2Inference {
  if (!Array.isArray(clusters) || clusters.length < EVAL_POWER_MINIMUM_CONFIRMATORY_REPOSITORIES) {
    throw new PowerAnalysisValidationError([
      `CR2 inference requires at least ${EVAL_POWER_MINIMUM_CONFIRMATORY_REPOSITORIES} repositories`,
    ]);
  }
  if (clusters.some((cluster) => !Array.isArray(cluster) || cluster.length === 0)) {
    throw new PowerAnalysisValidationError(["CR2 inference requires non-empty repository clusters"]);
  }
  const taskCount = clusters.reduce((sum, cluster) => sum + cluster.length, 0);
  if (taskCount < EVAL_POWER_MINIMUM_CONFIRMATORY_TASKS) {
    throw new PowerAnalysisValidationError([
      `CR2 inference requires at least ${EVAL_POWER_MINIMUM_CONFIRMATORY_TASKS} tasks`,
    ]);
  }
  if (clusters.some((cluster) => cluster.length * 100 > taskCount * 10)) {
    throw new PowerAnalysisValidationError(["CR2 inference repository clusters must obey the 10% task cap"]);
  }
  if (clusters.some((cluster) => cluster.some((value: unknown) =>
    typeof value !== "number" || !Number.isFinite(value) || value < -1 || value > 1))) {
    throw new PowerAnalysisValidationError(["CR2 task effects must be finite values from -1 through 1"]);
  }
  return computeInterceptOnlyCr2Raw(clusters);
}

function adjustComparatorOutcome(
  baseOutcome: 0 | 1,
  baseProbability: number,
  targetProbability: number,
  uniform: number,
): 0 | 1 {
  if (Math.abs(targetProbability - baseProbability) < EPSILON) return baseOutcome;
  if (targetProbability < baseProbability) {
    if (baseOutcome === 0) return 0;
    return uniform < targetProbability / baseProbability ? 1 : 0;
  }
  if (baseOutcome === 1) return 1;
  return uniform < (targetProbability - baseProbability) / (1 - baseProbability) ? 1 : 0;
}

function simulateClusteredTaskDifferences(
  sampledRepositories: readonly (readonly SyntheticTaskDraw[])[],
  scenario: ScenarioModel,
  pilot: ValidatedPilot,
): ReadonlyMap<string, readonly (readonly number[])[]> {
  const clustersByComparison = new Map<string, number[][]>(
    pilot.comparisons.map((comparison) => [
      comparison.comparisonId,
      sampledRepositories.map(() => []),
    ]),
  );
  for (const [repositoryIndex, repository] of sampledRepositories.entries()) {
    for (const task of repository) {
      const differences = pilot.comparisons.map(() => 0);
      const jointAttempts = pilot.jointAttemptsByTask.get(task.taskId) as readonly JointPilotAttempt[];
      for (const attempt of task.attempts) {
        // Resampling the whole attempt row preserves the empirical joint
        // multinomial (one shared primary plus every comparator). The monotone
        // transport below changes only the requested comparator marginal.
        const base = jointAttempts[attempt.jointAttemptIndex];
        for (const [comparisonIndex, comparison] of pilot.comparisons.entries()) {
          const baseComparatorOutcome = base.comparatorOutcomes.get(comparison.comparisonId) as 0 | 1;
          const baseComparatorProbability = (
            comparison.tasks.get(task.taskId) as AggregatedTask
          ).comparatorMean;
          const targetComparatorProbability = scenario.targetComparatorProbabilitiesByComparison
            .get(comparison.comparisonId)
            ?.get(task.taskId) as number;
          const comparatorOutcome = adjustComparatorOutcome(
            baseComparatorOutcome,
            baseComparatorProbability,
            targetComparatorProbability,
            attempt.adjustmentUniforms[comparisonIndex],
          );
          differences[comparisonIndex] += base.primaryOutcome - comparatorOutcome;
        }
      }
      for (const [comparisonIndex, comparison] of pilot.comparisons.entries()) {
        (clustersByComparison.get(comparison.comparisonId) as number[][])[repositoryIndex]
          .push(differences[comparisonIndex] / task.attempts.length);
      }
    }
  }
  return clustersByComparison;
}

function comparisonSucceeds(
  clusters: readonly (readonly number[])[],
  comparisonId: string,
  input: PowerAnalysisInput,
): boolean {
  const taskDifferences = clusters.flatMap((cluster, repositoryIndex) => cluster.map((difference) => ({
    cluster: `synthetic-repository-${String(repositoryIndex).padStart(5, "0")}`,
    difference,
  })));
  const pointEstimate = average(taskDifferences.map((entry) => entry.difference));
  const interval = computeRepositoryClusteredPercentileInterval(
    taskDifferences,
    comparisonId,
    {
      resamples: input.confirmatoryInferenceResamples,
      randomSeed: input.confirmatoryInferenceRandomSeed,
    },
  );
  return pointEstimate + EPSILON >= EVAL_POWER_MINIMUM_EFFECT && interval.lower > 0;
}

function wilsonEstimate(successes: number, replications: number): PowerEstimate {
  const estimate = successes / replications;
  const z2 = NORMAL_975 ** 2;
  const denominator = 1 + z2 / replications;
  const center = (estimate + z2 / (2 * replications)) / denominator;
  const halfWidth = NORMAL_975 * Math.sqrt(
    (estimate * (1 - estimate) + z2 / (4 * replications)) / replications,
  ) / denominator;
  return {
    successes,
    replications,
    estimate: round(estimate),
    monteCarloStandardError: round(Math.sqrt(estimate * (1 - estimate) / replications)),
    // Decision-facing lower bounds round outward, never upward across 0.80.
    wilsonLower95: roundDownProbability(center - halfWidth),
    wilsonUpper95: roundUpProbability(center + halfWidth),
  };
}

function simulateGrid(
  input: PowerAnalysisInput,
  pilot: ValidatedPilot,
  scenarios: readonly ScenarioModel[],
): readonly SensitivityCell[] {
  const candidateAllocations = input.candidateRepositoryTaskAllocations.map((allocation) =>
    [...allocation].sort((left, right) => left - right));
  const cells: SensitivityCell[] = [];
  for (const repositoryTaskCounts of candidateAllocations) {
    const taskCount = repositoryTaskCounts.reduce((sum, count) => sum + count, 0);
    const comparisonSuccesses = scenarios.map(() =>
      new Map(pilot.comparisons.map((comparison) => [comparison.comparisonId, 0])));
    const intersectionSuccesses = scenarios.map(() => 0);
    for (let replication = 0; replication < input.simulationReplications; replication += 1) {
      const replicationSeed = deriveRandomSeed(input.randomSeed, taskCount, replication);
      const random = new DeterministicRandom(replicationSeed);
      const sample = sampleSyntheticRepositories(
        pilot,
        repositoryTaskCounts,
        input.confirmatoryRepetitionsPerSystemTask,
        replicationSeed,
        random,
      );
      for (const [scenarioIndex, scenario] of scenarios.entries()) {
        let intersection = true;
        const clustersByComparison = simulateClusteredTaskDifferences(sample, scenario, pilot);
        for (const comparison of pilot.comparisons) {
          const succeeds = comparisonSucceeds(
            clustersByComparison.get(comparison.comparisonId) as readonly (readonly number[])[],
            comparison.comparisonId,
            input,
          );
          if (succeeds) {
            const successes = comparisonSuccesses[scenarioIndex];
            successes.set(comparison.comparisonId, (successes.get(comparison.comparisonId) as number) + 1);
          } else {
            intersection = false;
          }
        }
        if (intersection) intersectionSuccesses[scenarioIndex] += 1;
      }
    }
    for (const [scenarioIndex, scenario] of scenarios.entries()) {
      cells.push({
        assumedPairedDifference: round(scenario.assumedEffect),
        heterogeneityMultiplier: round(scenario.heterogeneityMultiplier),
        taskCount,
        repositoryCount: repositoryTaskCounts.length,
        comparisonPower: pilot.comparisons.map((comparison) => ({
          comparisonId: comparison.comparisonId,
          power: wilsonEstimate(
            comparisonSuccesses[scenarioIndex].get(comparison.comparisonId) as number,
            input.simulationReplications,
          ),
        })),
        intersectionPower: wilsonEstimate(
          intersectionSuccesses[scenarioIndex],
          input.simulationReplications,
        ),
      });
    }
  }
  return cells.sort((left, right) =>
    left.assumedPairedDifference - right.assumedPairedDifference
    || left.heterogeneityMultiplier - right.heterogeneityMultiplier
    || left.taskCount - right.taskCount);
}

function selectFixedPlan(
  input: PowerAnalysisInput,
  sensitivityGrid: readonly SensitivityCell[],
): FixedConfirmatoryPlan | null {
  const target = Number(EVAL_POWER_TARGET);
  for (const repositoryTaskCounts of input.candidateRepositoryTaskAllocations) {
    const normalizedAllocation = [...repositoryTaskCounts].sort((left, right) => left - right);
    const taskCount = normalizedAllocation.reduce((sum, count) => sum + count, 0);
    const cells = sensitivityGrid.filter((cell) =>
      cell.taskCount === taskCount
      && Math.abs(cell.assumedPairedDifference - input.planningEffectSize) < EPSILON);
    if (cells.length > 0 && cells.every((cell) => cell.intersectionPower.wilsonLower95 >= target)) {
      return {
        suiteId: input.confirmatorySuiteId,
        suiteVersion: input.confirmatorySuiteVersion,
        experimentId: input.confirmatoryExperimentId,
        taskCount,
        repositoryCount: normalizedAllocation.length,
        repositoryTaskCounts: normalizedAllocation,
        repetitionsPerSystemTask: input.confirmatoryRepetitionsPerSystemTask,
        inferenceResamples: input.confirmatoryInferenceResamples,
        inferenceRandomSeed: input.confirmatoryInferenceRandomSeed,
        stoppingRule: {
          kind: "fixed",
          taskCount,
          interimLooks: 0,
          optionalStopping: false,
        },
      };
    }
  }
  return null;
}

/**
 * Builds a deterministic, digest-bound pilot-to-confirmatory power analysis.
 * Invalid or incomplete paired data throws; an underpowered grid returns no
 * confirmatory plan and therefore cannot silently authorize a superiority run.
 */
export function computePowerAnalysis(input: PowerAnalysisInput): PowerAnalysisDocument {
  const pilot = validateAndAggregate(input);
  const scenarios = createScenarioModels(input, pilot);
  const sensitivityGrid = simulateGrid(input, pilot, scenarios);
  const confirmatoryPlan = selectFixedPlan(input, sensitivityGrid);
  const candidateRepositoryTaskAllocations = input.candidateRepositoryTaskAllocations.map(
    (allocation) => [...allocation].sort((left, right) => left - right),
  );
  const repositoryTaskCounts = [...pilot.taskIdsByRepository].map(([repositoryId, taskIds]) => ({
    repositoryId,
    taskCount: taskIds.length,
  }));
  const draft: Omit<PowerAnalysisDocument, "documentDigest"> = {
    kind: "agenc.eval.power-analysis",
    analysisVersion: EVAL_POWER_ANALYSIS_VERSION,
    analysisId: input.analysisId,
    pilotId: input.pilotId,
    createdAt: input.createdAt,
    primarySystemId: input.primarySystemId,
    pilot: {
      inputDigest: digestCanonicalJson("agenc.eval.power.pilot-input.v1", {
        pilotId: input.pilotId,
        primarySystemId: input.primarySystemId,
        outcomes: pilot.normalizedOutcomes,
      }),
      taskCount: [...pilot.taskIdsByRepository.values()].reduce(
        (sum, taskIds) => sum + taskIds.length,
        0,
      ),
      repositoryCount: pilot.repositoryIds.length,
      comparisonCount: pilot.comparisons.length,
      minimumRepetitionsPerTaskComparison: pilot.minimumRepetitions,
      maximumRepetitionsPerTaskComparison: pilot.maximumRepetitions,
      contractMinimumRepetitionsPerTaskComparison: EVAL_POWER_MINIMUM_REPETITIONS,
      recommendedRepetitionsPerTaskComparison: EVAL_POWER_RECOMMENDED_PILOT_REPETITIONS,
      repetitionRecommendation: pilot.minimumRepetitions >= EVAL_POWER_RECOMMENDED_PILOT_REPETITIONS
        ? "met"
        : "accepted_contract_minimum_below_recommended",
      aggregation: "mean_within_task_then_equal_task_weight",
      repositoryTaskCounts,
      comparisons: pilot.comparisons.map((comparison) =>
        summarizeComparison(comparison, pilot.taskIdsByRepository)),
    },
    design: {
      alpha: EVAL_POWER_ALPHA,
      targetPower: EVAL_POWER_TARGET,
      minimumEffect: EVAL_POWER_MINIMUM_EFFECT,
      primaryMetric: "paired_binary_success_rate_difference",
      inference: "repository_clustered_paired_percentile_bootstrap",
      interval: "two_sided_percentile",
      quantileMethod: "linear_type_7",
      inferenceUnit: "task_mean_after_repetition_aggregation",
      clusteringUnit: "repository",
      multipleComparators: "intersection_union",
      successRule: "point_at_least_minimum_effect_and_two_sided_lower_bound_above_zero_for_every_comparator",
      planningEffectSize: input.planningEffectSize,
      assumedEffectSizes: [...input.assumedEffectSizes].sort((left, right) => left - right),
      heterogeneityMultipliers: [...input.heterogeneityMultipliers].sort((left, right) => left - right),
      confirmatorySuiteId: input.confirmatorySuiteId,
      confirmatorySuiteVersion: input.confirmatorySuiteVersion,
      confirmatoryExperimentId: input.confirmatoryExperimentId,
      candidateRepositoryTaskAllocations,
      confirmatoryRepetitionsPerSystemTask: input.confirmatoryRepetitionsPerSystemTask,
      confirmatoryInferenceResamples: input.confirmatoryInferenceResamples,
      confirmatoryInferenceRandomSeed: input.confirmatoryInferenceRandomSeed,
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
      simulationReplications: input.simulationReplications,
      randomSeed: input.randomSeed,
      randomStream: "sha256_domain_seeded_xorshift32_rejection_sampling_v1",
      confirmatoryInference: "production_repository_clustered_percentile_bootstrap",
      powerDecisionInterval: "two_sided_wilson_95",
    },
    sensitivityGrid,
    decision: {
      status: confirmatoryPlan ? "adequately_powered" : "no_candidate_meets_target",
      rule: "smallest_fixed_n_whose_intersection_power_wilson_lower_95_meets_target_at_planning_effect_across_heterogeneity_grid",
      confirmatoryPlan,
    },
  };
  return validatePowerAnalysisDocument(withDocumentDigest<PowerAnalysisDocument>(draft));
}
