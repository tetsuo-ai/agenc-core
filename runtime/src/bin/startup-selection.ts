import { resolve as resolvePath } from "node:path";

import type { ProviderName } from "../llm/provider.js";
import {
  resolveProviderModelLayer,
  resolveProviderSlugOrThrow,
} from "../config/provider-model-authority.js";
import { resolveProfileName } from "../config/env.js";
import type { AgenCConfig } from "../config/schema.js";
import { tokenizeCliOptionRegion } from "./cli-option-region.js";
import { extractFlagValue } from "./route.js";
import {
  parseDeadlineFlag,
  parseDeadlineReserveFlag,
  resolveDeadlineReserveMs,
} from "../session/run-deadline.js";
import {
  isModelAllowed,
  ModelNotAllowedError,
} from "../utils/model/modelAllowlist.js";
import type { StartupCliFlags } from "./startup-cli-flags.js";
export { readStartupCliFlags, type StartupCliFlags } from "./startup-cli-flags.js";

/**
 * `--deadline` / `--deadline-reserve` for a print-mode run (#2503), resolved
 * once against `nowMs` into the runtime options the daemon receives. The
 * router has already rejected malformed values and non-print modes.
 */
export function readRunDeadlineFlags(
  argv: readonly string[],
  nowMs: number,
): { readonly deadlineAt?: number; readonly deadlineReserveMs?: number } {
  const { optionArgs } = tokenizeCliOptionRegion(argv.slice(2));
  const deadline = extractFlagValue(optionArgs, "--deadline");
  if (deadline === null) return {};
  const deadlineAt = parseDeadlineFlag(deadline, nowMs);
  const reserve = extractFlagValue(optionArgs, "--deadline-reserve");
  return {
    deadlineAt,
    deadlineReserveMs: resolveDeadlineReserveMs(
      deadlineAt - nowMs,
      reserve === null ? undefined : parseDeadlineReserveFlag(reserve),
    ),
  };
}

export interface StartupSelection {
  readonly config: AgenCConfig;
  readonly profileName?: string;
  readonly provider: ProviderName;
  readonly model: string;
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
    params.cli.provider !== undefined || params.cli.model !== undefined ||
    params.cli.taskTokenBudget !== undefined || params.cli.taskMaxCalls !== undefined;
  const cliOverrides = hasProviderOrModelOverride
    ? Object.freeze({
        ...(params.cli.budgetLevel !== undefined ? { budget_level: params.cli.budgetLevel } : {}),
        ...(params.cli.taskTokenBudget !== undefined ? { task_token_budget: params.cli.taskTokenBudget } : {}),
        ...(params.cli.taskMaxCalls !== undefined ? { task_max_calls: params.cli.taskMaxCalls } : {}),
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
