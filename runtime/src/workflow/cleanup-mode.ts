import {
  type DelegationOutputValidationCode,
  DELEGATION_OUTPUT_VALIDATION_CODES,
} from "../utils/delegation-validation.js";
import {
  type RuntimeVerificationChannelName,
  RUNTIME_VERIFICATION_CHANNEL_NAMES,
} from "./verification-results.js";

export const PLANNER_DELEGATION_VERIFIER_CLEANUP_MODE = {
  id: "phase0_freeze_semantics",
  active: true,
  declaredAt: "2026-03-29",
  scope: "planner_delegation_verifier",
  docs: {
    guide: "docs/architecture/guides/workflow-cleanup-mode.md",
    incidents: "runtime/benchmarks/v1/incidents/README.md",
  },
} as const;

export const PLANNER_VERIFIER_LITERAL_ISSUE_CODES = [
  "planner_verifier_unavailable",
  "planner_verifier_parse_failed",
  "missing_subagent_result",
  "missing_implementation_output_evidence",
  "malformed_subagent_result_payload",
  "child_reported_failure",
  "child_cancelled",
  "child_used_parent_fallback",
  "empty_child_output",
  "contract_violation_expected_json_output",
  "contract_violation_acceptance_criteria_count",
  "acceptance_criteria_not_evidenced",
  "child_claimed_completion_with_unresolved_work",
  "low_signal_browser_evidence",
  "missing_successful_tool_evidence",
  "missing_required_source_evidence",
  "missing_workspace_inspection_evidence",
  "missing_or_unauthorized_target_artifact_evidence",
  "missing_required_reviewer_children",
  "weak_evidence_density",
  "hallucination_risk_artifact_mismatch",
  "missing_tool_result_consistency_signal",
] as const;

export type PlannerVerifierLiteralIssueCode =
  typeof PLANNER_VERIFIER_LITERAL_ISSUE_CODES[number];

export const PLANNER_VERIFIER_CONTRACT_VIOLATION_CODES = [
  "acceptance_probe_failed",
  "missing_behavior_harness",
  "forbidden_phase_action",
  "blocked_phase_output",
  "missing_file_mutation_evidence",
] as const satisfies readonly DelegationOutputValidationCode[];

export type PlannerVerifierContractViolationIssueCode =
  `contract_violation_${typeof PLANNER_VERIFIER_CONTRACT_VIOLATION_CODES[number]}`;

export type PlannerVerifierRuntimeChannelIssueCode =
  `${RuntimeVerificationChannelName}:${DelegationOutputValidationCode}`;

export type PlannerVerifierIssueCode =
  | PlannerVerifierLiteralIssueCode
  | PlannerVerifierContractViolationIssueCode
  | PlannerVerifierRuntimeChannelIssueCode;

export const PLANNER_CLEANUP_COMPATIBILITY_OVERRIDE_FLAGS = [
  "explicitDelegationCompatibilityOverride",
  "directToolCompatibilityOverride",
] as const;

export type PlannerCleanupCompatibilityOverrideFlag =
  typeof PLANNER_CLEANUP_COMPATIBILITY_OVERRIDE_FLAGS[number];

export const PHASE0_MUST_PASS_INCIDENT_FIXTURES = [
  "allowlist-access-denied",
  "delegated-split-workspace-root",
  "delegation-fallback-dual-truth",
  "noop-success-rejected",
  "readonly-review-overdelegated",
  "shell-stub-false-completion",
  "ungrounded-writer-fabrication",
  "wrong-workspace-root",
] as const;

export const PHASE0_OPEN_FAILURE_CLASSES = [
  "reviewer_writer_contract_collapse",
  "needs_verification_child_deadlock",
  "tool_routing_fail_open",
  "follow_up_tool_schema_suppression",
  "request_tree_budget_reset_across_retries",
] as const;

export function mapDelegationValidationCodeToPlannerVerifierIssue(
  code: DelegationOutputValidationCode,
): PlannerVerifierIssueCode {
  switch (code) {
    case "empty_output":
      return "empty_child_output";
    case "empty_structured_payload":
    case "expected_json_object":
      return "contract_violation_expected_json_output";
    case "acceptance_count_mismatch":
      return "contract_violation_acceptance_criteria_count";
    case "acceptance_evidence_missing":
      return "acceptance_criteria_not_evidenced";
    case "contradictory_completion_claim":
      return "child_claimed_completion_with_unresolved_work";
    case "low_signal_browser_evidence":
      return "low_signal_browser_evidence";
    case "missing_successful_tool_evidence":
      return "missing_successful_tool_evidence";
    case "missing_required_source_evidence":
      return "missing_required_source_evidence";
    case "missing_workspace_inspection_evidence":
      return "missing_workspace_inspection_evidence";
    case "missing_file_artifact_evidence":
      return "missing_or_unauthorized_target_artifact_evidence";
    case "acceptance_probe_failed":
    case "missing_behavior_harness":
    case "forbidden_phase_action":
    case "blocked_phase_output":
    case "missing_file_mutation_evidence":
      return `contract_violation_${code}`;
    default:
      return assertNever(code);
  }
}

export function formatRuntimeVerificationIssueCode(params: {
  readonly channel: RuntimeVerificationChannelName;
  readonly code: DelegationOutputValidationCode;
}): PlannerVerifierRuntimeChannelIssueCode {
  if (!RUNTIME_VERIFICATION_CHANNEL_NAMES.includes(params.channel)) {
    throw new Error(
      `Unknown runtime verification channel in cleanup mode: ${params.channel}`,
    );
  }
  if (!DELEGATION_OUTPUT_VALIDATION_CODES.includes(params.code)) {
    throw new Error(
      `Unknown delegation validation code in cleanup mode: ${params.code}`,
    );
  }
  return `${params.channel}:${params.code}`;
}

export function isPlannerVerifierIssueCode(
  value: string,
): value is PlannerVerifierIssueCode {
  if (
    (PLANNER_VERIFIER_LITERAL_ISSUE_CODES as readonly string[]).includes(value)
  ) {
    return true;
  }
  if (
    value.startsWith("contract_violation_") &&
    (
      PLANNER_VERIFIER_CONTRACT_VIOLATION_CODES as readonly string[]
    ).includes(value.slice("contract_violation_".length))
  ) {
    return true;
  }

  const separatorIndex = value.indexOf(":");
  if (separatorIndex <= 0) {
    return false;
  }
  const channel = value.slice(0, separatorIndex);
  const code = value.slice(separatorIndex + 1);
  return (
    (RUNTIME_VERIFICATION_CHANNEL_NAMES as readonly string[]).includes(channel) &&
    (DELEGATION_OUTPUT_VALIDATION_CODES as readonly string[]).includes(code)
  );
}

function assertNever(value: never): never {
  throw new Error(`Unhandled cleanup-mode value: ${String(value)}`);
}
