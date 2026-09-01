import { resolve as resolvePath } from "node:path";

import type { ProviderName } from "../llm/provider.js";
import {
  isUserAddressablePermissionMode,
  USER_ADDRESSABLE_PERMISSION_MODES,
  type PermissionMode,
} from "../permissions/types.js";
import {
  resolveProviderModelLayer,
  resolveProviderSlugOrThrow,
} from "../config/provider-model-authority.js";
import { resolveProfileName } from "../config/env.js";
import type { AgenCConfig } from "../config/schema.js";
import { tokenizeCliOptionRegion } from "./cli-option-region.js";
import { extractFlagValue, extractFlagValues } from "./route.js";
import {
  assertNoRetiredStartupFlags,
  AUTONOMOUS_FLAG,
  DANGEROUS_BYPASS_FLAG,
} from "./startup-flags.js";
import {
  isModelAllowed,
  ModelNotAllowedError,
} from "../utils/model/modelAllowlist.js";

export interface StartupCliFlags {
  readonly provider?: string;
  readonly model?: string;
  readonly profile?: string;
  readonly configPath?: string;
  readonly addDirs?: readonly string[];
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
  const addDirs = extractFlagValues(optionArgs, "--add-dir");
  const rawPermissionMode =
    extractFlagValue(optionArgs, "--permission-mode") ?? undefined;
  // Distinguish "flag absent" from "flag present but invalid". An invalid
  // value must not be silently coerced to `undefined` (which would boot in
  // DEFAULT mode — a silent failure toward a LESS restrictive session). Throw
  // a helpful error mirroring provider validation and `/permissions mode`,
  // surfacing as a clean error + non-zero exit at the CLI entrypoint.
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
    ...(addDirs.length > 0 ? { addDirs: Object.freeze(addDirs) } : {}),
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

export interface StartupConfigLayerOptions {
  readonly flagConfigPath?: string;
  readonly profileName?: string;
  readonly cliOverrides?: AgenCConfig;
}

/**
 * Build the immutable layers for the one ConfigStore owned by this startup.
 * Provider/model coupling belongs to the repository layer merger. Startup
 * contributes only the operator's literal CLI patch.
 */
export function startupConfigLayerOptions(params: {
  readonly cli: StartupCliFlags;
  readonly cwd: string;
}): StartupConfigLayerOptions {
  const hasProviderOrModelOverride =
    params.cli.provider !== undefined || params.cli.model !== undefined;
  const cliOverrides = hasProviderOrModelOverride
    ? Object.freeze({
        ...(params.cli.provider !== undefined
          ? { model_provider: params.cli.provider }
          : {}),
        ...(params.cli.model !== undefined
          ? { model: params.cli.model }
          : {}),
      })
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
 * Resolve provider/model metadata from an already layered canonical
 * snapshot. Generic provider/model/profile env and CLI selectors are not read
 * again here: ConfigStore has already projected those authorities. Credentials
 * and provider transport options belong to the runtime provider authority.
 */
export function resolveCanonicalStartupSelection(params: {
  readonly config: AgenCConfig;
  readonly profileName?: string;
}): StartupSelection {
  const config = params.config;
  const configuredProvider = config.model_provider?.trim();
  const model = config.model?.trim();
  if (!configuredProvider || !model) {
    throw new Error(
      "canonical startup config must contain a provider/model pair",
    );
  }
  const canonicalPair = resolveProviderModelLayer(config, {
    model_provider: configuredProvider,
    model,
  });
  const provider: ProviderName = resolveProviderSlugOrThrow(
    canonicalPair.model_provider ?? "",
  );
  const canonicalModel = canonicalPair.model?.trim();
  if (!canonicalModel) {
    throw new Error(
      "canonical startup config must contain a provider/model pair",
    );
  }
  if (!isModelAllowed(provider, canonicalModel, config)) {
    throw new ModelNotAllowedError(canonicalModel);
  }
  const canonicalConfig =
    provider === configuredProvider && canonicalModel === model
      ? config
      : Object.freeze({
          ...config,
          model_provider: provider,
          model: canonicalModel,
        });

  return {
    config: canonicalConfig,
    ...(params.profileName !== undefined
      ? { profileName: params.profileName }
      : {}),
    provider,
    model: canonicalModel,
  };
}
