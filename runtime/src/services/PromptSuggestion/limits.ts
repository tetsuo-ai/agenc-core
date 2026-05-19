/**
 * Local rate-limit view used by the prompt-suggestion service.
 *
 * AgenC's API layer owns the full quota object. This service keeps only the
 * status slice PromptSuggestion needs; quota emitters push updates here.
 */

export type PromptSuggestionLimitStatus =
  | "allowed"
  | "allowed_warning"
  | "rejected";

export interface PromptSuggestionLimits {
  readonly status: PromptSuggestionLimitStatus;
}

let currentLimits: PromptSuggestionLimits = {
  status: "allowed",
};
let testLimits: PromptSuggestionLimits | null = null;

function normalizeStatus(status: unknown): PromptSuggestionLimitStatus {
  return status === "allowed" ||
    status === "allowed_warning" ||
    status === "rejected"
    ? status
    : "allowed";
}

export function getPromptSuggestionLimits(): PromptSuggestionLimits {
  if (testLimits) return testLimits;
  return {
    status: normalizeStatus(currentLimits.status),
  };
}

export function updatePromptSuggestionLimits(
  limits: { readonly status?: unknown },
): void {
  currentLimits = {
    status: normalizeStatus(limits.status),
  };
}

export function setPromptSuggestionLimitsForTests(
  limits: PromptSuggestionLimits | null,
): void {
  if (!limits) {
    testLimits = null;
    currentLimits = { status: "allowed" };
    return;
  }
  const normalized = { status: normalizeStatus(limits.status) };
  testLimits = normalized;
  currentLimits = normalized;
}
