/**
 * Provider availability CLI for `agenc providers`.
 *
 * Ports the upstream local-provider health probe shape onto AgenC's
 * provider/auth configuration: Ollama probes `/api/tags`, LM Studio and
 * generic OpenAI-compatible endpoints probe their `/models` surface, and
 * hosted providers report BYOK/managed-key readiness without making a model
 * request.
 */

import {
  createAuthBackend,
  type AuthBackend,
  type AuthBackendKind,
  type AuthSubscriptionTier,
  type RemoteAuthBackendOptions,
} from "../auth/index.js";
import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  loadConfig,
  resolveAgencHome,
  resolveProviderSettings,
  type AgenCConfig,
} from "../config/index.js";
import {
  normalizeProviderName,
  type ProviderName,
} from "../llm/provider.js";

type ProviderAvailabilityStatus = "usable" | "unusable";
type ProviderKeyStatus =
  | "present"
  | "missing"
  | "managed"
  | "unavailable"
  | "optional"
  | "not-required";
type ProviderLocalStatus = "up" | "down" | "unchecked" | "n/a";

const PROVIDERS_REQUIRING_KEY = new Set<ProviderName>([
  "grok",
  "openai",
  "anthropic",
  "openrouter",
  "groq",
  "deepseek",
  "gemini",
]);

const LOCAL_PROVIDERS = new Set<ProviderName>([
  "ollama",
  "lmstudio",
  "openai-compatible",
]);

const PROVIDER_API_KEY_ENV_HINTS: Readonly<Partial<Record<ProviderName, string>>> =
  Object.freeze({
    grok: "XAI_API_KEY",
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
    groq: "GROQ_API_KEY",
    deepseek: "DEEPSEEK_API_KEY",
    gemini: "GEMINI_API_KEY",
  });

const DEFAULT_LOCAL_PROBE_TIMEOUT_MS = 750;
const PROVIDER_CHECK_SESSION_ID = "cli";

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
]);

export type AgenCProvidersCliCommand =
  | {
      readonly kind: "providers";
      readonly json: boolean;
      readonly checkLocal: boolean;
    }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCProvidersCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

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

export interface AgenCProvidersCliOptions
  extends CollectProviderAvailabilityOptions {
  readonly agencHome?: string;
  readonly io?: AgenCProvidersCliIo;
  readonly remote?: RemoteAuthBackendOptions;
}

interface SubscriptionContext {
  readonly authBackendKind?: AuthBackendKind;
  readonly tier?: AuthSubscriptionTier;
  readonly error?: string;
}

export function formatAgenCProvidersCliHelpText(): string {
  return [
    "Usage: agenc providers [--json] [--no-local-check]",
    "",
    "Shows provider readiness: BYOK key status, local server health, and AgenC subscription tier.",
    "",
    "Options:",
    "  --json             Print machine-readable JSON",
    "  --no-local-check   Skip localhost health probes",
  ].join("\n");
}

export function parseAgenCProvidersCliArgs(
  argv: readonly string[],
): AgenCProvidersCliCommand | null {
  if (argv[0] !== "providers") return null;
  let json = false;
  let checkLocal = true;
  for (const arg of argv.slice(1)) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", text: formatAgenCProvidersCliHelpText() };
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--no-local-check") {
      checkLocal = false;
      continue;
    }
    return {
      kind: "error",
      message: `providers command does not accept argument '${arg}'`,
    };
  }
  return { kind: "providers", json, checkLocal };
}

export async function runAgenCProvidersCli(
  command: AgenCProvidersCliCommand,
  options: AgenCProvidersCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCProvidersCliHelpText()}\n`);
      return 1;
    case "providers":
      try {
        const authBackend =
          options.authBackend ??
          await resolveAgenCProvidersCliBackend(options, io);
        const report = await collectProviderAvailability({
          ...options,
          authBackend,
          checkLocal: command.checkLocal,
        });
        if (command.json) {
          io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
          io.stdout.write(`${formatProviderAvailabilityReport(report)}\n`);
        }
        return 0;
      } catch (error) {
        io.stderr.write(
          `agenc: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return 1;
      }
  }
}

export async function collectProviderAvailability(
  options: CollectProviderAvailabilityOptions = {},
): Promise<ProviderAvailabilityReport> {
  const env = options.env ?? process.env;
  const config = options.config ?? (await loadConfig({ home: resolveAgencHome(env) })).config;
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
            options.localProbeTimeoutMs ?? DEFAULT_LOCAL_PROBE_TIMEOUT_MS,
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

export async function resolveAgenCProvidersCliBackend(
  options: AgenCProvidersCliOptions,
  io: AgenCProvidersCliIo,
): Promise<AuthBackend | undefined> {
  if (options.authBackend !== undefined) return options.authBackend;
  const env = options.env ?? process.env;
  const agencHome = options.agencHome ?? resolveAgencHome(env);
  const loadedConfig = await loadConfig({
    home: agencHome,
    onWarn: (message) => io.stderr.write(`${message}\n`),
  });
  return createAuthBackend(loadedConfig.config, {
    agencHome,
    env,
    ...(options.remote !== undefined ? { remote: options.remote } : {}),
  });
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
  const keyEnvVar = settings?.apiKeyEnvVar ??
    PROVIDER_API_KEY_ENV_HINTS[params.provider];
  const hasKey = settings?.apiKey !== undefined;
  const subscriptionTier = params.subscription.tier;
  const paidSubscription = isPaidSubscriptionTier(subscriptionTier);
  const localUrl = localProviderProbeUrl(
    params.provider,
    settings?.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS[params.provider],
  );
  const localProbe =
    localUrl !== undefined
      ? await probeLocalProvider({
          url: localUrl,
          apiKey: localProbeApiKey(params.provider, settings?.apiKey),
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
    });
  }

  if (PROVIDERS_REQUIRING_KEY.has(params.provider)) {
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
    if (params.subscription.authBackendKind === "remote" && paidSubscription) {
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
  const trimmed = baseURL.replace(/\/+$/, "");
  if (/\/v\d+(?:beta)?$/i.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/api/tags`;
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
