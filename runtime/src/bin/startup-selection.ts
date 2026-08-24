import { resolve as resolvePath } from "node:path";

import {
  resolveBuiltInProviderSlug,
  type ProviderName,
} from "../llm/provider.js";
import {
  isUserAddressablePermissionMode,
  USER_ADDRESSABLE_PERMISSION_MODES,
  type PermissionMode,
} from "../permissions/types.js";
import {
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  BUILT_IN_PROVIDER_MODEL_CATALOG,
  buildProviderModelCatalog,
  resolveProviderSelection,
  resolveProviderSettings,
} from "../config/resolve-provider.js";
import {
  configuredModelForProvider,
  defaultModelForProvider,
  resolveDisambiguatedModelSelection,
} from "../config/resolve-model.js";
import { resolveProfile } from "../config/profiles.js";
import {
  assertNoObsoleteConfigEnvironment,
  resolveProfileName,
} from "../config/env.js";
import type { AgenCConfig } from "../config/schema.js";
import { tokenizeCliOptionRegion } from "./cli-option-region.js";
import { extractFlagValue } from "./route.js";
import {
  assertNoRetiredStartupFlags,
  AUTONOMOUS_FLAG,
  DANGEROUS_BYPASS_FLAG,
} from "./startup-flags.js";

const DEFAULT_MODEL = "grok-4.6";

export const PROVIDER_MODEL_CATALOG = BUILT_IN_PROVIDER_MODEL_CATALOG;

const DEFAULT_PROVIDER: ProviderName = "grok";

const DEFAULT_MODEL_BY_PROVIDER = BUILT_IN_PROVIDER_DEFAULT_MODELS;

export interface StartupCliFlags {
  readonly provider?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly permissionMode?: PermissionMode;
  readonly dangerouslyBypassApprovalsAndSandbox?: boolean;
  readonly autonomousMode?: boolean;
  readonly simpleMode?: boolean;
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
  const { optionArgs } = tokenizeCliOptionRegion(userArgv);
  assertNoRetiredStartupFlags(optionArgs);
  const provider = extractFlagValue(optionArgs, "--provider") ?? undefined;
  const model = extractFlagValue(optionArgs, "--model") ?? undefined;
  const profile = extractFlagValue(optionArgs, "--profile") ?? undefined;
  const configPath = extractFlagValue(optionArgs, "--config") ?? undefined;
  const rawPermissionMode =
    extractFlagValue(optionArgs, "--permission-mode") ?? undefined;
  // Distinguish "flag absent" from "flag present but invalid". An invalid
  // value must not be silently coerced to `undefined` (which would boot in
  // DEFAULT mode — a silent failure toward a LESS restrictive session). Throw
  // a helpful error mirroring `resolveProviderNameOrThrow` / `/permissions
  // mode`, surfacing as a clean error + non-zero exit at the CLI entrypoint.
  const permissionMode = resolvePermissionModeOrThrow(rawPermissionMode);
  const dangerouslyBypassApprovalsAndSandbox =
    optionArgs.includes(DANGEROUS_BYPASS_FLAG);
  const autonomousMode = optionArgs.includes(AUTONOMOUS_FLAG);
  const simpleMode = optionArgs.includes("--bare");
  return Object.freeze({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(profile ? { profile } : {}),
    ...(configPath ? { configPath } : {}),
    ...(permissionMode ? { permissionMode } : {}),
    ...(dangerouslyBypassApprovalsAndSandbox
      ? { dangerouslyBypassApprovalsAndSandbox: true }
      : {}),
    ...(autonomousMode ? { autonomousMode: true } : {}),
    ...(simpleMode ? { simpleMode: true } : {}),
  });
}

function resolvePermissionModeOrThrow(
  raw: string | undefined,
): PermissionMode | undefined {
  // Flag absent (or explicitly empty) — keep the default-mode behavior.
  if (!raw) return undefined;
  // A user-addressable mode — honor it.
  if (isUserAddressablePermissionMode(raw)) return raw;
  // Internal modes and typos are both invalid at the user-facing CLI. Never
  // recognize a value and then silently discard it: that would boot with a
  // different permission mode than the operator requested.
  throw new Error(
    `unknown permission mode '${raw}'. Expected one of: ${USER_ADDRESSABLE_PERMISSION_MODES.join(", ")}`,
  );
}

function resolveProviderNameOrThrow(raw: string): ProviderName {
  const normalized = resolveBuiltInProviderSlug(raw);
  if (normalized === undefined) {
    throw new Error(
      `unknown provider '${raw}'. Expected one of: ${Object.keys(DEFAULT_MODEL_BY_PROVIDER).join(", ")}`,
    );
  }
  return normalized;
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
  readonly modelOverride?: string;
}): string {
  return (
    params.modelOverride ??
    configuredStartupModelForProvider(params.config, params.provider) ??
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

export interface StartupConfigLayerOptions {
  readonly flagConfigPath?: string;
  readonly profileName?: string;
  readonly cliOverrides?: (config: AgenCConfig) => AgenCConfig | undefined;
}

/**
 * Build the immutable layers for the one ConfigStore owned by this startup.
 * The CLI override is a resolver, rather than a precomputed object, because it
 * must run after explicit config/profile/environment layers. That keeps a
 * provider-only override coupled to the configured provider default model and
 * gives qualified models the complete configured catalog.
 */
export function startupConfigLayerOptions(params: {
  readonly cli: StartupCliFlags;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd: string;
}): StartupConfigLayerOptions {
  const env: NodeJS.ProcessEnv = Object.freeze({
    ...(params.env ?? process.env),
  });
  assertNoObsoleteConfigEnvironment(env);
  const hasProviderOrModelOverride =
    params.cli.provider !== undefined || params.cli.model !== undefined;
  const cliOverrides = hasProviderOrModelOverride
    ? (config: AgenCConfig): AgenCConfig => {
        const selected = resolvePreparedStartupSelection({
          config,
          env,
          cli: params.cli,
        });
        return Object.freeze({
          model_provider: selected.provider,
          model: selected.model,
        });
      }
    : undefined;
  return Object.freeze({
    ...(params.cli.configPath !== undefined
      ? { flagConfigPath: resolvePath(params.cwd, params.cli.configPath) }
      : {}),
    ...(params.cli.profile !== undefined
      ? { profileName: params.cli.profile }
      : {}),
    ...(cliOverrides !== undefined ? { cliOverrides } : {}),
  });
}

export function resolvedStartupProfileName(
  cli: StartupCliFlags,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return cli.profile ?? resolveProfileName(env);
}

/**
 * Resolve provider/model/API-key metadata from an already layered canonical
 * snapshot. Generic provider/model/profile env and CLI selectors are not read
 * again here: ConfigStore has already projected those authorities. Provider-
 * specific credential and transport env remains runtime input; model env
 * names are not a second selection authority.
 */
export function resolveCanonicalStartupSelection(params: {
  readonly config: AgenCConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly profileName?: string;
}): StartupSelection {
  const env = params.env ?? process.env;
  const config = params.config;
  const configuredProvider = config.model_provider?.trim();
  let provider: ProviderName;
  let model: string;

  if (config.model?.trim().toLowerCase() === "agenc") {
    provider = "agenc";
    model = "agenc";
  } else if (configuredProvider) {
    provider = resolveProviderNameOrThrow(configuredProvider);
    model = startupModelForProvider({ config, provider });
  } else if (config.model?.trim()) {
    const resolved = resolveModelOrThrow(
      config.model,
      buildProviderModelCatalog(config),
    );
    provider = resolveProviderNameOrThrow(resolved.provider);
    model = resolved.model;
  } else {
    provider = DEFAULT_PROVIDER;
    model = DEFAULT_MODEL;
  }

  const providerSettings = resolveProviderSettings(provider, config, env);
  return {
    config,
    ...(params.profileName !== undefined
      ? { profileName: params.profileName }
      : {}),
    provider,
    model,
    ...(providerSettings?.apiKey ? { apiKey: providerSettings.apiKey } : {}),
  };
}

function resolvePreparedStartupSelection(params: {
  readonly config: AgenCConfig;
  readonly env: NodeJS.ProcessEnv;
  readonly cli: StartupCliFlags;
  readonly profileName?: string;
}): StartupSelection {
  const { config, env, cli } = params;
  const providerOverride = resolveProviderSelection({
    cliProvider: cli.provider,
    cliModel: cli.model,
    config,
    env,
  });
  const modelOverride = cli.model ?? undefined;
  const providerCatalog = buildProviderModelCatalog(config);

  if (typeof modelOverride === "string" && modelOverride.includes(":")) {
    const resolved = resolveModelOrThrow(modelOverride, providerCatalog);
    const providerSettings = resolveProviderSettings(
      resolved.provider,
      config,
      env,
    );
    return {
      config,
      ...(params.profileName !== undefined
        ? { profileName: params.profileName }
        : {}),
      provider: resolved.provider as ProviderName,
      model: resolved.model,
      ...(providerSettings?.apiKey ? { apiKey: providerSettings.apiKey } : {}),
    };
  }

  if (providerOverride) {
    const provider = resolveProviderNameOrThrow(providerOverride);
    const providerSettings = resolveProviderSettings(provider, config, env);
    const model = startupModelForProvider({
      config,
      provider,
      ...(modelOverride ? { modelOverride } : {}),
    });
    return {
      config,
      ...(params.profileName !== undefined
        ? { profileName: params.profileName }
        : {}),
      provider,
      model,
      ...(providerSettings?.apiKey ? { apiKey: providerSettings.apiKey } : {}),
    };
  }

  const configProvider = config.model_provider;
  if (configProvider && configProvider.length > 0) {
    const provider = resolveProviderNameOrThrow(configProvider);
    const providerSettings = resolveProviderSettings(provider, config, env);
    const model = startupModelForProvider({
      config,
      provider,
      ...(modelOverride ? { modelOverride } : {}),
    });
    return {
      config,
      ...(params.profileName !== undefined
        ? { profileName: params.profileName }
        : {}),
      provider,
      model,
      ...(providerSettings?.apiKey ? { apiKey: providerSettings.apiKey } : {}),
    };
  }

  if (modelOverride ?? config.model) {
    const resolved = resolveModelOrThrow(
      modelOverride ?? config.model ?? DEFAULT_MODEL,
      providerCatalog,
    );
    const providerSettings = resolveProviderSettings(
      resolved.provider,
      config,
      env,
    );
    return {
      config,
      ...(params.profileName !== undefined
        ? { profileName: params.profileName }
        : {}),
      provider: resolved.provider as ProviderName,
      model: resolved.model,
      ...(providerSettings?.apiKey ? { apiKey: providerSettings.apiKey } : {}),
    };
  }

  const defaultSettings = resolveProviderSettings(DEFAULT_PROVIDER, config, env);
  return {
    config,
    ...(params.profileName !== undefined
      ? { profileName: params.profileName }
      : {}),
    provider: DEFAULT_PROVIDER,
    model: DEFAULT_MODEL,
    ...(defaultSettings?.apiKey ? { apiKey: defaultSettings.apiKey } : {}),
  };
}

export function resolveStartupSelection(params: {
  readonly config: AgenCConfig;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly cli?: StartupCliFlags;
}): StartupSelection {
  const env = params.env ?? process.env;
  assertNoObsoleteConfigEnvironment(env);
  const cli = params.cli ?? readStartupCliFlags(params.argv ?? process.argv);
  const profileName = resolvedStartupProfileName(cli, env);
  const configWithProfile =
    profileName !== undefined
      ? resolveProfile(params.config, profileName)
      : params.config;
  return resolvePreparedStartupSelection({
    config: configWithProfile,
    env,
    cli,
    ...(profileName !== undefined ? { profileName } : {}),
  });
}
