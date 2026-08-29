import {
  mergeProviderModelLayer,
  resolveProviderSlugOrThrow,
  UnknownProviderError,
  type ProviderSlug,
} from "../config/provider-model-authority.js";
import { defaultConfig, type AgenCConfig } from "../config/schema.js";
import { resolveBuiltInProviderSlug } from "../llm/registry/provider-info.js";
import type { Session } from "./session.js";
import { asRecord } from "../utils/record.js";
import {
  isModelAllowed,
  ModelNotAllowedError,
} from "../utils/model/modelAllowlist.js";

export interface SessionSelection {
  readonly provider: string;
  readonly model: string;
}

export interface BuiltInSessionSelection extends SessionSelection {
  readonly provider: ProviderSlug;
  /** Non-empty when an invalid live provider pair was rejected. */
  readonly rejectedProvider?: string;
}

export interface ResolvedSessionSelection extends BuiltInSessionSelection {
  readonly providerChanged: boolean;
}

export interface ReadSessionSelectionOptions {
  /** Prefer the complete pair staged for the next turn, when present. */
  readonly includePending?: boolean;
  /** Canonical config snapshot for bridge sessions without a ConfigStore. */
  readonly fallbackConfig?: AgenCConfig;
}

export function resolveProviderModelSelection(
  config: AgenCConfig | undefined,
  current: SessionSelection,
  layer: Pick<AgenCConfig, "model_provider" | "model">,
): ResolvedSessionSelection {
  const configuredBase = mergeProviderModelLayer(defaultConfig(), config ?? {});
  const currentProvider = resolveBuiltInProviderSlug(current.provider);
  const base =
    currentProvider === undefined || current.model === "unknown"
      ? configuredBase
      : mergeProviderModelLayer(configuredBase, {
          model_provider: currentProvider,
          model: current.model,
        });
  const resolutionBase = Object.prototype.hasOwnProperty.call(
    layer,
    "model_provider",
  )
    ? configuredBase
    : base;
  const resolved = mergeProviderModelLayer(resolutionBase, layer);
  const provider = resolveProviderSlugOrThrow(resolved.model_provider ?? "");
  const model = nonEmptyString(resolved.model);
  if (model === undefined) {
    throw new Error("model selection values must be non-empty");
  }
  if (!isModelAllowed(provider, model, config ?? {})) {
    throw new ModelNotAllowedError(model);
  }
  return Object.freeze({
    provider,
    model,
    providerChanged: provider !== currentProvider,
  });
}

const UNKNOWN_SELECTION: SessionSelection = Object.freeze({
  provider: "unknown",
  model: "unknown",
});

export function formatSessionSelectionError(error: unknown): string {
  if (error instanceof UnknownProviderError) {
    return `unknown provider '${error.provider}'`;
  }
  return error instanceof Error ? error.message : String(error);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function pair(provider: unknown, model: unknown): SessionSelection | undefined {
  const normalizedProvider = nonEmptyString(provider);
  const normalizedModel = nonEmptyString(model);
  if (normalizedProvider === undefined || normalizedModel === undefined) {
    return undefined;
  }
  return Object.freeze({
    provider: normalizedProvider,
    model: normalizedModel,
  });
}

function configPair(config: unknown): SessionSelection | undefined {
  const record = asRecord(config);
  return pair(record?.model_provider, record?.model);
}

function configStoreCurrent(sessionRecord: Record<string, unknown> | null):
  | AgenCConfig
  | undefined {
  const services = asRecord(sessionRecord?.services);
  const configStore = asRecord(services?.configStore);
  const current = configStore?.current;
  return typeof current === "function"
    ? (current.call(services?.configStore) as AgenCConfig | undefined)
    : undefined;
}

function sessionConfigurationPair(
  configuration: unknown,
): SessionSelection | undefined {
  const record = asRecord(configuration);
  return pair(
    asRecord(record?.provider)?.slug,
    asRecord(record?.collaborationMode)?.model,
  );
}

/**
 * Read one atomic provider/model pair from session-owned runtime authority.
 *
 * A source is used only when it supplies both fields. This prevents a stale
 * session model, React projection, or partial bridge object from being paired
 * with a provider selected by a different authority.
 */
export function readSessionSelection(
  session: Session | unknown,
  options: ReadSessionSelectionOptions = {},
): SessionSelection {
  const sessionRecord = asRecord(session);

  if (options.includePending === true) {
    const pending = asRecord(sessionRecord?.pendingProviderSwitch);
    const pendingPair = pair(pending?.provider, pending?.model);
    if (pendingPair !== undefined) return pendingPair;
  }

  const services = asRecord(sessionRecord?.services);
  const providerService = asRecord(services?.providerService);
  const current = providerService?.current;
  if (typeof current === "function") {
    const binding = asRecord(current.call(services?.providerService));
    const servicePair = pair(binding?.provider, binding?.model);
    if (servicePair !== undefined) return servicePair;
  }

  const state = asRecord(sessionRecord?.state);
  const peek = state?.unsafePeek;
  if (typeof peek === "function") {
    const snapshot = asRecord(peek.call(sessionRecord?.state));
    const statePair = sessionConfigurationPair(snapshot?.sessionConfiguration);
    if (statePair !== undefined) return statePair;
  }

  const directPair = sessionConfigurationPair(
    sessionRecord?.sessionConfiguration,
  );
  if (directPair !== undefined) return directPair;

  const fallbackPair = configPair(options.fallbackConfig);
  if (fallbackPair !== undefined) return fallbackPair;

  const storePair = configPair(configStoreCurrent(sessionRecord));
  if (storePair !== undefined) return storePair;

  return UNKNOWN_SELECTION;
}

function canonicalConfigSelection(config?: AgenCConfig): BuiltInSessionSelection {
  const canonical = mergeProviderModelLayer(defaultConfig(), config ?? {});
  const provider = resolveProviderSlugOrThrow(canonical.model_provider ?? "");
  const model = nonEmptyString(canonical.model);
  if (model === undefined) {
    throw new Error("model selection values must be non-empty");
  }
  return Object.freeze({ provider, model });
}

/**
 * Read a live built-in pair, falling back through the canonical config engine.
 * Menus use this projection instead of maintaining their own provider/model
 * fallback trees.
 */
export function readBuiltInSessionSelection(
  session: Session | unknown,
  options: ReadSessionSelectionOptions = {},
): BuiltInSessionSelection {
  const current = readSessionSelection(session, options);
  const provider = resolveBuiltInProviderSlug(current.provider);
  if (provider !== undefined && current.model !== "unknown") {
    return Object.freeze({ provider, model: current.model });
  }

  const sessionRecord = asRecord(session);
  const fallback = canonicalConfigSelection(
    options.fallbackConfig ?? configStoreCurrent(sessionRecord),
  );
  return current.provider === "unknown" || provider !== undefined
    ? fallback
    : Object.freeze({
        ...fallback,
        rejectedProvider: current.provider,
      });
}

/**
 * Resolve one provider/model request against the session's atomic live pair
 * and canonical ConfigStore snapshot. Every command ingress uses this adapter;
 * only the config authority decides provider inference and provider defaults.
 */
export function resolveSessionProviderModelSelection(
  session: Session | unknown,
  layer: Pick<AgenCConfig, "model_provider" | "model">,
  options: ReadSessionSelectionOptions = {},
): ResolvedSessionSelection {
  const sessionRecord = asRecord(session);
  const config = options.fallbackConfig ?? configStoreCurrent(sessionRecord);
  const current = readSessionSelection(session, {
    ...options,
    ...(config === undefined ? {} : { fallbackConfig: config }),
  });
  return resolveProviderModelSelection(config, current, layer);
}
