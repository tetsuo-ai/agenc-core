/**
 * Ports upstream `src/utils/providerDiscovery.ts` and
 * `src/utils/providerAutoDetect.ts` provider-readiness probes onto AgenC's
 * provider registry, BYOK config, and auth backend.
 *
 * Shape difference from upstream:
 *   - AgenC reports readiness for built-in runtime providers rather than
 *     writing profile environment files.
 *   - Hosted/managed-key readiness is checked through AuthBackend instead of
 *     local profile secrets.
 */

import type { AuthBackend, AuthBackendKind, AuthSubscriptionTier } from "../../auth/backend.js";
import { loadConfig } from "../../config/loader.js";
import { resolveAgencHome } from "../../config/env.js";
import { resolveProviderSettings } from "../../config/resolve-provider.js";
import type { AgenCConfig } from "../../config/schema.js";
import {
  BUILT_IN_PROVIDER_API_KEY_ENVS,
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
} from "../registry/provider-info.js";
import {
  normalizeProviderName,
  type ProviderName,
} from "../provider.js";

export type ProviderAvailabilityStatus = "usable" | "unusable";
export type ProviderKeyStatus =
  | "present"
  | "missing"
  | "managed"
  | "unavailable"
  | "optional"
  | "not-required";
export type ProviderLocalStatus = "up" | "down" | "unchecked" | "n/a";

const PROVIDERS_REQUIRING_KEY = new Set<ProviderName>([
  "grok",
  "openai",
  "anthropic",
  "openrouter",
  "groq",
  "deepseek",
  "gemini",
  "mistral",
  "nvidia-nim",
  "minimax",
  "github",
  "amazon-bedrock",
]);

const MANAGED_KEY_PROVIDERS = new Set<ProviderName>([
  "openrouter",
]);

const LOCAL_PROVIDERS = new Set<ProviderName>([
  "ollama",
  "lmstudio",
  "openai-compatible",
]);

const HOSTED_AGENC_DELEGATE_PROVIDERS = new Set<ProviderName>([
  "grok",
  "openai",
  "anthropic",
  "ollama",
  "lmstudio",
  "openrouter",
  "groq",
  "deepseek",
  "gemini",
  "mistral",
  "nvidia-nim",
  "minimax",
  "github",
]);

const DEFAULT_LOCAL_PROVIDER_PROBE_TIMEOUT_MS = 750;
const PROVIDER_CHECK_SESSION_ID = "cli";

export interface ProviderAvailabilityEntry {
  readonly provider: ProviderName;
  readonly model: string;
  readonly status: ProviderAvailabilityStatus;
  readonly usable: boolean;
  readonly keyStatus: ProviderKeyStatus;
  readonly keyEnvVar?: string;
  readonly localStatus: ProviderLocalStatus;
  readonly localUrl?: string;
  readonly localStatusCode?: number;
  readonly subscriptionTier?: AuthSubscriptionTier;
  readonly authBackendKind?: AuthBackendKind;
  readonly detail: string;
}

export interface ProviderAvailabilityReport {
  readonly authBackendKind?: AuthBackendKind;
  readonly subscriptionTier?: AuthSubscriptionTier;
  readonly subscriptionError?: string;
  readonly entries: readonly ProviderAvailabilityEntry[];
}

export interface CollectProviderAvailabilityOptions {
  readonly authBackend?: AuthBackend;
  readonly checkLocal?: boolean;
  readonly config?: AgenCConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly localProbeTimeoutMs?: number;
}

interface SubscriptionContext {
  readonly authBackendKind?: AuthBackendKind;
  readonly tier?: AuthSubscriptionTier;
  readonly error?: string;
}

export async function collectProviderAvailability(
  options: CollectProviderAvailabilityOptions = {},
): Promise<ProviderAvailabilityReport> {
  const env = options.env ?? process.env;
  const config = options.config ??
    (await loadConfig({ home: resolveAgencHome(env) })).config;
  const subscription = await resolveSubscriptionContext(options.authBackend);
  const entries = await Promise.all(
    (Object.keys(BUILT_IN_PROVIDER_DEFAULT_MODELS) as ProviderName[]).map(
      (provider) =>
        resolveProviderAvailabilityEntry({
          provider,
          authBackend: options.authBackend,
          config,
          env,
          subscription,
          checkLocal: options.checkLocal !== false,
          fetchImpl: options.fetchImpl,
          localProbeTimeoutMs:
            options.localProbeTimeoutMs ?? DEFAULT_LOCAL_PROVIDER_PROBE_TIMEOUT_MS,
        }),
    ),
  );
  return {
    ...(subscription.authBackendKind !== undefined
      ? { authBackendKind: subscription.authBackendKind }
      : {}),
    ...(subscription.tier !== undefined
      ? { subscriptionTier: subscription.tier }
      : {}),
    ...(subscription.error !== undefined
      ? { subscriptionError: subscription.error }
      : {}),
    entries,
  };
}

export function formatProviderAvailabilityReport(
  report: ProviderAvailabilityReport,
): string {
  const auth = report.authBackendKind ?? "none";
  const tier = report.subscriptionTier ?? "unknown";
  const lines = [
    `Auth: ${auth}; subscription: ${tier}`,
    "",
    "",
    table([
      ["Provider", "Model", "Usable", "Key", "Local", "Tier", "Detail"],
      ...report.entries.map((entry) => [
        entry.provider,
        entry.model,
        entry.usable ? "yes" : "no",
        formatKeyStatus(entry),
        formatLocalStatus(entry),
        entry.subscriptionTier ?? "unknown",
        entry.detail,
      ]),
    ]),
  ];
  if (report.subscriptionError !== undefined) {
    lines.push("", `Subscription check: ${report.subscriptionError}`);
  }
  return lines.join("\n");
}

async function resolveSubscriptionContext(
  authBackend: AuthBackend | undefined,
): Promise<SubscriptionContext> {
  if (authBackend === undefined) return {};
  try {
    return {
      ...(authBackend.kind !== undefined ? { authBackendKind: authBackend.kind } : {}),
      tier: await authBackend.getSubscriptionTier({ sessionId: "cli" }),
    };
  } catch (error) {
    return {
      ...(authBackend.kind !== undefined ? { authBackendKind: authBackend.kind } : {}),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveProviderAvailabilityEntry(params: {
  readonly provider: ProviderName;
  readonly authBackend?: AuthBackend;
  readonly config: AgenCConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly subscription: SubscriptionContext;
  readonly checkLocal: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly localProbeTimeoutMs: number;
}): Promise<ProviderAvailabilityEntry> {
  const settings = resolveProviderSettings(
    params.provider,
    params.config,
    params.env,
  );
  const model =
    settings?.defaultModel ?? BUILT_IN_PROVIDER_DEFAULT_MODELS[params.provider];
  const credential = resolveProviderCredential({
    provider: params.provider,
    config: params.config,
    env: params.env,
    settingsApiKey: settings?.apiKey,
  });
  const keyEnvVar = credential.sourceEnvVar ?? credential.primaryEnvVar;
  const hasKey = credential.apiKey !== undefined;
  const hasRequiredAwsSecret = params.provider !== "amazon-bedrock" ||
    firstNonEmptyString(params.env.AWS_BEDROCK_SECRET_ACCESS_KEY) !== undefined ||
    firstNonEmptyString(params.env.AWS_SECRET_ACCESS_KEY) !== undefined;
  const subscriptionTier = params.subscription.tier;
  const paidSubscription = isPaidSubscriptionTier(subscriptionTier);
  const localUrl = localProviderProbeUrl(
    params.provider,
    resolveProviderBaseURLForDiscovery({
      provider: params.provider,
      config: params.config,
      env: params.env,
      settingsBaseURL: settings?.baseURL,
    }),
  );
  const localProbe =
    localUrl !== undefined
      ? await probeLocalProvider({
          url: localUrl,
          apiKey: localProbeApiKey(params.provider, credential.apiKey),
          checkLocal: params.checkLocal,
          fetchImpl: params.fetchImpl,
          timeoutMs: params.localProbeTimeoutMs,
        })
      : { localStatus: "n/a" as const };

  if (params.provider === "agenc") {
    const hostedRoute = paidSubscription
      ? await verifyHostedAgencRoute({
          authBackend: params.authBackend,
          model,
          subscriptionTier,
        })
      : {
          usable: false,
          detail: "requires paid AgenC subscription",
        };
    return buildEntry({
      provider: params.provider,
      model,
      keyStatus: "not-required",
      localProbe,
      subscription: params.subscription,
      usable: hostedRoute.usable,
      detail: hostedRoute.detail,
    });
  }

  if (localUrl !== undefined) {
    const usable = localProbe.localStatus === "up";
    return buildEntry({
      provider: params.provider,
      model,
      keyStatus: localProviderKeyStatus(params.provider, hasKey),
      localProbe,
      subscription: params.subscription,
      usable,
      detail: usable
        ? "local server reachable"
        : params.checkLocal
          ? `start local server or check ${localUrl}`
          : "local server check skipped",
      ...(hasKey && keyEnvVar !== undefined ? { keyEnvVar } : {}),
    });
  }

  if (PROVIDERS_REQUIRING_KEY.has(params.provider)) {
    if (hasKey && !hasRequiredAwsSecret) {
      return buildEntry({
        provider: params.provider,
        model,
        keyStatus: "missing",
        localProbe,
        subscription: params.subscription,
        usable: false,
        detail: "set AWS_SECRET_ACCESS_KEY for Amazon Bedrock SigV4 signing",
        ...(keyEnvVar !== undefined ? { keyEnvVar } : {}),
      });
    }
    if (hasKey) {
      return buildEntry({
        provider: params.provider,
        model,
        keyStatus: "present",
        localProbe,
        subscription: params.subscription,
        usable: true,
        detail: `BYOK credential found${keyEnvVar ? ` via ${keyEnvVar}` : ""}`,
        ...(keyEnvVar !== undefined ? { keyEnvVar } : {}),
      });
    }
    if (
      MANAGED_KEY_PROVIDERS.has(params.provider) &&
      params.subscription.authBackendKind === "remote" &&
      paidSubscription
    ) {
      const managedKey = await verifyManagedProviderKey({
        authBackend: params.authBackend,
        provider: params.provider,
      });
      if (!managedKey.usable) {
        return buildEntry({
          provider: params.provider,
          model,
          keyStatus: "unavailable",
          localProbe,
          subscription: params.subscription,
          usable: false,
          detail: managedKey.detail,
          ...(keyEnvVar !== undefined ? { keyEnvVar } : {}),
        });
      }
      return buildEntry({
        provider: params.provider,
        model,
        keyStatus: "managed",
        localProbe,
        subscription: params.subscription,
        usable: true,
        detail: "managed key available through AgenC subscription",
        ...(keyEnvVar !== undefined ? { keyEnvVar } : {}),
      });
    }
    return buildEntry({
      provider: params.provider,
      model,
      keyStatus: "missing",
      localProbe,
      subscription: params.subscription,
      usable: false,
      detail:
        params.subscription.authBackendKind === "remote" &&
          subscriptionTier === "free"
          ? "set BYOK credential or upgrade subscription for managed keys"
          : `set ${keyEnvVar ?? "provider API key"}`,
      ...(keyEnvVar !== undefined ? { keyEnvVar } : {}),
    });
  }

  return buildEntry({
    provider: params.provider,
    model,
    keyStatus: "not-required",
    localProbe,
    subscription: params.subscription,
    usable: true,
    detail: "available",
  });
}

function buildEntry(params: {
  readonly provider: ProviderName;
  readonly model: string;
  readonly keyStatus: ProviderKeyStatus;
  readonly localProbe: {
    readonly localStatus: ProviderLocalStatus;
    readonly localStatusCode?: number;
    readonly localUrl?: string;
  };
  readonly subscription: SubscriptionContext;
  readonly usable: boolean;
  readonly detail: string;
  readonly keyEnvVar?: string;
}): ProviderAvailabilityEntry {
  return {
    provider: params.provider,
    model: params.model,
    status: params.usable ? "usable" : "unusable",
    usable: params.usable,
    keyStatus: params.keyStatus,
    ...(params.keyEnvVar !== undefined ? { keyEnvVar: params.keyEnvVar } : {}),
    localStatus: params.localProbe.localStatus,
    ...(params.localProbe.localUrl !== undefined
      ? { localUrl: params.localProbe.localUrl }
      : {}),
    ...(params.localProbe.localStatusCode !== undefined
      ? { localStatusCode: params.localProbe.localStatusCode }
      : {}),
    ...(params.subscription.tier !== undefined
      ? { subscriptionTier: params.subscription.tier }
      : {}),
    ...(params.subscription.authBackendKind !== undefined
      ? { authBackendKind: params.subscription.authBackendKind }
      : {}),
    detail: params.detail,
  };
}

function localProviderKeyStatus(
  provider: ProviderName,
  hasKey: boolean,
): ProviderKeyStatus {
  if (provider === "ollama") return "not-required";
  return hasKey ? "present" : "optional";
}

function resolveProviderCredential(params: {
  readonly provider: ProviderName;
  readonly config: AgenCConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly settingsApiKey?: string;
}): {
  readonly apiKey?: string;
  readonly sourceEnvVar?: string;
  readonly primaryEnvVar?: string;
} {
  const configuredEnvVar = readProviderApiKeyEnvVar(
    params.config,
    params.provider,
  );
  if (configuredEnvVar !== undefined && params.env[configuredEnvVar] !== undefined) {
    const apiKey = firstNonEmptyString(params.env[configuredEnvVar]);
    return {
      ...(apiKey !== undefined ? { apiKey, sourceEnvVar: configuredEnvVar } : {}),
      primaryEnvVar: configuredEnvVar,
    };
  }
  const candidates = providerApiKeyEnvCandidates(params.provider);
  for (const candidate of candidates) {
    const apiKey = firstNonEmptyString(params.env[candidate]);
    if (apiKey !== undefined) {
      return {
        apiKey,
        sourceEnvVar: candidate,
        primaryEnvVar: configuredEnvVar ?? candidates[0],
      };
    }
  }
  const settingsApiKey = firstNonEmptyString(params.settingsApiKey);
  return {
    ...(settingsApiKey !== undefined ? { apiKey: settingsApiKey } : {}),
    primaryEnvVar: configuredEnvVar ?? candidates[0] ??
      BUILT_IN_PROVIDER_API_KEY_ENVS[params.provider],
  };
}

function providerApiKeyEnvCandidates(provider: ProviderName): readonly string[] {
  switch (provider) {
    case "grok":
      return ["XAI_API_KEY", "GROK_API_KEY", "AGENC_XAI_API_KEY"];
    case "lmstudio":
      return ["LMSTUDIO_API_KEY", "OPENAI_API_KEY"];
    case "openai-compatible":
      return ["OPENAI_COMPATIBLE_API_KEY", "OPENAI_API_KEY"];
    case "openai":
    case "anthropic":
    case "openrouter":
    case "groq":
    case "deepseek":
    case "gemini": {
      const envVar = BUILT_IN_PROVIDER_API_KEY_ENVS[provider];
      return envVar !== undefined ? [envVar] : [];
    }
    case "mistral":
      return ["MISTRAL_API_KEY"];
    case "nvidia-nim":
      return ["NVIDIA_API_KEY"];
    case "minimax":
      return ["MINIMAX_API_KEY"];
    case "github":
      return ["GITHUB_TOKEN", "GH_TOKEN"];
    case "amazon-bedrock":
      return ["AWS_BEDROCK_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"];
    case "agenc":
    case "ollama":
      return [];
  }
}

function resolveProviderBaseURLForDiscovery(params: {
  readonly provider: ProviderName;
  readonly config: AgenCConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly settingsBaseURL?: string;
}): string | undefined {
  const configuredBaseURL = readProviderBaseURL(params.config, params.provider);
  switch (params.provider) {
    case "ollama":
      return normalizeOllamaHost(
        firstNonEmptyString(params.env.OLLAMA_BASE_URL) ??
          configuredBaseURL ??
          BUILT_IN_PROVIDER_BASE_URLS.ollama,
      );
    case "lmstudio":
      return firstNonEmptyString(params.env.LMSTUDIO_BASE_URL) ??
        (!firstNonEmptyString(params.env.LMSTUDIO_API_KEY) &&
            firstNonEmptyString(params.env.OPENAI_API_KEY)
          ? firstNonEmptyString(params.env.OPENAI_BASE_URL)
          : undefined) ??
        configuredBaseURL ??
        BUILT_IN_PROVIDER_BASE_URLS.lmstudio;
    case "openai-compatible":
      return firstNonEmptyString(params.env.OPENAI_COMPATIBLE_BASE_URL) ??
        firstNonEmptyString(params.env.OPENAI_BASE_URL) ??
        firstNonEmptyString(params.env.OPENAI_API_BASE) ??
        configuredBaseURL ??
        BUILT_IN_PROVIDER_BASE_URLS["openai-compatible"];
    case "mistral":
      return firstNonEmptyString(params.env.MISTRAL_BASE_URL) ??
        configuredBaseURL ??
        BUILT_IN_PROVIDER_BASE_URLS.mistral;
    case "nvidia-nim":
      return firstNonEmptyString(params.env.NVIDIA_BASE_URL) ??
        configuredBaseURL ??
        BUILT_IN_PROVIDER_BASE_URLS["nvidia-nim"];
    case "minimax":
      return firstNonEmptyString(params.env.MINIMAX_BASE_URL) ??
        configuredBaseURL ??
        BUILT_IN_PROVIDER_BASE_URLS.minimax;
    case "github":
      return firstNonEmptyString(params.env.GITHUB_BASE_URL) ??
        configuredBaseURL ??
        BUILT_IN_PROVIDER_BASE_URLS.github;
    default:
      return params.settingsBaseURL ?? BUILT_IN_PROVIDER_BASE_URLS[params.provider];
  }
}

function readProviderApiKeyEnvVar(
  config: AgenCConfig,
  provider: ProviderName,
): string | undefined {
  return firstNonEmptyString(config.providers?.[provider]?.api_key_env);
}

function readProviderBaseURL(
  config: AgenCConfig,
  provider: ProviderName,
): string | undefined {
  return firstNonEmptyString(config.providers?.[provider]?.base_url);
}

function localProbeApiKey(
  provider: ProviderName,
  apiKey: string | undefined,
): string | undefined {
  if (provider !== "lmstudio" && provider !== "openai-compatible") {
    return undefined;
  }
  return firstNonEmptyString(apiKey);
}

function isPaidSubscriptionTier(
  tier: AuthSubscriptionTier | undefined,
): boolean {
  return tier === "pro" || tier === "team" || tier === "enterprise";
}

function localProviderProbeUrl(
  provider: ProviderName,
  baseURL: string | undefined,
): string | undefined {
  if (!LOCAL_PROVIDERS.has(provider) || baseURL === undefined) {
    return undefined;
  }
  if (provider === "ollama") {
    return ollamaProbeUrl(baseURL);
  }
  return modelsUrlFromBaseUrl(baseURL);
}

function ollamaProbeUrl(baseURL: string): string {
  const trimmed = normalizeOllamaHost(baseURL)?.replace(/\/+$/, "") ?? baseURL;
  return `${trimmed}/api/tags`;
}

function normalizeOllamaHost(baseURL: string | undefined): string | undefined {
  return firstNonEmptyString(baseURL)?.replace(/\/v1\/?$/i, "");
}

function modelsUrlFromBaseUrl(baseURL: string): string {
  const trimmed = baseURL.replace(/\/+$/, "");
  if (trimmed.endsWith("/models")) return trimmed;
  if (/\/(?:v\d+(?:beta)?|api\/v\d+)$/i.test(trimmed)) {
    return `${trimmed}/models`;
  }
  return `${trimmed}/v1/models`;
}

async function probeLocalProvider(params: {
  readonly url: string;
  readonly apiKey?: string;
  readonly checkLocal: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs: number;
}): Promise<{
  readonly localStatus: ProviderLocalStatus;
  readonly localUrl: string;
  readonly localStatusCode?: number;
}> {
  if (!params.checkLocal) {
    return { localStatus: "unchecked", localUrl: params.url };
  }
  const fetchImpl = params.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (fetchImpl === undefined) {
    return { localStatus: "down", localUrl: params.url };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  if (typeof (timer as { unref?: () => void }).unref === "function") {
    (timer as { unref: () => void }).unref();
  }
  try {
    const headers = params.apiKey !== undefined
      ? { Authorization: `Bearer ${params.apiKey}` }
      : undefined;
    const response = await fetchImpl(params.url, {
      method: "GET",
      signal: controller.signal,
      ...(headers !== undefined ? { headers } : {}),
    });
    return {
      localStatus: response.ok ? "up" : "down",
      localUrl: params.url,
      localStatusCode: response.status,
    };
  } catch {
    return { localStatus: "down", localUrl: params.url };
  } finally {
    clearTimeout(timer);
  }
}

async function verifyManagedProviderKey(params: {
  readonly authBackend: AuthBackend | undefined;
  readonly provider: string;
}): Promise<{ readonly usable: boolean; readonly detail: string }> {
  if (params.authBackend === undefined) {
    return {
      usable: false,
      detail: "managed key unavailable: no auth backend configured",
    };
  }
  try {
    const key = await params.authBackend.vendKey(
      params.provider,
      PROVIDER_CHECK_SESSION_ID,
    );
    const apiKey = firstNonEmptyString(key.apiKey);
    if (apiKey === undefined) {
      return {
        usable: false,
        detail: `managed key unavailable: empty key for ${params.provider}`,
      };
    }
    if (key.provider !== params.provider) {
      return {
        usable: false,
        detail:
          `managed key unavailable: provider mismatch for ${params.provider}`,
      };
    }
    if (key.sessionId !== PROVIDER_CHECK_SESSION_ID) {
      return {
        usable: false,
        detail: "managed key unavailable: session mismatch",
      };
    }
    return {
      usable: true,
      detail: "managed key vending verified",
    };
  } catch (error) {
    return {
      usable: false,
      detail: `managed key unavailable: ${errorMessage(error)}`,
    };
  }
}

async function verifyHostedAgencRoute(params: {
  readonly authBackend: AuthBackend | undefined;
  readonly model: string;
  readonly subscriptionTier: AuthSubscriptionTier | undefined;
}): Promise<{ readonly usable: boolean; readonly detail: string }> {
  if (params.authBackend === undefined) {
    return {
      usable: false,
      detail: "hosted AgenC routing unavailable: no auth backend configured",
    };
  }
  try {
    const inferred = await params.authBackend.inferAgencModel({
      provider: "agenc",
      requestedModel: params.model,
      sessionId: PROVIDER_CHECK_SESSION_ID,
      ...(params.subscriptionTier !== undefined
        ? { subscriptionTier: params.subscriptionTier }
        : {}),
    });
    const provider = normalizeProviderName(inferred.provider);
    const model = firstNonEmptyString(inferred.model);
    if (provider === null) {
      return {
        usable: false,
        detail:
          `hosted AgenC routing unavailable: unknown inferred provider "${inferred.provider}"`,
      };
    }
    if (
      provider === "agenc" ||
      !HOSTED_AGENC_DELEGATE_PROVIDERS.has(provider)
    ) {
      return {
        usable: false,
        detail:
          `hosted AgenC routing unavailable: invalid inferred provider "${inferred.provider}"`,
      };
    }
    if (model === undefined) {
      return {
        usable: false,
        detail: "hosted AgenC routing unavailable: empty inferred model",
      };
    }
    const managedKey = await verifyManagedProviderKey({
      authBackend: params.authBackend,
      provider,
    });
    if (!managedKey.usable) {
      return {
        usable: false,
        detail:
          `hosted AgenC routing unavailable after inferring ${provider}/${model}: ${managedKey.detail}`,
      };
    }
    return {
      usable: true,
      detail: `hosted AgenC routing verified via ${provider}/${model}`,
    };
  } catch (error) {
    return {
      usable: false,
      detail: `hosted AgenC routing unavailable: ${errorMessage(error)}`,
    };
  }
}

function formatKeyStatus(entry: ProviderAvailabilityEntry): string {
  if (entry.keyStatus === "missing" && entry.keyEnvVar !== undefined) {
    return `missing(${entry.keyEnvVar})`;
  }
  if (entry.keyStatus === "present" && entry.keyEnvVar !== undefined) {
    return `present(${entry.keyEnvVar})`;
  }
  return entry.keyStatus;
}

function formatLocalStatus(entry: ProviderAvailabilityEntry): string {
  if (entry.localStatusCode !== undefined) {
    return `${entry.localStatus}(${entry.localStatusCode})`;
  }
  return entry.localStatus;
}

function firstNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function table(rows: readonly (readonly string[])[]): string {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => row[column]?.length ?? 0))
  );
  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column] ?? cell.length))
        .join("  ")
        .trimEnd()
    )
    .join("\n");
}
