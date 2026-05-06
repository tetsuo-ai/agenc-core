import { useEffect, useState } from "react";

import { resolveProviderSettings } from "../config/resolve-provider.js";
import type { AgenCConfig } from "../config/schema.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  normalizeBuiltInProviderSlug,
  type BuiltInProviderSlug,
} from "../llm/registry/provider-info.js";
import type { OnboardingEnv } from "./projectOnboardingState.js";

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

const LOCAL_KEYLESS_PROVIDERS = new Set<BuiltInProviderSlug>([
  "ollama",
  "lmstudio",
  "openai-compatible",
]);

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
  const provider = normalizeBuiltInProviderSlug(params.provider);
  if (provider === undefined) {
    return { status: "error", error: `Unknown provider: ${params.provider}` };
  }
  if (provider === "agenc") {
    return {
      status: "error",
      error: "Hosted AgenC uses account auth instead of first-run BYOK keys.",
    };
  }
  if (LOCAL_KEYLESS_PROVIDERS.has(provider)) {
    return { status: "valid" };
  }
  const fetchImpl = params.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (fetchImpl === undefined) {
    return { status: "error", error: "No fetch implementation is available." };
  }
  const settings = resolveProviderSettings(
    provider,
    params.config,
    params.env,
  );
  const baseURL = settings?.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS[provider];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs ?? 1_500);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  try {
    const response = await fetchImpl(remoteModelsUrl(provider, baseURL), {
      method: "GET",
      headers: apiKeyHeaders(provider, apiKey),
      signal: controller.signal,
    });
    if (response.ok) return { status: "valid" };
    if (response.status === 401 || response.status === 403) {
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

function remoteModelsUrl(provider: BuiltInProviderSlug, baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  if (provider === "gemini" && !/\/openai$/i.test(trimmed)) {
    return `${trimmed}/openai/models`;
  }
  if (trimmed.endsWith("/models")) return trimmed;
  if (/\/(?:v\d+(?:beta)?|api\/v\d+)$/i.test(trimmed)) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

function apiKeyHeaders(
  provider: BuiltInProviderSlug,
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
