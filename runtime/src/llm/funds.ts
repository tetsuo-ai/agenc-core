/** Provider billing refusals. Keep this independent of retry and agent modules. */
function record(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string" && value.trimStart().startsWith("{")) {
    try { return record(JSON.parse(value)); } catch { return undefined; }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nestedCode(value: unknown): string | undefined {
  const item = record(value);
  if (item === undefined) return undefined;
  if (typeof item.code === "string") return item.code;
  if (typeof item.type === "string") return item.type;
  return record(item.error) === undefined ? undefined : nestedCode(item.error);
}

function nestedText(value: unknown): string {
  const item = record(value);
  if (item === undefined) return typeof value === "string" ? value : "";
  return [item.message, item.error, record(item.error)?.message]
    .filter((part): part is string => typeof part === "string").join(" ");
}

function geminiLongQuota(value: unknown): boolean {
  const item = record(value);
  const error = record(item?.error) ?? item;
  const details = error?.details;
  if (!Array.isArray(details)) return false;
  // Per-minute quota violations are ordinary throttling. Daily / paid-tier
  // quota exhaustion needs an account change or a new quota window.
  return details.some((detail) => {
    const violations = record(detail)?.violations;
    return Array.isArray(violations) && violations.some((violation) => {
      const quotaText = JSON.stringify(violation).toLowerCase();
      return /perday|per_day|daily|billing/.test(quotaText) ||
        (/free.?tier/.test(quotaText) && !/perminute|per_minute/.test(quotaText));
    });
  });
}

export function isProviderFundsFailure(providerName: string, error: unknown): boolean {
  const provider = providerName.toLowerCase();
  let current: unknown = error;
  for (let depth = 0; depth < 5; depth += 1) {
    const item = record(current);
    if (item === undefined) break;
    if (item.name === "LLMFundsError") return true;
    if (item.name === "LLMManagedAdmissionError" &&
      (item.reason === "insufficient_credits" || item.reason === "credits_unavailable")) return true;
    const status = item.status ?? item.statusCode;
    const code = nestedCode(item) ?? nestedCode(item.body);
    const message = `${nestedText(item)} ${nestedText(item.body)}`.toLowerCase();
    if (status === 402 && (code === "insufficient_credits" || code === "credits_unavailable")) return true;
    if ((provider === "deepseek" || provider === "openrouter" || provider === "agenc") && status === 402) return true;
    if (provider === "openai" || provider === "codex" || provider === "chatgpt") {
      if (["insufficient_quota", "credit_balance_exhausted", "organization_usage_limit_exceeded",
        "organization_spend_limit_exceeded", "project_spend_limit_exceeded",
        "usage_limit_reached", "usage_limit_exceeded", "usage_not_included", "usage_limit"].includes(code ?? "")) return true;
      if (/chatgpt usage limit|subscription usage limit/.test(message)) return true;
      if (status === 429 && /insufficient_quota|usage_limit_reached|usage_not_included|credit_balance_exhausted/.test(message)) return true;
    }
    if (provider === "anthropic" && /credit balance is too low/.test(message)) return true;
    if ((provider === "grok" || provider === "xai") && status === 403 &&
      (code === "personal-team-blocked:spending-limit" ||
        /you have run out of credits or need a grok subscription/.test(message))) return true;
    const bodyError = record(record(item.body)?.error);
    if (provider === "gemini" &&
      (code === "RESOURCE_EXHAUSTED" || record(item.error)?.status === "RESOURCE_EXHAUSTED" ||
       bodyError?.status === "RESOURCE_EXHAUSTED") &&
      (geminiLongQuota(item) || geminiLongQuota(item.body))) return true;
    if (provider === "openrouter" && status === 429 && /requires more credits|insufficient credits|monthly limit/.test(message)) return true;
    current = item.cause ?? item.originalError;
  }
  return false;
}
