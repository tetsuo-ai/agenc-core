import React from "react";

import {
  buildProviderModelCatalog,
  normalizeProviderSlug,
  resolveProviderSettings,
  type ProviderSlug,
} from "../config/resolve-provider.js";
import { hasEntitledRemoteAuthSessionSync } from "../auth/session-state.js";
import {
  configuredModelForProvider,
  defaultModelForProvider,
} from "../config/resolve-model.js";
import { resolveRegisteredModelCatalogEntry } from "../llm/registry/model-catalog.js";
import type { AgenCConfig } from "../config/schema.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { readCommandConfig } from "./config-context.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import {
  providerHasLiveSubscriptionRoute,
  subscriptionManagedModels,
} from "./subscription-managed-models.js";
import type { SlashCommandContext } from "./types.js";

type ModelRowStatus =
  | "current"
  | "configured"
  | "default"
  | "available"
  | "unavailable";

type ModelMenuRow = {
  readonly model: string;
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
  readonly managedKeysEnabled: boolean;
  readonly rows: readonly ModelMenuRow[];
  readonly activeIndex: number;
  readonly providerCounts: Readonly<Record<string, number>>;
};

export type ModelMenuSelectionResult = {
  readonly message: string;
  readonly shouldClose: boolean;
};

type SessionModelSnapshot = {
  readonly provider?: string;
  readonly model?: string;
};

function readSessionSelection(ctx: SlashCommandContext): SessionModelSnapshot {
  const peekState = (ctx.session as unknown as {
    state?: { unsafePeek?: () => unknown };
  }).state?.unsafePeek;
  const rawState =
    typeof peekState === "function"
      ? (peekState.call((ctx.session as unknown as { state?: unknown }).state) as {
          sessionConfiguration?: {
            provider?: { slug?: string };
            collaborationMode?: { model?: string };
          };
        })
      : null;
  const directConfig = (ctx.session as unknown as {
    sessionConfiguration?: {
      provider?: { slug?: string };
      collaborationMode?: { model?: string };
    };
  }).sessionConfiguration;
  const sessionConfiguration = rawState?.sessionConfiguration ?? directConfig;
  return {
    ...(sessionConfiguration?.provider?.slug
      ? { provider: sessionConfiguration.provider.slug }
      : {}),
    ...(sessionConfiguration?.collaborationMode?.model
      ? { model: sessionConfiguration.collaborationMode.model }
      : {}),
  };
}

function readAppStateModel(ctx: SlashCommandContext): string | undefined {
  const state = ctx.appState?.getAppState?.();
  if (typeof state !== "object" || state === null) return undefined;
  const model = (state as { mainLoopModel?: unknown }).mainLoopModel;
  return typeof model === "string" && model.trim().length > 0
    ? model.trim()
    : undefined;
}

function rowStatus(params: {
  readonly model: string;
  readonly provider: ProviderSlug;
  readonly currentProvider: ProviderSlug;
  readonly currentModel: string;
  readonly configuredModel?: string;
  readonly defaultModel: string;
}): ModelRowStatus {
  if (
    params.provider === params.currentProvider &&
    params.model === params.currentModel
  ) {
    return "current";
  }
  if (
    params.configuredModel !== undefined &&
    params.model === params.configuredModel
  ) {
    return "configured";
  }
  if (params.model === params.defaultModel) return "default";
  return "available";
}

function rowDetailForRoute(
  status: ModelRowStatus,
  provider: ProviderSlug,
  managedRoute: boolean,
): string {
  if (managedRoute) {
    switch (status) {
      case "current":
        return "active hosted subscription model";
      case "configured":
        return "configured hosted subscription model";
      case "default":
        return "default hosted subscription model";
      case "available":
        return "hosted subscription model";
      case "unavailable":
        return "no hosted models configured";
    }
  }
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

function statusColor(
  status: ModelRowStatus,
): "success" | "agenc" | "worker" | "inactive" | "warning" {
  switch (status) {
    case "current":
      return "success";
    case "configured":
      return "agenc";
    case "default":
      return "worker";
    case "available":
      return "inactive";
    case "unavailable":
      return "warning";
  }
}

function statusGlyph(status: ModelRowStatus): string {
  switch (status) {
    case "current":
      return "◆";
    case "configured":
      return "●";
    case "default":
      return "◇";
    case "available":
      return "·";
    case "unavailable":
      return "!";
  }
}

function providerOrder(
  catalog: Readonly<Record<string, readonly string[]>>,
  currentProvider: ProviderSlug,
): readonly ProviderSlug[] {
  const ids = Object.keys(catalog)
    .map(provider => normalizeProviderSlug(provider))
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
  readonly managedRoute?: boolean;
}): readonly ModelMenuRow[] {
  const configuredModel =
    params.config !== undefined
      ? configuredModelForProvider(params.config, params.provider)
      : undefined;
  const defaultModel = defaultModelForProvider(params.provider);
  const candidates = new Set<string>();
  if (params.provider === params.currentProvider) candidates.add(params.currentModel);
  if (configuredModel !== undefined) candidates.add(configuredModel);
  candidates.add(defaultModel);
  for (const model of params.catalogModels) {
    const trimmed = model.trim();
    if (trimmed.length === 0) continue;
    // `visibility: "hide"` models (e.g. internal review models) stay resolvable
    // via the flat catalog but must not be offered as new picker selections.
    // The current/configured/default candidates above are added unconditionally,
    // so a hidden model that is the active selection still renders its row.
    if (isHiddenCatalogModel(params.provider, trimmed)) continue;
    candidates.add(trimmed);
  }

  if (candidates.size === 0) {
    return [{
      provider: params.provider,
      model: "(no models)",
      status: "unavailable",
      selectable: false,
      groupLabel: params.provider,
      detail: rowDetailForRoute(
        "unavailable",
        params.provider,
        params.managedRoute === true,
      ),
    }];
  }

  return [...candidates].map((model): ModelMenuRow => {
    const status = rowStatus({
      model,
      provider: params.provider,
      currentProvider: params.currentProvider,
      currentModel: params.currentModel,
      configuredModel,
      defaultModel,
    });
    return {
      model,
      provider: params.provider,
      status,
      selectable: status !== "unavailable",
      groupLabel: params.provider,
      detail: rowDetailForRoute(
        status,
        params.provider,
        params.managedRoute === true,
      ),
    };
  });
}

export function readModelMenuSnapshot(ctx: SlashCommandContext): ModelMenuSnapshot {
  const config = readCommandConfig(ctx);
  const sessionSelection = readSessionSelection(ctx);
  const provider =
    normalizeProviderSlug(sessionSelection.provider) ??
    normalizeProviderSlug(config?.model_provider) ??
    "grok";
  const defaultModel = defaultModelForProvider(provider);
  const currentModel =
    readAppStateModel(ctx) ??
    sessionSelection.model?.trim() ??
    config?.model?.trim() ??
    defaultModel;
  const configuredModel =
    config !== undefined ? configuredModelForProvider(config, provider) : undefined;
  const catalog = buildProviderModelCatalog(config);
  const managedKeysEnabled = config?.auth?.managedKeys?.enabled === true;
  const managedSubscriptionAvailable =
    managedKeysEnabled && hasEntitledRemoteAuthSessionSync(process.env);
  const providerApiKey = (catalogProvider: ProviderSlug): string | undefined =>
    config !== undefined
      ? resolveProviderSettings(catalogProvider, config, process.env)?.apiKey
      : undefined;
  const providerHasByok = (catalogProvider: ProviderSlug): boolean => {
    const apiKey = providerApiKey(catalogProvider);
    return apiKey !== undefined && apiKey.trim().length > 0;
  };
  const shouldShowProvider = (catalogProvider: ProviderSlug): boolean => {
    if (catalogProvider === provider) return true;
    if (!managedKeysEnabled) return true;
    if (providerHasByok(catalogProvider)) return true;
    return (
      managedSubscriptionAvailable &&
      providerHasLiveSubscriptionRoute(catalogProvider)
    );
  };
  const modelsForProvider = (catalogProvider: ProviderSlug): readonly string[] => {
    if (
      managedSubscriptionAvailable &&
      providerHasLiveSubscriptionRoute(catalogProvider) &&
      !providerHasByok(catalogProvider)
    ) {
      return subscriptionManagedModels(catalogProvider);
    }
    return catalog[catalogProvider] ?? [];
  };
  const rows = providerOrder(catalog, provider)
    .filter(shouldShowProvider)
    .flatMap(catalogProvider => {
      const managedRoute =
        managedSubscriptionAvailable &&
        providerHasLiveSubscriptionRoute(catalogProvider) &&
        !providerHasByok(catalogProvider);
      return providerRows({
        provider: catalogProvider,
        currentProvider: provider,
        currentModel,
        ...(config !== undefined ? { config } : {}),
        catalogModels: modelsForProvider(catalogProvider),
        managedRoute,
      });
    });
  const activeIndex = Math.max(0, rows.findIndex(row => row.status === "current"));
  // Count the rows actually offered per provider (hidden models are filtered
  // out in providerRows) so the displayed count matches the selectable list.
  const providerCounts = Object.freeze(
    rows.reduce<Record<string, number>>((counts, row) => {
      counts[row.provider] = (counts[row.provider] ?? 0) + 1;
      return counts;
    }, {}),
  );
  return {
    provider,
    currentModel,
    ...(configuredModel !== undefined ? { configuredModel } : {}),
    defaultModel,
    managedKeysEnabled,
    rows,
    activeIndex,
    providerCounts,
  };
}

export function modelMenuFallback(snapshot: ModelMenuSnapshot): string {
  const lines = [
    "Model selection",
    `Provider: ${snapshot.provider}`,
    `Current: ${snapshot.currentModel}`,
    `Managed keys: ${snapshot.managedKeysEnabled ? "on" : "off"}`,
    "",
    "Available models:",
  ];
  for (const row of snapshot.rows) {
    lines.push(
      `  ${row.status === "current" ? "*" : "-"} ${row.provider}:${row.model} (${row.detail})`,
    );
  }
  lines.push(
    "",
    "Run /model <model-name> or /model <provider>:<model-name> to switch.",
    "Run /provider to see whether that provider uses BYOK or subscription-managed keys.",
  );
  return lines.join("\n");
}

function modelSwitchMessage(message: string): boolean {
  return (
    message.startsWith("Model switch") ||
    message.startsWith("Model switched")
  );
}

function ModelMenuView({
  snapshot,
  onDone,
  onSelect,
}: {
  readonly snapshot: ModelMenuSnapshot;
  readonly onDone: () => void;
  readonly onSelect: (provider: ProviderSlug, model: string) => Promise<ModelMenuSelectionResult>;
}): React.ReactNode {
  const [activeIndex, setActiveIndex] = React.useState(snapshot.activeIndex);
  const [message, setMessage] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const rows = snapshot.rows;

  useInput((input, key) => {
    if (busy) return;
    if (key.escape || input === "q") {
      onDone();
      return;
    }
    if (key.upArrow || input === "k") {
      setActiveIndex(index => previousMenuIndex(index, rows.length));
      return;
    }
    if (key.downArrow || input === "j") {
      setActiveIndex(index => nextMenuIndex(index, rows.length));
      return;
    }
    if (key.return) {
      const row = rows[activeIndex];
      if (row === undefined) return;
      if (!row.selectable) {
        setMessage(`${row.provider}: no models configured. Use /provider or config to add a default model.`);
        return;
      }
      setBusy(true);
      setMessage("Switching model...");
      void onSelect(row.provider, row.model).then(
        result => {
          if (result.shouldClose) {
            onDone();
            return;
          }
          setMessage(result.message);
          setBusy(false);
        },
        error => {
          setMessage(error instanceof Error ? error.message : String(error));
          setBusy(false);
        },
      );
    }
  });

  const selected = rows[activeIndex] ?? rows[0];
  const selectedCount =
    selected === undefined ? 0 : snapshot.providerCounts[selected.provider] ?? 0;
  return (
    <MenuModal
      title="model"
      count={`${rows.length}`}
      summary={`active ${snapshot.provider} / ${snapshot.currentModel} · managed ${snapshot.managedKeysEnabled ? "on" : "off"}`}
      headerRight={busy ? "switching" : "live"}
      columns={[3, 13, 15, 34, 12, 34]}
      headers={["", "status", "provider", "model", "group", "detail"]}
      items={rows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => {
        const color = statusColor(row.status);
        return [
          <ThemedText key="mark" color={color}>
            {statusGlyph(row.status)}
          </ThemedText>,
          <ThemedText key="status" color={color} wrap="truncate-end">
            {row.status}
          </ThemedText>,
          <ThemedText key="provider" color={row.provider === snapshot.provider ? "success" : "subtle"} wrap="truncate-end">
            {row.provider}
          </ThemedText>,
          <ThemedText key="model" color={active ? "agenc" : "text2"} wrap="truncate-middle">
            {row.model}
          </ThemedText>,
          <ThemedText key="group" color="inactive" wrap="truncate-end">
            {row.groupLabel}
          </ThemedText>,
          <ThemedText key="detail" color="subtle" wrap="truncate-end">
            {row.detail}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Model Route</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Empty /model opens this provider-grouped catalog. Use /provider to
            inspect credentials and provider auth state.
          </ThemedText>
          <ThemedText color={snapshot.managedKeysEnabled ? "success" : "warning"} wrap="wrap">
            Managed keys: {snapshot.managedKeysEnabled ? "on" : "off"}. Paid accounts can use
            subscription-managed provider keys when no BYOK key is set.
          </ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Pro hosted models appear under OpenRouter. Other providers are BYOK
            or local routes unless they show hosted subscription detail.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Selected: {selected?.provider ?? snapshot.provider}:{selected?.model ?? snapshot.currentModel}
          </ThemedText>
          {selected ? (
            <>
              <ThemedText color={statusColor(selected.status)} wrap="wrap">
                {selected.status}: {selected.detail}
              </ThemedText>
              <ThemedText color="inactive" wrap="wrap">
                provider models: {selectedCount > 0 ? selectedCount : "none"}
              </ThemedText>
              {!selected.selectable ? (
                <ThemedText color="warning" wrap="wrap">
                  No models are available for this provider. Configure a default model
                  or switch providers first.
                </ThemedText>
              ) : null}
            </>
          ) : null}
          {message ? (
            <ThemedText
              color={modelSwitchMessage(message) ? "success" : "error"}
              wrap="wrap"
            >
              {message}
            </ThemedText>
          ) : null}
        </Box>
      }
      footer={[
        { keyName: "up/down", label: "navigate" },
        { keyName: "enter", label: "select" },
        { keyName: "q", label: "close" },
      ]}
      hint="provider:model catalog"
    />
  );
}

export function openModelMenu(
  ctx: SlashCommandContext,
  snapshot: ModelMenuSnapshot,
  onSelect: (provider: ProviderSlug, model: string) => Promise<ModelMenuSelectionResult>,
): boolean {
  return openLocalJsxCommand(ctx, close => (
    <ModelMenuView snapshot={snapshot} onDone={close} onSelect={onSelect} />
  ));
}
