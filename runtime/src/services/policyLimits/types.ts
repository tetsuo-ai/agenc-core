/**
 * branding-scan: allow donor source citation for the S-08 parity record
 * Ports openclaude `src/services/policyLimits/types.ts` onto AgenC-owned
 * policy-limit response contracts.
 *
 * Shape differences from upstream:
 *   - AgenC keeps validation dependency-free and exposes a small parser
 *     instead of carrying the donor schema wrapper.
 */

export interface PolicyRestriction {
  readonly allowed: boolean;
}

export type PolicyLimitsRestrictions = Record<string, PolicyRestriction>;

export interface PolicyLimitsResponse {
  readonly restrictions: PolicyLimitsRestrictions;
}

export interface PolicyLimitsFetchResult {
  readonly success: boolean;
  readonly restrictions?: PolicyLimitsRestrictions | null;
  readonly etag?: string;
  readonly error?: string;
  readonly skipRetry?: boolean;
}

export function parsePolicyLimitsResponse(
  value: unknown,
): PolicyLimitsResponse | null {
  if (!isRecord(value)) return null;
  const restrictions = parsePolicyLimitsRestrictions(value.restrictions);
  if (restrictions === null) return null;
  return { restrictions };
}

export function parsePolicyLimitsRestrictions(
  value: unknown,
): PolicyLimitsRestrictions | null {
  if (!isRecord(value)) return null;
  const restrictions = Object.create(null) as PolicyLimitsRestrictions;
  for (const [policy, rawRestriction] of Object.entries(value)) {
    if (!isRecord(rawRestriction)) return null;
    if (typeof rawRestriction.allowed !== "boolean") return null;
    Object.defineProperty(restrictions, policy, {
      value: { allowed: rawRestriction.allowed },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return restrictions;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
