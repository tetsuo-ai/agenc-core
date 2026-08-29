import type { HomeContext } from "../config/home.js";
import {
  resolveProviderSettings,
  type ResolvedProviderSettings,
} from "../config/resolve-provider.js";
import type { AgenCConfig } from "../config/schema.js";
import type { ProviderFallbackLadderOptions } from "./api/fallback-ladder.js";
import type {
  ProviderFactoryOptions,
  ProviderName,
} from "./provider.js";
import type { ProviderEnvironment } from "./provider-options.js";
import { resolveXaiCapabilityExtra } from "./xai-capability-config.js";

export interface ProviderRuntimeRequest {
  readonly requested: ProviderFactoryOptions;
  readonly settings: ResolvedProviderSettings | undefined;
}

export type OpenAiCompatibleApiFormat = "chat_completions" | "responses";

export function parseOpenAiCompatibleApiFormat(
  value: string | undefined,
): OpenAiCompatibleApiFormat | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[- ]+/g, "_");
  if (
    normalized === "responses" ||
    normalized === "response" ||
    normalized === "responses_api"
  ) {
    return "responses";
  }
  if (
    normalized === "chat_completions" ||
    normalized === "chat_completion" ||
    normalized === "completions" ||
    normalized === "completion" ||
    normalized === "chat"
  ) {
    return "chat_completions";
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function parseTimeoutMs(value: string | undefined): number | undefined {
  const normalized = nonEmpty(value);
  if (normalized === undefined || !/^\d+$/u.test(normalized)) return undefined;
  const timeoutMs = Number(normalized);
  return Number.isSafeInteger(timeoutMs) ? timeoutMs : undefined;
}

function parseCustomHeaders(
  value: string | undefined,
): Readonly<Record<string, string>> | undefined {
  const headers = Object.create(null) as Record<string, string>;
  for (const line of value?.split(/\r?\n/u) ?? []) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim();
    const headerValue = line.slice(colon + 1).trim();
    if (name) headers[name] = headerValue;
  }
  return Object.keys(headers).length > 0 ? Object.freeze(headers) : undefined;
}

function readStringHeaders(
  value: unknown,
): Readonly<Record<string, string>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.some(([, headerValue]) => typeof headerValue !== "string")) {
    return undefined;
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

const FORWARDED_PROVIDER_AUTH_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "x-goog-user-project",
]);

export function stripForwardedProviderAuthHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !FORWARDED_PROVIDER_AUTH_HEADERS.has(name.toLowerCase()),
    ),
  );
}

function providerTransportExtra(
  provider: ProviderName,
  environment: ProviderEnvironment,
  baseExtra: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, unknown>> {
  const parsedHeaders =
    provider === "anthropic"
      ? parseCustomHeaders(environment.ANTHROPIC_CUSTOM_HEADERS)
      : undefined;
  const baseHeaders = readStringHeaders(baseExtra?.defaultHeaders);
  const mergedHeaders =
    baseHeaders === undefined && parsedHeaders === undefined
      ? undefined
      : { ...(baseHeaders ?? {}), ...(parsedHeaders ?? {}) };
  const defaultHeaders = mergedHeaders === undefined
    ? undefined
    : provider === "anthropic"
      ? mergedHeaders
      : stripForwardedProviderAuthHeaders(mergedHeaders);
  const ownsOpenAiCompatibility =
    provider === "openai" || provider === "openai-compatible";
  const authHeader = ownsOpenAiCompatibility
    ? nonEmpty(environment.OPENAI_AUTH_HEADER)
    : undefined;
  const authHeaderValue = ownsOpenAiCompatibility
    ? nonEmpty(environment.OPENAI_AUTH_HEADER_VALUE)
    : undefined;
  const normalizedAuthScheme = ownsOpenAiCompatibility
    ? nonEmpty(environment.OPENAI_AUTH_SCHEME)?.toLowerCase()
    : undefined;
  const azureApiVersion = ownsOpenAiCompatibility
    ? nonEmpty(environment.AZURE_OPENAI_API_VERSION)
    : undefined;
  const apiFormat = ownsOpenAiCompatibility
    ? parseOpenAiCompatibleApiFormat(environment.OPENAI_API_FORMAT)
    : undefined;
  const openAiCompatibility = {
    ...(authHeader !== undefined ? { authHeader } : {}),
    ...(authHeaderValue !== undefined ? { authHeaderValue } : {}),
    ...(normalizedAuthScheme === "bearer" || normalizedAuthScheme === "raw"
      ? { authScheme: normalizedAuthScheme }
      : {}),
    ...(azureApiVersion !== undefined ? { azureApiVersion } : {}),
  };
  return {
    ...(defaultHeaders !== undefined ? { defaultHeaders } : {}),
    ...(apiFormat !== undefined
      ? { useResponsesApi: apiFormat === "responses" }
      : {}),
    ...(Object.keys(openAiCompatibility).length > 0
      ? { openAiCompatibility: Object.freeze(openAiCompatibility) }
      : {}),
  };
}

function providerFallbackOptions(params: {
  readonly provider: ProviderName;
  readonly model: string;
  readonly settings: ResolvedProviderSettings | undefined;
}): ProviderFallbackLadderOptions | undefined {
  const targets = params.settings?.fallbackTargets;
  if (!targets || targets.length === 0) return undefined;
  return {
    provider: params.provider,
    model: params.model,
    targets,
    ...(params.settings?.fallbackMaxFailures !== undefined
      ? { maxFailures: params.settings.fallbackMaxFailures }
      : {}),
    ...(params.settings?.fallbackStatuses !== undefined &&
    params.settings.fallbackStatuses.length > 0
      ? { statuses: params.settings.fallbackStatuses }
      : {}),
  };
}

/** Build the non-credential request for startup and later provider switches. */
export function resolveProviderRuntimeRequest(params: {
  readonly provider: ProviderName;
  readonly model: string;
  readonly config: AgenCConfig;
  readonly environment: ProviderEnvironment;
  readonly credentialHome?: HomeContext;
  readonly tools?: ProviderFactoryOptions["tools"];
  readonly baseExtra?: Readonly<Record<string, unknown>>;
  readonly executionAdmissionRequired?: boolean;
}): ProviderRuntimeRequest {
  const settings = resolveProviderSettings(
    params.provider,
    params.config,
    params.environment,
  );
  const providerFallback = params.executionAdmissionRequired === true
    ? undefined
    : providerFallbackOptions({
        provider: params.provider,
        model: params.model,
        settings,
      });
  const environmentTimeoutMs = parseTimeoutMs(
    params.environment.API_TIMEOUT_MS,
  );
  const extra = {
    ...(params.baseExtra ?? {}),
    ...providerTransportExtra(
      params.provider,
      params.environment,
      params.baseExtra,
    ),
    ...(settings?.contextWindowTokens !== undefined
      ? { contextWindowTokens: settings.contextWindowTokens }
      : {}),
    ...(settings?.maxOutputTokens !== undefined
      ? { maxTokens: settings.maxOutputTokens }
      : {}),
    ...(params.executionAdmissionRequired === true
      ? { maxRetries: 0 }
      : providerFallback !== undefined
        ? { providerFallback }
        : {}),
    ...resolveXaiCapabilityExtra({
      provider: params.provider,
      baseURL: settings?.baseURL,
      grokCapabilities: params.config.providers?.grok,
      env: params.environment,
    }),
  };
  return Object.freeze({
    settings,
    requested: Object.freeze({
      ...(params.credentialHome !== undefined
        ? { credentialHome: params.credentialHome }
        : {}),
      ...(settings?.baseURL !== undefined ? { baseURL: settings.baseURL } : {}),
      model: params.model,
      ...(settings?.timeoutMs !== undefined
        ? { timeoutMs: settings.timeoutMs }
        : environmentTimeoutMs !== undefined
          ? { timeoutMs: environmentTimeoutMs }
          : {}),
      ...(params.tools !== undefined ? { tools: [...params.tools] } : {}),
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    }),
  });
}
