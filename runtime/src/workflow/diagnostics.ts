import { redactSecrets, redactSecretsInValue } from "../secrets/index.js";

export const DEFAULT_WORKFLOW_DIAGNOSTIC_LIMIT = 240;

/**
 * Render untrusted workflow diagnostics for durable errors and operator logs.
 * Redaction happens before truncation so a cut cannot expose a secret prefix.
 */
export function boundedWorkflowDiagnostic(
  value: unknown,
  limit = DEFAULT_WORKFLOW_DIAGNOSTIC_LIMIT,
): string {
  const boundedLimit =
    Number.isSafeInteger(limit) && limit > 0
      ? limit
      : DEFAULT_WORKFLOW_DIAGNOSTIC_LIMIT;
  const flat = redactSecrets(diagnosticText(value))
    .replace(/\s+/gu, " ")
    .trim();
  if (flat.length === 0) return "(empty response)";
  return flat.length > boundedLimit
    ? `${flat.slice(0, Math.max(0, boundedLimit - 1))}…`
    : flat;
}

function diagnosticText(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    const redacted = redactSecretsInValue(value);
    return typeof redacted === "string"
      ? redacted
      : (JSON.stringify(redacted) ?? String(redacted));
  } catch {
    try {
      return Object.prototype.toString.call(value);
    } catch {
      return "[unavailable diagnostic]";
    }
  }
}
