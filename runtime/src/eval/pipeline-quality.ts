/**
 * Phase 9 pipeline-quality artifact schema and helpers.
 *
 * @module
 */

import { stableStringifyJson, type JsonValue } from "./types.js";
import type {
  ChaosScenarioArtifact as PipelineChaosScenarioArtifact,
  ChaosSuiteArtifact as PipelineChaosArtifact,
} from "./chaos-suite.js";
import type { EconomicsScorecard } from "./economics-scorecard.js";

const LEGACY_PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION = 1 as const;
const PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V2 = 2 as const;
const PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V3 = 3 as const;
const PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V4 = 4 as const;
const PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V5 = 5 as const;
const PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V6 = 6 as const;
const PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V7 = 7 as const;
export const PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION = 8 as const;

export interface PipelineContextGrowthArtifact {
  turns: number;
  promptTokenSeries: number[];
  tokenDeltas: number[];
  maxDelta: number;
  slope: number;
}

export interface PipelineToolTurnArtifact {
  validCases: number;
  validAccepted: number;
  malformedCases: number;
  malformedRejected: number;
  malformedForwarded: number;
}

export interface PipelineDesktopRunArtifact {
  runId: string;
  ok: boolean;
  timedOut: boolean;
  durationMs: number;
  failedStep?: number;
  preview?: string;
}

export interface PipelineDesktopStabilityArtifact {
  runs: number;
  failedRuns: number;
  timedOutRuns: number;
  maxDurationMs: number;
  runSummaries: PipelineDesktopRunArtifact[];
}

export interface PipelineTokenEfficiencyArtifact {
  completedTasks: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  tokensPerCompletedTask: number;
}

export interface PipelineOfflineReplayFixtureArtifact {
  fixtureId: string;
  ok: boolean;
  parseError?: string;
  replayError?: string;
  deterministicMismatch?: boolean;
}

export interface PipelineOfflineReplayArtifact {
  fixtureCount: number;
  parseFailures: number;
  replayFailures: number;
  deterministicMismatches: number;
  fixtures: PipelineOfflineReplayFixtureArtifact[];
}

export type PipelineDelegationScenarioMode =
  | "no_delegation"
  | "single_child"
  | "parallel_children"
  | "handoff"
  | "verifier_retry";

export interface PipelineDelegationScenarioArtifact {
  scenarioId: string;
  mode: PipelineDelegationScenarioMode;
  runCount: number;
  passRate: number;
  passAtK: number;
  passCaretK: number;
  meanLatencyMs: number;
  meanCostUnits: number;
  passAtKDeltaVsBaseline: number;
  passCaretKDeltaVsBaseline: number;
}

export interface PipelineDelegationArtifact {
  totalCases: number;
  delegatedCases: number;
  usefulDelegations: number;
  harmfulDelegations: number;
  unnecessaryDelegations: number;
  plannerExecutionMismatches: number;
  childTimeouts: number;
  childFailures: number;
  synthesisConflicts: number;
  depthCapHits: number;
  fanoutCapHits: number;
  delegationAttemptRate: number;
  usefulDelegationRate: number;
  harmfulDelegationRate: number;
  plannerToExecutionMismatchRate: number;
  childTimeoutRate: number;
  childFailureRate: number;
  synthesisConflictRate: number;
  depthCapHitRate: number;
  fanoutCapHitRate: number;
  costDeltaVsBaseline: number;
  latencyDeltaVsBaseline: number;
  qualityDeltaVsBaseline: number;
  passAtKDeltaVsBaseline: number;
  passCaretKDeltaVsBaseline: number;
  baselineScenarioId: string;
  k: number;
  scenarioSummaries: PipelineDelegationScenarioArtifact[];
}

export interface PipelineOrchestrationScenarioArtifact {
  scenarioId: string;
  title: string;
  category: string;
  sourceTraceId: string;
  passed: boolean;
  finalStatus: string;
  replayErrors: number;
  replayWarnings: number;
  policyViolations: number;
  verifierVerdicts: number;
  turns: number;
  toolCalls: number;
  fallbackCount: number;
  spuriousSubagentCount: number;
  approvalCount: number;
  restartRecoverySuccess: boolean;
  mismatchReasons: string[];
}

export interface PipelineOrchestrationBaselineArtifact {
  scenarioCount: number;
  passingScenarios: number;
  passRate: number;
  averageTurns: number;
  averageToolCalls: number;
  fallbackCount: number;
  spuriousSubagentCount: number;
  approvalCount: number;
  wrongRootIncidents: number;
  unsafeMutationAttempts: number;
  approvalCorrectnessRate: number;
  effectLedgerCompletenessRate: number;
  restartRecoverySuccessCount: number;
  restartRecoverySuccessRate: number;
  scenarios: PipelineOrchestrationScenarioArtifact[];
}

export interface PipelineLiveCodingScenarioArtifact {
  scenarioId: string;
  title: string;
  passed: boolean;
  tempRepoPath: string;
  fileMutationCount: number;
  shellMutationCount: number;
  wrongRootIncident: boolean;
  unauthorizedWriteBlocked: boolean;
  effectLedgerComplete: boolean;
  exitCode: number;
  notes?: string;
}

export interface PipelineLiveCodingArtifact {
  scenarioCount: number;
  passingScenarios: number;
  passRate: number;
  tempRepoCount: number;
  totalFileMutations: number;
  totalShellMutations: number;
  wrongRootIncidents: number;
  unauthorizedWriteBlocks: number;
  effectLedgerCompletenessRate: number;
  scenarios: readonly PipelineLiveCodingScenarioArtifact[];
}

export type PipelineSafetyAttackClass =
  | "prompt_injection"
  | "malicious_repo_file"
  | "unsafe_shell"
  | "unauthorized_artifact_write";

export interface PipelineSafetyScenarioArtifact {
  scenarioId: string;
  title: string;
  attackClass: PipelineSafetyAttackClass;
  passed: boolean;
  blocked: boolean;
  requiredApproval: boolean;
  denied: boolean;
  unsafeMutationAttempt: boolean;
  approvalCorrect: boolean;
  notes?: string;
}

export interface PipelineSafetyArtifact {
  scenarioCount: number;
  blockedScenarios: number;
  passingScenarios: number;
  passRate: number;
  promptInjectionBlocks: number;
  maliciousRepoFileBlocks: number;
  unsafeShellBlocks: number;
  unauthorizedArtifactWriteBlocks: number;
  unsafeMutationAttempts: number;
  approvalCorrectnessRate: number;
  scenarios: readonly PipelineSafetyScenarioArtifact[];
}

export type PipelineLongHorizonScenarioCategory =
  | "hundred_step"
  | "crash_resume"
  | "compact_continue"
  | "background_persistence"
  | "multi_worker_completion";

export interface PipelineLongHorizonScenarioArtifact {
  scenarioId: string;
  title: string;
  category: PipelineLongHorizonScenarioCategory;
  passed: boolean;
  stepCount: number;
  resumed: boolean;
  compacted: boolean;
  persisted: boolean;
  restartRecoverySuccess: boolean;
  notes?: string;
}

export interface PipelineLongHorizonArtifact {
  scenarioCount: number;
  passingScenarios: number;
  passRate: number;
  hundredStepRuns: number;
  crashResumeRuns: number;
  compactContinueRuns: number;
  backgroundPersistenceRuns: number;
  restartRecoverySuccessRate: number;
  compactionContinuationRate: number;
  backgroundPersistenceRate: number;
  scenarios: readonly PipelineLongHorizonScenarioArtifact[];
}

export type PipelineImplementationGateScenarioCategory =
  | "shell_stub_replay"
  | "deterministic_false_completion"
  | "live_runtime_false_completion"
  | "scaffold_placeholder"
  | "implementation_repair"
  | "wrong_artifact_verifier"
  | "resume_partial_completion"
  | "degraded_provider_retry"
  | "safety_incomplete_output";

export type PipelineImplementationGateExecutionMode =
  | "replay"
  | "temp_repo"
  | "runtime"
  | "background_run"
  | "policy";

export interface PipelineImplementationGateScenarioArtifact {
  scenarioId: string;
  title: string;
  category: PipelineImplementationGateScenarioCategory;
  mandatory: boolean;
  executionMode: PipelineImplementationGateExecutionMode;
  passed: boolean;
  falseCompleted: boolean;
  observedOutcome: string;
  expectedOutcome: string;
  notes?: string;
}

export interface PipelineImplementationGateArtifact {
  scenarioCount: number;
  mandatoryScenarioCount: number;
  advisoryScenarioCount: number;
  passingScenarios: number;
  passRate: number;
  mandatoryPassingScenarios: number;
  mandatoryPassRate: number;
  falseCompletedScenarios: number;
  scenarios: readonly PipelineImplementationGateScenarioArtifact[];
}

export type PipelineDelegatedWorkspaceGateScenarioCategory =
  | "trace_replay"
  | "split_root_invariant"
  | "preflight_rejection"
  | "alias_migration_consistency"
  | "shared_artifact_writer_denial"
  | "degraded_provider_retry";

export type PipelineDelegatedWorkspaceGateExecutionMode =
  | "replay"
  | "runtime"
  | "policy";

export interface PipelineDelegatedWorkspaceGateScenarioArtifact {
  scenarioId: string;
  title: string;
  category: PipelineDelegatedWorkspaceGateScenarioCategory;
  mandatory: boolean;
  executionMode: PipelineDelegatedWorkspaceGateExecutionMode;
  passed: boolean;
  falseCompleted: boolean;
  observedOutcome: string;
  expectedOutcome: string;
  notes?: string;
}

export interface PipelineDelegatedWorkspaceGateArtifact {
  scenarioCount: number;
  mandatoryScenarioCount: number;
  advisoryScenarioCount: number;
  passingScenarios: number;
  passRate: number;
  mandatoryPassingScenarios: number;
  mandatoryPassRate: number;
  falseCompletedScenarios: number;
  scenarios: readonly PipelineDelegatedWorkspaceGateScenarioArtifact[];
}

export interface PipelineQualityArtifact {
  schemaVersion: typeof PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION;
  runId: string;
  generatedAtMs: number;
  contextGrowth: PipelineContextGrowthArtifact;
  toolTurn: PipelineToolTurnArtifact;
  desktopStability: PipelineDesktopStabilityArtifact;
  tokenEfficiency: PipelineTokenEfficiencyArtifact;
  offlineReplay: PipelineOfflineReplayArtifact;
  delegation: PipelineDelegationArtifact;
  orchestrationBaseline: PipelineOrchestrationBaselineArtifact;
  liveCoding: PipelineLiveCodingArtifact;
  safety: PipelineSafetyArtifact;
  longHorizon: PipelineLongHorizonArtifact;
  implementationGates: PipelineImplementationGateArtifact;
  delegatedWorkspaceGates: PipelineDelegatedWorkspaceGateArtifact;
  chaos: PipelineChaosArtifact;
  economics: EconomicsScorecard;
}

export interface PipelineContextGrowthInput {
  promptTokenSeries: readonly number[];
}

export interface PipelineToolTurnInput {
  validCases: number;
  validAccepted: number;
  malformedCases: number;
  malformedRejected: number;
  malformedForwarded: number;
}

export interface PipelineDesktopStabilityInput {
  runSummaries: readonly PipelineDesktopRunArtifact[];
}

export interface PipelineTokenEfficiencyInput {
  completedTasks: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
}

export interface PipelineOfflineReplayInput {
  fixtures: readonly PipelineOfflineReplayFixtureArtifact[];
}

export interface PipelineDelegationScenarioInput {
  scenarioId: string;
  mode: PipelineDelegationScenarioMode;
  runCount: number;
  passRate: number;
  passAtK: number;
  passCaretK: number;
  meanLatencyMs: number;
  meanCostUnits: number;
  passAtKDeltaVsBaseline: number;
  passCaretKDeltaVsBaseline: number;
}

export interface PipelineDelegationInput {
  totalCases: number;
  delegatedCases: number;
  usefulDelegations: number;
  harmfulDelegations: number;
  unnecessaryDelegations: number;
  plannerExecutionMismatches: number;
  childTimeouts: number;
  childFailures: number;
  synthesisConflicts: number;
  depthCapHits: number;
  fanoutCapHits: number;
  costDeltaVsBaseline: number;
  latencyDeltaVsBaseline: number;
  qualityDeltaVsBaseline: number;
  passAtKDeltaVsBaseline: number;
  passCaretKDeltaVsBaseline: number;
  baselineScenarioId: string;
  k: number;
  scenarioSummaries: readonly PipelineDelegationScenarioInput[];
}

export interface PipelineQualityArtifactInput {
  runId: string;
  generatedAtMs: number;
  contextGrowth: PipelineContextGrowthInput;
  toolTurn: PipelineToolTurnInput;
  desktopStability: PipelineDesktopStabilityInput;
  tokenEfficiency: PipelineTokenEfficiencyInput;
  offlineReplay: PipelineOfflineReplayInput;
  delegation?: PipelineDelegationInput;
  orchestrationBaseline?: PipelineOrchestrationBaselineInput;
  liveCoding?: PipelineLiveCodingArtifact;
  safety?: PipelineSafetyArtifact;
  longHorizon?: PipelineLongHorizonArtifact;
  implementationGates?: PipelineImplementationGateArtifact;
  delegatedWorkspaceGates?: PipelineDelegatedWorkspaceGateArtifact;
  chaos?: PipelineChaosArtifact;
  economics?: EconomicsScorecard;
}

export interface PipelineOrchestrationScenarioInput {
  scenarioId: string;
  title: string;
  category: string;
  sourceTraceId: string;
  passed: boolean;
  finalStatus: string;
  replayErrors: number;
  replayWarnings: number;
  policyViolations: number;
  verifierVerdicts: number;
  turns: number;
  toolCalls: number;
  fallbackCount: number;
  spuriousSubagentCount: number;
  approvalCount: number;
  restartRecoverySuccess: boolean;
  mismatchReasons?: string[];
}

export interface PipelineOrchestrationBaselineInput {
  scenarios: readonly PipelineOrchestrationScenarioInput[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function normalizeEconomics(
  input: EconomicsScorecard | undefined,
): EconomicsScorecard {
  const fallback: EconomicsScorecard = {
    scenarioCount: 0,
    passingScenarios: 0,
    passRate: 0,
    tokenCeilingComplianceRate: 0,
    latencyCeilingComplianceRate: 0,
    spendCeilingComplianceRate: 0,
    negativeEconomicsApplicableCount: 0,
    negativeEconomicsDelegationDenialRate: 0,
    degradedProviderRerouteApplicableCount: 0,
    degradedProviderRerouteRate: 0,
    meanSpendUnits: 0,
    meanLatencyMs: 0,
    scenarios: [],
  };

  return input
    ? {
        ...fallback,
        ...input,
      }
    : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asFiniteNumber(value: unknown, path: string): number {
  assert(
    typeof value === "number" && Number.isFinite(value),
    `${path} must be a finite number`,
  );
  return value;
}

function asFiniteNonNegativeNumber(value: unknown, path: string): number {
  const numeric = asFiniteNumber(value, path);
  assert(numeric >= 0, `${path} must be a non-negative finite number`);
  return numeric;
}

function asInteger(value: unknown, path: string): number {
  assert(
    typeof value === "number" && Number.isInteger(value),
    `${path} must be an integer`,
  );
  return value;
}

function asNonNegativeInteger(value: unknown, path: string): number {
  const numeric = asInteger(value, path);
  assert(numeric >= 0, `${path} must be a non-negative integer`);
  return numeric;
}

function asRate(value: unknown, path: string): number {
  const numeric = asFiniteNumber(value, path);
  assert(
    numeric >= 0 && numeric <= 1,
    `${path} must be a rate in [0, 1]`,
  );
  return numeric;
}

function parseNumberArray(value: unknown, path: string): number[] {
  assert(Array.isArray(value), `${path} must be an array`);
  return value.map((entry, index) =>
    asFiniteNonNegativeNumber(entry, `${path}[${index}]`),
  );
}

function computeTokenDeltas(series: readonly number[]): number[] {
  if (series.length <= 1) return [];
  const deltas: number[] = [];
  for (let i = 1; i < series.length; i++) {
    deltas.push(series[i]! - series[i - 1]!);
  }
  return deltas;
}

function computeSlope(series: readonly number[]): number {
  if (series.length <= 1) return 0;
  const first = series[0] ?? 0;
  const last = series[series.length - 1] ?? first;
  return (last - first) / (series.length - 1);
}

function safeRatio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function defaultDelegationInput(): PipelineDelegationInput {
  return {
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
  };
}

function normalizeContextGrowth(
  input: PipelineContextGrowthInput,
): PipelineContextGrowthArtifact {
  const promptTokenSeries = input.promptTokenSeries.map((value, index) =>
    asFiniteNonNegativeNumber(
      value,
      `contextGrowth.promptTokenSeries[${index}]`,
    ),
  );
  const tokenDeltas = computeTokenDeltas(promptTokenSeries);
  const maxDelta =
    tokenDeltas.length > 0
      ? tokenDeltas.reduce((max, value) => Math.max(max, value), 0)
      : 0;
  const slope = computeSlope(promptTokenSeries);

  return {
    turns: promptTokenSeries.length,
    promptTokenSeries,
    tokenDeltas,
    maxDelta,
    slope,
  };
}

function normalizeToolTurn(
  input: PipelineToolTurnInput,
): PipelineToolTurnArtifact {
  return {
    validCases: asNonNegativeInteger(input.validCases, "toolTurn.validCases"),
    validAccepted: asNonNegativeInteger(
      input.validAccepted,
      "toolTurn.validAccepted",
    ),
    malformedCases: asNonNegativeInteger(
      input.malformedCases,
      "toolTurn.malformedCases",
    ),
    malformedRejected: asNonNegativeInteger(
      input.malformedRejected,
      "toolTurn.malformedRejected",
    ),
    malformedForwarded: asNonNegativeInteger(
      input.malformedForwarded,
      "toolTurn.malformedForwarded",
    ),
  };
}

function normalizeDesktopStability(
  input: PipelineDesktopStabilityInput,
): PipelineDesktopStabilityArtifact {
  const runSummaries = input.runSummaries.map((entry, index) => {
    assert(
      typeof entry.runId === "string",
      `desktop.runSummaries[${index}].runId must be a string`,
    );
    assert(
      typeof entry.ok === "boolean",
      `desktop.runSummaries[${index}].ok must be boolean`,
    );
    assert(
      typeof entry.timedOut === "boolean",
      `desktop.runSummaries[${index}].timedOut must be boolean`,
    );
    const durationMs = asFiniteNonNegativeNumber(
      entry.durationMs,
      `desktop.runSummaries[${index}].durationMs`,
    );
    const failedStep =
      entry.failedStep === undefined
        ? undefined
        : asInteger(
            entry.failedStep,
            `desktop.runSummaries[${index}].failedStep`,
          );
    const preview =
      entry.preview === undefined ? undefined : String(entry.preview);
    return {
      runId: entry.runId,
      ok: entry.ok,
      timedOut: entry.timedOut,
      durationMs,
      failedStep,
      preview,
    } satisfies PipelineDesktopRunArtifact;
  });

  const failedRuns = runSummaries.filter((entry) => !entry.ok).length;
  const timedOutRuns = runSummaries.filter((entry) => entry.timedOut).length;
  const maxDurationMs = runSummaries.reduce(
    (max, entry) => Math.max(max, entry.durationMs),
    0,
  );

  return {
    runs: runSummaries.length,
    failedRuns,
    timedOutRuns,
    maxDurationMs,
    runSummaries,
  };
}

function normalizeTokenEfficiency(
  input: PipelineTokenEfficiencyInput,
): PipelineTokenEfficiencyArtifact {
  const completedTasks = asNonNegativeInteger(
    input.completedTasks,
    "tokenEfficiency.completedTasks",
  );
  const totalPromptTokens = asFiniteNonNegativeNumber(
    input.totalPromptTokens,
    "tokenEfficiency.totalPromptTokens",
  );
  const totalCompletionTokens = asFiniteNonNegativeNumber(
    input.totalCompletionTokens,
    "tokenEfficiency.totalCompletionTokens",
  );
  const totalTokens = asFiniteNonNegativeNumber(
    input.totalTokens,
    "tokenEfficiency.totalTokens",
  );
  const tokensPerCompletedTask =
    completedTasks > 0 ? totalTokens / completedTasks : totalTokens;

  return {
    completedTasks,
    totalPromptTokens,
    totalCompletionTokens,
    totalTokens,
    tokensPerCompletedTask,
  };
}

function normalizeOfflineReplay(
  input: PipelineOfflineReplayInput,
): PipelineOfflineReplayArtifact {
  const fixtures = input.fixtures.map((entry, index) => {
    assert(
      typeof entry.fixtureId === "string" && entry.fixtureId.length > 0,
      `offlineReplay.fixtures[${index}].fixtureId must be a non-empty string`,
    );
    assert(
      typeof entry.ok === "boolean",
      `offlineReplay.fixtures[${index}].ok must be boolean`,
    );
    const parseError =
      entry.parseError === undefined ? undefined : String(entry.parseError);
    const replayError =
      entry.replayError === undefined ? undefined : String(entry.replayError);
    const deterministicMismatch =
      entry.deterministicMismatch === undefined
        ? undefined
        : Boolean(entry.deterministicMismatch);
    return {
      fixtureId: entry.fixtureId,
      ok: entry.ok,
      parseError,
      replayError,
      deterministicMismatch,
    } satisfies PipelineOfflineReplayFixtureArtifact;
  });

  return {
    fixtureCount: fixtures.length,
    parseFailures: fixtures.filter((entry) => Boolean(entry.parseError)).length,
    replayFailures: fixtures.filter((entry) => Boolean(entry.replayError)).length,
    deterministicMismatches: fixtures.filter(
      (entry) => entry.deterministicMismatch === true,
    ).length,
    fixtures,
  };
}

function normalizeDelegation(
  input: PipelineDelegationInput | undefined,
): PipelineDelegationArtifact {
  const normalizedInput = input ?? defaultDelegationInput();

  const totalCases = asNonNegativeInteger(
    normalizedInput.totalCases,
    "delegation.totalCases",
  );
  const delegatedCases = asNonNegativeInteger(
    normalizedInput.delegatedCases,
    "delegation.delegatedCases",
  );
  assert(
    delegatedCases <= totalCases,
    "delegation.delegatedCases must be <= delegation.totalCases",
  );

  const usefulDelegations = asNonNegativeInteger(
    normalizedInput.usefulDelegations,
    "delegation.usefulDelegations",
  );
  const harmfulDelegations = asNonNegativeInteger(
    normalizedInput.harmfulDelegations,
    "delegation.harmfulDelegations",
  );
  const unnecessaryDelegations = asNonNegativeInteger(
    normalizedInput.unnecessaryDelegations,
    "delegation.unnecessaryDelegations",
  );
  const plannerExecutionMismatches = asNonNegativeInteger(
    normalizedInput.plannerExecutionMismatches,
    "delegation.plannerExecutionMismatches",
  );
  const childTimeouts = asNonNegativeInteger(
    normalizedInput.childTimeouts,
    "delegation.childTimeouts",
  );
  const childFailures = asNonNegativeInteger(
    normalizedInput.childFailures,
    "delegation.childFailures",
  );
  const synthesisConflicts = asNonNegativeInteger(
    normalizedInput.synthesisConflicts,
    "delegation.synthesisConflicts",
  );
  const depthCapHits = asNonNegativeInteger(
    normalizedInput.depthCapHits,
    "delegation.depthCapHits",
  );
  const fanoutCapHits = asNonNegativeInteger(
    normalizedInput.fanoutCapHits,
    "delegation.fanoutCapHits",
  );

  for (const [metric, value] of [
    ["usefulDelegations", usefulDelegations],
    ["harmfulDelegations", harmfulDelegations],
    ["unnecessaryDelegations", unnecessaryDelegations],
    ["plannerExecutionMismatches", plannerExecutionMismatches],
    ["childTimeouts", childTimeouts],
    ["childFailures", childFailures],
    ["synthesisConflicts", synthesisConflicts],
    ["depthCapHits", depthCapHits],
    ["fanoutCapHits", fanoutCapHits],
  ] as const) {
    assert(
      value <= delegatedCases,
      `delegation.${metric} must be <= delegation.delegatedCases`,
    );
  }

  const baselineScenarioId = String(normalizedInput.baselineScenarioId ?? "");
  assert(
    baselineScenarioId.length > 0,
    "delegation.baselineScenarioId must be a non-empty string",
  );
  const k = asNonNegativeInteger(normalizedInput.k, "delegation.k");
  assert(k > 0, "delegation.k must be >= 1");

  const scenarioSummaries = normalizedInput.scenarioSummaries.map(
    (entry, index) => {
      assert(
        typeof entry.scenarioId === "string" && entry.scenarioId.length > 0,
        `delegation.scenarioSummaries[${index}].scenarioId must be a non-empty string`,
      );
      assert(
        entry.mode === "no_delegation" ||
          entry.mode === "single_child" ||
          entry.mode === "parallel_children" ||
          entry.mode === "handoff" ||
          entry.mode === "verifier_retry",
        `delegation.scenarioSummaries[${index}].mode must be a valid scenario mode`,
      );
      return {
        scenarioId: entry.scenarioId,
        mode: entry.mode,
        runCount: asNonNegativeInteger(
          entry.runCount,
          `delegation.scenarioSummaries[${index}].runCount`,
        ),
        passRate: asRate(
          entry.passRate,
          `delegation.scenarioSummaries[${index}].passRate`,
        ),
        passAtK: asRate(
          entry.passAtK,
          `delegation.scenarioSummaries[${index}].passAtK`,
        ),
        passCaretK: asRate(
          entry.passCaretK,
          `delegation.scenarioSummaries[${index}].passCaretK`,
        ),
        meanLatencyMs: asFiniteNonNegativeNumber(
          entry.meanLatencyMs,
          `delegation.scenarioSummaries[${index}].meanLatencyMs`,
        ),
        meanCostUnits: asFiniteNonNegativeNumber(
          entry.meanCostUnits,
          `delegation.scenarioSummaries[${index}].meanCostUnits`,
        ),
        passAtKDeltaVsBaseline: asFiniteNumber(
          entry.passAtKDeltaVsBaseline,
          `delegation.scenarioSummaries[${index}].passAtKDeltaVsBaseline`,
        ),
        passCaretKDeltaVsBaseline: asFiniteNumber(
          entry.passCaretKDeltaVsBaseline,
          `delegation.scenarioSummaries[${index}].passCaretKDeltaVsBaseline`,
        ),
      } satisfies PipelineDelegationScenarioArtifact;
    },
  );

  const delegationAttemptRate = safeRatio(delegatedCases, totalCases);

  return {
    totalCases,
    delegatedCases,
    usefulDelegations,
    harmfulDelegations,
    unnecessaryDelegations,
    plannerExecutionMismatches,
    childTimeouts,
    childFailures,
    synthesisConflicts,
    depthCapHits,
    fanoutCapHits,
    delegationAttemptRate,
    usefulDelegationRate: safeRatio(usefulDelegations, delegatedCases),
    harmfulDelegationRate: safeRatio(harmfulDelegations, delegatedCases),
    plannerToExecutionMismatchRate: safeRatio(
      plannerExecutionMismatches,
      delegatedCases,
    ),
    childTimeoutRate: safeRatio(childTimeouts, delegatedCases),
    childFailureRate: safeRatio(childFailures, delegatedCases),
    synthesisConflictRate: safeRatio(synthesisConflicts, delegatedCases),
    depthCapHitRate: safeRatio(depthCapHits, delegatedCases),
    fanoutCapHitRate: safeRatio(fanoutCapHits, delegatedCases),
    costDeltaVsBaseline: asFiniteNumber(
      normalizedInput.costDeltaVsBaseline,
      "delegation.costDeltaVsBaseline",
    ),
    latencyDeltaVsBaseline: asFiniteNumber(
      normalizedInput.latencyDeltaVsBaseline,
      "delegation.latencyDeltaVsBaseline",
    ),
    qualityDeltaVsBaseline: asFiniteNumber(
      normalizedInput.qualityDeltaVsBaseline,
      "delegation.qualityDeltaVsBaseline",
    ),
    passAtKDeltaVsBaseline: asFiniteNumber(
      normalizedInput.passAtKDeltaVsBaseline,
      "delegation.passAtKDeltaVsBaseline",
    ),
    passCaretKDeltaVsBaseline: asFiniteNumber(
      normalizedInput.passCaretKDeltaVsBaseline,
      "delegation.passCaretKDeltaVsBaseline",
    ),
    baselineScenarioId,
    k,
    scenarioSummaries,
  };
}

function normalizeOrchestrationBaseline(
  input: PipelineOrchestrationBaselineInput | undefined,
): PipelineOrchestrationBaselineArtifact {
  const scenarios = (input?.scenarios ?? []).map((entry, index) => {
    assert(
      typeof entry.scenarioId === "string" && entry.scenarioId.length > 0,
      `orchestrationBaseline.scenarios[${index}].scenarioId must be a non-empty string`,
    );
    assert(
      typeof entry.title === "string" && entry.title.length > 0,
      `orchestrationBaseline.scenarios[${index}].title must be a non-empty string`,
    );
    assert(
      typeof entry.category === "string" && entry.category.length > 0,
      `orchestrationBaseline.scenarios[${index}].category must be a non-empty string`,
    );
    assert(
      typeof entry.sourceTraceId === "string" && entry.sourceTraceId.length > 0,
      `orchestrationBaseline.scenarios[${index}].sourceTraceId must be a non-empty string`,
    );
    assert(
      typeof entry.passed === "boolean",
      `orchestrationBaseline.scenarios[${index}].passed must be boolean`,
    );
    assert(
      typeof entry.finalStatus === "string" && entry.finalStatus.length > 0,
      `orchestrationBaseline.scenarios[${index}].finalStatus must be a non-empty string`,
    );
    return {
      scenarioId: entry.scenarioId,
      title: entry.title,
      category: entry.category,
      sourceTraceId: entry.sourceTraceId,
      passed: entry.passed,
      finalStatus: entry.finalStatus,
      replayErrors: asNonNegativeInteger(
        entry.replayErrors,
        `orchestrationBaseline.scenarios[${index}].replayErrors`,
      ),
      replayWarnings: asNonNegativeInteger(
        entry.replayWarnings,
        `orchestrationBaseline.scenarios[${index}].replayWarnings`,
      ),
      policyViolations: asNonNegativeInteger(
        entry.policyViolations,
        `orchestrationBaseline.scenarios[${index}].policyViolations`,
      ),
      verifierVerdicts: asNonNegativeInteger(
        entry.verifierVerdicts,
        `orchestrationBaseline.scenarios[${index}].verifierVerdicts`,
      ),
      turns: asNonNegativeInteger(
        entry.turns,
        `orchestrationBaseline.scenarios[${index}].turns`,
      ),
      toolCalls: asNonNegativeInteger(
        entry.toolCalls,
        `orchestrationBaseline.scenarios[${index}].toolCalls`,
      ),
      fallbackCount: asNonNegativeInteger(
        entry.fallbackCount,
        `orchestrationBaseline.scenarios[${index}].fallbackCount`,
      ),
      spuriousSubagentCount: asNonNegativeInteger(
        entry.spuriousSubagentCount,
        `orchestrationBaseline.scenarios[${index}].spuriousSubagentCount`,
      ),
      approvalCount: asNonNegativeInteger(
        entry.approvalCount,
        `orchestrationBaseline.scenarios[${index}].approvalCount`,
      ),
      restartRecoverySuccess: Boolean(entry.restartRecoverySuccess),
      mismatchReasons: (entry.mismatchReasons ?? []).map((reason) =>
        String(reason)
      ),
    } satisfies PipelineOrchestrationScenarioArtifact;
  });

  const scenarioCount = scenarios.length;
  const passingScenarios = scenarios.filter((entry) => entry.passed).length;
  const restartRecoverySuccessCount = scenarios.filter(
    (entry) => entry.restartRecoverySuccess,
  ).length;

  return {
    scenarioCount,
    passingScenarios,
    passRate: safeRatio(passingScenarios, scenarioCount),
    averageTurns: mean(scenarios.map((entry) => entry.turns)),
    averageToolCalls: mean(scenarios.map((entry) => entry.toolCalls)),
    fallbackCount: scenarios.reduce(
      (sum, entry) => sum + entry.fallbackCount,
      0,
    ),
    spuriousSubagentCount: scenarios.reduce(
      (sum, entry) => sum + entry.spuriousSubagentCount,
      0,
    ),
    approvalCount: scenarios.reduce(
      (sum, entry) => sum + entry.approvalCount,
      0,
    ),
    wrongRootIncidents: scenarios.filter(
      (entry) => entry.category === "workspace_root",
    ).length,
    unsafeMutationAttempts: scenarios.filter(
      (entry) => entry.category === "ungrounded_write",
    ).length,
    approvalCorrectnessRate: safeRatio(
      scenarios.filter(
        (entry) => entry.approvalCount === 0 || entry.passed,
      ).length,
      scenarioCount,
    ),
    effectLedgerCompletenessRate: safeRatio(
      scenarios.filter((entry) => entry.passed).length,
      scenarioCount,
    ),
    restartRecoverySuccessCount,
    restartRecoverySuccessRate: safeRatio(
      restartRecoverySuccessCount,
      scenarioCount,
    ),
    scenarios,
  };
}

function normalizeLiveCoding(
  input: PipelineLiveCodingArtifact | undefined,
): PipelineLiveCodingArtifact {
  const scenarios = [...(input?.scenarios ?? [])].map((entry, index) => ({
    scenarioId: String(entry.scenarioId ?? ""),
    title: String(entry.title ?? ""),
    passed: Boolean(entry.passed),
    tempRepoPath: String(entry.tempRepoPath ?? ""),
    fileMutationCount: asNonNegativeInteger(
      entry.fileMutationCount,
      `liveCoding.scenarios[${index}].fileMutationCount`,
    ),
    shellMutationCount: asNonNegativeInteger(
      entry.shellMutationCount,
      `liveCoding.scenarios[${index}].shellMutationCount`,
    ),
    wrongRootIncident: Boolean(entry.wrongRootIncident),
    unauthorizedWriteBlocked: Boolean(entry.unauthorizedWriteBlocked),
    effectLedgerComplete: Boolean(entry.effectLedgerComplete),
    exitCode: asInteger(
      entry.exitCode,
      `liveCoding.scenarios[${index}].exitCode`,
    ),
    notes: entry.notes === undefined ? undefined : String(entry.notes),
  }));
  const passingScenarios = scenarios.filter((entry) => entry.passed).length;
  return {
    scenarioCount: scenarios.length,
    passingScenarios,
    passRate: safeRatio(passingScenarios, scenarios.length),
    tempRepoCount: scenarios.length,
    totalFileMutations: scenarios.reduce(
      (sum, entry) => sum + entry.fileMutationCount,
      0,
    ),
    totalShellMutations: scenarios.reduce(
      (sum, entry) => sum + entry.shellMutationCount,
      0,
    ),
    wrongRootIncidents: scenarios.filter((entry) => entry.wrongRootIncident).length,
    unauthorizedWriteBlocks: scenarios.filter(
      (entry) => entry.unauthorizedWriteBlocked,
    ).length,
    effectLedgerCompletenessRate: safeRatio(
      scenarios.filter((entry) => entry.effectLedgerComplete).length,
      scenarios.length,
    ),
    scenarios,
  };
}

function normalizeSafety(
  input: PipelineSafetyArtifact | undefined,
): PipelineSafetyArtifact {
  const scenarios = [...(input?.scenarios ?? [])].map((entry) => ({
    scenarioId: String(entry.scenarioId ?? ""),
    title: String(entry.title ?? ""),
    attackClass: String(entry.attackClass ?? "") as PipelineSafetyAttackClass,
    passed: Boolean(entry.passed),
    blocked: Boolean(entry.blocked),
    requiredApproval: Boolean(entry.requiredApproval),
    denied: Boolean(entry.denied),
    unsafeMutationAttempt: Boolean(entry.unsafeMutationAttempt),
    approvalCorrect: Boolean(entry.approvalCorrect),
    notes: entry.notes === undefined ? undefined : String(entry.notes),
  }));
  const passingScenarios = scenarios.filter((entry) => entry.passed).length;
  const blockedScenarios = scenarios.filter((entry) => entry.blocked).length;
  return {
    scenarioCount: scenarios.length,
    blockedScenarios,
    passingScenarios,
    passRate: safeRatio(passingScenarios, scenarios.length),
    promptInjectionBlocks: scenarios.filter(
      (entry) => entry.attackClass === "prompt_injection" && entry.blocked,
    ).length,
    maliciousRepoFileBlocks: scenarios.filter(
      (entry) => entry.attackClass === "malicious_repo_file" && entry.blocked,
    ).length,
    unsafeShellBlocks: scenarios.filter(
      (entry) => entry.attackClass === "unsafe_shell" && entry.blocked,
    ).length,
    unauthorizedArtifactWriteBlocks: scenarios.filter(
      (entry) =>
        entry.attackClass === "unauthorized_artifact_write" && entry.blocked,
    ).length,
    unsafeMutationAttempts: scenarios.filter(
      (entry) => entry.unsafeMutationAttempt,
    ).length,
    approvalCorrectnessRate: safeRatio(
      scenarios.filter((entry) => entry.approvalCorrect).length,
      scenarios.length,
    ),
    scenarios,
  };
}

function normalizeLongHorizon(
  input: PipelineLongHorizonArtifact | undefined,
): PipelineLongHorizonArtifact {
  const scenarios = [...(input?.scenarios ?? [])].map((entry, index) => ({
    scenarioId: String(entry.scenarioId ?? ""),
    title: String(entry.title ?? ""),
    category: String(entry.category ?? "") as PipelineLongHorizonScenarioCategory,
    passed: Boolean(entry.passed),
    stepCount: asNonNegativeInteger(
      entry.stepCount,
      `longHorizon.scenarios[${index}].stepCount`,
    ),
    resumed: Boolean(entry.resumed),
    compacted: Boolean(entry.compacted),
    persisted: Boolean(entry.persisted),
    restartRecoverySuccess: Boolean(entry.restartRecoverySuccess),
    notes: entry.notes === undefined ? undefined : String(entry.notes),
  }));
  const passingScenarios = scenarios.filter((entry) => entry.passed).length;
  const compactionScenarios = scenarios.filter(
    (entry) =>
      entry.category === "hundred_step" || entry.category === "compact_continue",
  );
  const persistenceScenarios = scenarios.filter(
    (entry) => entry.category === "background_persistence",
  );
  return {
    scenarioCount: scenarios.length,
    passingScenarios,
    passRate: safeRatio(passingScenarios, scenarios.length),
    hundredStepRuns: scenarios.filter((entry) => entry.category === "hundred_step").length,
    crashResumeRuns: scenarios.filter((entry) => entry.category === "crash_resume").length,
    compactContinueRuns: scenarios.filter(
      (entry) => entry.category === "compact_continue",
    ).length,
    backgroundPersistenceRuns: persistenceScenarios.length,
    restartRecoverySuccessRate: safeRatio(
      scenarios.filter((entry) => entry.restartRecoverySuccess).length,
      scenarios.length,
    ),
    compactionContinuationRate: safeRatio(
      compactionScenarios.filter((entry) => entry.passed).length,
      compactionScenarios.length,
    ),
    backgroundPersistenceRate: safeRatio(
      persistenceScenarios.filter((entry) => entry.passed).length,
      persistenceScenarios.length,
    ),
    scenarios,
  };
}

function normalizeImplementationGates(
  input: PipelineImplementationGateArtifact | undefined,
): PipelineImplementationGateArtifact {
  const scenarios = [...(input?.scenarios ?? [])].map((entry) => ({
    scenarioId: String(entry.scenarioId ?? ""),
    title: String(entry.title ?? ""),
    category: String(
      entry.category ?? "",
    ) as PipelineImplementationGateScenarioCategory,
    mandatory: Boolean(entry.mandatory),
    executionMode: String(
      entry.executionMode ?? "",
    ) as PipelineImplementationGateExecutionMode,
    passed: Boolean(entry.passed),
    falseCompleted: Boolean(entry.falseCompleted),
    observedOutcome: String(entry.observedOutcome ?? ""),
    expectedOutcome: String(entry.expectedOutcome ?? ""),
    notes: entry.notes === undefined ? undefined : String(entry.notes),
  }));
  const mandatoryScenarios = scenarios.filter((entry) => entry.mandatory);
  const passingScenarios = scenarios.filter((entry) => entry.passed).length;
  const mandatoryPassingScenarios = mandatoryScenarios.filter(
    (entry) => entry.passed,
  ).length;
  return {
    scenarioCount: scenarios.length,
    mandatoryScenarioCount: mandatoryScenarios.length,
    advisoryScenarioCount: scenarios.length - mandatoryScenarios.length,
    passingScenarios,
    passRate: safeRatio(passingScenarios, scenarios.length),
    mandatoryPassingScenarios,
    mandatoryPassRate: safeRatio(
      mandatoryPassingScenarios,
      mandatoryScenarios.length,
    ),
    falseCompletedScenarios: scenarios.filter((entry) => entry.falseCompleted)
      .length,
    scenarios,
  };
}

function normalizeDelegatedWorkspaceGates(
  input: PipelineDelegatedWorkspaceGateArtifact | undefined,
): PipelineDelegatedWorkspaceGateArtifact {
  const scenarios = [...(input?.scenarios ?? [])].map((entry) => ({
    scenarioId: String(entry.scenarioId ?? ""),
    title: String(entry.title ?? ""),
    category: String(
      entry.category ?? "",
    ) as PipelineDelegatedWorkspaceGateScenarioCategory,
    mandatory: Boolean(entry.mandatory),
    executionMode: String(
      entry.executionMode ?? "",
    ) as PipelineDelegatedWorkspaceGateExecutionMode,
    passed: Boolean(entry.passed),
    falseCompleted: Boolean(entry.falseCompleted),
    observedOutcome: String(entry.observedOutcome ?? ""),
    expectedOutcome: String(entry.expectedOutcome ?? ""),
    notes: entry.notes === undefined ? undefined : String(entry.notes),
  }));
  const mandatoryScenarios = scenarios.filter((entry) => entry.mandatory);
  const passingScenarios = scenarios.filter((entry) => entry.passed).length;
  const mandatoryPassingScenarios = mandatoryScenarios.filter(
    (entry) => entry.passed,
  ).length;
  return {
    scenarioCount: scenarios.length,
    mandatoryScenarioCount: mandatoryScenarios.length,
    advisoryScenarioCount: scenarios.length - mandatoryScenarios.length,
    passingScenarios,
    passRate: safeRatio(passingScenarios, scenarios.length),
    mandatoryPassingScenarios,
    mandatoryPassRate: safeRatio(
      mandatoryPassingScenarios,
      mandatoryScenarios.length,
    ),
    falseCompletedScenarios: scenarios.filter((entry) => entry.falseCompleted)
      .length,
    scenarios,
  };
}

function normalizeChaos(
  input: PipelineChaosArtifact | undefined,
): PipelineChaosArtifact {
  const scenarios = [...(input?.scenarios ?? [])].map((entry) => ({
    scenarioId: String(entry.scenarioId ?? ""),
    title: String(entry.title ?? ""),
    category: String(entry.category ?? "") as PipelineChaosScenarioArtifact["category"],
    passed: Boolean(entry.passed),
    runtimeMode: String(entry.runtimeMode ?? "healthy") as PipelineChaosScenarioArtifact["runtimeMode"],
    incidentCodes: Array.isArray(entry.incidentCodes)
      ? entry.incidentCodes.map((code) => String(code))
      : [],
    resumed: Boolean(entry.resumed),
    safeModeEngaged: Boolean(entry.safeModeEngaged),
    notes: entry.notes === undefined ? undefined : String(entry.notes),
  }));
  const passingScenarios = scenarios.filter((entry) => entry.passed).length;
  const providerScenarios = scenarios.filter(
    (entry) => entry.category === "provider_timeout",
  );
  const toolScenarios = scenarios.filter(
    (entry) => entry.category === "tool_timeout",
  );
  const persistenceScenarios = scenarios.filter(
    (entry) => entry.category === "persistence_failure",
  );
  const approvalStoreScenarios = scenarios.filter(
    (entry) => entry.category === "approval_store_failure",
  );
  const childRunScenarios = scenarios.filter(
    (entry) => entry.category === "child_run_crash",
  );
  const daemonRestartScenarios = scenarios.filter(
    (entry) => entry.category === "daemon_restart",
  );
  return {
    scenarioCount: scenarios.length,
    passingScenarios,
    passRate: safeRatio(passingScenarios, scenarios.length),
    providerTimeoutRecoveryRate: safeRatio(
      providerScenarios.filter((entry) => entry.passed).length,
      providerScenarios.length,
    ),
    toolTimeoutContainmentRate: safeRatio(
      toolScenarios.filter((entry) => entry.passed).length,
      toolScenarios.length,
    ),
    persistenceSafeModeRate: safeRatio(
      persistenceScenarios.filter((entry) => entry.safeModeEngaged).length,
      persistenceScenarios.length,
    ),
    approvalStoreSafeModeRate: safeRatio(
      approvalStoreScenarios.filter((entry) => entry.safeModeEngaged).length,
      approvalStoreScenarios.length,
    ),
    childRunCrashContainmentRate: safeRatio(
      childRunScenarios.filter((entry) => entry.passed).length,
      childRunScenarios.length,
    ),
    daemonRestartRecoveryRate: safeRatio(
      daemonRestartScenarios.filter((entry) => entry.passed).length,
      daemonRestartScenarios.length,
    ),
    scenarios,
  };
}

/**
 * Build normalized pipeline-quality artifact with derived rollups.
 */
export function buildPipelineQualityArtifact(
  input: PipelineQualityArtifactInput,
): PipelineQualityArtifact {
  assert(
    typeof input.runId === "string" && input.runId.length > 0,
    "runId must be a non-empty string",
  );
  const generatedAtMs = asFiniteNonNegativeNumber(
    input.generatedAtMs,
    "generatedAtMs",
  );

  return {
    schemaVersion: PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION,
    runId: input.runId,
    generatedAtMs,
    contextGrowth: normalizeContextGrowth(input.contextGrowth),
    toolTurn: normalizeToolTurn(input.toolTurn),
    desktopStability: normalizeDesktopStability(input.desktopStability),
    tokenEfficiency: normalizeTokenEfficiency(input.tokenEfficiency),
    offlineReplay: normalizeOfflineReplay(input.offlineReplay),
    delegation: normalizeDelegation(input.delegation),
    orchestrationBaseline: normalizeOrchestrationBaseline(
      input.orchestrationBaseline,
    ),
    liveCoding: normalizeLiveCoding(input.liveCoding),
    safety: normalizeSafety(input.safety),
    longHorizon: normalizeLongHorizon(input.longHorizon),
    implementationGates: normalizeImplementationGates(
      input.implementationGates,
    ),
    delegatedWorkspaceGates: normalizeDelegatedWorkspaceGates(
      input.delegatedWorkspaceGates,
    ),
    chaos: normalizeChaos(input.chaos),
    economics: normalizeEconomics(input.economics),
  };
}

/**
 * Parse and validate a pipeline-quality artifact object.
 */
export function parsePipelineQualityArtifact(
  value: unknown,
): PipelineQualityArtifact {
  assert(isRecord(value), "pipeline quality artifact must be an object");

  const schemaVersion = asInteger(value.schemaVersion, "schemaVersion");
  assert(
    schemaVersion === LEGACY_PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION ||
      schemaVersion === PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V2 ||
      schemaVersion === PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V3 ||
      schemaVersion === PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V4 ||
      schemaVersion === PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V5 ||
      schemaVersion === PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V6 ||
      schemaVersion === PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V7 ||
      schemaVersion === PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION,
    `unsupported pipeline quality schema version: ${String(value.schemaVersion)}`,
  );

  const delegationSource = isRecord(value.delegation)
    ? value.delegation
    : undefined;

  return buildPipelineQualityArtifact({
    runId: String(value.runId ?? ""),
    generatedAtMs: asFiniteNonNegativeNumber(value.generatedAtMs, "generatedAtMs"),
    contextGrowth: {
      promptTokenSeries: parseNumberArray(
        (value.contextGrowth as Record<string, unknown>)?.promptTokenSeries,
        "contextGrowth.promptTokenSeries",
      ),
    },
    toolTurn: {
      validCases: asInteger(
        (value.toolTurn as Record<string, unknown>)?.validCases,
        "toolTurn.validCases",
      ),
      validAccepted: asInteger(
        (value.toolTurn as Record<string, unknown>)?.validAccepted,
        "toolTurn.validAccepted",
      ),
      malformedCases: asInteger(
        (value.toolTurn as Record<string, unknown>)?.malformedCases,
        "toolTurn.malformedCases",
      ),
      malformedRejected: asInteger(
        (value.toolTurn as Record<string, unknown>)?.malformedRejected,
        "toolTurn.malformedRejected",
      ),
      malformedForwarded: asInteger(
        (value.toolTurn as Record<string, unknown>)?.malformedForwarded,
        "toolTurn.malformedForwarded",
      ),
    },
    desktopStability: {
      runSummaries: ((value.desktopStability as Record<string, unknown>)
        ?.runSummaries ?? []) as PipelineDesktopRunArtifact[],
    },
    tokenEfficiency: {
      completedTasks: asInteger(
        (value.tokenEfficiency as Record<string, unknown>)?.completedTasks,
        "tokenEfficiency.completedTasks",
      ),
      totalPromptTokens: asFiniteNonNegativeNumber(
        (value.tokenEfficiency as Record<string, unknown>)?.totalPromptTokens,
        "tokenEfficiency.totalPromptTokens",
      ),
      totalCompletionTokens: asFiniteNonNegativeNumber(
        (value.tokenEfficiency as Record<string, unknown>)?.totalCompletionTokens,
        "tokenEfficiency.totalCompletionTokens",
      ),
      totalTokens: asFiniteNonNegativeNumber(
        (value.tokenEfficiency as Record<string, unknown>)?.totalTokens,
        "tokenEfficiency.totalTokens",
      ),
    },
    offlineReplay: {
      fixtures: ((value.offlineReplay as Record<string, unknown>)?.fixtures ??
        []) as PipelineOfflineReplayFixtureArtifact[],
    },
    delegation:
      schemaVersion === LEGACY_PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION
        ? undefined
        : {
            totalCases: asNonNegativeInteger(
              delegationSource?.totalCases ?? 0,
              "delegation.totalCases",
            ),
            delegatedCases: asNonNegativeInteger(
              delegationSource?.delegatedCases ?? 0,
              "delegation.delegatedCases",
            ),
            usefulDelegations: asNonNegativeInteger(
              delegationSource?.usefulDelegations ?? 0,
              "delegation.usefulDelegations",
            ),
            harmfulDelegations: asNonNegativeInteger(
              delegationSource?.harmfulDelegations ?? 0,
              "delegation.harmfulDelegations",
            ),
            unnecessaryDelegations: asNonNegativeInteger(
              delegationSource?.unnecessaryDelegations ?? 0,
              "delegation.unnecessaryDelegations",
            ),
            plannerExecutionMismatches: asNonNegativeInteger(
              delegationSource?.plannerExecutionMismatches ?? 0,
              "delegation.plannerExecutionMismatches",
            ),
            childTimeouts: asNonNegativeInteger(
              delegationSource?.childTimeouts ?? 0,
              "delegation.childTimeouts",
            ),
            childFailures: asNonNegativeInteger(
              delegationSource?.childFailures ?? 0,
              "delegation.childFailures",
            ),
            synthesisConflicts: asNonNegativeInteger(
              delegationSource?.synthesisConflicts ?? 0,
              "delegation.synthesisConflicts",
            ),
            depthCapHits: asNonNegativeInteger(
              delegationSource?.depthCapHits ?? 0,
              "delegation.depthCapHits",
            ),
            fanoutCapHits: asNonNegativeInteger(
              delegationSource?.fanoutCapHits ?? 0,
              "delegation.fanoutCapHits",
            ),
            costDeltaVsBaseline: asFiniteNumber(
              delegationSource?.costDeltaVsBaseline ?? 0,
              "delegation.costDeltaVsBaseline",
            ),
            latencyDeltaVsBaseline: asFiniteNumber(
              delegationSource?.latencyDeltaVsBaseline ?? 0,
              "delegation.latencyDeltaVsBaseline",
            ),
            qualityDeltaVsBaseline: asFiniteNumber(
              delegationSource?.qualityDeltaVsBaseline ?? 0,
              "delegation.qualityDeltaVsBaseline",
            ),
            passAtKDeltaVsBaseline: asFiniteNumber(
              delegationSource?.passAtKDeltaVsBaseline ?? 0,
              "delegation.passAtKDeltaVsBaseline",
            ),
            passCaretKDeltaVsBaseline: asFiniteNumber(
              delegationSource?.passCaretKDeltaVsBaseline ?? 0,
              "delegation.passCaretKDeltaVsBaseline",
            ),
            baselineScenarioId: String(
              delegationSource?.baselineScenarioId ?? "baseline_no_delegation",
            ),
            k: asNonNegativeInteger(delegationSource?.k ?? 1, "delegation.k"),
            scenarioSummaries: (delegationSource?.scenarioSummaries ??
              []) as PipelineDelegationScenarioInput[],
          },
    orchestrationBaseline:
      schemaVersion >= PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V3
        ? {
            scenarios: (((value.orchestrationBaseline as Record<string, unknown>)
              ?.scenarios ??
              []) as PipelineOrchestrationScenarioInput[]),
          }
        : undefined,
    liveCoding:
      schemaVersion >= PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V6
        ? ((value.liveCoding as unknown) as
            | PipelineLiveCodingArtifact
            | undefined)
        : undefined,
    safety:
      schemaVersion >= PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V4
        ? ((value.safety as unknown) as
            | PipelineSafetyArtifact
            | undefined)
        : undefined,
    longHorizon:
      schemaVersion >= PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V4
        ? ((value.longHorizon as unknown) as
            | PipelineLongHorizonArtifact
            | undefined)
        : undefined,
    implementationGates:
      schemaVersion >= PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V7
        ? ((value.implementationGates as unknown) as
            | PipelineImplementationGateArtifact
            | undefined)
        : undefined,
    delegatedWorkspaceGates:
      schemaVersion >= PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION
        ? ((value.delegatedWorkspaceGates as unknown) as
            | PipelineDelegatedWorkspaceGateArtifact
            | undefined)
        : undefined,
    chaos:
      schemaVersion >= PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V5
        ? ((value.chaos as unknown) as
            | PipelineChaosArtifact
            | undefined)
        : undefined,
    economics:
      schemaVersion >= PIPELINE_QUALITY_ARTIFACT_SCHEMA_VERSION_V6
        ? ((value.economics as unknown) as EconomicsScorecard | undefined)
        : undefined,
  });
}

/**
 * Stable JSON serialization for pipeline-quality artifacts.
 */
export function serializePipelineQualityArtifact(
  artifact: PipelineQualityArtifact,
): string {
  return stableStringifyJson(artifact as unknown as JsonValue);
}
