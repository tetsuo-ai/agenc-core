import { defaultModelForProvider } from "../config/resolve-model.js";
import { assertModelCatalogSelection, openRouterSelectionNotice } from "../llm/model-catalog-selection.js";
import { resolve as resolvePath } from "node:path";

import { ModelMetadataResolver, type ModelMetadataResolverOptions } from "../llm/model-metadata.js";
import { veniceDefaultModel } from "../llm/registry/venice-models.js";
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
  /** The same scoped provider environment used to create this session. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Catalog dependencies captured at ingress, never rediscovered from env. */
  readonly metadata?: Omit<ModelMetadataResolverOptions, "env">;
  /** A model typed at CLI ingress. Omit for saved, profile, or restored selections. */
  readonly explicitModel?: string;
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
  if (provider === "openrouter" && params.metadata !== undefined) {
    new ModelMetadataResolver({ ...params.metadata, env: params.env }).readOpenRouterCatalog();
  }
  // Saved models may outlive a curated catalog entry or arrive before Core
  // learns about them. Preserve main's startup behavior for those selections.
  if (params.explicitModel !== undefined) {
    assertModelCatalogSelection(config, provider, canonicalModel, params.env);
    const note = provider === "openrouter" ? openRouterSelectionNotice(canonicalModel) : undefined;
    if (note !== undefined) console.warn(note);
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

/** Discover only a provider default. Explicit CLI/config model choices stay pinned. */
export async function resolveDiscoveredStartupDefault(
  startup: StartupSelection,
  modelSelectionSource: "explicit" | "provider_default" | undefined,
  metadata: ModelMetadataResolverOptions,
): Promise<StartupSelection> {
  if (startup.provider === "openrouter" && modelSelectionSource === "provider_default" &&
      !startup.config.providers?.openrouter?.default_model) {
    const resolver = new ModelMetadataResolver(metadata);
    resolver.readOpenRouterCatalog();
    void resolver.discoverOpenRouterModels();
    const model = defaultModelForProvider("openrouter");
    if (model !== startup.model) return { ...startup, model, config: { ...startup.config, model } };
    return startup;
  }
  if (startup.provider !== "venice" || startup.config.providers?.venice?.default_model) return startup;
  if (modelSelectionSource !== "provider_default") return startup;
  const models = await new ModelMetadataResolver(metadata).discoverVeniceModels(startup.config);
  const model = veniceDefaultModel(models ?? []);
  if (!model || model === startup.model) return startup;
  return resolveCanonicalStartupSelection({
    config: { ...startup.config, model },
    env: metadata.env ?? process.env,
    ...(startup.profileName === undefined ? {} : { profileName: startup.profileName }),
  });
}
