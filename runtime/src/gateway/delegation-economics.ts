import { normalizeArtifactPaths } from "../workflow/path-normalization.js";
import type { WorkflowGraphEdge } from "../workflow/types.js";
import type { DelegationExecutionContext } from "../utils/delegation-execution-context.js";
import { sanitizeDelegationContextRequirements } from "../utils/delegation-execution-context.js";

const EXPLICIT_FILE_ARTIFACT_GLOBAL_RE =
  /(?:^|[\s`'"])(?:\/[^\s`'"]*?\.[a-z0-9]{1,10}|\.{1,2}\/[^\s`'"]*?\.[a-z0-9]{1,10}|(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+\.[a-z0-9]{1,10}|[a-z0-9_.-]+\.[a-z0-9]{1,10})(?=$|[\s`'"])/gi;
const EXPLICIT_SCOPED_PATH_GLOBAL_RE =
  /(?:^|[\s`'"])(?:\/[^\s`'"]+|(?:[a-z0-9_.-]+\/)+[a-z0-9_.-]+)(?=$|[\s`'"])/gi;
const REPO_SCOPED_ROOT_SEGMENTS = new Set([
  "packages",
  "apps",
  "src",
  "tests",
  "test",
  "docs",
  "scripts",
  "crates",
  "programs",
  "runtime",
  "contracts",
  "examples",
  "plugins",
  "sdk",
  "lib",
  "bin",
]);

const READ_ONLY_CAPABILITY_RE =
  /(?:read|list|search|snapshot|navigate|inspect|find|grep|glob|browser|documentation|trace|observe)/i;
const WRITE_CAPABILITY_RE =
  /(?:write|append|edit|save|modify|patch|delete|mkdir|scaffold|code_generation|file_write)/i;
const SHELL_CAPABILITY_RE =
  /(?:bash|shell|package_manager|build|test|compile|run|execute|command)/i;
const TEST_TRIAGE_TEXT_RE =
  /\b(?:test|tests|ci|failure|failures|failing|flaky|error|errors|stack\s+trace|logs?)\b/i;
const EXPLORATION_TEXT_RE =
  /\b(?:explore|inventory|map|locate|find|inspect|survey|trace|understand|catalog|analy[sz]e|review|audit)\b/i;

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
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseBudgetHintMinutes(raw: string): number {
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) return 5;
  const match = normalized.match(/^(\d+(?:\.\d+)?)(ms|s|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/);
  if (!match) return 5;
  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return 5;
  const unit = match[2] ?? "m";
  if (unit === "ms") return value / 60_000;
  if (unit === "s") return value / 60;
  if (unit === "h" || unit === "hr" || unit === "hrs" || unit === "hour" || unit === "hours") {
    return value * 60;
  }
  return value;
}

function extractExplicitFileArtifacts(
  segments: readonly string[],
  workspaceRoot?: string,
): readonly string[] {
  const matches = new Set<string>();
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.trim().length === 0) continue;
    for (const match of segment.matchAll(EXPLICIT_FILE_ARTIFACT_GLOBAL_RE)) {
      const normalized = match[0]?.trim().replace(/^[`'"]+|[`'"]+$/g, "")
        .replace(/[),.;:]+$/g, "");
      if (normalized) {
        for (const artifact of normalizeArtifactPaths([normalized], workspaceRoot)) {
          matches.add(artifact);
        }
      }
    }
  }
  return [...matches];
}

function extractExplicitScopedArtifacts(
  segments: readonly string[],
  workspaceRoot?: string,
): readonly string[] {
  const matches = new Set<string>();
  for (const segment of segments) {
    if (typeof segment !== "string" || segment.trim().length === 0) continue;
    for (const match of segment.matchAll(EXPLICIT_SCOPED_PATH_GLOBAL_RE)) {
      const normalized = match[0]?.trim().replace(/^[`'"]+|[`'"]+$/g, "")
        .replace(/[),.;:]+$/g, "");
      if (!normalized) continue;
      if (!normalized.includes("/")) continue;
      if (/^(?:https?:)?\/\//i.test(normalized)) continue;
      if (!looksLikeScopedRepoArtifact(normalized)) continue;
      for (const artifact of normalizeArtifactPaths([normalized], workspaceRoot)) {
        matches.add(artifact);
      }
    }
  }
  return [...matches];
}

function looksLikeScopedRepoArtifact(value: string): boolean {
  if (
    value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../")
  ) {
    return true;
  }
  const segments = value.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) return false;
  const first = segments[0]!.toLowerCase();
  if (REPO_SCOPED_ROOT_SEGMENTS.has(first)) {
    return true;
  }
  return segments.some((segment) => /[._-]|\d/.test(segment));
}

function isWriteCapability(capability: string): boolean {
  return WRITE_CAPABILITY_RE.test(capability);
}

function isShellCapability(capability: string): boolean {
  return SHELL_CAPABILITY_RE.test(capability);
}

function isReadCapability(capability: string): boolean {
  return READ_ONLY_CAPABILITY_RE.test(capability);
}

function isReadOnlyEnvelope(effectClass?: DelegationExecutionContext["effectClass"]): boolean {
  return effectClass === "read_only";
}

function collectOwnedArtifacts(
  step: DelegationCandidateStep,
): readonly string[] {
  const workspaceRoot = step.executionContext?.workspaceRoot;
  const targetArtifacts = step.executionContext?.targetArtifacts ?? [];
  if (targetArtifacts.length > 0) {
    return targetArtifacts;
  }

  const explicitTextArtifacts = extractExplicitFileArtifacts(
    [
      step.objective ?? "",
      step.inputContract ?? "",
      ...step.acceptanceCriteria,
    ],
    workspaceRoot,
  );
  if (explicitTextArtifacts.length > 0) {
    return explicitTextArtifacts;
  }

  const explicitScopedArtifacts = extractExplicitScopedArtifacts(
    [
      step.objective ?? "",
      step.inputContract ?? "",
      ...step.acceptanceCriteria,
    ],
    workspaceRoot,
  );
  if (explicitScopedArtifacts.length > 0) {
    return explicitScopedArtifacts;
  }

  const sourceArtifacts = step.executionContext?.requiredSourceArtifacts ??
    step.executionContext?.inputArtifacts ??
    [];
  if (sourceArtifacts.length > 0) {
    return sourceArtifacts;
  }

  return [];
}

function collectReferencedArtifacts(step: DelegationCandidateStep): readonly string[] {
  const workspaceRoot = step.executionContext?.workspaceRoot;
  const sanitizedContextRequirements = sanitizeDelegationContextRequirements(
    step.contextRequirements,
  );
  const explicitArtifacts = extractExplicitFileArtifacts(
    [
      step.objective ?? "",
      step.inputContract ?? "",
      ...step.acceptanceCriteria,
      ...sanitizedContextRequirements,
    ],
    workspaceRoot,
  );
  return [
    ...(step.executionContext?.inputArtifacts ?? []),
    ...(step.executionContext?.requiredSourceArtifacts ?? []),
    ...(step.executionContext?.targetArtifacts ?? []),
    ...explicitArtifacts,
  ].filter((artifact, index, artifacts) => artifacts.indexOf(artifact) === index);
}

function analyzeStep(step: DelegationCandidateStep): DelegationStepAnalysis {
  const capabilities = step.requiredToolCapabilities.map((capability) =>
    capability.trim()
  ).filter((capability) => capability.length > 0);
  const writeCapabilityCount = capabilities.filter(isWriteCapability).length;
  const shellCapabilityCount = capabilities.filter(isShellCapability).length;
  const readCapabilityCount = capabilities.filter(isReadCapability).length;
  const envelope = step.executionContext;
  const ownedArtifacts = collectOwnedArtifacts(step);
  const referencedArtifacts = collectReferencedArtifacts(step);
  const readOnly = isReadOnlyEnvelope(envelope?.effectClass) ||
    (
      writeCapabilityCount === 0 &&
      shellCapabilityCount === 0 &&
      capabilities.length > 0 &&
      readCapabilityCount === capabilities.length
    );
  const shellObservationOnly =
    writeCapabilityCount === 0 &&
    shellCapabilityCount > 0 &&
    (envelope?.targetArtifacts?.length ?? 0) === 0 &&
    (envelope?.effectClass === "read_only" || readOnly);
  const mutable =
    envelope?.effectClass === "filesystem_write" ||
    envelope?.effectClass === "filesystem_scaffold" ||
    envelope?.effectClass === "mixed" ||
    writeCapabilityCount > 0 ||
    (!readOnly && shellCapabilityCount > 0);

  return {
    step,
    ownedArtifacts,
    referencedArtifacts,
    mutable,
    readOnly: readOnly && !mutable,
    shellObservationOnly,
    budgetMinutes: parseBudgetHintMinutes(step.maxBudgetHint),
  };
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function hasDependency(
  from: string,
  to: string,
  dependencyGraph: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (from === to) return true;
  const visited = new Set<string>();
  const queue = [to];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    const deps = dependencyGraph.get(current);
    if (!deps) continue;
    if (deps.has(from)) return true;
    for (const dep of deps) queue.push(dep);
  }
  return false;
}

function buildDependencyGraph(
  steps: readonly DelegationCandidateStep[],
  edges: readonly WorkflowGraphEdge[],
): Map<string, Set<string>> {
  const stepNames = new Set(steps.map((step) => step.name));
  const graph = new Map<string, Set<string>>();
  for (const step of steps) {
    graph.set(step.name, new Set(
      (step.dependsOn ?? []).filter((dep) => stepNames.has(dep)),
    ));
  }
  for (const edge of edges) {
    if (!stepNames.has(edge.from) || !stepNames.has(edge.to)) continue;
    graph.get(edge.to)?.add(edge.from);
  }
  return graph;
}

function estimateDependencyDepth(
  steps: readonly DelegationCandidateStep[],
  edges: readonly WorkflowGraphEdge[],
): number {
  if (steps.length === 0) return 0;
  const graph = buildDependencyGraph(steps, edges);
  const memo = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (name: string): number => {
    if (memo.has(name)) return memo.get(name)!;
    if (visiting.has(name)) return Number.POSITIVE_INFINITY;
    visiting.add(name);
    let depth = 1;
    for (const dependency of graph.get(name) ?? []) {
      depth = Math.max(depth, visit(dependency) + 1);
    }
    visiting.delete(name);
    memo.set(name, depth);
    return depth;
  };
  let maxDepth = 1;
  for (const step of steps) {
    maxDepth = Math.max(maxDepth, visit(step.name));
  }
  return maxDepth;
}

function countIndependentParallelPairs(
  analyses: readonly DelegationStepAnalysis[],
  dependencyGraph: ReadonlyMap<string, ReadonlySet<string>>,
): { readonly independentPairs: number; readonly totalPairs: number } {
  let independentPairs = 0;
  let totalPairs = 0;
  for (let index = 0; index < analyses.length; index += 1) {
    const left = analyses[index];
    if (!left?.step.canRunParallel) continue;
    for (let inner = index + 1; inner < analyses.length; inner += 1) {
      const right = analyses[inner];
      if (!right?.step.canRunParallel) continue;
      totalPairs += 1;
      if (
        hasDependency(left.step.name, right.step.name, dependencyGraph) ||
        hasDependency(right.step.name, left.step.name, dependencyGraph)
      ) {
        continue;
      }
      const leftOwned = new Set(left.ownedArtifacts);
      const rightOwned = new Set(right.ownedArtifacts);
      const overlap = jaccard(leftOwned, rightOwned);
      if (overlap <= 0.2) {
        independentPairs += 1;
      }
    }
  }
  return { independentPairs, totalPairs };
}

function averageOwnershipOverlap(
  analyses: readonly DelegationStepAnalysis[],
): number {
  const mutable = analyses.filter((analysis) => analysis.mutable);
  if (mutable.length < 2) return 0;
  const overlaps: number[] = [];
  for (let index = 0; index < mutable.length; index += 1) {
    const left = mutable[index]!;
    for (let inner = index + 1; inner < mutable.length; inner += 1) {
      const right = mutable[inner]!;
      const leftOwned = new Set(left.ownedArtifacts);
      const rightOwned = new Set(right.ownedArtifacts);
      if (
        leftOwned.size === 0 &&
        rightOwned.size === 0 &&
        left.step.executionContext?.workspaceRoot &&
        left.step.executionContext.workspaceRoot ===
          right.step.executionContext?.workspaceRoot
      ) {
        overlaps.push(1);
        continue;
      }
      overlaps.push(jaccard(leftOwned, rightOwned));
    }
  }
  return average(overlaps);
}

function averageToolOverlap(
  analyses: readonly DelegationStepAnalysis[],
): number {
  if (analyses.length < 2) return 0;
  const overlaps: number[] = [];
  for (let index = 0; index < analyses.length; index += 1) {
    const left = analyses[index]!;
    const leftCapabilities = new Set(left.step.requiredToolCapabilities);
    for (let inner = index + 1; inner < analyses.length; inner += 1) {
      const rightCapabilities = new Set(analyses[inner]!.step.requiredToolCapabilities);
      overlaps.push(jaccard(leftCapabilities, rightCapabilities));
    }
  }
  return average(overlaps);
}

function computeVerifierCost(analyses: readonly DelegationStepAnalysis[]): number {
  const weights = analyses.map((analysis) => {
    const verificationMode = analysis.step.executionContext?.verificationMode;
    const modeWeight =
      verificationMode === "deterministic_followup"
        ? 0.45
        : verificationMode === "mutation_required"
        ? 0.32
        : verificationMode === "grounded_read"
        ? 0.18
        : 0.08;
    return clamp01(
      modeWeight +
        Math.min(0.25, analysis.step.acceptanceCriteria.length * 0.05) +
        Math.min(0.2, analysis.ownedArtifacts.length * 0.06),
    );
  });
  return average(weights);
}

function computeRetryCost(analyses: readonly DelegationStepAnalysis[]): number {
  const weights = analyses.map((analysis) => {
    let base = clamp01(analysis.budgetMinutes / 20);
    if (analysis.mutable) base += 0.22;
    if (analysis.shellObservationOnly) base += 0.08;
    if (analysis.step.executionContext?.effectClass === "mixed") base += 0.18;
    return clamp01(base);
  });
  return average(weights);
}

function computeContextFootprint(analyses: readonly DelegationStepAnalysis[]): number {
  const weights = analyses.map((analysis) =>
    clamp01(
      Math.min(0.35, analysis.referencedArtifacts.length * 0.06) +
        Math.min(
          0.25,
          sanitizeDelegationContextRequirements(
            analysis.step.contextRequirements,
          ).length * 0.04,
        ),
    )
  );
  return average(weights);
}

export function deriveDelegationEconomics(input: {
  readonly messageText: string;
  readonly steps: readonly DelegationCandidateStep[];
  readonly edges: readonly WorkflowGraphEdge[];
}): DelegationEconomics {
  const analyses = input.steps.map(analyzeStep);
  const dependencyGraph = buildDependencyGraph(input.steps, input.edges);
  const dependencyDepth = estimateDependencyDepth(input.steps, input.edges);
  const dependencyDepthRisk = clamp01((dependencyDepth - 1) / 3);
  const ownershipOverlap = averageOwnershipOverlap(analyses);
  const toolOverlap = averageToolOverlap(analyses);
  const verifierCost = computeVerifierCost(analyses);
  const retryCost = computeRetryCost(analyses);
  const contextFootprint = computeContextFootprint(analyses);
  const parallelizableCount = analyses.filter((analysis) =>
    analysis.step.canRunParallel
  ).length;
  const { independentPairs, totalPairs } = countIndependentParallelPairs(
    analyses,
    dependencyGraph,
  );
  const explicitOwnershipCoverage = analyses.length > 0
    ? analyses.filter((analysis) => analysis.ownedArtifacts.length > 0).length /
      analyses.length
    : 0;
  const parallelGain = clamp01(
    Math.min(0.35, parallelizableCount / Math.max(1, analyses.length) * 0.45) +
      Math.min(0.35, totalPairs > 0 ? (independentPairs / totalPairs) * 0.45 : 0) +
      Math.min(0.15, explicitOwnershipCoverage * 0.2) +
      (TEST_TRIAGE_TEXT_RE.test(input.messageText) || EXPLORATION_TEXT_RE.test(input.messageText)
        ? 0.08
        : 0),
  );
  const dependencyCoupling = clamp01(
    dependencyDepthRisk * 0.35 +
      ownershipOverlap * 0.4 +
      toolOverlap * 0.15 +
      contextFootprint * 0.1,
  );
  const utilityScore = clamp01(
    parallelGain * 0.55 +
      explicitOwnershipCoverage * 0.15 -
      dependencyCoupling * 0.35 -
      verifierCost * 0.1 -
      retryCost * 0.1 +
      0.5,
  );

  return {
    stepAnalyses: analyses,
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
