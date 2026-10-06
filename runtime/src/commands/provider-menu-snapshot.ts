import {
  buildProviderModelCatalog,
  mergeProviderModelLayer,
  type ProviderSlug,
} from "../config/provider-model-authority.js";
import { readProviderConfig, resolveProviderSlug } from "../config/resolve-provider.js";
import { configuredModelForProvider } from "../config/resolve-model.js";
import { defaultConfig, type AgenCConfig } from "../config/schema.js";
import { listBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import { readCommandConfig } from "./config-context.js";
import {
  createProviderCommandAccessOverlay,
  formatProviderCommandRejection,
  type ProviderCommandAccess,
} from "./provider-command-access.js";
import { readBuiltInSessionSelection } from "../session/provider-model-selection.js";
import type { SlashCommandContext } from "./types.js";

type ProviderRowStatus = "current" | "configured" | "default";
export type ProviderAuthState = "managed" | "ready" | "missing" | "optional";
export type ProviderRuntimeState =
  | "active"
  | "available"
  | "local"
  | "unverified"
  | "unauthenticated"
  | "unavailable"
  | "error";
export type ProviderMenuRow = {
  readonly provider: ProviderSlug;
  readonly name: string;
  readonly model: string;
  readonly models: readonly string[];
  readonly baseURL: string;
  readonly status: ProviderRowStatus;
  readonly runtimeState: ProviderRuntimeState;
  readonly authState: ProviderAuthState;
  readonly auth: string;
  readonly credentialSource: string;
  readonly configured: boolean;
  readonly detail: string;
  readonly error?: string;
};

export type ProviderMenuSnapshot = {
  readonly currentProvider: ProviderSlug;
  readonly currentModel: string;
  readonly rows: readonly ProviderMenuRow[];
  readonly activeIndex: number;
  readonly diagnostics: readonly string[];
};

export type ProviderMenuSelectionResult = {
  readonly message: string;
  readonly shouldClose: boolean;
};

function providerModel(params: {
  readonly config?: AgenCConfig;
  readonly provider: ProviderSlug;
  readonly currentProvider: ProviderSlug;
  readonly currentModel: string;
  readonly requestedModel?: string;
}): string {
  if (params.provider === params.currentProvider) return params.currentModel;
  const base = mergeProviderModelLayer(defaultConfig(), params.config ?? {});
  const selection = mergeProviderModelLayer(
    base,
    {
      model_provider: params.provider,
      ...(params.requestedModel === undefined
        ? {}
        : { model: params.requestedModel }),
    },
  );
  const model = selection.model?.trim();
  if (model === undefined || model.length === 0) {
    throw new Error(`No model resolved for provider ${params.provider}`);
  }
  return model;
}

function rowStatus(params: {
  readonly config?: AgenCConfig;
  readonly provider: ProviderSlug;
  readonly currentProvider: ProviderSlug;
}): ProviderRowStatus {
  if (params.provider === params.currentProvider) return "current";
  if (
    params.config !== undefined &&
    configuredModelForProvider(params.config, params.provider) !== undefined
  ) {
    return "configured";
  }
  return "default";
}

function rowDetail(status: ProviderRowStatus): string {
  switch (status) {
    case "current":
      return "active provider";
    case "configured":
      return "configured model";
    case "default":
      return "built-in default";
  }
}

function baseURLError(baseURL: string): string | undefined {
  try {
    new URL(baseURL);
    return undefined;
  } catch {
    return "invalid base URL";
  }
}

function providerMenuAuth(access: ProviderCommandAccess): {
  readonly state: ProviderAuthState;
  readonly label: string;
  readonly source: string;
} {
  const rejection = formatProviderCommandRejection(access, "provider");
  if (rejection !== undefined) {
    const label = access.rejection?.code === "provider-managed-auth-required"
      ? "AgenC sign-in required"
      : access.rejection?.code === "login-required"
        ? "login or BYOK required"
        : access.rejection?.code === "upgrade-required"
          ? "upgrade required"
          : access.rejection?.code === "model-not-managed"
            ? "hosted model unavailable"
            : access.rejection?.code === "configuration"
              ? "configuration error"
              : access.auth.label;
    return { state: "missing", label, source: rejection };
  }
  return {
    state: access.auth.state === "error" ? "missing" : access.auth.state,
    label: access.auth.label,
    source: access.auth.source,
  };
}

function runtimeState(params: {
  readonly status: ProviderRowStatus;
  readonly access: ProviderCommandAccess;
  readonly models: readonly string[];
  readonly baseURL: string;
}): { readonly state: ProviderRuntimeState; readonly error?: string } {
  if (params.access.configurationError !== undefined) {
    return { state: "error", error: params.access.configurationError };
  }
  const baseError = baseURLError(params.baseURL);
  if (baseError !== undefined) {
    return { state: "error", error: baseError };
  }
  if (params.models.length === 0) {
    return { state: "unavailable", error: "no models available" };
  }
  if (
    params.access.effect === "blocked" ||
    params.access.route === "unavailable"
  ) {
    return { state: "unauthenticated" };
  }
  if (params.status === "current") {
    return { state: "active" };
  }
  if (params.access.route === "deferred") {
    return { state: "unverified" };
  }
  if (params.access.route === "local") {
    return { state: "local" };
  }
  return { state: "available" };
}

function runtimeDetail(params: {
  readonly state: ProviderRuntimeState;
  readonly status: ProviderRowStatus;
  readonly error?: string;
}): string {
  if (params.error !== undefined) return params.error;
  switch (params.state) {
    case "active":
      return "active provider";
    case "local":
      return "local endpoint";
    case "available":
      return rowDetail(params.status);
    case "unverified":
      return "credential checked on switch";
    case "unauthenticated":
      return "credential required";
    case "unavailable":
      return "no models";
    case "error":
      return "configuration error";
  }
}

function providerRuntimeRank(state: ProviderRuntimeState): number {
  switch (state) {
    case "active":
      return 0;
    case "available":
      return 1;
    case "local":
      return 2;
    case "unverified":
      return 3;
    case "unauthenticated":
      return 4;
    case "unavailable":
      return 5;
    case "error":
      return 6;
  }
}

function sortProviderRows(
  rows: readonly ProviderMenuRow[],
  currentProvider: ProviderSlug,
): readonly ProviderMenuRow[] {
  return [...rows].sort((left, right) => {
    if (left.provider === currentProvider) return -1;
    if (right.provider === currentProvider) return 1;
    const rankDelta =
      providerRuntimeRank(left.runtimeState) -
      providerRuntimeRank(right.runtimeState);
    if (rankDelta !== 0) return rankDelta;
    return left.provider.localeCompare(right.provider);
  });
}

export function readProviderMenuSnapshot(ctx: SlashCommandContext): ProviderMenuSnapshot {
  const config = readCommandConfig(ctx);
  const accessOverlay = createProviderCommandAccessOverlay(ctx);
  const sessionSelection = readBuiltInSessionSelection(ctx.session, {
    includePending: true,
    ...(config !== undefined ? { fallbackConfig: config } : {}),
  });
  const diagnostics: string[] = [];
  if (sessionSelection.rejectedProvider !== undefined) {
    diagnostics.push(
      `Unknown session provider: ${sessionSelection.rejectedProvider}`,
    );
  }
  const currentProvider = sessionSelection.provider;
  const currentModel = sessionSelection.model;
  const modelCatalog = buildProviderModelCatalog(config);

  const unsortedRows = listBuiltInProviderInfo().map((info): ProviderMenuRow => {
    const provider = info.id;
    const providerConfig = config ? readProviderConfig(config, provider) : undefined;
    const status = rowStatus({ config, provider, currentProvider });
    const configuredModel = providerModel({
      config,
      provider,
      currentProvider,
      currentModel,
    });
    const configuredAccess = accessOverlay.inspect({
      provider,
      model: configuredModel,
    });
    const managedProjectionActive =
      configuredAccess.directCredential?.status === "missing" &&
      configuredAccess.managed.enabled &&
      configuredAccess.managed.signedIn &&
      configuredAccess.managed.defaultModel !== undefined;
    const managedModelRequest = managedProjectionActive
      ? configuredAccess.managed.defaultModel
      : undefined;
    const model = providerModel({
      config,
      provider,
      currentProvider,
      currentModel,
      ...(managedModelRequest === undefined
        ? {}
        : { requestedModel: managedModelRequest }),
    });
    const access = model === configuredModel
      ? configuredAccess
      : accessOverlay.inspect({ provider, model });
    const baseURL = access.endpoint?.baseURL ?? info.baseURL;
    const auth = providerMenuAuth(access);
    const rawModels = modelCatalog[provider] ?? [];
    const models = managedProjectionActive
      ? access.managed.visibleModels
      : rawModels;
    const state = runtimeState({
      status,
      access,
      models,
      baseURL,
    });
    return {
      provider,
      name: info.name,
      model,
      models,
      baseURL,
      status,
      runtimeState: state.state,
      authState: auth.state,
      auth: auth.label,
      credentialSource: auth.source,
      configured:
        providerConfig !== undefined ||
        (config?.model_provider !== undefined &&
          resolveProviderSlug(config.model_provider) === provider),
      detail: runtimeDetail({
        state: state.state,
        status,
        ...(state.error ? { error: state.error } : {}),
      }),
      ...(state.error ? { error: state.error } : {}),
    };
  });

  const rows = sortProviderRows(unsortedRows, currentProvider);
  const currentActiveIndex = rows.findIndex(row => row.provider === currentProvider);
  const activeIndex = Math.max(0, currentActiveIndex);
  return {
    currentProvider,
    currentModel,
    rows,
    activeIndex,
    diagnostics,
  };
}

export function providerMenuFallback(snapshot: ProviderMenuSnapshot): string {
  const lines = [
    "Provider selection",
    `Current: ${snapshot.currentProvider} / ${snapshot.currentModel}`,
    "",
    "Available providers:",
  ];
  for (const row of snapshot.rows) {
    lines.push(
      `  ${row.status === "current" ? "*" : "-"} ${row.provider} -> ${row.model} (${row.detail})`,
    );
  }
  lines.push("", "Run /provider <provider> [model] to switch.");
  return lines.join("\n");
}
