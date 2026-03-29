import { canonicalizeExecutionStepKind } from "./execution-intent.js";
import type {
  ExecutionEffectClass,
  ExecutionStepKind,
  ExecutionVerificationMode,
} from "./execution-envelope.js";

export interface RequiredSubagentOrchestrationStep {
  readonly name: string;
  readonly description: string;
}

export interface RequiredSubagentOrchestrationRequirements {
  readonly mode: "exact_steps" | "minimum_steps";
  readonly steps: readonly RequiredSubagentOrchestrationStep[];
  readonly stepNames: readonly string[];
  readonly requiredStepCount: number;
  readonly roleHints: readonly string[];
  readonly requiresSynthesis: boolean;
}

export interface RequiredSubagentVerificationCandidate {
  readonly name: string;
  readonly objective?: string;
  readonly inputContract?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly executionContext?: {
    readonly stepKind?: ExecutionStepKind;
    readonly effectClass?: ExecutionEffectClass;
    readonly verificationMode?: ExecutionVerificationMode;
    readonly targetArtifacts?: readonly string[];
  };
}

const REQUIRED_SUBAGENT_PLAN_MARKER_RE =
  /sub-agent orchestration plan(?:\s*\((?:required|mandatory)\)|\s+(?:required|mandatory))\s*:/i;
const REQUIRED_SUBAGENT_STEP_NAME_RE =
  /(?:^|\s)(\d+)[\).:]\s*(?:`([^`]+)`|([A-Za-z0-9_-]+))/g;
const REQUIRED_DELIVERABLE_CUE_RE =
  /\b(final deliverables|how to play|known limitations|architecture summary)\b/i;
const AGENT_REQUEST_VERB_RE =
  /\b(?:create|spawn|spin up|launch|start|use|run|have)\b/i;
const AGENT_NOUN_RE =
  /\b(?:sub[\s-]?agents?|child agents?|agents?|reviewers?|researchers?)\b/i;
const DISTINCT_ROLE_CUE_RE =
  /\b(?:different|distinct)\s+(?:roles?|perspectives?|types?)\b|\beach\s+(?:one|agent|reviewer|researcher)\s+should\s+be\b/i;
const MULTI_AGENT_ROLE_CUE_RE =
  /\b(?:multiple|several)\s+(?:sub[\s-]?agents?|agents?|reviewers?|researchers?)\b/i;
const ROLE_HINT_PATTERNS: readonly { hint: string; re: RegExp }[] = [
  { hint: "skeptical", re: /\b(?:skeptic|skeptical)\b/i },
  { hint: "qa", re: /\b(?:qa|quality assurance|test(?:ing)?|verification)\b/i },
  { hint: "security", re: /\bsecurity\b/i },
  { hint: "architecture", re: /\b(?:architect|architecture|design)\b/i },
  { hint: "documentation", re: /\b(?:docs?|documentation|clarity|readability)\b/i },
  { hint: "layout", re: /\b(?:layout|directory|tree|structure)\b/i },
  { hint: "implementation", re: /\b(?:implementation|code|engineering)\b/i },
  { hint: "performance", re: /\bperformance\b/i },
  { hint: "completeness", re: /\b(?:complete(?:ness)?|coverage|gaps?)\b/i },
];
const NUMBER_WORDS = new Map<string, number>([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
]);
const IMPLICIT_AGENT_COUNT_RE = new RegExp(
  String.raw`\b(?:(?:create|spawn|spin up|launch|start|use|run|have)\s+)?(\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:actual\s+|distinct\s+|different\s+)?(?:sub[\s-]?agents?|child agents?|agents?|reviewers?|researchers?)\b`,
  "i",
);

function sanitizePlannerStepName(name: string): string {
  const trimmed = name.trim();
  const normalized = trimmed.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
  return normalized.length > 0 ? normalized : "step";
}

function normalizeExplicitRequirementDescription(description: string): string {
  return description
    .replace(/\s+/g, " ")
    .replace(/\s*-\s*/g, " - ")
    .trim();
}

function dedupePreservingOrder(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized.length === 0 || seen.has(normalized)) continue;
    seen.add(normalized);
    ordered.push(normalized);
  }
  return ordered;
}

function extractRoleHints(messageText: string): readonly string[] {
  const hints: string[] = [];
  for (const pattern of ROLE_HINT_PATTERNS) {
    if (pattern.re.test(messageText)) {
      hints.push(pattern.hint);
    }
  }
  return dedupePreservingOrder(hints);
}

function parseRequestedAgentCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  return NUMBER_WORDS.get(trimmed);
}

function extractExplicitRequirements(
  messageText: string,
): RequiredSubagentOrchestrationRequirements | undefined {
  const markerMatch = REQUIRED_SUBAGENT_PLAN_MARKER_RE.exec(messageText);
  if (!markerMatch) return undefined;

  const section = messageText.slice(markerMatch.index + markerMatch[0].length);
  const steps: RequiredSubagentOrchestrationStep[] = [];
  const seen = new Set<string>();
  const itemMatches = section.matchAll(
    /(\d+)[\).:]\s*(?:`([^`]+)`|([A-Za-z0-9_-]+))\s*:\s*([\s\S]*?)(?=(?:\s+\d+[\).:]\s*(?:`[^`]+`|[A-Za-z0-9_-]+)\s*:)|$)/g,
  );
  for (const match of itemMatches) {
    const normalizedName = sanitizePlannerStepName(
      match[2] ?? match[3] ?? "",
    );
    if (normalizedName.length === 0 || seen.has(normalizedName)) continue;
    seen.add(normalizedName);
    steps.push({
      name: normalizedName,
      description: normalizeExplicitRequirementDescription(match[4] ?? ""),
    });
  }

  if (steps.length < 2) {
    const stepNames: string[] = [];
    REQUIRED_SUBAGENT_STEP_NAME_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = REQUIRED_SUBAGENT_STEP_NAME_RE.exec(section)) !== null) {
      const normalizedName = sanitizePlannerStepName(
        match[2] ?? match[3] ?? "",
      );
      if (normalizedName.length === 0 || seen.has(normalizedName)) continue;
      seen.add(normalizedName);
      stepNames.push(normalizedName);
    }
    if (stepNames.length < 2) return undefined;
    return {
      mode: "exact_steps",
      steps: stepNames.map((name) => ({ name, description: "" })),
      stepNames,
      requiredStepCount: stepNames.length,
      roleHints: extractRoleHints(messageText),
      requiresSynthesis: REQUIRED_DELIVERABLE_CUE_RE.test(messageText),
    };
  }

  return {
    mode: "exact_steps",
    steps,
    stepNames: steps.map((step) => step.name),
    requiredStepCount: steps.length,
    roleHints: extractRoleHints(messageText),
    requiresSynthesis: REQUIRED_DELIVERABLE_CUE_RE.test(messageText),
  };
}

function extractImplicitRequirements(
  messageText: string,
): RequiredSubagentOrchestrationRequirements | undefined {
  if (!AGENT_REQUEST_VERB_RE.test(messageText) || !AGENT_NOUN_RE.test(messageText)) {
    return undefined;
  }
  const roleHints = extractRoleHints(messageText);
  const countMatch = IMPLICIT_AGENT_COUNT_RE.exec(messageText);
  const requestedCount = parseRequestedAgentCount(countMatch?.[1]);
  const hasDistinctRoleCue =
    DISTINCT_ROLE_CUE_RE.test(messageText) ||
    (MULTI_AGENT_ROLE_CUE_RE.test(messageText) && roleHints.length > 0);
  const requiredStepCount =
    requestedCount ??
    (hasDistinctRoleCue && roleHints.length >= 2 ? roleHints.length : undefined);
  if (!requiredStepCount || requiredStepCount < 2) {
    return undefined;
  }
  if (!hasDistinctRoleCue && roleHints.length === 0) {
    return undefined;
  }
  return {
    mode: "minimum_steps",
    steps: [],
    stepNames: [],
    requiredStepCount,
    roleHints,
    requiresSynthesis: REQUIRED_DELIVERABLE_CUE_RE.test(messageText),
  };
}

export function extractRequiredSubagentOrchestrationRequirements(
  messageText: string,
): RequiredSubagentOrchestrationRequirements | undefined {
  return (
    extractExplicitRequirements(messageText) ??
    extractImplicitRequirements(messageText)
  );
}

export function allowsUserMandatedSubagentCardinalityOverride(
  requirements: RequiredSubagentOrchestrationRequirements | undefined,
): boolean {
  return (
    requirements !== undefined &&
    requirements.requiredStepCount > 1
  );
}

export function orchestrationRoleHintRegex(roleHint: string): RegExp | undefined {
  return ROLE_HINT_PATTERNS.find((pattern) => pattern.hint === roleHint)?.re;
}

function joinCandidateRoleText(
  candidate: RequiredSubagentVerificationCandidate,
): string {
  return [
    candidate.name,
    candidate.objective,
    candidate.inputContract,
    ...(candidate.acceptanceCriteria ?? []),
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ");
}

function candidateExecutionStepKind(
  candidate: RequiredSubagentVerificationCandidate,
): ExecutionStepKind | undefined {
  return canonicalizeExecutionStepKind({
    stepKind: candidate.executionContext?.stepKind,
    effectClass: candidate.executionContext?.effectClass,
    verificationMode: candidate.executionContext?.verificationMode,
    targetArtifacts: candidate.executionContext?.targetArtifacts,
  });
}

function isMutableArtifactOwnerCandidate(
  candidate: RequiredSubagentVerificationCandidate,
): boolean {
  const stepKind = candidateExecutionStepKind(candidate);
  return (
    stepKind === "delegated_write" ||
    stepKind === "delegated_scaffold" ||
    candidate.executionContext?.verificationMode === "mutation_required"
  );
}

function isReviewPreferredCandidate(
  candidate: RequiredSubagentVerificationCandidate,
): boolean {
  const stepKind = candidateExecutionStepKind(candidate);
  if (stepKind === "delegated_review" || stepKind === "delegated_validation") {
    return true;
  }
  if (isMutableArtifactOwnerCandidate(candidate)) {
    return false;
  }
  return (
    candidate.executionContext?.verificationMode === "grounded_read" ||
    candidate.executionContext?.effectClass === "read_only" ||
    candidate.executionContext === undefined
  );
}

export function resolveRequiredSubagentVerificationStepNames(params: {
  readonly requirements?: RequiredSubagentOrchestrationRequirements;
  readonly candidates: readonly RequiredSubagentVerificationCandidate[];
}): readonly string[] {
  const requirements = params.requirements;
  if (!requirements) {
    return [];
  }

  const candidatesByNormalizedName = new Map<
    string,
    RequiredSubagentVerificationCandidate
  >();
  for (const candidate of params.candidates) {
    candidatesByNormalizedName.set(
      sanitizePlannerStepName(candidate.name),
      candidate,
    );
  }

  if (requirements.mode === "exact_steps") {
    return requirements.stepNames
      .map((name) => candidatesByNormalizedName.get(name)?.name)
      .filter((name): name is string => typeof name === "string");
  }

  const reviewPreferredCandidates = params.candidates.filter(
    isReviewPreferredCandidate,
  );
  const prioritizedCandidates =
    reviewPreferredCandidates.length >= requirements.requiredStepCount
      ? reviewPreferredCandidates
      : params.candidates.filter(
          (candidate) => !isMutableArtifactOwnerCandidate(candidate),
        );
  const orderedPool =
    prioritizedCandidates.length > 0
      ? prioritizedCandidates
      : params.candidates;

  const selectedNames: string[] = [];
  const seenNames = new Set<string>();

  const trySelect = (
    predicate: (candidate: RequiredSubagentVerificationCandidate) => boolean,
  ): void => {
    const match = orderedPool.find((candidate) => {
      if (seenNames.has(candidate.name)) {
        return false;
      }
      return predicate(candidate);
    });
    if (!match) {
      return;
    }
    seenNames.add(match.name);
    selectedNames.push(match.name);
  };

  for (const roleHint of requirements.roleHints) {
    const roleRe = orchestrationRoleHintRegex(roleHint);
    if (!roleRe) {
      continue;
    }
    trySelect((candidate) => roleRe.test(joinCandidateRoleText(candidate)));
    if (selectedNames.length >= requirements.requiredStepCount) {
      return selectedNames.slice(0, requirements.requiredStepCount);
    }
  }

  for (const candidate of orderedPool) {
    if (selectedNames.length >= requirements.requiredStepCount) {
      break;
    }
    if (seenNames.has(candidate.name)) {
      continue;
    }
    seenNames.add(candidate.name);
    selectedNames.push(candidate.name);
  }

  if (selectedNames.length < requirements.requiredStepCount) {
    for (const candidate of params.candidates) {
      if (selectedNames.length >= requirements.requiredStepCount) {
        break;
      }
      if (seenNames.has(candidate.name)) {
        continue;
      }
      seenNames.add(candidate.name);
      selectedNames.push(candidate.name);
    }
  }

  return selectedNames.slice(0, requirements.requiredStepCount);
}
