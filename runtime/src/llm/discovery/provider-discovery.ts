/**
 * Reports built-in provider readiness from the canonical provider registry,
 * session environment, BYOK state, local health probes, and auth backend.
 */

import type { AuthBackend, AuthBackendKind, AuthSubscriptionTier } from "../../auth/backend.js";
import { loadCanonicalConfig } from "../../config/repository.js";
import { readProviderConfig } from "../../config/resolve-provider.js";
import type { AgenCConfig } from "../../config/schema.js";
import type { HomeContext } from "../../config/home.js";
import { readLocalByokCredential } from "../../auth/native-credentials.js";
import { captureSecureStorageIngress } from "../../utils/secureStorage/home.js";
import {
  resolveProviderBaseURLEnvironment,
  type ProviderCredentialProvenance,
} from "../registry/provider-ingress.js";
import {
  BUILT_IN_PROVIDER_DEFINITIONS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
} from "../registry/provider-info.js";
import {
  resolveBuiltInProviderSlug,
  type ProviderName,
} from "../provider.js";
import { resolveProviderCredentialAuthority } from "../provider-options.js";

export type ProviderAvailabilityStatus = "usable" | "unusable";
export type ProviderCredentialStatus =
  | "present"
  | "missing"
  | "managed"
  | "unavailable"
  | "optional"
  | "not-required";
export type ProviderLocalStatus = "up" | "down" | "unchecked" | "n/a";

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
  readonly credentialStatus: ProviderCredentialStatus;
  readonly credentialProvenance?: ProviderCredentialProvenance;
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
  const ingress = captureSecureStorageIngress(options.env ?? process.env);
  const env = ingress.environment;
  const home = ingress.home;
  const config = options.config ??
    (await loadCanonicalConfig({ home, env })).config;
  const subscription = await resolveSubscriptionContext(options.authBackend);
  const entries = await Promise.all(
    (Object.keys(BUILT_IN_PROVIDER_DEFAULT_MODELS) as ProviderName[]).map(
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
  const model =
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
  const credential = authority.credential;
  const credentialReady = credential.status === "ready";
  const credentialProvenance = "provenance" in credential
    ? credential.provenance
    : undefined;
  const subscriptionTier = params.subscription.tier;
  const paidSubscription = isPaidSubscriptionTier(subscriptionTier);
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
      credentialStatus: "not-required",
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
    if (
      BUILT_IN_PROVIDER_DEFINITIONS[params.provider].onboarding
        .supportsManagedKeyAccess &&
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
          credentialStatus: "unavailable",
          localProbe,
          subscription: params.subscription,
          usable: false,
          detail: managedKey.detail,
        });
      }
      return buildEntry({
        provider: params.provider,
        model,
        credentialStatus: "managed",
        localProbe,
        subscription: params.subscription,
        usable: true,
        detail: "managed key available through AgenC subscription",
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
        params.subscription.authBackendKind === "remote" &&
          subscriptionTier === "free"
          ? "set BYOK credential or upgrade subscription for managed keys"
          : `set ${credential.status === "missing" ? credential.missingLabel : "provider credentials"}`,
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
  return {
    provider: params.provider,
    model: params.model,
    status: params.usable ? "usable" : "unusable",
    usable: params.usable,
    credentialStatus: params.credentialStatus,
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

function isPaidSubscriptionTier(
  tier: AuthSubscriptionTier | undefined,
): boolean {
  return tier === "pro" || tier === "team" || tier === "enterprise";
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
    if (key.kind !== "api-key") {
      return {
        usable: false,
        detail:
          `managed key unavailable: expected api-key credential for ${params.provider}, received ${key.kind}`,
      };
    }
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
    const provider = resolveBuiltInProviderSlug(inferred.provider);
    const model = firstNonEmptyString(inferred.model);
    if (provider === undefined) {
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
