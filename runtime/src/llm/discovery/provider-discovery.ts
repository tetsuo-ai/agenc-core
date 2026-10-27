/**
 * Reports built-in provider readiness from the canonical provider registry,
 * session environment, BYOK state, local health probes, and auth backend.
 */

import { ModelMetadataResolver } from "../model-metadata.js";
import { veniceDefaultModel } from "../registry/venice-models.js";
import type { AuthAgencModel, AuthBackend, AuthBackendKind, AuthSubscriptionTier } from "../../auth/backend.js";

import { loadCanonicalConfig } from "../../config/repository.js";
import { readProviderConfig } from "../../config/resolve-provider.js";
import type { AgenCConfig } from "../../config/schema.js";
import type { HomeContext } from "../../config/home.js";
import { readLocalByokCredential } from "../../auth/native-credentials.js";
import { captureSecureStorageIngress } from "../../utils/secureStorage/home.js";
import {
  canonicalProviderApiKeyEnvVar,
  resolveProviderBaseURLEnvironment,
  type ProviderCredentialProvenance,
} from "../registry/provider-ingress.js";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
} from "../registry/provider-info.js";
import type { ProviderName } from "../provider.js";
import {
  resolveProviderCredentialAuthority,
} from "../provider-options.js";

export type ProviderAvailabilityStatus = "usable" | "unusable";
export type ProviderCredentialStatus =
  | "present"
  | "missing"
  | "unavailable"
  | "optional"
  | "not-required";
export type ProviderLocalStatus = "up" | "down" | "unchecked" | "n/a";

const DEFAULT_LOCAL_PROVIDER_PROBE_TIMEOUT_MS = 750;

export interface ProviderAvailabilityEntry {
  readonly provider: ProviderName;
  readonly model: string;
  readonly models?: readonly AuthAgencModel[];
  readonly status: ProviderAvailabilityStatus;
  readonly usable: boolean;
  readonly credentialStatus: ProviderCredentialStatus;
  readonly credentialProvenance?: ProviderCredentialProvenance;
  readonly localStatus: ProviderLocalStatus;
  readonly localUrl?: string;
  readonly localStatusCode?: number;
  readonly subscriptionTier?: AuthSubscriptionTier;
  readonly authBackendKind?: AuthBackendKind;
  readonly detail: string;
  /**
   * Canonical API-key environment variable for BYOK entry (first alias),
   * absent for keyless credential kinds. Clients render their key input
   * from this — without it the desktop showed no API-key option at all.
   */
  readonly keyEnvVar?: string;
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
  const ingress = captureSecureStorageIngress(options.env ?? process.env);
  const env = ingress.environment;
  const home = ingress.home;
  const config = options.config ??
    (await loadCanonicalConfig({ home, env })).config;
  const subscription = await resolveSubscriptionContext(options.authBackend);
  const entries = await Promise.all(
    (Object.keys(BUILT_IN_PROVIDER_DEFAULT_MODELS) as ProviderName[]).filter(provider => provider !== "agenc").map(
      (provider) =>
        resolveProviderAvailabilityEntry({
          provider,
          authBackend: options.authBackend,
          config,
          home,
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
      ["Provider", "Model", "Usable", "Credential", "Local", "Tier", "Detail"],
      ...report.entries.map((entry) => [
        entry.provider,
        entry.model,
        entry.usable ? "yes" : "no",
        formatCredentialStatus(entry),
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
  readonly home: HomeContext;
  readonly env: NodeJS.ProcessEnv;
  readonly subscription: SubscriptionContext;
  readonly checkLocal: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly localProbeTimeoutMs: number;
}): Promise<ProviderAvailabilityEntry> {
  const providerConfig = readProviderConfig(params.config, params.provider);
  let model =
    providerConfig?.default_model?.trim() ??
    BUILT_IN_PROVIDER_DEFAULT_MODELS[params.provider];
  const configuredBaseURL =
    resolveProviderBaseURLEnvironment(params.provider, params.env)?.value ??
    providerConfig?.base_url?.trim();
  let authority: ReturnType<typeof resolveProviderCredentialAuthority>;
  try {
    authority = resolveProviderCredentialAuthority(
      params.provider,
      {
        credentialHome: params.home,
        model,
        ...(configuredBaseURL ? { baseURL: configuredBaseURL } : {}),
      },
      params.env,
      {
        savedApiKey: readLocalByokCredential(
          params.home,
          params.provider,
        )?.apiKey,
      },
    );
  } catch (error) {
    return buildEntry({
      provider: params.provider,
      model,
      credentialStatus: "unavailable",
      localProbe: { localStatus: "n/a" },
      subscription: params.subscription,
      usable: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  if (params.provider === "venice" && authority.factoryOptions.apiKey && !providerConfig?.default_model) {
    const models = await new ModelMetadataResolver({
      fetchImpl: params.fetchImpl ?? fetch,
      env: { ...params.env, VENICE_API_KEY: authority.factoryOptions.apiKey },
    }).discoverVeniceModels(params.config);
    model = veniceDefaultModel(models ?? []) ?? model;
  }
  const credential = authority.credential;
  const credentialReady = credential.status === "ready";
  const credentialProvenance = "provenance" in credential
    ? credential.provenance
    : undefined;
  const localUrl = localProviderProbeUrl(
    params.provider,
    resolveProviderBaseURLForDiscovery({
      provider: params.provider,
      settingsBaseURL: configuredBaseURL,
    }),
  );
  const localProbe =
    localUrl !== undefined
      ? await probeLocalProvider({
          url: localUrl,
          apiKey: localProbeApiKey(
            params.provider,
            authority.factoryOptions.apiKey,
          ),
          checkLocal: params.checkLocal,
          fetchImpl: params.fetchImpl,
          timeoutMs: params.localProbeTimeoutMs,
        })
      : { localStatus: "n/a" as const };

  if (localUrl !== undefined) {
    const usable = localProbe.localStatus === "up";
    return buildEntry({
      provider: params.provider,
      model,
      credentialStatus: localProviderCredentialStatus(
        params.provider,
        credentialReady,
      ),
      localProbe,
      subscription: params.subscription,
      usable,
      detail: usable
        ? "local server reachable"
        : params.checkLocal
          ? `start local server or check ${localUrl}`
          : "local server check skipped",
      ...(credentialProvenance !== undefined
        ? { credentialProvenance }
        : {}),
    });
  }

  if (credential.status === "not-required") {
    return buildEntry({
      provider: params.provider,
      model,
      credentialStatus: "not-required",
      localProbe,
      subscription: params.subscription,
      usable: true,
      detail: "available",
    });
  }

  if (
    ["api-key", "environment"].includes(
      BUILT_IN_PROVIDER_DEFINITIONS[params.provider].onboarding.access,
    )
  ) {
    if (credentialReady) {
      return buildEntry({
        provider: params.provider,
        model,
        credentialStatus: "present",
        localProbe,
        subscription: params.subscription,
        usable: true,
        detail: params.provider === "gemini"
          ? `Gemini credential found via ${credential.label}`
          : credentialProvenance?.kind === "oauth"
            ? "xAI OAuth credential found"
            : credential.source === "native-sign-in"
              ? `${credential.label} credential found`
              : `BYOK credential found via ${credentialProvenance?.fields.map((field) => field.envVar).join(" + ") ?? credential.label}`,
        ...(credentialProvenance !== undefined
          ? { credentialProvenance }
          : {}),
      });
    }
    return buildEntry({
      provider: params.provider,
      model,
      credentialStatus: "missing",
      localProbe,
      subscription: params.subscription,
      usable: false,
      detail:
        `set ${credential.status === "missing" ? credential.missingLabel : "provider credentials"}`,
      ...(credentialProvenance !== undefined
        ? { credentialProvenance }
        : {}),
    });
  }

  return buildEntry({
    provider: params.provider,
    model,
    credentialStatus: "not-required",
    localProbe,
    subscription: params.subscription,
    usable: true,
    detail: "available",
  });
}

function buildEntry(params: {
  readonly provider: ProviderName;
  readonly model: string;
  readonly credentialStatus: ProviderCredentialStatus;
  readonly localProbe: {
    readonly localStatus: ProviderLocalStatus;
    readonly localStatusCode?: number;
    readonly localUrl?: string;
  };
  readonly subscription: SubscriptionContext;
  readonly usable: boolean;
  readonly detail: string;
  readonly credentialProvenance?: ProviderCredentialProvenance;
}): ProviderAvailabilityEntry {
  const keyEnvVar = canonicalProviderApiKeyEnvVar(params.provider);
  return {
    provider: params.provider,
    model: params.model,
    status: params.usable ? "usable" : "unusable",
    usable: params.usable,
    credentialStatus: params.credentialStatus,
    ...(keyEnvVar !== undefined ? { keyEnvVar } : {}),
    ...(params.credentialProvenance !== undefined
      ? { credentialProvenance: params.credentialProvenance }
      : {}),
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

function localProviderCredentialStatus(
  provider: ProviderName,
  credentialReady: boolean,
): ProviderCredentialStatus {
  if (provider === "ollama") return "not-required";
  return credentialReady ? "present" : "optional";
}

function resolveProviderBaseURLForDiscovery(params: {
  readonly provider: ProviderName;
  readonly settingsBaseURL?: string;
}): string | undefined {
  const baseURL = params.settingsBaseURL ??
    BUILT_IN_PROVIDER_DEFINITIONS[params.provider].baseURL;
  return params.provider === "ollama"
    ? normalizeOllamaHost(baseURL)
    : baseURL;
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

function localProviderProbeUrl(
  provider: ProviderName,
  baseURL: string | undefined,
): string | undefined {
  if (
    BUILT_IN_PROVIDER_DEFINITIONS[provider].onboarding.access !== "local" ||
    baseURL === undefined
  ) {
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

function formatCredentialStatus(entry: ProviderAvailabilityEntry): string {
  if (
    entry.credentialStatus === "present" &&
    entry.credentialProvenance !== undefined
  ) {
    if (entry.credentialProvenance.kind === "oauth") {
      return "present(xAI OAuth)";
    }
    if (entry.credentialProvenance.kind === "environment") {
      return `present(${entry.credentialProvenance.fields.map((field) => field.envVar).join("+")})`;
    }
  }
  return entry.credentialStatus;
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
