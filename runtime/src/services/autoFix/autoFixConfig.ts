/**
 * Ports the donor auto-fix configuration loader onto AgenC's config
 * shape.
 *
 * Why this lives here / shape difference from upstream:
 *   - AgenC's live config surface is the typed `AgenCConfig` object,
 *     not the donor settings schema, so validation is implemented as a
 *     small local parser with the same accepted values and defaults.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Zod settings-schema coupling; AgenC's config schema is
 *     hand-validated in `runtime/src/config/schema.ts`.
 */

import { z } from "zod/v4";

export const AUTO_FIX_DEFAULT_MAX_RETRIES = 3;
export const AUTO_FIX_DEFAULT_TIMEOUT_MS = 30_000;
export const AUTO_FIX_MAX_RETRIES_LIMIT = 10;
export const AUTO_FIX_MIN_TIMEOUT_MS = 1_000;
export const AUTO_FIX_MAX_TIMEOUT_MS = 300_000;

export interface AutoFixConfig {
  readonly enabled: true;
  readonly lint?: string;
  readonly test?: string;
  readonly maxRetries: number;
  readonly timeout: number;
}

export const AutoFixConfigSchema = z.object({
  enabled: z.boolean(),
  lint: z.string().optional(),
  test: z.string().optional(),
  maxRetries: z.number().int().optional(),
  timeout: z.number().int().optional(),
});

export interface AutoFixParseFailure {
  readonly success: false;
  readonly reason: string;
}

export interface AutoFixParseSuccess {
  readonly success: true;
  readonly data: AutoFixConfig | null;
}

export type AutoFixParseResult = AutoFixParseSuccess | AutoFixParseFailure;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function optionalString(
  value: unknown,
  field: string,
): { readonly ok: true; readonly value?: string } | { readonly ok: false; readonly reason: string } {
  if (value === undefined) return { ok: true };
  if (typeof value !== "string") {
    return { ok: false, reason: `${field} must be a string` };
  }
  if (value.trim().length === 0) {
    return { ok: false, reason: `${field} must not be empty` };
  }
  return { ok: true, value };
}

function boundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  defaultValue: number,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string } {
  if (value === undefined) return { ok: true, value: defaultValue };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return { ok: false, reason: `${field} must be an integer` };
  }
  if (value < min || value > max) {
    return { ok: false, reason: `${field} must be between ${min} and ${max}` };
  }
  return { ok: true, value };
}

export function parseAutoFixConfig(rawConfig: unknown): AutoFixParseResult {
  if (!isPlainObject(rawConfig)) {
    return { success: true, data: null };
  }
  if (typeof rawConfig.enabled !== "boolean") {
    return { success: false, reason: "enabled must be a boolean" };
  }

  const lint = optionalString(rawConfig.lint, "lint");
  if (!lint.ok) return { success: false, reason: lint.reason };
  const test = optionalString(rawConfig.test, "test");
  if (!test.ok) return { success: false, reason: test.reason };

  const maxRetries = boundedInteger(
    rawConfig.maxRetries,
    "maxRetries",
    0,
    AUTO_FIX_MAX_RETRIES_LIMIT,
    AUTO_FIX_DEFAULT_MAX_RETRIES,
  );
  if (!maxRetries.ok) return { success: false, reason: maxRetries.reason };

  const timeout = boundedInteger(
    rawConfig.timeout,
    "timeout",
    AUTO_FIX_MIN_TIMEOUT_MS,
    AUTO_FIX_MAX_TIMEOUT_MS,
    AUTO_FIX_DEFAULT_TIMEOUT_MS,
  );
  if (!timeout.ok) return { success: false, reason: timeout.reason };

  if (!rawConfig.enabled) {
    return { success: true, data: null };
  }
  if (lint.value === undefined && test.value === undefined) {
    return {
      success: false,
      reason: 'at least one of "lint" or "test" must be set when enabled',
    };
  }

  return {
    success: true,
    data: Object.freeze({
      enabled: true,
      ...(lint.value !== undefined ? { lint: lint.value } : {}),
      ...(test.value !== undefined ? { test: test.value } : {}),
      maxRetries: maxRetries.value,
      timeout: timeout.value,
    }),
  };
}

export function getAutoFixConfig(rawConfig: unknown): AutoFixConfig | null {
  const parsed = parseAutoFixConfig(rawConfig);
  if (!parsed.success) return null;
  return parsed.data;
}
