import type { AuthAgencModel, AuthBackend, AuthLlmUsageAllowance } from "./backend.js";
import { hasActivePilotModelAccess } from "./pilot-access.js";

export interface AccountModelAccess {
  readonly authenticated: boolean;
  readonly unavailable?: boolean;
  readonly managedModelsEnabled?: boolean;
  readonly subscriptionTier?: string;
  readonly allowance?: AuthLlmUsageAllowance;
  readonly models: readonly AuthAgencModel[];
  readonly expiresAt?: string;
}

/**
 * Resolve access using Core's native credential store. No tokens, upstream
 * credentials or account identity cross this boundary. Usage may enroll an
 * eligible promotional account; listing never vends a key or runs inference.
 */
export async function readAccountModelAccess(
  backend: AuthBackend,
  nowMs = Date.now(),
): Promise<AccountModelAccess> {
  let authenticated = false;
  try {
    const account = await backend.whoami({ sessionId: "cli" });
    authenticated = account.authenticated;
    if (!authenticated) return { authenticated: false, models: [] };
    if (backend.kind !== "remote" || backend.managedKeysEnabled === false) return { authenticated: true, managedModelsEnabled: false, models: [] };
    const usage = await backend.getLlmUsage({ sessionId: "cli" });
    const result = {
      authenticated: true,
      managedModelsEnabled: usage.managedModelsEnabled,
      subscriptionTier: usage.subscriptionTier,
      allowance: usage.modelAllowance,
    };
    const allowed = usage.pilotAccess?.models.filter(model => hasActivePilotModelAccess(usage, model, nowMs)) ?? [];
    if (allowed.length === 0 || usage.modelAllowance.remainingUsd === 0) return { ...result, models: [] };
    try {
      const catalog = backend.listAgencModels === undefined
        ? allowed.map(id => ({ id, name: id }))
        : await backend.listAgencModels();
      const models = catalog.filter(model => allowed.includes(model.id));
      return { ...result, models, expiresAt: usage.pilotAccess!.expiresAt };
    } catch {
      // Balance remains real when discovery is unavailable. A stale catalog
      // must never make a removed or paused model selectable.
      return { ...result, unavailable: true, models: [] };
    }
  } catch {
    return { authenticated, unavailable: true, models: [] };
  }
}

export function accountDefaultModel(access: AccountModelAccess, preferred?: string): string | undefined {
  if (!access.authenticated || access.unavailable || access.managedModelsEnabled !== true) return undefined;
  return access.models.find(model => model.id === preferred)?.id ?? access.models[0]?.id;
}

/** Validate and project the backend catalog; never forward arbitrary fields. */
export function parseAgencModelCatalog(value: unknown): readonly AuthAgencModel[] {
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) {
    throw new Error("Invalid AgenC model catalog");
  }
  const rows = (value as { data: unknown[] }).data;
  if (rows.length > 256) throw new Error("Invalid AgenC model catalog");
  const seen = new Set<string>();
  return rows.map(value => {
    if (!value || typeof value !== "object") throw new Error("Invalid AgenC model catalog");
    const row = value as Record<string, unknown>;
    const validText = (v: unknown): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(v);
    if (row.provider !== "agenc" || !validText(row.id) || !validText(row.name) || seen.has(row.id)) throw new Error("Invalid AgenC model catalog");
    seen.add(row.id);
    const positiveInteger = (key: string): number | undefined => {
      const number = row[key];
      if (number === undefined) return undefined;
      if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) throw new Error("Invalid AgenC model catalog");
      return number;
    };
    const contextWindow = positiveInteger("context_length");
    const maxOutputTokens = positiveInteger("max_completion_tokens");
    return { id: row.id, name: row.name,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    };
  });
}
