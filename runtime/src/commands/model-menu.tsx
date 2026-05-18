import React from "react";

import {
  buildProviderModelCatalog,
  normalizeProviderSlug,
  type ProviderSlug,
} from "../config/resolve-provider.js";
import {
  configuredModelForProvider,
  defaultModelForProvider,
} from "../config/resolve-model.js";
import type { AgenCConfig } from "../config/schema.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";
import type { SlashCommandContext } from "./types.js";

type ModelRowStatus = "current" | "configured" | "default" | "available";

type ModelMenuRow = {
  readonly model: string;
  readonly provider: ProviderSlug;
  readonly status: ModelRowStatus;
  readonly detail: string;
};

export type ModelMenuSnapshot = {
  readonly provider: ProviderSlug;
  readonly currentModel: string;
  readonly configuredModel?: string;
  readonly defaultModel: string;
  readonly rows: readonly ModelMenuRow[];
  readonly activeIndex: number;
};

export type ModelMenuSelectionResult = {
  readonly message: string;
  readonly shouldClose: boolean;
};

type SessionModelSnapshot = {
  readonly provider?: string;
  readonly model?: string;
};

function readConfig(ctx: SlashCommandContext): AgenCConfig | undefined {
  return (
    ctx.configStore?.current() ??
    (ctx.session as unknown as {
      services?: { configStore?: { current?: () => AgenCConfig } };
    }).services?.configStore?.current?.()
  );
}

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
  readonly currentModel: string;
  readonly configuredModel?: string;
  readonly defaultModel: string;
}): ModelRowStatus {
  if (params.model === params.currentModel) return "current";
  if (params.configuredModel !== undefined && params.model === params.configuredModel) {
    return "configured";
  }
  if (params.model === params.defaultModel) return "default";
  return "available";
}

function rowDetail(status: ModelRowStatus): string {
  switch (status) {
    case "current":
      return "active session model";
    case "configured":
      return "configured for provider";
    case "default":
      return "built-in provider default";
    case "available":
      return "catalog option";
  }
}

function statusColor(status: ModelRowStatus): "success" | "agenc" | "worker" | "inactive" {
  switch (status) {
    case "current":
      return "success";
    case "configured":
      return "agenc";
    case "default":
      return "worker";
    case "available":
      return "inactive";
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
  }
}

export function readModelMenuSnapshot(ctx: SlashCommandContext): ModelMenuSnapshot {
  const config = readConfig(ctx);
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
  const candidates = new Set<string>();
  candidates.add(currentModel);
  if (configuredModel !== undefined) candidates.add(configuredModel);
  candidates.add(defaultModel);
  for (const model of catalog[provider] ?? []) {
    const trimmed = model.trim();
    if (trimmed.length > 0) candidates.add(trimmed);
  }

  const rows = [...candidates].map((model): ModelMenuRow => {
    const status = rowStatus({
      model,
      currentModel,
      configuredModel,
      defaultModel,
    });
    return {
      model,
      provider,
      status,
      detail: rowDetail(status),
    };
  });
  const activeIndex = Math.max(0, rows.findIndex(row => row.status === "current"));
  return {
    provider,
    currentModel,
    ...(configuredModel !== undefined ? { configuredModel } : {}),
    defaultModel,
    rows,
    activeIndex,
  };
}

export function modelMenuFallback(snapshot: ModelMenuSnapshot): string {
  const lines = [
    "Model selection",
    `Provider: ${snapshot.provider}`,
    `Current: ${snapshot.currentModel}`,
    "",
    "Available models:",
  ];
  for (const row of snapshot.rows) {
    lines.push(`  ${row.status === "current" ? "*" : "-"} ${row.model} (${row.detail})`);
  }
  lines.push("", "Run /model <model-name> to switch.");
  return lines.join("\n");
}

function ModelMenuView({
  snapshot,
  onDone,
  onSelect,
}: {
  readonly snapshot: ModelMenuSnapshot;
  readonly onDone: () => void;
  readonly onSelect: (model: string) => Promise<ModelMenuSelectionResult>;
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
      setBusy(true);
      setMessage("Switching model...");
      void onSelect(row.model).then(
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
  return (
    <MenuModal
      title="model"
      count={`${rows.length}`}
      summary={`provider ${snapshot.provider}`}
      headerRight={busy ? "switching" : "live"}
      columns={[3, 13, 30, 13, 36]}
      headers={["", "status", "model", "provider", "detail"]}
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
          <ThemedText key="model" color={active ? "agenc" : "text2"} wrap="truncate-middle">
            {row.model}
          </ThemedText>,
          <ThemedText key="provider" color="subtle" wrap="truncate-end">
            {row.provider}
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
            Empty /model opens this active-provider catalog. Use /model-provider to switch
            providers.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Selected: {selected?.model ?? snapshot.currentModel}
          </ThemedText>
          {message ? (
            <ThemedText
              color={message.startsWith("Model switch") || message.startsWith("Model switched") ? "success" : "error"}
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
      hint="catalog comes from provider config"
    />
  );
}

export function openModelMenu(
  ctx: SlashCommandContext,
  snapshot: ModelMenuSnapshot,
  onSelect: (model: string) => Promise<ModelMenuSelectionResult>,
): boolean {
  const setToolJSX = ctx.appState?.setToolJSX;
  if (typeof setToolJSX !== "function") return false;
  const close = () => {
    setToolJSX({
      jsx: null,
      shouldHidePromptInput: false,
      clearLocalJSX: true,
    });
  };
  setToolJSX({
    isLocalJSXCommand: true,
    shouldHidePromptInput: true,
    jsx: <ModelMenuView snapshot={snapshot} onDone={close} onSelect={onSelect} />,
  });
  return true;
}
