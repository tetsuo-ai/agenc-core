import { openRouterMenuCatalog } from "./openrouter-menu-models.js";
import { OPENROUTER_CATALOG_FALLBACK_NOTE } from "../llm/registry/openrouter-live-catalog.js";
import { withSecureStorageDisplaySnapshot } from "../utils/secureStorage/index.js";
import {
  buildProviderModelCatalog,
  type ProviderSlug,
} from "../config/provider-model-authority.js";
import { resolveProviderSlug } from "../config/resolve-provider.js";
import {
  configuredModelForProvider,
  defaultModelForProvider,
} from "../config/resolve-model.js";
import { resolveRegisteredModelCatalogEntry } from "../llm/registry/model-catalog.js";
import {
  providerLocalModelIdFromCatalog,
} from "../llm/registry/provider-info.js";
import { isModelAllowed } from "../utils/model/modelAllowlist.js";
import type { AgenCConfig } from "../config/schema.js";
import { readCommandConfig, requireCommandConfigStore } from "./config-context.js";
import { readBuiltInSessionSelection } from "../session/provider-model-selection.js";
import { createProviderCommandAccessOverlay } from "./provider-command-access.js";
import type { SlashCommandContext } from "./types.js";
import { readVeniceMenuModels } from "./venice-menu-models.js";
import { readOllamaMenuModels } from "./ollama-menu-models.js";

export type ModelRowStatus =
  | "current"
  | "configured"
  | "default"
  | "available"
  | "unavailable";

type ModelMenuRow = {
  readonly model: string;
  readonly displayModel: string;
  readonly provider: ProviderSlug;
  readonly status: ModelRowStatus;
  readonly detail: string;
  readonly selectable: boolean;
  readonly groupLabel: string;
};

export type ModelMenuSnapshot = {
  readonly provider: ProviderSlug;
  readonly currentModel: string;
  readonly configuredModel?: string;
  readonly defaultModel: string;
  readonly rows: readonly ModelMenuRow[];
  readonly activeIndex: number;
  readonly catalogNote?: string;
  readonly providerCounts: Readonly<Record<string, number>>;
};

export type ModelMenuSelectionResult = {
  readonly message: string;
  readonly shouldClose: boolean;
};

function rowStatus(params: {
  readonly displayModel: string;
  readonly provider: ProviderSlug;
  readonly currentProvider: ProviderSlug;
  readonly currentModel: string;
  readonly configuredModel?: string;
  readonly defaultModel: string;
}): ModelRowStatus {
  if (
    params.provider === params.currentProvider &&
    params.displayModel === providerLocalModelIdFromCatalog(
      params.provider,
      params.currentModel,
    )
  ) {
    return "current";
  }
  if (
    params.configuredModel !== undefined &&
    params.displayModel === providerLocalModelIdFromCatalog(
      params.provider,
      params.configuredModel,
    )
  ) {
    return "configured";
  }
  if (
    params.displayModel === providerLocalModelIdFromCatalog(
      params.provider,
      params.defaultModel,
    )
  ) return "default";
  return "available";
}

function rowDetailForRoute(
  status: ModelRowStatus,
  provider: ProviderSlug,
): string {
  switch (status) {
    case "current":
      return "active session model";
    case "configured":
      return "configured for provider";
    case "default":
      return "built-in provider default";
    case "available":
      return `catalog option for ${provider}`;
    case "unavailable":
      return "no models configured";
  }
}

function providerOrder(
  catalog: Readonly<Record<string, readonly string[]>>,
  currentProvider: ProviderSlug,
): readonly ProviderSlug[] {
  const ids = Object.keys(catalog)
    .map(provider => resolveProviderSlug(provider))
    .filter((provider): provider is ProviderSlug => provider !== undefined);
  const unique = [...new Set(ids)];
  return unique.sort((left, right) => {
    if (left === currentProvider) return -1;
    if (right === currentProvider) return 1;
    return left.localeCompare(right);
  });
}

function isHiddenCatalogModel(provider: ProviderSlug, model: string): boolean {
  return (
    resolveRegisteredModelCatalogEntry({ provider, model })?.visibility ===
      "hide"
  );
}

function providerRows(params: {
  readonly provider: ProviderSlug;
  readonly currentProvider: ProviderSlug;
  readonly currentModel: string;
  readonly config?: AgenCConfig;
  readonly catalogModels: readonly string[];
}): readonly ModelMenuRow[] {
  const configuredModel =
    params.config !== undefined
      ? configuredModelForProvider(params.config, params.provider)
      : undefined;
  const defaultModel = defaultModelForProvider(params.provider);
  const candidates = new Map<string, string>();
  const addCandidate = (model: string, preferCatalogSpelling = false): void => {
    const displayModel = providerLocalModelIdFromCatalog(
      params.provider,
      model,
    );
    if (
      !isModelAllowed(
        params.provider,
        displayModel,
        params.config ?? {},
      )
    ) return;
    if (preferCatalogSpelling || !candidates.has(displayModel)) {
      candidates.set(displayModel, model);
    }
  };
  if (params.provider === params.currentProvider) addCandidate(params.currentModel);
  if (configuredModel !== undefined) addCandidate(configuredModel);
  addCandidate(defaultModel);
  for (const model of params.catalogModels) {
    const trimmed = model.trim();
    if (trimmed.length === 0) continue;
    // `visibility: "hide"` models (e.g. internal review models) stay resolvable
    // via the flat catalog but must not be offered as new picker selections.
    // Current/configured/default candidates bypass visibility filtering.
    if (isHiddenCatalogModel(params.provider, trimmed)) continue;
    addCandidate(trimmed, true);
  }

  if (candidates.size === 0) {
    return [{
      provider: params.provider,
      model: "(no models)",
      displayModel: "(no models)",
      status: "unavailable",
      selectable: false,
      groupLabel: params.provider,
      detail:
        params.config?.availableModels === undefined
          ? rowDetailForRoute(
              "unavailable",
              params.provider,
            )
          : "no models allowed by managed policy",
    }];
  }

  return [...candidates].map(([displayModel, model]): ModelMenuRow => {
    const status = rowStatus({
      displayModel,
      provider: params.provider,
      currentProvider: params.currentProvider,
      currentModel: params.currentModel,
      configuredModel,
      defaultModel,
    });
    return {
      model,
      displayModel,
      provider: params.provider,
      status,
      selectable: status !== "unavailable",
      groupLabel: params.provider,
      detail: rowDetailForRoute(
        status,
        params.provider,
      ),
    };
  });
}

export function readModelMenuSnapshot(ctx: SlashCommandContext): ModelMenuSnapshot {
  return withSecureStorageDisplaySnapshot(requireCommandConfigStore(ctx).homeContext, () => readModelMenuSnapshotFromStorage(ctx));
}

function readModelMenuSnapshotFromStorage(ctx: SlashCommandContext): ModelMenuSnapshot {
  const openrouter = openRouterMenuCatalog(ctx).read();
  const config = readCommandConfig(ctx);
  const sessionSelection = readBuiltInSessionSelection(ctx.session, {
    includePending: true,
    ...(config !== undefined ? { fallbackConfig: config } : {}),
  });
  const provider = sessionSelection.provider;
  const defaultModel = defaultModelForProvider(provider);
  const currentModel = sessionSelection.model;
  const configuredModel =
    config !== undefined ? configuredModelForProvider(config, provider) : undefined;
  // Venice's own list replaces its bundled snapshot once the menu has read it,
  // and so do the models installed on the local Ollama server.
  const veniceModels = readVeniceMenuModels(ctx);
  const ollamaModels = readOllamaMenuModels(ctx);
  const catalog: Readonly<Record<string, readonly string[]>> = {
    ...buildProviderModelCatalog(config),
    ...(veniceModels === undefined ? {} : { venice: veniceModels.map(entry => entry.model) }),
    ...(ollamaModels === undefined ? {} : { ollama: ollamaModels.map(entry => entry.model) }),
  };
  const accessOverlay = createProviderCommandAccessOverlay(ctx);
  const accessFor = (catalogProvider: ProviderSlug, model: string) =>
    accessOverlay.inspect({ provider: catalogProvider, model });
  const isVisibleSelection = (
    catalogProvider: ProviderSlug,
    model: string,
  ): boolean => {
    const access = accessFor(catalogProvider, model);
    if (catalogProvider === "agenc") return false;
    if (access.effect === "unchanged") return true;
    if (access.effect === "blocked" || access.route === "unavailable") {
      return false;
    }
    return true;
  };
  const rows = providerOrder(catalog, provider)
    .flatMap(catalogProvider => {
      const visibleModels = [
        ...(catalog[catalogProvider] ?? []),
      ].filter((model, index, candidates) =>
        candidates.indexOf(model) === index &&
        isVisibleSelection(catalogProvider, model),
      );
      const projectedRows = providerRows({
        provider: catalogProvider,
        currentProvider: provider,
        currentModel,
        ...(config !== undefined ? { config } : {}),
        catalogModels: visibleModels,
      });
      if (
        projectedRows.length === 1 &&
        projectedRows[0]?.status === "unavailable"
      ) {
        return visibleModels.length > 0 || catalogProvider === provider
          ? projectedRows
          : [];
      }
      return projectedRows.flatMap(row => {
        if (!isVisibleSelection(row.provider, row.model)) return [];
        const access = accessFor(row.provider, row.model);
        return [{
          ...row,
          selectable: access.effect !== "blocked",
          detail: rowDetailForRoute(row.status, row.provider),
        }];
      });
    });
  const currentActiveIndex = rows.findIndex(row => row.status === "current");
  const firstSelectableIndex = rows.findIndex(row => row.selectable);
  const activeIndex = Math.max(
    0,
    currentActiveIndex >= 0 ? currentActiveIndex : firstSelectableIndex,
  );
  // Count the rows actually offered per provider (hidden models are filtered
  // out in providerRows) so the displayed count matches the selectable list.
  const providerCounts = Object.freeze(
    rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.provider] =
        (counts[row.provider] ?? 0) + (row.selectable ? 1 : 0);
      return counts;
    }, {}),
  );
  return {
    provider,
    currentModel,
    ...(configuredModel !== undefined ? { configuredModel } : {}),
    defaultModel,
    rows,
    activeIndex,
    providerCounts,
    ...(provider === "openrouter" && openrouter.source === "bundled" ? { catalogNote: OPENROUTER_CATALOG_FALLBACK_NOTE } : {}),
  };
}

export function modelMenuFallback(snapshot: ModelMenuSnapshot): string {
  const lines = [
    "Model selection",
    `Provider: ${snapshot.provider}`,
    `Current: ${snapshot.currentModel}`,
    "",
    ...(snapshot.catalogNote === undefined ? [] : [snapshot.catalogNote]),
    "Available models:",
  ];
  for (const row of snapshot.rows) {
    lines.push(
      `  ${row.status === "current" ? "*" : "-"} ${row.provider}:${row.displayModel} (${row.detail})`,
    );
  }
  lines.push(
    "",
    "Run /model <model-name> or /model <provider>:<model-name> to switch.",
    "Run /provider to configure your provider credentials.",
  );
  return lines.join("\n");
}
