import React from "react";

import {
  normalizeProviderSlug,
  type ProviderSlug,
} from "../config/resolve-provider.js";
import {
  configuredModelForProvider,
  defaultModelForProvider,
} from "../config/resolve-model.js";
import type { AgenCConfig } from "../config/schema.js";
import { listBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import type { SlashCommandContext } from "./types.js";

type ProviderRowStatus = "current" | "configured" | "default";

type ProviderMenuRow = {
  readonly provider: ProviderSlug;
  readonly model: string;
  readonly status: ProviderRowStatus;
  readonly auth: string;
  readonly detail: string;
};

export type ProviderMenuSnapshot = {
  readonly currentProvider: ProviderSlug;
  readonly currentModel: string;
  readonly rows: readonly ProviderMenuRow[];
  readonly activeIndex: number;
};

export type ProviderMenuSelectionResult = {
  readonly message: string;
  readonly shouldClose: boolean;
};

function readConfig(ctx: SlashCommandContext): AgenCConfig | undefined {
  return (
    ctx.configStore?.current() ??
    (ctx.session as unknown as {
      services?: { configStore?: { current?: () => AgenCConfig } };
    }).services?.configStore?.current?.()
  );
}

function readSessionSelection(ctx: SlashCommandContext): {
  readonly provider?: string;
  readonly model?: string;
} {
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

function providerModel(params: {
  readonly config?: AgenCConfig;
  readonly provider: ProviderSlug;
  readonly currentProvider: ProviderSlug;
  readonly currentModel: string;
}): string {
  if (params.provider === params.currentProvider) return params.currentModel;
  return (
    (params.config !== undefined
      ? configuredModelForProvider(params.config, params.provider)
      : undefined) ?? defaultModelForProvider(params.provider)
  );
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

function authLabel(params: {
  readonly requiresManagedAuth: boolean;
  readonly apiKeyEnvVar?: string;
}): string {
  if (params.requiresManagedAuth) return "managed";
  return params.apiKeyEnvVar ?? "local";
}

function statusColor(status: ProviderRowStatus): "success" | "agenc" | "inactive" {
  switch (status) {
    case "current":
      return "success";
    case "configured":
      return "agenc";
    case "default":
      return "inactive";
  }
}

function statusGlyph(status: ProviderRowStatus): string {
  switch (status) {
    case "current":
      return "◆";
    case "configured":
      return "●";
    case "default":
      return "◇";
  }
}

export function readProviderMenuSnapshot(ctx: SlashCommandContext): ProviderMenuSnapshot {
  const config = readConfig(ctx);
  const sessionSelection = readSessionSelection(ctx);
  const currentProvider =
    normalizeProviderSlug(sessionSelection.provider) ??
    normalizeProviderSlug(config?.model_provider) ??
    "grok";
  const currentModel =
    readAppStateModel(ctx) ??
    sessionSelection.model?.trim() ??
    config?.model?.trim() ??
    defaultModelForProvider(currentProvider);

  const rows = listBuiltInProviderInfo().map((info): ProviderMenuRow => {
    const provider = info.id;
    const status = rowStatus({ config, provider, currentProvider });
    return {
      provider,
      model: providerModel({ config, provider, currentProvider, currentModel }),
      status,
      auth: authLabel({
        requiresManagedAuth: info.requiresManagedAuth,
        ...(info.apiKeyEnvVar ? { apiKeyEnvVar: info.apiKeyEnvVar } : {}),
      }),
      detail: rowDetail(status),
    };
  });

  const activeIndex = Math.max(
    0,
    rows.findIndex(row => row.provider === currentProvider),
  );
  return {
    currentProvider,
    currentModel,
    rows,
    activeIndex,
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
  lines.push("", "Run /model-provider <provider> [model] to switch.");
  return lines.join("\n");
}

function ProviderMenuView({
  snapshot,
  onDone,
  onSelect,
}: {
  readonly snapshot: ProviderMenuSnapshot;
  readonly onDone: () => void;
  readonly onSelect: (provider: ProviderSlug, model: string) => Promise<ProviderMenuSelectionResult>;
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
      setActiveIndex(index => Math.max(0, index - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setActiveIndex(index => Math.min(rows.length - 1, index + 1));
      return;
    }
    if (key.return) {
      const row = rows[activeIndex];
      if (row === undefined) return;
      setBusy(true);
      setMessage("Switching provider...");
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
  return (
    <MenuModal
      title="provider"
      count={`${rows.length}`}
      summary={`${snapshot.currentProvider} / ${snapshot.currentModel}`}
      headerRight={busy ? "switching" : "live"}
      columns={[3, 12, 20, 28, 18, 24]}
      headers={["", "status", "provider", "model", "auth", "detail"]}
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
          <ThemedText key="provider" color={active ? "agenc" : "text2"} wrap="truncate-end">
            {row.provider}
          </ThemedText>,
          <ThemedText key="model" color="subtle" wrap="truncate-middle">
            {row.model}
          </ThemedText>,
          <ThemedText key="auth" color="inactive" wrap="truncate-end">
            {row.auth}
          </ThemedText>,
          <ThemedText key="detail" color="subtle" wrap="truncate-end">
            {row.detail}
          </ThemedText>,
        ];
      }}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Provider Route</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Empty /provider opens this registry-backed provider list. Enter switches to
            the configured or default model for that provider.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            Selected: {selected?.provider ?? snapshot.currentProvider} /{" "}
            {selected?.model ?? snapshot.currentModel}
          </ThemedText>
          {message ? (
            <ThemedText
              color={message.startsWith("Provider switch") || message.startsWith("Provider switched") ? "success" : "error"}
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
      hint="registry + config defaults"
    />
  );
}

export function openProviderMenu(
  ctx: SlashCommandContext,
  snapshot: ProviderMenuSnapshot,
  onSelect: (provider: ProviderSlug, model: string) => Promise<ProviderMenuSelectionResult>,
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
    jsx: <ProviderMenuView snapshot={snapshot} onDone={close} onSelect={onSelect} />,
  });
  return true;
}
