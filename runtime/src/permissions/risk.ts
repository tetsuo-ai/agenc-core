export type ApprovalRiskTier = "low" | "medium" | "destructive";

export function classifyApprovalRisk(input: {
  readonly request?: { readonly ctx?: { readonly toolName?: unknown } };
  readonly toolName?: string;
  readonly description?: string;
  readonly command?: string;
}): ApprovalRiskTier {
  const requestToolName =
    typeof input.request?.ctx?.toolName === "string"
      ? input.request.ctx.toolName
      : undefined;
  const haystack = [
    requestToolName,
    input.toolName,
    input.description,
    input.command,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/\b(rm\s+-rf|delete|destroy|wipe|format|mainnet|settle|stake|transfer|slash|escrow)\b/u.test(haystack)) {
    return "destructive";
  }
  if (/\b(write|edit|patch|chmod|chown|mv|deploy|install|network|curl|wget)\b/u.test(haystack)) {
    return "medium";
  }
  return "low";
}

export function typedConfirmationWordForRisk(input: {
  readonly risk: ApprovalRiskTier;
  readonly command?: string;
  readonly description?: string;
}): string {
  if (input.risk !== "destructive") return "yes";
  const haystack = [input.command, input.description].filter(Boolean).join(" ").toLowerCase();
  if (/\bsettle\b/u.test(haystack)) return "settle";
  if (/\bstake\b/u.test(haystack)) return "stake";
  if (/\btransfer\b/u.test(haystack)) return "transfer";
  if (/\bdelete|destroy|wipe|rm\s+-rf\b/u.test(haystack)) return "delete";
  return "approve";
}
