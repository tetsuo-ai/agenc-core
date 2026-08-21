import type { RunArtifactPointer } from "../contracts/run-contracts.js";

/** Exact media types pinned by the verified-change evidence contract. */
export const WORKFLOW_ARTIFACT_MEDIA_TYPES = Object.freeze({
  base_state: "application/vnd.agenc.workflow.base-state.v1+json",
  patch: "text/x-patch",
  changed_files: "text/plain",
  test_result: "application/vnd.agenc.workflow.test-result.v1+json",
  independent_review: "application/json",
  cost_usage: "application/vnd.agenc.workflow.cost-usage.v1+json",
  effect_log: "application/vnd.agenc.workflow.effect-log.v1+json",
  risk_register: "application/vnd.agenc.workflow.risk-register.v1+json",
  verification_stdout:
    "application/vnd.agenc.workflow.command-stdout.v1+octet-stream",
  verification_stderr:
    "application/vnd.agenc.workflow.command-stderr.v1+octet-stream",
} as const satisfies Partial<Record<RunArtifactPointer["role"], string>>);

export function sanitizeWorkflowEvidenceIdentifier(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "-");
}

/**
 * Stable ledger event identity for one artifact pointer. Keeping this shared
 * lets the strict reader bind a pointer to the exact event/media type instead
 * of guessing from another event that happens to carry equal payload bytes.
 */
export function workflowArtifactEventId(input: {
  readonly stepId: string;
  readonly role: RunArtifactPointer["role"];
  readonly digest: string;
}): string {
  const hex = input.digest.slice("sha256:".length);
  return sanitizeWorkflowEvidenceIdentifier(
    `artifact.${input.stepId}.${input.role}.${hex.slice(0, 24)}`,
  );
}
