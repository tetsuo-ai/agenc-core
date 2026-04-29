import { safeStringify } from "../tools/types.js";

type DelegatedScopeTrustClass =
  | "trusted_authoritative"
  | "informational_untrusted"
  | "rejected_invalid_scope";

interface DelegatedScopeTrustAssessment {
  readonly delegatedScopeTrust: DelegatedScopeTrustClass;
  readonly delegatedScopeTrustReason: string;
  readonly delegatedScopeContainsEnvironmentFact: boolean;
}

const TRUST_CLASSES = new Set<DelegatedScopeTrustClass>([
  "trusted_authoritative",
  "informational_untrusted",
  "rejected_invalid_scope",
]);

const INVALID_SCOPE_ISSUE_CODES = new Set([
  "missing_execution_context",
  "missing_workspace_root",
  "workspace_root_mismatch",
  "read_root_outside_workspace_root",
  "write_root_outside_workspace_root",
  "required_source_outside_workspace_root",
  "target_outside_workspace_root",
  "workspace_root_missing_for_required_sources",
  "missing_parent_workspace_authority",
  "workspace_root_outside_parent_workspace",
  "read_root_outside_parent_workspace",
  "write_root_outside_parent_workspace",
  "input_artifact_outside_parent_workspace",
  "required_source_outside_parent_workspace",
  "target_outside_parent_workspace",
]);

const INVALID_SCOPE_VALIDATION_CODES = new Set([
  "missing_execution_context",
]);

const INVALID_SCOPE_MESSAGE_RE =
  /\b(?:missing_execution_context|trusted parent workspace root|canonical workspace root|child working directory|outside the trusted parent workspace|outside the canonical workspace root|delegated local-file work must have a canonical workspace root|requires a trusted parent workspace root|first trusted child root|does not accept executionContext\.workspaceRoot)\b/i;
const DELEGATED_SCOPE_OUTPUT_RE =
  /\b(?:subagent|child|delegated)\b[\s\S]{0,32}\b(?:cwd|current working directory|working directory|workspace root)\b/i;
const DELEGATED_SCOPE_TASK_RE =
  /\b(?:pwd|cwd|current working directory|working directory|workspace root|what(?:'s| is)? the current working directory|what(?:'s| is)? the workspace root)\b/i;
const ASSISTANT_DELEGATED_SCOPE_SUMMARY_RE =
  /\b(?:subagent|child|delegated)\b[\s\S]{0,24}\b(?:cwd|current working directory|working directory|workspace root)\b/i;
const ABSOLUTE_PATH_OUTPUT_RE = /^(?:\/|~|[A-Za-z]:[\\/])[^\n\r]*$/;

function parseObject(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractDelegatedTaskText(
  args: Record<string, unknown> | undefined,
): string {
  if (!args) return "";
  const task = args.task;
  if (typeof task === "string" && task.trim().length > 0) {
    return task.trim();
  }
  const objective = args.objective;
  return typeof objective === "string" ? objective.trim() : "";
}

function extractIssueCodes(parsed: Record<string, unknown>): readonly string[] {
  const issues = parsed.issues;
  if (!Array.isArray(issues)) return [];
  return issues.flatMap((issue) => {
    if (typeof issue !== "object" || issue === null || Array.isArray(issue)) {
      return [];
    }
    const code = (issue as { code?: unknown }).code;
    return typeof code === "string" && code.trim().length > 0
      ? [code.trim()]
      : [];
  });
}

function isInvalidScopeFailure(parsed: Record<string, unknown>): boolean {
  const validationCode =
    typeof parsed.validationCode === "string"
      ? parsed.validationCode.trim().toLowerCase()
      : "";
  if (INVALID_SCOPE_VALIDATION_CODES.has(validationCode)) {
    return true;
  }

  const issueCodes = extractIssueCodes(parsed);
  if (issueCodes.some((code) => INVALID_SCOPE_ISSUE_CODES.has(code))) {
    return true;
  }

  const pieces = [
    typeof parsed.error === "string" ? parsed.error : "",
    typeof parsed.output === "string" ? parsed.output : "",
  ]
    .filter((value) => value.length > 0)
    .join("\n");
  return INVALID_SCOPE_MESSAGE_RE.test(pieces);
}

function isDelegatedEnvironmentClaimOutput(params: {
  readonly args?: Record<string, unknown>;
  readonly output: string;
}): boolean {
  const trimmed = params.output.trim();
  if (trimmed.length === 0) return false;
  if (DELEGATED_SCOPE_OUTPUT_RE.test(trimmed)) return true;
  const delegatedTask = extractDelegatedTaskText(params.args);
  return (
    delegatedTask.length > 0 &&
    DELEGATED_SCOPE_TASK_RE.test(delegatedTask) &&
    ABSOLUTE_PATH_OUTPUT_RE.test(trimmed)
  );
}

function isDelegatedAssistantEnvironmentSummary(
  content: string,
): boolean {
  return ASSISTANT_DELEGATED_SCOPE_SUMMARY_RE.test(content);
}

export function sanitizeDelegatedAssistantEnvironmentSummary(
  content: string,
): string {
  if (!isDelegatedAssistantEnvironmentSummary(content)) {
    return content;
  }
  return "[assistant summary omitted: delegated cwd/workspace-root claim not replayed]";
}

export function assessExecuteWithAgentResult(params: {
  readonly args?: Record<string, unknown>;
  readonly result: string;
}): DelegatedScopeTrustAssessment | undefined {
  const parsed = parseObject(params.result);
  if (!parsed) return undefined;

  const existingTrust = parsed.delegatedScopeTrust;
  const existingReason = parsed.delegatedScopeTrustReason;
  const existingContainsEnvironmentFact =
    parsed.delegatedScopeContainsEnvironmentFact;
  if (
    typeof existingTrust === "string" &&
    TRUST_CLASSES.has(existingTrust as DelegatedScopeTrustClass)
  ) {
    return {
      delegatedScopeTrust: existingTrust as DelegatedScopeTrustClass,
      delegatedScopeTrustReason:
        typeof existingReason === "string" && existingReason.trim().length > 0
          ? existingReason.trim()
          : "annotated_execute_with_agent_result",
      delegatedScopeContainsEnvironmentFact:
        existingContainsEnvironmentFact === true,
    };
  }

  if (isInvalidScopeFailure(parsed)) {
    return {
      delegatedScopeTrust: "rejected_invalid_scope",
      delegatedScopeTrustReason: "runtime_scope_rejection",
      delegatedScopeContainsEnvironmentFact: false,
    };
  }

  const output = typeof parsed.output === "string" ? parsed.output.trim() : "";
  if (
    output.length > 0 &&
    isDelegatedEnvironmentClaimOutput({ args: params.args, output })
  ) {
    return {
      delegatedScopeTrust: "informational_untrusted",
      delegatedScopeTrustReason: "delegated_environment_claim",
      delegatedScopeContainsEnvironmentFact: true,
    };
  }

  return {
    delegatedScopeTrust: "trusted_authoritative",
    delegatedScopeTrustReason: "runtime_approved_result",
    delegatedScopeContainsEnvironmentFact: false,
  };
}

export function annotateExecuteWithAgentResult(params: {
  readonly args?: Record<string, unknown>;
  readonly payload: Record<string, unknown>;
}): string {
  const assessment = assessExecuteWithAgentResult({
    args: params.args,
    result: safeStringify(params.payload),
  }) ?? {
    delegatedScopeTrust: "trusted_authoritative" as const,
    delegatedScopeTrustReason: "runtime_approved_result",
    delegatedScopeContainsEnvironmentFact: false,
  };

  return safeStringify({
    ...params.payload,
    delegatedScopeTrust: assessment.delegatedScopeTrust,
    delegatedScopeTrustReason: assessment.delegatedScopeTrustReason,
    delegatedScopeContainsEnvironmentFact:
      assessment.delegatedScopeContainsEnvironmentFact,
  });
}

export function buildAssistantDelegatedScopeMetadata(params: {
  readonly content: string;
  readonly toolCalls: readonly {
    readonly name: string;
    readonly args?: Record<string, unknown>;
    readonly result: string;
  }[];
}): Record<string, unknown> | undefined {
  if (!isDelegatedAssistantEnvironmentSummary(params.content)) {
    return undefined;
  }

  const assessments = params.toolCalls
    .filter((toolCall) => toolCall.name === "execute_with_agent")
    .map((toolCall) =>
      assessExecuteWithAgentResult({
        args: toolCall.args,
        result: toolCall.result,
      })
    )
    .filter(
      (assessment): assessment is DelegatedScopeTrustAssessment =>
        assessment !== undefined,
    );

  const delegatedScopeTrust = assessments.some(
    (assessment) => assessment.delegatedScopeTrust === "rejected_invalid_scope",
  )
    ? "rejected_invalid_scope"
    : assessments.some(
        (assessment) =>
          assessment.delegatedScopeTrust === "informational_untrusted",
      )
      ? "informational_untrusted"
      : "trusted_authoritative";

  return {
    delegatedScopeTrust,
    delegatedScopeTrustReason:
      delegatedScopeTrust === "rejected_invalid_scope"
        ? "assistant_summary_after_scope_rejection"
        : "assistant_delegated_environment_summary",
    delegatedScopeContainsEnvironmentFact: true,
    memoryRole: "working",
  };
}
