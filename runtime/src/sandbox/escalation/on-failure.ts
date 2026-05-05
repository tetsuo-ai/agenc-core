export function renderOnFailureApprovalGuidance(): string {
  return [
    "Approval policy is on-failure.",
    "Run the first attempt inside the selected sandbox.",
    "If the command fails because the sandbox blocked it, request approval before retrying without the sandbox.",
  ].join("\n");
}

export function onFailureEscalationReason(
  failureMessage: string,
): string {
  const trimmed = failureMessage.trim();
  return trimmed.length > 0
    ? `Sandboxed command failed: ${trimmed}`
    : "Sandboxed command failed; retry without the sandbox?";
}
