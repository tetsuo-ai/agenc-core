import {
  parseGeminiCredentialPlan,
  type GeminiCredentialPlan,
} from "../../../utils/geminiAuth.js";
import {
  parseGeminiEndpointPlan,
  type GeminiEndpointPlan,
} from "./endpoint-plan.js";

export const GEMINI_RUNTIME_EXTRA_KEY = "gemini" as const;

/** The sole serializable Gemini authority carried through provider rebuilds. */
export interface GeminiRuntimeOptions {
  readonly credentialPlan: GeminiCredentialPlan;
  readonly endpointPlan: GeminiEndpointPlan;
  readonly cachedContent?: string;
}

const RETIRED_GEMINI_RUNTIME_KEYS = new Set([
  "accessToken",
  "authMode",
  "cachedContent",
  "geminiLocation",
  "location",
  "oauth",
  "project",
  "resolveCredential",
]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Gemini runtime options require a non-empty ${field}`);
  }
  return value.trim();
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `${label} contain unsupported fields: ${unknown.sort().join(", ")}`,
    );
  }
}

/** Reject every pre-canonical top-level Gemini factory/runtime field. */
export function assertNoRetiredGeminiRuntimeFields(
  extra: Readonly<Record<string, unknown>> | undefined,
): void {
  const retired = Object.keys(extra ?? {}).filter((key) =>
    RETIRED_GEMINI_RUNTIME_KEYS.has(key)
  );
  if (retired.length > 0) {
    throw new Error(
      `Gemini factory options contain retired credential/config fields: ${retired.sort().join(", ")}; pass the canonical extra.gemini runtime options instead`,
    );
  }
}

export function parseGeminiRuntimeOptions(value: unknown): GeminiRuntimeOptions {
  if (!isRecord(value)) {
    throw new Error("Gemini runtime options must be an object");
  }
  assertOnlyKeys(
    value,
    new Set(["credentialPlan", "endpointPlan", "cachedContent"]),
    "Gemini runtime options",
  );
  const cachedContent = value.cachedContent === undefined
    ? undefined
    : nonEmptyString(value.cachedContent, "cachedContent");
  return Object.freeze({
    credentialPlan: parseGeminiCredentialPlan(value.credentialPlan),
    endpointPlan: parseGeminiEndpointPlan(value.endpointPlan),
    ...(cachedContent !== undefined ? { cachedContent } : {}),
  });
}

export function readGeminiRuntimeOptions(
  extra: Readonly<Record<string, unknown>> | undefined,
): GeminiRuntimeOptions | undefined {
  const value = extra?.[GEMINI_RUNTIME_EXTRA_KEY];
  return value === undefined ? undefined : parseGeminiRuntimeOptions(value);
}

export function createGeminiRuntimeOptions(input: {
  readonly credentialPlan: GeminiCredentialPlan;
  readonly endpointPlan: GeminiEndpointPlan;
  readonly cachedContent?: string;
}): GeminiRuntimeOptions {
  return parseGeminiRuntimeOptions(input);
}
