import type { WorkflowGraphEdge } from "../workflow/types.js";
import type { ExecuteWithAgentInput } from "./delegation-tool.js";
import type { DelegationBudgetSnapshot } from "../llm/run-budget.js";
import { estimateDelegationStepSpendUnits } from "../llm/model-routing-policy.js";
import { hasRuntimeLimit } from "../llm/runtime-limit-policy.js";
import {
  allowsUserMandatedSubagentCardinalityOverride,
  extractRequiredSubagentOrchestrationRequirements,
} from "../workflow/subagent-orchestration-requirements.js";
import {
  deriveDelegationEconomics,
  type DelegationCandidateStep,
  type DelegationEconomics,
  type DelegationStepAnalysis,
} from "./delegation-economics.js";
import {
  resolveExecutionEnvelopeArtifactRelations,
  resolveExecutionEnvelopeRole,
} from "../workflow/execution-envelope.js";
import { safeStepStringArray } from "../llm/chat-executor-planner.js";

const REVIEW_TEXT_RE =
  /\b(?:review|critique|audit|inspect|assess|evaluate|docs?|documentation|security|architecture)\b/i;
const EXPLORATION_TEXT_RE =
  /\b(?:explore|inventory|map|locate|find|trace|survey|catalog|understand|investigate|inspect|review|audit|research|analy[sz]e)\b/i;
const TEST_TRIAGE_TEXT_RE =
  /\b(?:test|tests|ci|failure|failures|failing|flaky|error|errors|stack\s+trace|logs?)\b/i;
const BUILD_OR_TEST_OBLIGATION_RE =
  /\b(?:build|compile|typecheck|lint|test|tests|pytest|vitest|cargo test|npm run|pnpm|yarn)\b/i;
const LOCAL_INSPECTION_TEXT_RE =
  /\b(?:catalog|check|explore|find|git status|inspect|inventory|list|locate|ls|map|read|readme|review|status|survey|trace|understand)\b/i;

export type DelegationAdmissionShape =
  | "repo_exploration"
  | "test_triage"
  | "independent_parallel_branches"
  | "bounded_sequential_handoff";

export type DelegationAdmissionReason =
  | "no_subagent_steps"
  | "trivial_request"
  | "single_hop_request"
  | "shared_context_review"
  | "shared_artifact_writer_inline"
  | "fanout_exceeded"
  | "depth_exceeded"
  | "missing_execution_envelope"
  | "parallel_gain_insufficient"
  | "dependency_coupling_high"
  | "tool_overlap_high"
  | "verifier_cost_high"
  | "retry_cost_high"
  | "negative_economics"
  | "no_safe_delegation_shape"
  | "score_below_threshold"
  | "approved";

export interface DelegationStepAdmission {
  readonly stepName: string;
  readonly shape: DelegationAdmissionShape | null;
  readonly isolationReason: string;
  readonly ownedArtifacts: readonly string[];
  readonly verifierObligations: readonly string[];
}

export interface DelegationAdmissionDecision {
  readonly allowed: boolean;
  readonly reason: DelegationAdmissionReason;
  readonly shape: DelegationAdmissionShape | null;
  readonly economics: DelegationEconomics;
  readonly stepAdmissions: readonly DelegationStepAdmission[];
  readonly diagnostics: Readonly<Record<string, number | boolean | string>>;
}

export interface DelegationAdmissionInput {
  readonly messageText: string;
  readonly totalSteps: number;
  readonly synthesisSteps: number;
  readonly steps: readonly DelegationCandidateStep[];
  readonly edges: readonly WorkflowGraphEdge[];
  readonly threshold: number;
  readonly maxFanoutPerTurn: number;
  readonly maxDepth: number;
  readonly explicitDelegationRequested?: boolean;
  readonly budgetSnapshot?: DelegationBudgetSnapshot;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function countWords(value: string): number {
  return value.trim().split(/\s+/u).filter(Boolean).length;
}

function isSharedContextReadOnlyReview(
  input: DelegationAdmissionInput,
  economics: DelegationEconomics,
): boolean {
  if (input.explicitDelegationRequested === true) {
    return false;
  }
  if (
    input.steps.length === 0 ||
    input.steps.length > 4 ||
    input.synthesisSteps > 1
  ) {
    return false;
  }
  if (!REVIEW_TEXT_RE.test(input.messageText)) return false;
  if (economics.stepAnalyses.some((analysis) => analysis.mutable)) return false;
  if (economics.stepAnalyses.some((analysis) => analysis.shellObservationOnly)) {
    return false;
  }
  const first = economics.stepAnalyses[0];
  if (!first) return false;
  const sharedArtifacts = collectSharedReviewArtifacts(first);
  if (sharedArtifacts.length === 0) return false;
  return economics.stepAnalyses.slice(1).every((analysis) => {
    const analysisArtifacts = collectSharedReviewArtifacts(analysis);
    return analysisArtifacts.some((artifact) => sharedArtifacts.includes(artifact));
  });
}

function collectPrimaryOwnedArtifacts(
  analysis: DelegationStepAnalysis,
): readonly string[] {
  return analysis.ownedArtifacts;
}

function hasSingleWriterReadOnlyReviewerHandoff(
  analyses: readonly DelegationStepAnalysis[],
): boolean {
  const writers = analyses.filter((analysis) => analysis.mutable);
  if (writers.length !== 1) {
    return false;
  }
  const [writer] = writers;
  if (!writer || writer.ownedArtifacts.length === 0) {
    return false;
  }
  const writerArtifacts = new Set(writer.ownedArtifacts);
  let readOnlyReviewerCount = 0;
  for (const analysis of analyses) {
    if (analysis.step.name === writer.step.name) {
      continue;
    }
    if (!analysis.readOnly && !analysis.shellObservationOnly) {
      return false;
    }
    if (analysis.ownedArtifacts.length > 0) {
      return false;
    }
    if (
      !analysis.referencedArtifacts.some((artifact) =>
        writerArtifacts.has(artifact)
      )
    ) {
      return false;
    }
    readOnlyReviewerCount += 1;
  }
  return readOnlyReviewerCount > 0;
}

function hasSingleMutableOwnerHandoff(
  analyses: readonly DelegationStepAnalysis[],
): boolean {
  if (analyses.length === 0) {
    return false;
  }
  const mutable = analyses.filter((analysis) => analysis.mutable);
  if (mutable.length !== 1) {
    return false;
  }
  const [analysis] = mutable;
  if (!analysis || analysis.readOnly || analysis.shellObservationOnly) {
    return false;
  }
  const hasOwnedScope =
    analysis.ownedArtifacts.length > 0 ||
    Boolean(analysis.step.executionContext?.workspaceRoot);
  if (!hasOwnedScope) {
    return false;
  }
  return analyses.every((candidate) =>
    candidate.step.name === analysis.step.name ||
    candidate.readOnly ||
    candidate.shellObservationOnly
  );
}

function collectSharedReviewArtifacts(
  analysis: DelegationStepAnalysis,
): readonly string[] {
  const context = analysis.step.executionContext;
  return [
    ...analysis.ownedArtifacts,
    ...analysis.referencedArtifacts,
    ...(context?.requiredSourceArtifacts ?? []),
    ...(context?.inputArtifacts ?? []),
    ...(context?.targetArtifacts ?? []),
  ].filter((artifact, index, artifacts) => artifacts.indexOf(artifact) === index);
}
function detectSharedArtifactWriterInline(
  economics: DelegationEconomics,
): {
  readonly artifact: string;
  readonly mutableStepNames: readonly string[];
  readonly readOnlyStepNames: readonly string[];
} | undefined {
  const artifactOwners = new Map<
    string,
    {
      mutable: Set<string>;
      readOnly: Set<string>;
    }
  >();

  for (const analysis of economics.stepAnalyses) {
    const artifacts = collectPrimaryOwnedArtifacts(analysis);
    if (artifacts.length === 0) {
      continue;
    }
    for (const artifact of artifacts) {
      const entry = artifactOwners.get(artifact) ?? {
        mutable: new Set<string>(),
        readOnly: new Set<string>(),
      };
      if (analysis.mutable) {
        entry.mutable.add(analysis.step.name);
      } else if (analysis.readOnly || analysis.shellObservationOnly) {
        entry.readOnly.add(analysis.step.name);
      }
      artifactOwners.set(artifact, entry);
    }
  }

  for (const [artifact, owners] of artifactOwners.entries()) {
    if (owners.mutable.size >= 2) {
      // Check if the mutable steps form a sequential dependency chain.
      // Sequential writers (A → B → C) are safe handoffs, not concurrent
      // conflicts.  Only flag truly concurrent (parallel) shared writers.
      if (isSequentialDependencyChain(owners.mutable, economics.stepAnalyses)) {
        continue;
      }
      return {
        artifact,
        mutableStepNames: [...owners.mutable],
        readOnlyStepNames: [...owners.readOnly],
      };
    }
    if (owners.mutable.size === 1 && owners.readOnly.size > 0) {
      // A single writer with read-only reviewers is a safe handoff pattern
      // (writer → reviewer), not a conflict.
      continue;
    }
  }

  return undefined;
}

function isSequentialDependencyChain(
  stepNames: ReadonlySet<string>,
  stepAnalyses: readonly DelegationStepAnalysis[],
): boolean {
  if (stepNames.size <= 1) return true;
  const names = [...stepNames];
  const stepMap = new Map(
    stepAnalyses.map((analysis) => [analysis.step.name, analysis.step]),
  );
  // Check if every pair of mutable steps has a dependency relationship
  // (one depends on the other, directly or transitively).
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const stepA = stepMap.get(names[i]!);
      const stepB = stepMap.get(names[j]!);
      if (!stepA || !stepB) return false;
      const aDepB = (stepA.dependsOn ?? []).includes(names[j]!);
      const bDepA = (stepB.dependsOn ?? []).includes(names[i]!);
      if (!aDepB && !bDepA) return false;
    }
  }
  return true;
}

function isIsolatedSingleStep(
  economics: DelegationEconomics,
): boolean {
  const analysis = economics.stepAnalyses[0];
  if (!analysis) return false;
  if (analysis.ownedArtifacts.length > 0) return true;
  const context = analysis.step.executionContext;
  if (analysis.mutable && context?.workspaceRoot) return true;
  return Boolean(
    context &&
      (
        (context.targetArtifacts?.length ?? 0) > 0 ||
        (context.requiredSourceArtifacts?.length ?? 0) > 0 ||
        (context.inputArtifacts?.length ?? 0) > 0
      ),
  );
}

function isParentSafeReadOnlyInspection(
  input: DelegationAdmissionInput,
  economics: DelegationEconomics,
  _shape: DelegationAdmissionShape | null,
): boolean {
  if (input.explicitDelegationRequested === true) {
    return false;
  }
  if (input.steps.length !== 1) return false;
  const analysis = economics.stepAnalyses[0];
  if (!analysis) return false;
  if (!analysis.readOnly && !analysis.shellObservationOnly) {
    return false;
  }
  if (analysis.mutable) return false;
  const executionContext = analysis.step.executionContext;
  if ((executionContext?.targetArtifacts?.length ?? 0) > 0) {
    return false;
  }
  if (economics.parallelizableCount > 1 || economics.parallelGain >= 0.35) {
    return false;
  }
  const contractText = [
    input.messageText,
    analysis.step.objective,
    analysis.step.inputContract,
    ...safeStepStringArray(analysis.step.acceptanceCriteria),
  ]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .join(" ");
  if (!LOCAL_INSPECTION_TEXT_RE.test(contractText)) {
    return false;
  }
  return true;
}

function detectShape(
  input: DelegationAdmissionInput,
  economics: DelegationEconomics,
): DelegationAdmissionShape | null {
  const analyses = economics.stepAnalyses;
  const allReadOnly = analyses.every((analysis) =>
    analysis.readOnly || analysis.shellObservationOnly
  );
  const parallelizable = economics.parallelizableCount;
  const explorationRequested = matchesDelegationIntent(
    input,
    analyses,
    EXPLORATION_TEXT_RE,
  );
  const testTriageRequested = matchesDelegationIntent(
    input,
    analyses,
    TEST_TRIAGE_TEXT_RE,
  );
  if (input.steps.length === 1) {
    const only = analyses[0];
    if (
      only &&
      allReadOnly &&
      (explorationRequested || testTriageRequested)
    ) {
      return testTriageRequested
        ? "test_triage"
        : "repo_exploration";
    }
    if (only && only.mutable && isIsolatedSingleStep(economics)) {
      return "bounded_sequential_handoff";
    }
  }
  if (
    allReadOnly &&
    explorationRequested &&
    (
      parallelizable >= 2 ||
      input.explicitDelegationRequested === true ||
      (input.steps.length <= 3 && economics.dependencyCoupling <= 0.55)
    )
  ) {
    return "repo_exploration";
  }
  if (
    allReadOnly &&
    testTriageRequested &&
    (
      parallelizable >= 2 ||
      input.explicitDelegationRequested === true ||
      (input.steps.length <= 3 && economics.dependencyCoupling <= 0.55)
    )
  ) {
    return "test_triage";
  }
  if (
    input.steps.length >= 2 &&
    input.steps.length <= 6 &&
    hasSingleWriterReadOnlyReviewerHandoff(analyses) &&
    economics.dependencyDepth <= Math.max(3, input.maxDepth * 2) &&
    economics.dependencyCoupling <= 0.72
  ) {
    return "bounded_sequential_handoff";
  }
  if (
    parallelizable >= 2 &&
    economics.explicitOwnershipCoverage >= 0.75 &&
    economics.ownershipOverlap <= 0.2 &&
    economics.dependencyCoupling <= 0.45
  ) {
    return "independent_parallel_branches";
  }
  if (
    input.steps.length >= 2 &&
    input.steps.length <= 6 &&
    economics.explicitOwnershipCoverage >= 0.75 &&
    economics.ownershipOverlap <= 0.2 &&
    economics.dependencyDepth <= Math.max(3, input.maxDepth * 2) &&
    economics.dependencyCoupling <= 0.65 &&
    economics.parallelizableCount <= 1
  ) {
    return "bounded_sequential_handoff";
  }
  return null;
}

function matchesDelegationIntent(
  input: DelegationAdmissionInput,
  analyses: readonly DelegationStepAnalysis[],
  matcher: RegExp,
): boolean {
  if (matcher.test(input.messageText)) {
    return true;
  }
  return analyses.some((analysis) => {
    const acceptanceText = safeStepStringArray(analysis.step.acceptanceCriteria).join(" ");
    const executionText = [
      analysis.step.name,
      analysis.step.objective,
      analysis.step.inputContract,
      acceptanceText,
      analysis.step.executionContext?.verificationMode ?? "",
    ]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join(" ");
    return matcher.test(executionText);
  });
}

function buildVerifierObligations(
  analysis: DelegationStepAnalysis,
): readonly string[] {
  const obligations: string[] = [];
  const context = analysis.step.executionContext;
  if ((context?.requiredSourceArtifacts?.length ?? 0) > 0) {
    obligations.push("Inspect the declared required source artifacts before claiming derived output.");
  }
  if ((context?.targetArtifacts?.length ?? 0) > 0) {
    obligations.push(
      `Limit authored artifacts to: ${context!.targetArtifacts!.join(", ")}.`,
    );
  }
  if (context?.verificationMode === "grounded_read") {
    obligations.push("Cite grounded read evidence from the inspected artifacts.");
  }
  if (context?.verificationMode === "mutation_required") {
    obligations.push("Return concrete mutation evidence for the owned target artifacts.");
  }
  if (context?.verificationMode === "deterministic_followup") {
    obligations.push("Run or cite deterministic follow-up verification for the owned artifacts.");
  }
  if (
    safeStepStringArray(analysis.step.acceptanceCriteria).some((criterion) =>
      BUILD_OR_TEST_OBLIGATION_RE.test(criterion)
    )
  ) {
    obligations.push("Report the observed build/test command output required by the acceptance criteria.");
  }
  if (obligations.length === 0) {
    obligations.push("Return only claims grounded in the delegated phase's own tool evidence.");
  }
  return obligations.filter((item, index, items) => items.indexOf(item) === index);
}

function buildIsolationReason(
  shape: DelegationAdmissionShape | null,
  analysis: DelegationStepAnalysis,
): string {
  const ownedArtifacts = analysis.ownedArtifacts.length > 0
    ? analysis.ownedArtifacts.join(", ")
    : analysis.referencedArtifacts.length > 0
    ? analysis.referencedArtifacts.join(", ")
    : (analysis.step.executionContext?.workspaceRoot ?? analysis.step.name);
  switch (shape) {
    case "repo_exploration":
      return `This child owns read-only repository exploration scoped to ${ownedArtifacts}.`;
    case "test_triage":
      return `This child owns failure triage for ${ownedArtifacts} and must return evidence only, not edits.`;
    case "independent_parallel_branches":
      return `This child owns a disjoint branch of work scoped to ${ownedArtifacts}, separate from sibling artifact sets.`;
    case "bounded_sequential_handoff":
      if (ownsRemainingRequestEndToEnd(analysis)) {
        return `This child owns the remaining request end to end inside ${ownedArtifacts} after its declared dependencies complete.`;
      }
      return `This child owns a bounded handoff phase scoped to ${ownedArtifacts} after its declared dependencies complete.`;
    default:
      return `This child owns work scoped to ${ownedArtifacts}.`;
  }
}

function ownsRemainingRequestEndToEnd(
  analysis: DelegationStepAnalysis,
): boolean {
  const executionContext = analysis.step.executionContext;
  const workspaceRoot = executionContext?.workspaceRoot?.trim();
  const role = resolveExecutionEnvelopeRole(executionContext);
  if (!workspaceRoot || role !== "writer") {
    return false;
  }
  const artifactRelations = resolveExecutionEnvelopeArtifactRelations(
    executionContext,
  );
  const ownsWorkspaceRoot = artifactRelations.some((relation) =>
    relation.relationType === "write_owner" &&
      relation.artifactPath.trim() === workspaceRoot
  ) || (executionContext?.targetArtifacts ?? []).some((artifactPath) =>
    artifactPath.trim() === workspaceRoot
  );
  if (!ownsWorkspaceRoot) {
    return false;
  }
  const combinedText = [
    analysis.step.name,
    analysis.step.objective,
    analysis.step.inputContract,
    ...safeStepStringArray(analysis.step.acceptanceCriteria),
  ]
    .join(" ")
    .toLowerCase();
  return (
    analysis.step.name.trim().toLowerCase() === "implement_owner" ||
    /\b(?:end to end|every phase|all phases|sequentially in full|requested implementation phases|full request)\b/i
      .test(combinedText)
  );
}

export function buildDelegationStepAdmission(params: {
  readonly analysis: DelegationStepAnalysis;
  readonly shape: DelegationAdmissionShape | null;
}): DelegationStepAdmission {
  return {
    stepName: params.analysis.step.name,
    shape: params.shape,
    isolationReason: buildIsolationReason(params.shape, params.analysis),
    ownedArtifacts: params.analysis.ownedArtifacts,
    verifierObligations: buildVerifierObligations(params.analysis),
  };
}

function buildDecision(
  input: {
    readonly allowed: boolean;
    readonly reason: DelegationAdmissionReason;
    readonly shape: DelegationAdmissionShape | null;
    readonly economics: DelegationEconomics;
    readonly stepAdmissions: readonly DelegationStepAdmission[];
    readonly diagnostics?: Readonly<Record<string, number | boolean | string>>;
  },
): DelegationAdmissionDecision {
  return {
    allowed: input.allowed,
    reason: input.reason,
    shape: input.shape,
    economics: input.economics,
    stepAdmissions: input.stepAdmissions,
    diagnostics: input.diagnostics ?? {},
  };
}

function parseBudgetHintMinutes(maxBudgetHint: string | undefined): number {
  const raw = maxBudgetHint?.trim().toLowerCase() ?? "";
  if (raw.length === 0) return 5;
  const match = raw.match(/^(\d+)(ms|s|m|h)?$/u);
  if (!match) return 5;
  const value = Math.max(1, Number.parseInt(match[1] ?? "5", 10));
  const unit = match[2] ?? "m";
  switch (unit) {
    case "ms":
      return Math.max(1, Math.ceil(value / 60_000));
    case "s":
      return Math.max(1, Math.ceil(value / 60));
    case "h":
      return value * 60;
    default:
      return value;
  }
}

function estimateDelegationStepTokens(
  snapshot: DelegationBudgetSnapshot,
  analysis: DelegationStepAnalysis,
  economics: DelegationEconomics,
): number {
  const budgetMs = Math.max(
    60_000,
    parseBudgetHintMinutes(analysis.step.maxBudgetHint) * 60_000,
  );
  const timeRatio = clamp01(
    budgetMs / Math.max(60_000, snapshot.childBudget.latencyCeilingMs),
  );
  const executionWeight = analysis.mutable
    ? 0.28
    : analysis.shellObservationOnly
    ? 0.08
    : 0.12;
  const verificationWeight =
    1 + clamp01(economics.verifierCost) * 0.1 + clamp01(economics.retryCost) * 0.08;
  return Math.max(
    256,
    Math.min(
      snapshot.childBudget.tokenCeiling,
      Math.ceil(
        snapshot.childBudget.tokenCeiling *
          Math.max(0.1, timeRatio) *
          executionWeight *
          verificationWeight,
      ),
    ),
  );
}

function estimateDelegationStepSpend(
  analysis: DelegationStepAnalysis,
  economics: DelegationEconomics,
): number {
  return estimateDelegationStepSpendUnits({
    budgetMinutes: parseBudgetHintMinutes(analysis.step.maxBudgetHint),
    mutable: analysis.mutable,
    shellObservationOnly: analysis.shellObservationOnly,
    verifierCost: economics.verifierCost,
    retryCost: economics.retryCost,
  });
}

function isEconomicallyNegative(
  input: DelegationAdmissionInput,
  economics: DelegationEconomics,
): {
  readonly negative: boolean;
  readonly estimatedTokens: number;
  readonly estimatedSpendUnits: number;
} {
  const snapshot = input.budgetSnapshot;
  if (!snapshot) {
    return {
      negative: false,
      estimatedTokens: 0,
      estimatedSpendUnits: 0,
    };
  }

  const parentPressureHigh =
    snapshot.parentTokenRatio >= 0.9 ||
    snapshot.parentLatencyRatio >= 0.9 ||
    snapshot.parentSpendRatio >= 0.9;
  const childMostlyAvailable =
    snapshot.remainingTokens >= snapshot.childBudget.tokenCeiling * 0.65 &&
    snapshot.remainingSpendUnits >= snapshot.childBudget.spendCeilingUnits * 0.65;
  if (
    childMostlyAvailable &&
    !parentPressureHigh &&
    (
      !hasRuntimeLimit(snapshot.childFanoutSoftCap) ||
      economics.parallelizableCount <= snapshot.childFanoutSoftCap
    )
  ) {
    return {
      negative: false,
      estimatedTokens: 0,
      estimatedSpendUnits: 0,
    };
  }

  const estimatedTokens = economics.stepAnalyses.reduce(
    (sum, analysis) =>
      sum + estimateDelegationStepTokens(snapshot, analysis, economics),
    0,
  );
  const estimatedSpendUnits = Number(
    economics.stepAnalyses
      .reduce(
        (sum, analysis) => sum + estimateDelegationStepSpend(analysis, economics),
        0,
      )
      .toFixed(4),
  );
  const remainingTokensAfter = snapshot.remainingTokens - estimatedTokens;
  const remainingSpendAfter =
    snapshot.remainingSpendUnits - estimatedSpendUnits;
  return {
    negative:
      (
        hasRuntimeLimit(snapshot.childFanoutSoftCap) &&
        economics.parallelizableCount > snapshot.childFanoutSoftCap
      ) ||
      remainingTokensAfter < snapshot.negativeDelegationMarginTokens ||
      remainingSpendAfter < snapshot.negativeDelegationMarginUnits ||
      parentPressureHigh,
    estimatedTokens,
    estimatedSpendUnits,
  };
}

export function assessDelegationAdmission(
  input: DelegationAdmissionInput,
): DelegationAdmissionDecision {
  const economics = deriveDelegationEconomics({
    messageText: input.messageText,
    steps: input.steps,
    edges: input.edges,
  });
  const shape = detectShape(input, economics);
  const stepAdmissions = economics.stepAnalyses.map((analysis) =>
    buildDelegationStepAdmission({ analysis, shape })
  );
  const diagnostics = {
    explicitDelegationRequested: input.explicitDelegationRequested === true,
    explicitOwnershipCoverage: Number(
      economics.explicitOwnershipCoverage.toFixed(4),
    ),
    dependencyDepth: economics.dependencyDepth,
    dependencyCoupling: Number(economics.dependencyCoupling.toFixed(4)),
    parallelGain: Number(economics.parallelGain.toFixed(4)),
    toolOverlap: Number(economics.toolOverlap.toFixed(4)),
    verifierCost: Number(economics.verifierCost.toFixed(4)),
    retryCost: Number(economics.retryCost.toFixed(4)),
    utilityScore: Number(economics.utilityScore.toFixed(4)),
    ownershipOverlap: Number(economics.ownershipOverlap.toFixed(4)),
    shape: shape ?? "none",
    ...(input.budgetSnapshot
      ? {
          childRemainingTokens: input.budgetSnapshot.remainingTokens,
          childRemainingSpendUnits: Number(
            input.budgetSnapshot.remainingSpendUnits.toFixed(4),
          ),
          childFanoutSoftCap: input.budgetSnapshot.childFanoutSoftCap,
          parentTokenRatio: Number(
            input.budgetSnapshot.parentTokenRatio.toFixed(4),
          ),
          parentLatencyRatio: Number(
            input.budgetSnapshot.parentLatencyRatio.toFixed(4),
          ),
          parentSpendRatio: Number(
            input.budgetSnapshot.parentSpendRatio.toFixed(4),
          ),
        }
      : {}),
  } as const;

  if (input.steps.length === 0) {
    return buildDecision({
      allowed: false,
      reason: "no_subagent_steps",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  const requiredOrchestration =
    extractRequiredSubagentOrchestrationRequirements(input.messageText);
  const allowUserMandatedCardinality =
    allowsUserMandatedSubagentCardinalityOverride(requiredOrchestration);

  if (
    hasRuntimeLimit(input.maxFanoutPerTurn) &&
    input.steps.length > input.maxFanoutPerTurn &&
    !allowUserMandatedCardinality
  ) {
    return buildDecision({
      allowed: false,
      reason: "fanout_exceeded",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  if (
    input.explicitDelegationRequested !== true &&
    countWords(input.messageText) <= 28 &&
    input.steps.length <= 1 &&
    input.totalSteps <= 2 &&
    economics.stepAnalyses.every((analysis) => !analysis.mutable) &&
    !isIsolatedSingleStep(economics)
  ) {
    return buildDecision({
      allowed: false,
      reason: "trivial_request",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  if (isSharedContextReadOnlyReview(input, economics)) {
    return buildDecision({
      allowed: false,
      reason: "shared_context_review",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  if (
    input.explicitDelegationRequested !== true &&
    input.steps.length <= 1 &&
    input.totalSteps <= 2 &&
    economics.dependencyDepth <= 1 &&
    economics.parallelGain < 0.2 &&
    !isIsolatedSingleStep(economics)
  ) {
    return buildDecision({
      allowed: false,
      reason: "single_hop_request",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  const sharedArtifactWriterInline = detectSharedArtifactWriterInline(economics);
  if (sharedArtifactWriterInline) {
    return buildDecision({
      allowed: false,
      reason: "shared_artifact_writer_inline",
      shape,
      economics,
      stepAdmissions,
      diagnostics: {
        ...diagnostics,
        sharedPrimaryArtifact: sharedArtifactWriterInline.artifact,
        sharedArtifactMutableSteps:
          sharedArtifactWriterInline.mutableStepNames.join(","),
        sharedArtifactReadOnlySteps:
          sharedArtifactWriterInline.readOnlyStepNames.join(","),
      },
    });
  }

  if (isParentSafeReadOnlyInspection(input, economics, shape)) {
    return buildDecision({
      allowed: false,
      reason: "single_hop_request",
      shape,
      economics,
      stepAdmissions,
      diagnostics: {
        ...diagnostics,
        parentSafeReadOnlyInspection: true,
      },
    });
  }

  if (isSharedContextReadOnlyReview(input, economics)) {
    return buildDecision({
      allowed: false,
      reason: "shared_context_review",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  if (
    input.threshold >= 0.5 &&
    economics.utilityScore < clamp01(input.threshold)
  ) {
    return buildDecision({
      allowed: false,
      reason: "score_below_threshold",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  const economicsNegative = isEconomicallyNegative(input, economics);
  if (economicsNegative.negative) {
    return buildDecision({
      allowed: false,
      reason: "negative_economics",
      shape,
      economics,
      stepAdmissions,
      diagnostics: {
        ...diagnostics,
        estimatedDelegationTokens: economicsNegative.estimatedTokens,
        estimatedDelegationSpendUnits: Number(
          economicsNegative.estimatedSpendUnits.toFixed(4),
        ),
      },
    });
  }

  if (!shape && input.explicitDelegationRequested === true) {
    const [analysis] = economics.stepAnalyses;
    if (analysis) {
      const compatibilityShape: DelegationAdmissionShape =
        analysis.readOnly || analysis.shellObservationOnly
          ? (
            TEST_TRIAGE_TEXT_RE.test(input.messageText)
              ? "test_triage"
              : "repo_exploration"
          )
          : "bounded_sequential_handoff";
      return buildDecision({
        allowed: true,
        reason: "approved",
        shape: compatibilityShape,
        economics,
        stepAdmissions: [
          buildDelegationStepAdmission({
            analysis,
            shape: compatibilityShape,
          }),
        ],
        diagnostics: {
          ...diagnostics,
          explicitDelegationCompatibilityOverride: true,
          explicitDelegationCompatibilityShape: compatibilityShape,
          shape: compatibilityShape,
        },
      });
    }
  }

  if (!shape) {
    return buildDecision({
      allowed: false,
      reason: "no_safe_delegation_shape",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  if (economics.dependencyCoupling > 0.72) {
    return buildDecision({
      allowed: false,
      reason: "dependency_coupling_high",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  if (
    economics.toolOverlap > 0.86 &&
    economics.ownershipOverlap > 0.4 &&
    economics.explicitOwnershipCoverage < 0.75 &&
    shape !== "repo_exploration" &&
    shape !== "test_triage" &&
    shape !== "independent_parallel_branches" &&
    shape !== "bounded_sequential_handoff"
  ) {
    return buildDecision({
      allowed: false,
      reason: "tool_overlap_high",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  if (economics.verifierCost > 0.88 && shape !== "repo_exploration") {
    return buildDecision({
      allowed: false,
      reason: "verifier_cost_high",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  if (
    economics.retryCost > 0.9 &&
    shape === "bounded_sequential_handoff" &&
    !hasSingleMutableOwnerHandoff(economics.stepAnalyses)
  ) {
    return buildDecision({
      allowed: false,
      reason: "retry_cost_high",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  if (economics.utilityScore < clamp01(input.threshold)) {
    return buildDecision({
      allowed: false,
      reason: "score_below_threshold",
      shape,
      economics,
      stepAdmissions,
      diagnostics,
    });
  }

  return buildDecision({
    allowed: true,
    reason: "approved",
    shape,
    economics,
    stepAdmissions,
    diagnostics,
  });
}

export function assessDirectDelegationAdmission(params: {
  readonly input: ExecuteWithAgentInput;
  readonly threshold: number;
}): DelegationAdmissionDecision {
  const capabilities = params.input.requiredToolCapabilities ??
    params.input.tools ??
    [];
  const step: DelegationCandidateStep = {
    name: "direct_delegation",
    objective: params.input.objective ?? params.input.task,
    inputContract: params.input.inputContract,
    acceptanceCriteria: params.input.acceptanceCriteria ?? [],
    requiredToolCapabilities: capabilities,
    contextRequirements: [],
    executionContext: params.input.executionContext,
    maxBudgetHint: params.input.timeoutMs
      ? `${Math.max(1, Math.round(params.input.timeoutMs / 60_000))}m`
      : "5m",
    canRunParallel: false,
  };
  const baseDecision = assessDelegationAdmission({
    messageText: params.input.objective ?? params.input.task,
    totalSteps: 1,
    synthesisSteps: 0,
    steps: [step],
    edges: [],
    threshold: params.threshold,
    maxFanoutPerTurn: 1,
    maxDepth: 1,
    explicitDelegationRequested: true,
    budgetSnapshot: undefined,
  });

  if (baseDecision.allowed) {
    return baseDecision;
  }

  const [analysis] = baseDecision.economics.stepAnalyses;
  if (!analysis) {
    return baseDecision;
  }

  const fallbackShape: DelegationAdmissionShape =
    analysis.readOnly || analysis.shellObservationOnly
      ? (
        TEST_TRIAGE_TEXT_RE.test(params.input.objective ?? params.input.task)
          ? "test_triage"
          : "repo_exploration"
      )
      : "bounded_sequential_handoff";

  const compatibilityReasons = new Set<DelegationAdmissionReason>([
    "trivial_request",
    "single_hop_request",
    "shared_context_review",
    "no_safe_delegation_shape",
    "score_below_threshold",
  ]);

  if (!compatibilityReasons.has(baseDecision.reason)) {
    return baseDecision;
  }

  return buildDecision({
    allowed: true,
    reason: "approved",
    shape: fallbackShape,
    economics: baseDecision.economics,
    stepAdmissions: [
      buildDelegationStepAdmission({
        analysis,
        shape: fallbackShape,
      }),
    ],
    diagnostics: {
      ...baseDecision.diagnostics,
      directToolCompatibilityOverride: true,
      directToolCompatibilityReason: baseDecision.reason,
      shape: fallbackShape,
    },
  });
}
