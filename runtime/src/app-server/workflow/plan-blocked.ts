import { boundedWorkflowDiagnostic } from "../../workflow/diagnostics.js";

export const PLAN_BLOCKED_KIND = "agenc.goal.plan-blocked.v1" as const;
const MAX_EXPLANATION_LENGTH = 2000;
const MAX_REQUIREMENT_LENGTH = 1000;
const MAX_RESPONSE_LENGTH = 12_000;

export interface WorkflowPlanBlocked {
  readonly kind: typeof PLAN_BLOCKED_KIND;
  readonly reason: "requirement_conflict";
  readonly explanation: string;
  readonly conflictingRequirements: readonly string[];
}

function boundedText(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= limit;
}

/** Validate durable evidence with the same rules as a fresh planner response. */
export function readPlanBlocked(value: unknown): WorkflowPlanBlocked | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const report = value as Record<string, unknown>;
  if (Object.keys(report).length !== 4 ||
    !Object.keys(report).every(key => ["kind", "reason", "explanation", "conflictingRequirements"].includes(key)) || report.kind !== PLAN_BLOCKED_KIND ||
    report.reason !== "requirement_conflict" || !boundedText(report.explanation, MAX_EXPLANATION_LENGTH) ||
    !Array.isArray(report.conflictingRequirements) || report.conflictingRequirements.length < 2 ||
    report.conflictingRequirements.length > 8 ||
    !report.conflictingRequirements.every(value => boundedText(value, MAX_REQUIREMENT_LENGTH))) return undefined;
  const requirements = report.conflictingRequirements.map(value => boundedWorkflowDiagnostic(value, MAX_REQUIREMENT_LENGTH));
  if (new Set(requirements).size !== requirements.length) return undefined;
  return {
    kind: PLAN_BLOCKED_KIND,
    reason: "requirement_conflict",
    explanation: boundedWorkflowDiagnostic(report.explanation, MAX_EXPLANATION_LENGTH),
    conflictingRequirements: requirements,
  };
}

/** Only a complete raw JSON response is a control result. Prose and examples stay plans. */
export function parsePlanBlockedResponse(response: string | null): WorkflowPlanBlocked | undefined {
  if (response === null || response.length > MAX_RESPONSE_LENGTH) return undefined;
  try {
    return readPlanBlocked(JSON.parse(response));
  } catch {
    return undefined;
  }
}

export const PLAN_BLOCKED_INSTRUCTIONS = [
  "Only if explicit requirements directly contradict one another, you may stop this Goal during planning.",
  "Inspect the relevant files and checks first. A missing detail, product name, architecture choice, empty repository, uncertainty, or ordinary ambiguity is not a requirement conflict. Choose a reasonable interpretation and continue planning in those cases.",
  "To report a requirement conflict, return only a raw JSON object with exactly these four fields and no markdown fence or other text:",
  '{"kind":"agenc.goal.plan-blocked.v1","reason":"requirement_conflict","explanation":"Explain why the listed requirements cannot both be met.","conflictingRequirements":["First explicit requirement","Second explicit requirement"]}',
  "The explanation must be nonempty and at most 2000 characters. Include 2 to 8 distinct nonempty requirement strings, each at most 1000 characters.",
  "This report ends the Goal as failed. It does not claim completion or override verification. Do not include an agenc-verification block with a conflict report.",
].join("\n");
