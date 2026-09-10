import type { AdmissionUsageSummary, AdmissionUsageTotals } from "../budget/admission-types.js";
import { asRecord } from "../utils/record.js";

function isUsageTotals(value: unknown): value is AdmissionUsageTotals {
  const record = asRecord(value);
  if (record === null || typeof record.hasUnknownCost !== "boolean") return false;
  for (const key of ["costUsd", "heldCostUsd"]) {
    const amount = record[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return false;
  }
  for (const key of ["inputTokens", "outputTokens", "totalTokens", "modelCalls"]) {
    const count = record[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return false;
  }
  return true;
}

export function isAdmissionUsageSummary(value: unknown): value is AdmissionUsageSummary {
  const record = asRecord(value);
  return record !== null && isUsageTotals(record) &&
    typeof record.runId === "string" && record.runId.length > 0 &&
    typeof record.sequence === "number" && Number.isSafeInteger(record.sequence) && record.sequence >= 0 &&
    Array.isArray(record.models) && record.models.every((entry: unknown) => {
      const model = asRecord(entry);
      return model !== null && isUsageTotals(model) &&
        typeof model.model === "string" &&
        (model.provider === undefined || typeof model.provider === "string");
    }) &&
    Array.isArray(record.agents) && record.agents.every((entry: unknown) => {
      const agent = asRecord(entry);
      return agent !== null && isUsageTotals(agent) &&
        typeof agent.runId === "string" && agent.runId.length > 0;
    });
}

export function latestSessionUsage(
  current: AdmissionUsageSummary | null,
  event: unknown,
): AdmissionUsageSummary | null {
  const record = asRecord(event);
  const message = asRecord(record?.msg) ?? record;
  if (message?.type !== "session_usage" || !isAdmissionUsageSummary(message.payload)) return current;
  const summary = message.payload;
  if (current !== null && (summary.runId !== current.runId || summary.sequence <= current.sequence)) return current;
  return summary;
}
