import React from "react";

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import { Box, useInput } from "../tui/ink.js";
import ThemedText from "../tui/components/design-system/ThemedText.js";
import { MenuModal } from "../tui/components/v2/primitives.js";
import { openLocalJsxCommand } from "./local-jsx-command.js";
import { nextMenuIndex, previousMenuIndex } from "./menu-navigation.js";

type PluginRow = {
  readonly name: string;
  readonly version: string;
  readonly status: "enabled" | "disabled" | "error";
  readonly detail: string;
};

type PluginSnapshot = {
  readonly enabled: readonly { readonly name?: string; readonly version?: string }[];
  readonly disabled: readonly { readonly name?: string; readonly version?: string }[];
  readonly errors: readonly { readonly message?: string }[];
  readonly needsRefresh: boolean;
};

function readPluginSnapshot(ctx: SlashCommandContext): PluginSnapshot | null {
  const state = ctx.appState?.getAppState?.();
  if (typeof state !== "object" || state === null) return null;
  const plugins = (state as {
    plugins?: {
      enabled?: readonly { name?: string; version?: string }[];
      disabled?: readonly { name?: string; version?: string }[];
      errors?: readonly { message?: string }[];
      needsRefresh?: boolean;
    };
  }).plugins;
  if (!plugins) return null;
  return {
    enabled: plugins.enabled ?? [],
    disabled: plugins.disabled ?? [],
    errors: plugins.errors ?? [],
    needsRefresh: plugins.needsRefresh === true,
  };
}

function pluginRows(snapshot: PluginSnapshot): PluginRow[] {
  return [
    ...snapshot.enabled.map((plugin): PluginRow => ({
      name: plugin.name ?? "(unnamed)",
      version: plugin.version ?? "—",
      status: "enabled",
      detail: "loaded",
    })),
    ...snapshot.disabled.map((plugin): PluginRow => ({
      name: plugin.name ?? "(unnamed)",
      version: plugin.version ?? "—",
      status: "disabled",
      detail: "disabled",
    })),
    ...snapshot.errors.map((error, index): PluginRow => ({
      name: `error-${index + 1}`,
      version: "—",
      status: "error",
      detail: error.message ?? "unknown plugin error",
    })),
  ];
}

function pluginListFromSnapshot(snapshot: PluginSnapshot | null): string {
  if (!snapshot) return "Plugin state is not available in this session.";

  const enabled = snapshot.enabled;
  const disabled = snapshot.disabled;
  const lines = [
    "AgenC Plugins",
    `${enabled.length} enabled · ${disabled.length} disabled`,
  ];
  if (snapshot.needsRefresh) {
    lines.push("State changed on disk; restart AgenC to consume refreshed plugins.");
  }
  if (enabled.length > 0) {
    lines.push("", "Enabled:");
    for (const plugin of enabled) {
      lines.push(`  ${plugin.name ?? "(unnamed)"}${plugin.version ? ` ${plugin.version}` : ""}`);
    }
  }
  if (disabled.length > 0) {
    lines.push("", "Disabled:");
    for (const plugin of disabled) {
      lines.push(`  ${plugin.name ?? "(unnamed)"}${plugin.version ? ` ${plugin.version}` : ""}`);
    }
  }
  if (snapshot.errors.length > 0) {
    lines.push("", "Errors:");
    for (const error of snapshot.errors) {
      lines.push(`  ${error.message ?? "unknown plugin error"}`);
    }
  }
  return lines.join("\n");
}

function PluginsMenuView({
  snapshot,
  onDone,
}: {
  readonly snapshot: PluginSnapshot;
  readonly onDone: () => void;
}): React.ReactNode {
  const rows = React.useMemo(() => pluginRows(snapshot), [snapshot]);
  const displayRows = rows.length > 0 ? rows : [{
    name: "no plugins",
    version: "—",
    status: "disabled" as const,
    detail: "no plugin records loaded",
  }];
  const [activeIndex, setActiveIndex] = React.useState(0);
  useInput((input, key) => {
    if (key.escape || input === "q") {
      onDone();
      return;
    }
    if (key.upArrow || input === "k") {
      setActiveIndex(index => previousMenuIndex(index, displayRows.length));
      return;
    }
    if (key.downArrow || input === "j") {
      setActiveIndex(index => nextMenuIndex(index, displayRows.length));
    }
  });

  const enabledCount = snapshot.enabled.length;
  const disabledCount = snapshot.disabled.length;
  return (
    <MenuModal
      title="plugins"
      count={`${rows.length}`}
      summary={`${enabledCount} enabled · ${disabledCount} disabled`}
      headerRight={snapshot.needsRefresh ? "restart needed" : "live"}
      columns={[3, 12, 18, 12, 36]}
      headers={["", "status", "name", "version", "detail"]}
      items={displayRows}
      activeIndex={activeIndex}
      renderRow={(row, _index, active) => [
        <ThemedText key="mark" color={row.status === "error" ? "error" : row.status === "enabled" ? "success" : "inactive"}>
          {row.status === "enabled" ? "◆" : row.status === "error" ? "✕" : "◇"}
        </ThemedText>,
        <ThemedText key="status" color={row.status === "error" ? "error" : row.status === "enabled" ? "success" : "inactive"} wrap="truncate-end">
          {row.status}
        </ThemedText>,
        <ThemedText key="name" color={active ? "agenc" : "text2"} wrap="truncate-end">
          {row.name}
        </ThemedText>,
        <ThemedText key="version" color="subtle" wrap="truncate-end">
          {row.version}
        </ThemedText>,
        <ThemedText key="detail" color={row.status === "error" ? "error" : "subtle"} wrap="truncate-end">
          {row.detail}
        </ThemedText>,
      ]}
      preview={
        <Box flexDirection="column" gap={1}>
          <ThemedText color="agenc">Plugin Registry</ThemedText>
          <ThemedText color="text2" wrap="wrap">
            Plugins extend AgenC with slash commands, skills, MCP servers, and runtime hooks.
          </ThemedText>
          <ThemedText color="subtle" wrap="wrap">
            This menu is bound to AppStateStore.plugins; restart notices come from the same state used by the existing plugin manager.
          </ThemedText>
        </Box>
      }
      footer={[
        { keyName: "q", label: "close" },
      ]}
      hint="plugin / marketplace aliases"
    />
  );
}

function openPluginsMenu(ctx: SlashCommandContext, snapshot: PluginSnapshot): boolean {
  return openLocalJsxCommand(ctx, close => (
    <PluginsMenuView snapshot={snapshot} onDone={close} />
  ));
}

export const pluginsCommand: SlashCommand = {
  name: "plugins",
  aliases: ["plugin", "marketplace"],
  description: "Show loaded AgenC plugins",
  supportedSurfaces: ["runtime", "daemon-tui"],
  userInvocable: true,
  immediate: true,
  execute: (ctx): Promise<SlashCommandResult> =>
    safeExecute(async () => {
      const snapshot = readPluginSnapshot(ctx);
      if (snapshot && openPluginsMenu(ctx, snapshot)) {
        return { kind: "skip" };
      }
      return { kind: "text", text: pluginListFromSnapshot(snapshot) };
    }),
};
