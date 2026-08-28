import { useEffect, useState } from "react";

import type { AgenCConfig } from "../config/schema.js";
import type { ProviderFactoryOptions } from "../llm/provider.js";
import { resolveProviderCredentialAuthority } from "../llm/provider-options.js";
import { resolveProviderRuntimeRequest } from "../llm/provider-request.js";
import { geminiEndpointFor } from "../llm/providers/gemini/endpoint-plan.js";
import { readGeminiRuntimeOptions } from "../llm/providers/gemini/runtime-options.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  resolveBuiltInProviderInfo,
  type BuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import {
  geminiCredentialHeaders,
  materializeGeminiCredentialPlan,
} from "../utils/geminiAuth.js";
import type { OnboardingEnv } from "./projectOnboardingState.js";
import { getProxyFetchOptions } from "../utils/proxy.js";

export type VerificationStatus =
  | "loading"
  | "valid"
  | "invalid"
  | "missing"
  | "error";

export interface ApiKeyVerificationResult {
  readonly status: VerificationStatus;
  readonly error?: string;
}

export interface VerifyApiKeyParams {
  readonly provider: BuiltInProviderSlug | string;
  readonly apiKey: string | undefined;
  readonly config: AgenCConfig;
  readonly env?: OnboardingEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface UseApiKeyVerificationOptions extends VerifyApiKeyParams {
  readonly enabled?: boolean;
}

export interface VerifyPreparedProviderConnectionParams {
  readonly provider: BuiltInProviderSlug;
  readonly factoryOptions: ProviderFactoryOptions;
  readonly environment?: OnboardingEnv;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

type GenericApiKeyVerificationProvider = Exclude<
  BuiltInProviderSlug,
  "gemini"
>;

// This is provider verification-protocol behavior, not the onboarding access
// classification: an OpenAI-compatible local endpoint can authenticate its
// models route, while Ollama and LM Studio have no stable key-check contract.
const PROVIDERS_WITHOUT_API_KEY_VERIFICATION = new Set<BuiltInProviderSlug>([
  "ollama",
  "lmstudio",
]);

/**
 * Default timeout for the one-time provider key checks. Live probes put a
 * cold TLS handshake plus the models round trip at 0.8–1.6s on a healthy
 * connection (OpenRouter alone exceeded the previous 1.5s default), so the
 * first-run check gets a comfortable margin instead of aborting on
 * perfectly good keys.
 */
export const DEFAULT_PROVIDER_VERIFY_TIMEOUT_MS = 5_000;

function preparedDefaultHeaders(
  value: unknown,
): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const entries = Object.entries(value);
  return entries.some(([, entry]) => typeof entry !== "string")
    ? {}
    : (Object.fromEntries(entries) as Readonly<Record<string, string>>);
}

/**
 * Providers that reject bad API keys with HTTP 400 instead of 401/403 on
 * their models endpoint (verified live): x.ai returns 400 for both
 * malformed and well-formed-but-wrong keys, and the Gemini Developer API
 * does the same. For these, 400 on a bare authenticated GET means
 * "key rejected", not "request malformed".
 */
const PROVIDERS_REJECTING_KEYS_WITH_400 = new Set<BuiltInProviderSlug>([
  "grok",
  "gemini",
]);

/** True when the HTTP status means the provider rejected this API key. */
export function isKeyRejectedStatus(
  provider: BuiltInProviderSlug,
  status: number,
): boolean {
  if (status === 401 || status === 403) return true;
  return status === 400 && PROVIDERS_REJECTING_KEYS_WITH_400.has(provider);
}

export async function verifyApiKey(
  params: VerifyApiKeyParams,
): Promise<ApiKeyVerificationResult> {
  const apiKey = params.apiKey?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return { status: "missing", error: "Enter an API key to verify." };
  }
  if (/\s/.test(apiKey)) {
    return { status: "invalid", error: "API keys must not contain whitespace." };
  }
  const providerInfo = resolveBuiltInProviderInfo(params.provider);
  if (providerInfo === undefined) {
    return { status: "error", error: `Unknown provider: ${params.provider}` };
  }
  const provider = providerInfo.id;
  if (providerInfo.onboarding.access === "managed") {
    return {
      status: "error",
      error: "Hosted AgenC uses account auth instead of first-run BYOK keys.",
    };
  }
  if (providerInfo.onboarding.access === "environment") {
    return {
      status: "error",
      error:
        "Amazon Bedrock uses an AWS SigV4 credential set and cannot be verified as a one-field API key.",
    };
  }
  if (PROVIDERS_WITHOUT_API_KEY_VERIFICATION.has(provider)) {
    return { status: "valid" };
  }
  const environment = params.env ?? {};
  const runtimeRequest = resolveProviderRuntimeRequest({
    provider,
    model: providerInfo.defaultModel,
    config: params.config,
    environment,
  });
  let authority: ReturnType<typeof resolveProviderCredentialAuthority>;
  try {
    authority = resolveProviderCredentialAuthority(
      provider,
      {
        ...runtimeRequest.requested,
        apiKey,
      },
      environment,
    );
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error
        ? error.message
        : "Provider verification configuration is invalid.",
    };
  }
  if (provider === "gemini") {
    const runtime = readGeminiRuntimeOptions(authority.factoryOptions.extra);
    if (runtime?.credentialPlan.kind !== "api-key") {
      return {
        status: "error",
        error:
          "Gemini API-key verification is blocked by the configured non-API-key auth mode.",
      };
    }
  }
  return verifyPreparedProviderConnection({
    provider,
    factoryOptions: authority.factoryOptions,
    environment,
    ...(params.fetchImpl !== undefined ? { fetchImpl: params.fetchImpl } : {}),
    ...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
  });
}

export async function verifyPreparedProviderConnection(
  params: VerifyPreparedProviderConnectionParams,
): Promise<ApiKeyVerificationResult> {
  const fetchImpl = params.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (fetchImpl === undefined) {
    return { status: "error", error: "No fetch implementation is available." };
  }
  const { provider, factoryOptions } = params;
  const environment = params.environment ?? {};
  let verificationURL: string;
  let headers: Readonly<Record<string, string>>;
  if (provider === "gemini") {
    const runtime = readGeminiRuntimeOptions(factoryOptions.extra);
    if (runtime === undefined) {
      return {
        status: "error",
        error: "Gemini verification requires canonical runtime options.",
      };
    }
    const credential = await materializeGeminiCredentialPlan(
      runtime.credentialPlan,
    );
    const canonicalHeaders = geminiCredentialHeaders(credential);
    if (canonicalHeaders === undefined) {
      return {
        status: "error",
        error: "Gemini API-key verification could not materialize credentials.",
      };
    }
    const nativeBaseURL = geminiEndpointFor(runtime.endpointPlan)
      .replace(/\/+$/, "");
    verificationURL = `${nativeBaseURL}/models`;
    headers = canonicalHeaders;
  } else {
    const apiKey = factoryOptions.apiKey?.trim();
    const authToken = factoryOptions.authToken?.trim();
    if (apiKey === undefined && authToken === undefined) {
      return {
        status: "missing",
        error: "Provider verification requires a prepared credential.",
      };
    }
    verificationURL = providerVerificationUrl(
      provider,
      factoryOptions.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS[provider],
    );
    headers = {
      ...preparedDefaultHeaders(factoryOptions.extra?.defaultHeaders),
      ...(provider === "anthropic" && authToken !== undefined
        ? {
            "anthropic-version": "2023-06-01",
            Authorization: `Bearer ${authToken}`,
          }
        : apiKeyHeaders(provider, apiKey ?? "")),
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    params.timeoutMs ??
      factoryOptions.timeoutMs ??
      DEFAULT_PROVIDER_VERIFY_TIMEOUT_MS,
  );
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  try {
    const response = await fetchImpl(verificationURL, {
      method: "GET",
      headers,
      signal: controller.signal,
      ...(getProxyFetchOptions({
        environment,
        forAnthropicAPI: provider === "anthropic",
      }) as RequestInit),
    });
    if (response.ok) return { status: "valid" };
    if (isKeyRejectedStatus(provider, response.status)) {
      return { status: "invalid", error: "Provider rejected this API key." };
    }
    return {
      status: "error",
      error: `Provider verification failed with HTTP ${response.status}.`,
    };
  } catch {
    return {
      status: "error",
      error: "Provider verification did not complete. Check network access.",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function useApiKeyVerification(
  options: UseApiKeyVerificationOptions,
): ApiKeyVerificationResult {
  const [result, setResult] = useState<ApiKeyVerificationResult>(() =>
    options.enabled === false
      ? { status: "missing" }
      : { status: "loading" }
  );

  useEffect(() => {
    if (options.enabled === false) {
      setResult({ status: "missing" });
      return;
    }
    let cancelled = false;
    setResult({ status: "loading" });
    void verifyApiKey(options).then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [
    options.apiKey,
    options.config,
    options.enabled,
    options.env,
    options.fetchImpl,
    options.provider,
    options.timeoutMs,
  ]);

  return result;
}

/**
 * URL used to verify a provider API key. This is the models listing for
 * most providers, except OpenRouter: its models endpoint is public (it returns
 * 200 for any Authorization header, verified live), so its authenticated
 * key-info endpoint `/auth/key` is used instead.
 */
export function providerVerificationUrl(
  provider: GenericApiKeyVerificationProvider,
  baseURL: string,
): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  if (provider === "openrouter" && !/\/auth\/key$/i.test(trimmed)) {
    return `${trimmed}/auth/key`;
  }
  if (trimmed.endsWith("/models")) return trimmed;
  if (/\/(?:v\d+(?:beta)?|api\/v\d+)$/i.test(trimmed)) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

function apiKeyHeaders(
  provider: GenericApiKeyVerificationProvider,
  apiKey: string,
): Readonly<Record<string, string>> {
  if (provider === "anthropic") {
    return {
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    };
  }
  return { Authorization: `Bearer ${apiKey}` };
}
