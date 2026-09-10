import type { AuthLlmUsage, AuthPilotAccess } from "./backend.js";

export function normalizePilotAccess(value: unknown): AuthPilotAccess | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.provider !== "agenc" ||
    !Array.isArray(record.models) || record.models.length === 0 ||
    record.models.length > 32 ||
    !record.models.every((model) => typeof model === "string" && model.trim() === model && model.length > 0) ||
    typeof record.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(record.expiresAt))
  ) return undefined;
  return { provider: "agenc", models: [...record.models], expiresAt: record.expiresAt };
}

export function hasActivePilotModelAccess(
  usage: AuthLlmUsage,
  model: string | undefined,
  nowMs = Date.now(),
): boolean {
  const access = normalizePilotAccess(usage.pilotAccess);
  return usage.managedModelsEnabled === true &&
    usage.modelAllowance.status === "active" &&
    usage.modelAllowance.allowedModelCount > 0 &&
    access !== undefined &&
    Date.parse(access.expiresAt) > nowMs &&
    model !== undefined && access.models.includes(model);
}
