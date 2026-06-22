/**
 * AgenC-owned policy-limit response contracts. Validation stays
 * dependency-free through the small parser in this package.
 */

import { isRecord } from "../../utils/record.js";

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

function parsePolicyLimitsRestrictions(
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
