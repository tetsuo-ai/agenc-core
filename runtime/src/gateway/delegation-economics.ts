import type { WorkflowGraphEdge } from "../workflow/types.js";
import type { DelegationExecutionContext } from "../utils/delegation-execution-context.js";
import {
  isMutationLikeVerificationMode,
  resolveExecutionEnvelopeArtifactRelations,
  resolveExecutionEnvelopeRole,
  type WorkflowArtifactRelation,
} from "../workflow/execution-envelope.js";

export interface DelegationCandidateStep {
  readonly name: string;
  readonly objective?: string;
  readonly inputContract?: string;
  readonly dependsOn?: readonly string[];
  readonly acceptanceCriteria: readonly string[];
  readonly requiredToolCapabilities: readonly string[];
  readonly contextRequirements: readonly string[];
  readonly executionContext?: DelegationExecutionContext;
  readonly maxBudgetHint: string;
  readonly canRunParallel: boolean;
}

export interface DelegationStepAnalysis {
  readonly step: DelegationCandidateStep;
  readonly artifactRelations: readonly WorkflowArtifactRelation[];
  readonly ownedArtifacts: readonly string[];
  readonly referencedArtifacts: readonly string[];
  readonly mutable: boolean;
  readonly readOnly: boolean;
  readonly shellObservationOnly: boolean;
  readonly budgetMinutes: number;
}

export interface DelegationEconomics {
  readonly stepAnalyses: readonly DelegationStepAnalysis[];
  readonly contextFootprint: number;
  readonly dependencyDepth: number;
  readonly dependencyCoupling: number;
  readonly parallelGain: number;
  readonly toolOverlap: number;
  readonly verifierCost: number;
  readonly retryCost: number;
  readonly utilityScore: number;
  readonly explicitOwnershipCoverage: number;
  readonly ownershipOverlap: number;
  readonly parallelizableCount: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 1) {
    return 1;
  }
  return value;
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function parseBudgetMinutes(maxBudgetHint: string | undefined): number {
  const raw = maxBudgetHint?.trim().toLowerCase() ?? "";
  if (raw.length === 0) {
    return 5;
  }
  const match = raw.match(/^(\d+)(ms|s|m|h)?$/u);
  if (!match) {
    return 5;
  }
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

function hasWriteLikeCapability(step: DelegationCandidateStep): boolean {
  return step.requiredToolCapabilities.some((capability) =>
    /(?:write|edit|patch|scaffold|mkdir|rename|delete|remove|move|copy)/iu.test(
      capability,
    ),
  );
}

function hasShellCapability(step: DelegationCandidateStep): boolean {
  return step.requiredToolCapabilities.some((capability) =>
    /(?:bash|shell|exec|terminal|command)/iu.test(capability),
  );
}

function buildAnalysis(step: DelegationCandidateStep): DelegationStepAnalysis {
  const executionContext = step.executionContext;
  const artifactRelations = resolveExecutionEnvelopeArtifactRelations(
    executionContext,
  );
  const role = resolveExecutionEnvelopeRole(executionContext);
  const ownedArtifacts = uniqueStrings(
    artifactRelations
      .filter((relation) => relation.relationType === "write_owner")
      .map((relation) => relation.artifactPath),
  );
  const referencedArtifacts = uniqueStrings(
    artifactRelations
      .filter((relation) => relation.relationType !== "write_owner")
      .map((relation) => relation.artifactPath),
  );
  const mutable =
    role === "writer" ||
    executionContext?.effectClass === "filesystem_write" ||
    executionContext?.effectClass === "filesystem_scaffold" ||
    executionContext?.effectClass === "mixed" ||
    isMutationLikeVerificationMode(executionContext?.verificationMode) ||
    ownedArtifacts.length > 0 ||
    hasWriteLikeCapability(step) ||
    ((executionContext?.targetArtifacts?.length ?? 0) > 0 &&
      executionContext?.effectClass !== "read_only");
  const shellObservationOnly =
    !mutable &&
    executionContext?.effectClass === "shell" &&
    hasShellCapability(step) &&
    (executionContext?.targetArtifacts?.length ?? 0) === 0;

  return {
    step,
    artifactRelations,
    ownedArtifacts,
    referencedArtifacts,
    mutable,
    readOnly: !mutable && !shellObservationOnly,
    shellObservationOnly,
    budgetMinutes: parseBudgetMinutes(step.maxBudgetHint),
  };
}

function buildDependencyMap(
  steps: readonly DelegationCandidateStep[],
  edges: readonly WorkflowGraphEdge[],
): Map<string, Set<string>> {
  const byName = new Map<string, Set<string>>();
  for (const step of steps) {
    byName.set(step.name, new Set(step.dependsOn ?? []));
  }
  for (const edge of edges) {
    if (!byName.has(edge.to) || !byName.has(edge.from)) {
      continue;
    }
    byName.get(edge.to)?.add(edge.from);
  }
  return byName;
}

function computeDependencyDepth(
  steps: readonly DelegationCandidateStep[],
  edges: readonly WorkflowGraphEdge[],
): number {
  const dependencies = buildDependencyMap(steps, edges);
  const memo = new Map<string, number>();

  const visit = (stepName: string, trail: Set<string>): number => {
    if (memo.has(stepName)) {
      return memo.get(stepName) ?? 0;
    }
    if (trail.has(stepName)) {
      return 0;
    }
    const nextTrail = new Set(trail);
    nextTrail.add(stepName);
    const parents = [...(dependencies.get(stepName) ?? [])];
    const depth =
      parents.length === 0
        ? 0
        : Math.max(...parents.map((parent) => visit(parent, nextTrail) + 1));
    memo.set(stepName, depth);
    return depth;
  };

  return steps.reduce((maxDepth, step) => Math.max(maxDepth, visit(step.name, new Set())), 0);
}

function jaccardSimilarity(left: readonly string[], right: readonly string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) {
      intersection += 1;
    }
  }
  return intersection / union.size;
}

function computeToolOverlap(stepAnalyses: readonly DelegationStepAnalysis[]): number {
  if (stepAnalyses.length <= 1) {
    return 0;
  }
  let pairs = 0;
  let overlap = 0;
  for (let index = 0; index < stepAnalyses.length; index += 1) {
    for (let inner = index + 1; inner < stepAnalyses.length; inner += 1) {
      pairs += 1;
      overlap += jaccardSimilarity(
        stepAnalyses[index]?.step.requiredToolCapabilities ?? [],
        stepAnalyses[inner]?.step.requiredToolCapabilities ?? [],
      );
    }
  }
  return pairs === 0 ? 0 : clamp01(overlap / pairs);
}

function computeDependencyCoupling(
  stepAnalyses: readonly DelegationStepAnalysis[],
  edges: readonly WorkflowGraphEdge[],
): number {
  if (stepAnalyses.length <= 1) {
    return 0;
  }
  const dependencyCount =
    edges.length +
    stepAnalyses.reduce(
      (sum, analysis) => sum + (analysis.step.dependsOn?.length ?? 0),
      0,
    );
  const possiblePairs = Math.max(
    1,
    (stepAnalyses.length * (stepAnalyses.length - 1)) / 2,
  );
  let sharedArtifactPairs = 0;
  for (let index = 0; index < stepAnalyses.length; index += 1) {
    for (let inner = index + 1; inner < stepAnalyses.length; inner += 1) {
      const leftArtifacts = new Set([
        ...stepAnalyses[index]!.ownedArtifacts,
        ...stepAnalyses[index]!.referencedArtifacts,
      ]);
      const rightArtifacts = [
        ...stepAnalyses[inner]!.ownedArtifacts,
        ...stepAnalyses[inner]!.referencedArtifacts,
      ];
      if (rightArtifacts.some((artifact) => leftArtifacts.has(artifact))) {
        sharedArtifactPairs += 1;
      }
    }
  }
  return clamp01(
    dependencyCount / possiblePairs + (sharedArtifactPairs / possiblePairs) * 0.35,
  );
}

function computeVerifierCost(stepAnalyses: readonly DelegationStepAnalysis[]): number {
  if (stepAnalyses.length === 0) {
    return 0;
  }
  const total = stepAnalyses.reduce((sum, analysis) => {
    switch (analysis.step.executionContext?.verificationMode) {
      case "mutation_required":
        return sum + 1;
      case "conditional_mutation":
        return sum + 0.8;
      case "deterministic_followup":
        return sum + 0.7;
      case "grounded_read":
        return sum + 0.25;
      default:
        return sum;
    }
  }, 0);
  return clamp01(total / stepAnalyses.length);
}

function computeOwnershipCoverage(stepAnalyses: readonly DelegationStepAnalysis[]): number {
  if (stepAnalyses.length === 0) {
    return 0;
  }
  const covered = stepAnalyses.filter((analysis) =>
    analysis.ownedArtifacts.length > 0 ||
    analysis.referencedArtifacts.length > 0 ||
    Boolean(analysis.step.executionContext?.workspaceRoot),
  ).length;
  return clamp01(covered / stepAnalyses.length);
}

function computeOwnershipOverlap(stepAnalyses: readonly DelegationStepAnalysis[]): number {
  const mutableAnalyses = stepAnalyses.filter((analysis) => analysis.mutable);
  if (mutableAnalyses.length <= 1) {
    return 0;
  }
  let overlappingPairs = 0;
  let pairs = 0;
  for (let index = 0; index < mutableAnalyses.length; index += 1) {
    for (let inner = index + 1; inner < mutableAnalyses.length; inner += 1) {
      pairs += 1;
      const left = new Set(mutableAnalyses[index]!.ownedArtifacts);
      if (mutableAnalyses[inner]!.ownedArtifacts.some((artifact) => left.has(artifact))) {
        overlappingPairs += 1;
      }
    }
  }
  return pairs === 0 ? 0 : clamp01(overlappingPairs / pairs);
}

export function deriveDelegationEconomics(
  input: Record<string, unknown> & {
    readonly steps: readonly DelegationCandidateStep[];
    readonly edges?: readonly WorkflowGraphEdge[];
  },
): DelegationEconomics {
  const stepAnalyses = input.steps.map(buildAnalysis);
  const dependencyDepth = computeDependencyDepth(stepAnalyses.map((analysis) => analysis.step), input.edges ?? []);
  const dependencyCoupling = computeDependencyCoupling(stepAnalyses, input.edges ?? []);
  const parallelizableCount = input.steps.filter((step) => step.canRunParallel).length;
  const parallelGain = clamp01(
    (parallelizableCount / Math.max(1, input.steps.length)) *
      (1 - dependencyCoupling * 0.5),
  );
  const toolOverlap = computeToolOverlap(stepAnalyses);
  const verifierCost = computeVerifierCost(stepAnalyses);
  const ownershipOverlap = computeOwnershipOverlap(stepAnalyses);
  const explicitOwnershipCoverage = computeOwnershipCoverage(stepAnalyses);
  const mutableFraction =
    stepAnalyses.filter((analysis) => analysis.mutable).length /
    Math.max(1, stepAnalyses.length);
  const retryCost = clamp01(
    mutableFraction * 0.45 + verifierCost * 0.35 + dependencyCoupling * 0.2,
  );
  const contextFootprint = stepAnalyses.reduce(
    (sum, analysis) =>
      sum +
      analysis.artifactRelations.length +
      analysis.step.acceptanceCriteria.length +
      analysis.step.contextRequirements.length +
      analysis.step.requiredToolCapabilities.length,
    0,
  );
  const utilityScore = clamp01(
    0.55 +
      parallelGain * 0.2 +
      explicitOwnershipCoverage * 0.15 -
      dependencyCoupling * 0.15 -
      toolOverlap * 0.1 -
      verifierCost * 0.05 -
      retryCost * 0.05 -
      ownershipOverlap * 0.2,
  );

  return {
    stepAnalyses,
    contextFootprint,
    dependencyDepth,
    dependencyCoupling,
    parallelGain,
    toolOverlap,
    verifierCost,
    retryCost,
    utilityScore,
    explicitOwnershipCoverage,
    ownershipOverlap,
    parallelizableCount,
  };
}
