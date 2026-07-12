import {
  normalizeProviderName,
  type ProviderName,
} from "../llm/provider.js";
import {
  isPermissionMode,
  isUserAddressablePermissionMode,
  USER_ADDRESSABLE_PERMISSION_MODES,
  type PermissionMode,
} from "../permissions/types.js";
import { BUILT_IN_PROVIDER_DEFAULT_MODELS, BUILT_IN_PROVIDER_MODEL_CATALOG, buildProviderModelCatalog, resolveProviderSelection, resolveProviderSettings } from "../config/resolve-provider.js";
import { configuredModelForProvider, defaultModelForProvider, resolveDisambiguatedModelSelection } from "../config/resolve-model.js";
import { resolveProfile } from "../config/profiles.js";
import { resolveProfileName } from "../config/env.js";
import type { AgenCConfig } from "../config/schema.js";
import { extractFlagValue } from "./route.js";

const DEFAULT_MODEL = "grok-4.5";

export const PROVIDER_MODEL_CATALOG = BUILT_IN_PROVIDER_MODEL_CATALOG;

const DEFAULT_PROVIDER: ProviderName = "grok";

const DEFAULT_MODEL_BY_PROVIDER = BUILT_IN_PROVIDER_DEFAULT_MODELS;

export interface StartupCliFlags {
  readonly provider?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly permissionMode?: PermissionMode;
  readonly allowDangerouslySkipPermissions?: boolean;
  readonly autonomousMode?: boolean;
}

export interface StartupSelection {
  readonly config: AgenCConfig;
  readonly profileName?: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly apiKey?: string;
}

export function readStartupCliFlags(
  argv: readonly string[],
): StartupCliFlags {
  const userArgv = argv.slice(2);
  const provider = extractFlagValue(userArgv, "--provider") ?? undefined;
  const model = extractFlagValue(userArgv, "--model") ?? undefined;
  const profile = extractFlagValue(userArgv, "--profile") ?? undefined;
  const rawPermissionMode =
    extractFlagValue(userArgv, "--permission-mode") ?? undefined;
  // Distinguish "flag absent" from "flag present but invalid". An invalid
  // value must not be silently coerced to `undefined` (which would boot in
  // DEFAULT mode — a silent failure toward a LESS restrictive session). Throw
  // a helpful error mirroring `resolveProviderNameOrThrow` / `/permissions
  // mode`, surfacing as a clean error + non-zero exit at the CLI entrypoint.
  const permissionMode = resolvePermissionModeOrThrow(rawPermissionMode);
  const allowDangerouslySkipPermissions =
    userArgv.includes("--yolo") ||
    userArgv.includes("--dangerously-bypass-approvals-and-sandbox") ||
    userArgv.includes("--allow-dangerously-skip-permissions");
  const autonomousMode =
    userArgv.includes("--autonomous") || userArgv.includes("--proactive");
  return Object.freeze({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(profile ? { profile } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(allowDangerouslySkipPermissions
      ? { allowDangerouslySkipPermissions: true }
      : {}),
    ...(autonomousMode ? { autonomousMode: true } : {}),
  });
}

function resolvePermissionModeOrThrow(
  raw: string | undefined,
): PermissionMode | undefined {
  // Flag absent (or explicitly empty) — keep the default-mode behavior.
  if (!raw) return undefined;
  // A user-addressable mode — honor it.
  if (isUserAddressablePermissionMode(raw)) return raw;
  // A VALID permission mode that simply isn't user-addressable (e.g. the
  // internal/daemon-only "unattended" or "bubble" modes). The existing
  // contract is to silently IGNORE these at the startup CLI surface, not
  // error — they are recognized, just not selectable here.
  if (isPermissionMode(raw)) return undefined;
  // Anything else is a genuine typo / garbage value. Throw a helpful error
  // mirroring `resolveProviderNameOrThrow` / `/permissions mode` so a typo
  // toward a more restrictive mode can't silently boot a LESS restrictive
  // session.
  throw new Error(
    `unknown permission mode '${raw}'. Expected one of: ${USER_ADDRESSABLE_PERMISSION_MODES.join(", ")}`,
  );
}

function resolveProviderNameOrThrow(raw: string): ProviderName {
  const normalized = normalizeProviderName(raw);
  if (normalized === null) {
    throw new Error(
      `unknown provider '${raw}'. Expected one of: ${Object.keys(DEFAULT_MODEL_BY_PROVIDER).join(", ")}`,
    );
  }
  return normalized;
}

function firstNonEmpty(
  ...values: Array<string | undefined>
): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function envModelForProvider(
  provider: ProviderName,
  env: NodeJS.ProcessEnv,
): string | undefined {
  switch (provider) {
    case "openai-compatible":
      return firstNonEmpty(env.OPENAI_COMPATIBLE_MODEL, env.OPENAI_MODEL);
    case "amazon-bedrock":
      return firstNonEmpty(env.AWS_BEDROCK_MODEL);
    default:
      return undefined;
  }
}

function configuredStartupModelForProvider(
  config: AgenCConfig,
  provider: ProviderName,
): string | undefined {
  const configured = configuredModelForProvider(config, provider);
  if (provider !== "openai-compatible" || configured !== DEFAULT_MODEL) {
    return configured;
  }

  const providerDefault = config.providers?.[provider]?.default_model?.trim();
  if (providerDefault) return configured;

  return undefined;
}

function startupModelForProvider(params: {
  readonly config: AgenCConfig;
  readonly provider: ProviderName;
  readonly env: NodeJS.ProcessEnv;
  readonly modelOverride?: string;
}): string {
  return (
    params.modelOverride ??
    configuredStartupModelForProvider(params.config, params.provider) ??
    envModelForProvider(params.provider, params.env) ??
    defaultModelForProvider(params.provider)
  );
}

/**
 * Resolve a model slug to a {provider, model} pair, THROWING on an ambiguous
 * or unknown model.
 *
 * This is shared selection code: `resolveStartupSelection` is reached not only
 * from the `bin/agenc.ts` CLI entrypoints but also from the daemon/TUI context
 * (`app-server-client` `createAgenCDaemonOnlyTuiContext`). An earlier version
 * called `process.exit(1)` here, which hard-killed the process for any caller —
 * even ones (daemon/TUI) that want to intercept the failure for cleanup or
 * remapping. Mirroring `resolvePermissionModeOrThrow`, this now throws a
 * catchable error and lets each caller's existing `try/catch` decide. The CLI
 * entrypoints already funnel thrown errors through `main()`'s top-level catch,
 * which emits a clean `agenc: <message>` and exits 1 — so the user-visible CLI
 * behavior for an ambiguous/unknown `--model` is unchanged (clean message, no
 * stack trace), while non-CLI callers regain control.
 *
 * The original `AmbiguousModelError` / `UnknownModelError` are re-thrown
 * unchanged so callers can `instanceof`-discriminate and their messages stay
 * stable.
 */
export function resolveModelOrThrow(
  slug: string,
  catalog: Readonly<Record<string, readonly string[]>> = PROVIDER_MODEL_CATALOG,
): { provider: string; model: string } {
  return resolveDisambiguatedModelSelection({ slug, catalog });
}

export function resolveStartupSelection(params: {
  readonly config: AgenCConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
}): StartupSelection {
  const env = params.env ?? process.env;
  const cli = readStartupCliFlags(params.argv ?? process.argv);
  const profileName = cli.profile ?? resolveProfileName(env);
  const configWithProfile =
    profileName !== undefined ? resolveProfile(params.config, profileName) : params.config;

  const providerOverride = resolveProviderSelection({
    cliProvider: cli.provider,
    cliModel: cli.model,
    config: configWithProfile,
    env,
  });
  const modelOverride = cli.model ?? undefined;
  const providerCatalog = buildProviderModelCatalog(configWithProfile);

  if (typeof modelOverride === "string" && modelOverride.includes(":")) {
    const resolved = resolveModelOrThrow(modelOverride, providerCatalog);
    const providerSettings = resolveProviderSettings(
      resolved.provider,
      configWithProfile,
      env,
    );
    return {
      config: configWithProfile,
      ...(profileName !== undefined ? { profileName } : {}),
      provider: resolved.provider as ProviderName,
      model: resolved.model,
      ...(providerSettings?.apiKey
        ? { apiKey: providerSettings.apiKey }
        : {}),
    };
  }

  if (providerOverride) {
    const provider = resolveProviderNameOrThrow(providerOverride);
    const providerSettings = resolveProviderSettings(
      provider,
      configWithProfile,
      env,
    );
    const model = startupModelForProvider({
      config: configWithProfile,
      provider,
      env,
      ...(modelOverride ? { modelOverride } : {}),
    });
    return {
      config: configWithProfile,
      ...(profileName !== undefined ? { profileName } : {}),
      provider,
      model,
      ...(providerSettings?.apiKey
        ? { apiKey: providerSettings.apiKey }
        : {}),
    };
  }

  const configProvider = configWithProfile.model_provider;
  if (configProvider && configProvider.length > 0) {
    const provider = resolveProviderNameOrThrow(configProvider);
    const providerSettings = resolveProviderSettings(
      provider,
      configWithProfile,
      env,
    );
    const model = startupModelForProvider({
      config: configWithProfile,
      provider,
      env,
      ...(modelOverride ? { modelOverride } : {}),
    });
    return {
      config: configWithProfile,
      ...(profileName !== undefined ? { profileName } : {}),
      provider,
      model,
      ...(providerSettings?.apiKey
        ? { apiKey: providerSettings.apiKey }
        : {}),
    };
  }

  if (modelOverride ?? configWithProfile.model) {
    const resolved = resolveModelOrThrow(
      modelOverride ?? configWithProfile.model ?? DEFAULT_MODEL,
      providerCatalog,
    );
    const providerSettings = resolveProviderSettings(
      resolved.provider,
      configWithProfile,
      env,
    );
    return {
      config: configWithProfile,
      ...(profileName !== undefined ? { profileName } : {}),
      provider: resolved.provider as ProviderName,
      model: resolved.model,
      ...(providerSettings?.apiKey
        ? { apiKey: providerSettings.apiKey }
        : {}),
    };
  }

  const defaultSettings = resolveProviderSettings(
    DEFAULT_PROVIDER,
    configWithProfile,
    env,
  );
  return {
    config: configWithProfile,
    ...(profileName !== undefined ? { profileName } : {}),
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    ...(defaultSettings?.apiKey
      ? { apiKey: defaultSettings.apiKey }
      : {}),
  };
}
