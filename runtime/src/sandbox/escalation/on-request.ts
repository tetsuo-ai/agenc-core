import { isDangerousShellCommand } from "../../permissions/dangerous-patterns.js";

export interface EscalationGuidanceOptions {
  readonly includeRuleGuidance?: boolean;
  readonly includeExamples?: boolean;
}

export const SANDBOX_ESCALATION_PERMISSION = "require_escalated";

export function renderOnRequestEscalationGuidance(
  options: EscalationGuidanceOptions = {},
): string {
  const includeRuleGuidance = options.includeRuleGuidance ?? true;
  const includeExamples = options.includeExamples ?? true;
  const lines = [
    "Commands run outside the sandbox only after user approval or an existing allow rule.",
    "Split shell commands into independent command segments before checking restrictions.",
    "Request full escalation with sandbox_permissions=\"require_escalated\" and a short justification question.",
  ];
  if (includeRuleGuidance) {
    lines.push(
      "Suggest a prefix_rule only when it is narrow, reusable, and not destructive.",
    );
  }
  if (includeExamples) {
    lines.push(
      "Good prefix_rule examples include [\"npm\", \"run\", \"dev\"] and [\"cargo\", \"test\"].",
    );
  }
  return lines.join("\n");
}

export function shouldRetryWithEscalationAfterFailure(
  errorText: string,
): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes("sandbox") ||
    lower.includes("permission denied") ||
    lower.includes("operation not permitted") ||
    lower.includes("eacces") ||
    lower.includes("network is unreachable") ||
    lower.includes("temporary failure in name resolution") ||
    lower.includes("could not resolve host") ||
    lower.includes("registry") ||
    lower.includes("package index")
  );
}

export function prefixRuleAllowedForCommand(
  command: readonly string[],
): boolean {
  if (command.length === 0) return false;
  const joined = command.join(" ");
  if (joined.includes("<<") || joined.includes("<<<")) return false;
  if (isDangerousShellCommand(joined)) return false;
  if (/\bgit(?:\s+-C\s+\S+)?\s+reset\b[\s\S]*\s--hard\b/u.test(joined)) {
    return false;
  }
  if (/\brm\b|\bdd\b|\bmkfs\b/u.test(joined)) return false;
  const head = command[0] ?? "";
  return head !== "python" && head !== "python3" && head !== "node";
}
