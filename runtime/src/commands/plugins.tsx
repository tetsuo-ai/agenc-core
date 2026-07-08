import React from "react";
import { join } from "node:path";

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
import {
  installPluginOp,
  listInstalledPlugins,
  setPluginEnabledOp,
  uninstallPluginOp,
  type InstalledPluginSummary,
  type PluginOperationOptions,
  type PluginScope,
} from "../plugins/cli/pluginOperations.js";
import {
  findInstallableMarketplacePlugin,
  listMarketplaces,
  readMarketplaceIndex,
  type Marketplace,
  type MarketplaceListOutcome,
  type MarketplacePlugin,
} from "../plugins/marketplace/marketplace.js";

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

/**
 * User-driven plugin operations bound to one agencHome/workspace pair. The
 * menu component never touches disk directly; everything mutating goes
 * through these thin wrappers over the plugin CLI operations layer. These
 * are slash-command surfaces only — never exposed as model-facing tools.
 */
export interface PluginMenuActions {
  readonly setEnabled: (pluginId: string, enabled: boolean) => Promise<void>;
  readonly uninstall: (pluginId: string) => Promise<void>;
  readonly listMarketplaces: () => Promise<MarketplaceListOutcome>;
  readonly installFromMarketplace: (
    marketplace: Marketplace,
    pluginName: string,
  ) => Promise<InstalledPluginSummary>;
}

/**
 * Uninstall targets the scope where the plugin is actually installed:
 * install roots under `<workspace>/.agents/plugins` are project scope,
 * everything else (including ambiguity) defaults to user scope.
 */
async function resolveInstalledPluginScope(
  pluginId: string,
  options: PluginOperationOptions,
): Promise<PluginScope> {
  const listed = await listInstalledPlugins(options);
  const match = listed.plugins.find((plugin) => plugin.name === pluginId);
  if (match !== undefined && options.workspaceRoot !== undefined) {
    const projectRoot = join(options.workspaceRoot, ".agents", "plugins");
    if (match.root === projectRoot || match.root.startsWith(`${projectRoot}/`)) {
      return "project";
    }
  }
  return "user";
}

export function createPluginMenuActions(
  options: PluginOperationOptions,
): PluginMenuActions {
  return {
    setEnabled: async (pluginId, enabled) => {
      await setPluginEnabledOp({ ...options, pluginId, enabled });
    },
    uninstall: async (pluginId) => {
      const scope = await resolveInstalledPluginScope(pluginId, options);
      await uninstallPluginOp({ ...options, pluginId, scope });
    },
    listMarketplaces: async () => {
      const index = await readMarketplaceIndex(options);
      const roots = Object.values(index.marketplaces).map(
        (record) => record.installedPath,
      );
      return listMarketplaces(roots);
    },
    installFromMarketplace: async (marketplace, pluginName) => {
      const resolved = await findInstallableMarketplacePlugin(
        marketplace.path,
        pluginName,
        undefined,
        marketplace.name,
      );
      const source = resolved.source.type === "local"
        ? resolved.source.path
        : resolved.source.url;
      const installed = await installPluginOp({
        ...options,
        source,
        name: resolved.pluginName,
      });
      return installed.plugin;
    },
  };
}

function pluginMenuActionsFromContext(ctx: SlashCommandContext): PluginMenuActions {
  return createPluginMenuActions({
    agencHome: ctx.agencHome ?? join(ctx.home, ".agenc"),
    workspaceRoot: ctx.cwd,
  });
}

/**
 * Flag the on-disk plugin state as stale in the live AppState so every
 * consumer of `plugins.needsRefresh` (header badge, headless refresh)
 * sees the same truth the registration manager maintains.
 */
function markPluginsNeedRefresh(ctx: SlashCommandContext): void {
  ctx.appState?.setAppState?.((prev) => {
    if (typeof prev !== "object" || prev === null) return prev;
    const record = prev as Record<string, unknown>;
    const plugins = typeof record.plugins === "object" && record.plugins !== null
      ? record.plugins as Record<string, unknown>
      : {};
    return { ...record, plugins: { ...plugins, needsRefresh: true } };
  });
}

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

type PluginsScreen =
  | { readonly kind: "list" }
  | { readonly kind: "confirm-uninstall"; readonly pluginName: string }
  | { readonly kind: "marketplaces" }
  | { readonly kind: "marketplace-plugins"; readonly marketplace: Marketplace };

type MenuNotice = {
  readonly tone: "info" | "error";
  readonly text: string;
};

function installableMarketplacePlugins(
  marketplace: Marketplace,
): readonly MarketplacePlugin[] {
  return marketplace.plugins.filter(
    (plugin) => plugin.policy.installation !== "NOT_AVAILABLE",
  );
}

function marketplacePluginSourceLabel(plugin: MarketplacePlugin): string {
  return plugin.source.type === "local" ? plugin.source.path : plugin.source.url;
}

const ADD_MARKETPLACE_HINT =
  "No plugin marketplaces configured. Add one from your shell with `agenc plugin marketplace add <path|git|url>`, then reopen this menu.";

export function PluginsMenuView({
  snapshot,
  actions,
  onPluginsChangedOnDisk,
  onDone,
}: {
  readonly snapshot: PluginSnapshot;
  readonly actions: PluginMenuActions;
  readonly onPluginsChangedOnDisk: () => void;
  readonly onDone: () => void;
}): React.ReactNode {
  const [rows, setRows] = React.useState<readonly PluginRow[]>(
    () => pluginRows(snapshot),
  );
  const [screen, setScreen] = React.useState<PluginsScreen>({ kind: "list" });
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [marketplaces, setMarketplaces] =
    React.useState<MarketplaceListOutcome | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [notice, setNotice] = React.useState<MenuNotice | null>(null);
  const [needsRefresh, setNeedsRefresh] = React.useState(snapshot.needsRefresh);

  const markChanged = React.useCallback(() => {
    setNeedsRefresh(true);
    onPluginsChangedOnDisk();
  }, [onPluginsChangedOnDisk]);

  // Every mutating action funnels through here so op failures always render
  // inline instead of surfacing as unhandled rejections.
  const runPluginOperation = React.useCallback(
    (operation: () => Promise<void>) => {
      setBusy(true);
      setNotice(null);
      void operation()
        .catch((error: unknown) => {
          setNotice({
            tone: "error",
            text: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => setBusy(false));
    },
    [],
  );

  const showList = React.useCallback(() => {
    setScreen({ kind: "list" });
    setActiveIndex(0);
  }, []);

  const toggleSelected = (row: PluginRow) => {
    const nextEnabled = row.status !== "enabled";
    runPluginOperation(async () => {
      await actions.setEnabled(row.name, nextEnabled);
      setRows((current) => current.map((candidate) =>
        candidate.name === row.name && candidate.status !== "error"
          ? {
              ...candidate,
              status: nextEnabled ? "enabled" : "disabled",
              detail: "restart to apply",
            }
          : candidate,
      ));
      markChanged();
      setNotice({
        tone: "info",
        text: `${row.name} ${nextEnabled ? "enabled" : "disabled"} — restart AgenC to apply`,
      });
    });
  };

  const uninstallConfirmed = (pluginName: string) => {
    runPluginOperation(async () => {
      await actions.uninstall(pluginName);
      setRows((current) => current.filter((row) => row.name !== pluginName));
      markChanged();
      setNotice({
        tone: "info",
        text: `${pluginName} uninstalled — restart AgenC to apply`,
      });
    });
  };

  const openMarketplaces = () => {
    setScreen({ kind: "marketplaces" });
    setActiveIndex(0);
    runPluginOperation(async () => {
      setMarketplaces(await actions.listMarketplaces());
    });
  };

  const installSelected = (marketplace: Marketplace, plugin: MarketplacePlugin) => {
    runPluginOperation(async () => {
      const installed = await actions.installFromMarketplace(
        marketplace,
        plugin.name,
      );
      setRows((current) => [
        ...current.filter((row) => row.name !== installed.name),
        {
          name: installed.name,
          version: installed.version ?? "—",
          status: "enabled",
          detail: "installed · restart to load",
        },
      ]);
      markChanged();
      setNotice({
        tone: "info",
        text: `installed ${installed.name} — restart AgenC to load it`,
      });
      setScreen({ kind: "list" });
      setActiveIndex(0);
    });
  };

  const marketplaceItems = marketplaces?.marketplaces ?? [];
  const currentItemCount = screen.kind === "marketplaces"
    ? marketplaceItems.length
    : screen.kind === "marketplace-plugins"
      ? installableMarketplacePlugins(screen.marketplace).length
      : rows.length;

  useInput((input, key) => {
    if (busy) return;
    if (screen.kind === "confirm-uninstall") {
      if (input === "y") {
        uninstallConfirmed(screen.pluginName);
        showList();
        return;
      }
      if (input === "n" || input === "q" || key.escape) showList();
      return;
    }
    if (key.escape || input === "q") {
      if (screen.kind === "list") {
        onDone();
      } else if (screen.kind === "marketplace-plugins") {
        setScreen({ kind: "marketplaces" });
        setActiveIndex(0);
      } else {
        showList();
      }
      return;
    }
    if (key.upArrow || input === "k") {
      setActiveIndex((index) => previousMenuIndex(index, currentItemCount));
      return;
    }
    if (key.downArrow || input === "j") {
      setActiveIndex((index) => nextMenuIndex(index, currentItemCount));
      return;
    }
    if (screen.kind === "list") {
      if (input === "i") {
        openMarketplaces();
        return;
      }
      const row = rows[activeIndex];
      if (input === "e") {
        if (row === undefined || row.status === "error") {
          setNotice({ tone: "error", text: "select an enabled or disabled plugin to toggle" });
          return;
        }
        toggleSelected(row);
        return;
      }
      if (input === "u") {
        if (row === undefined || row.status === "error") {
          setNotice({ tone: "error", text: "select an installed plugin to uninstall" });
          return;
        }
        setScreen({ kind: "confirm-uninstall", pluginName: row.name });
      }
      return;
    }
    if (screen.kind === "marketplaces" && key.return) {
      const marketplace = marketplaceItems[activeIndex];
      if (marketplace !== undefined) {
        setScreen({ kind: "marketplace-plugins", marketplace });
        setActiveIndex(0);
      }
      return;
    }
    if (screen.kind === "marketplace-plugins" && key.return) {
      const plugin = installableMarketplacePlugins(screen.marketplace)[activeIndex];
      if (plugin !== undefined) installSelected(screen.marketplace, plugin);
    }
  });

  const enabledCount = rows.filter((row) => row.status === "enabled").length;
  const disabledCount = rows.filter((row) => row.status === "disabled").length;
  const headerRight = busy
    ? "working…"
    : needsRefresh
      ? "restart needed"
      : "live";

  const noticeText = notice !== null
    ? (
        <ThemedText color={notice.tone === "error" ? "error" : "success"} wrap="wrap">
          {notice.text}
        </ThemedText>
      )
    : null;

  if (screen.kind === "marketplaces") {
    const displayMarketplaces: readonly (Marketplace | null)[] =
      marketplaceItems.length > 0 ? marketplaceItems : [null];
    return (
      <MenuModal
        title="plugins · marketplaces"
        count={`${marketplaceItems.length}`}
        headerRight={headerRight}
        columns={[20, 8, 48]}
        headers={["name", "plugins", "manifest"]}
        items={displayMarketplaces}
        activeIndex={activeIndex}
        renderRow={(marketplace, _index, active) =>
          marketplace === null
            ? [
                <ThemedText key="name" color="inactive">none</ThemedText>,
                <ThemedText key="count" color="inactive">—</ThemedText>,
                <ThemedText key="path" color="subtle" wrap="truncate-end">
                  {busy ? "loading marketplaces…" : "no marketplaces configured"}
                </ThemedText>,
              ]
            : [
                <ThemedText key="name" color={active ? "agenc" : "text2"} wrap="truncate-end">
                  {marketplace.name}
                </ThemedText>,
                <ThemedText key="count" color="subtle">
                  {`${installableMarketplacePlugins(marketplace).length}`}
                </ThemedText>,
                <ThemedText key="path" color="subtle" wrap="truncate-end">
                  {marketplace.path}
                </ThemedText>,
              ]}
        preview={
          <Box flexDirection="column" gap={1}>
            <ThemedText color="agenc">Install Plugins</ThemedText>
            {noticeText ?? (
              <ThemedText color="text2" wrap="wrap">
                {marketplaces !== null && marketplaceItems.length === 0
                  ? ADD_MARKETPLACE_HINT
                  : "Pick a marketplace to browse its installable plugins."}
              </ThemedText>
            )}
            {(marketplaces?.errors ?? []).map((error) => (
              <ThemedText key={error.path} color="error" wrap="wrap">
                {`${error.path}: ${error.message}`}
              </ThemedText>
            ))}
          </Box>
        }
        footer={[
          { keyName: "enter", label: "browse" },
          { keyName: "esc", label: "back" },
        ]}
      />
    );
  }

  if (screen.kind === "marketplace-plugins") {
    const installable = installableMarketplacePlugins(screen.marketplace);
    const displayPlugins: readonly (MarketplacePlugin | null)[] =
      installable.length > 0 ? installable : [null];
    return (
      <MenuModal
        title={`plugins · install from ${screen.marketplace.name}`}
        count={`${installable.length}`}
        headerRight={headerRight}
        columns={[20, 8, 48]}
        headers={["name", "type", "source"]}
        items={displayPlugins}
        activeIndex={activeIndex}
        renderRow={(plugin, _index, active) =>
          plugin === null
            ? [
                <ThemedText key="name" color="inactive">none</ThemedText>,
                <ThemedText key="type" color="inactive">—</ThemedText>,
                <ThemedText key="source" color="subtle" wrap="truncate-end">
                  no installable plugins in this marketplace
                </ThemedText>,
              ]
            : [
                <ThemedText key="name" color={active ? "agenc" : "text2"} wrap="truncate-end">
                  {plugin.name}
                </ThemedText>,
                <ThemedText key="type" color="subtle">{plugin.source.type}</ThemedText>,
                <ThemedText key="source" color="subtle" wrap="truncate-end">
                  {marketplacePluginSourceLabel(plugin)}
                </ThemedText>,
              ]}
        preview={
          <Box flexDirection="column" gap={1}>
            <ThemedText color="agenc">Install Plugins</ThemedText>
            {noticeText ?? (
              <ThemedText color="text2" wrap="wrap">
                Press enter to install the selected plugin into user scope.
                Installed plugins load on the next AgenC restart.
              </ThemedText>
            )}
          </Box>
        }
        footer={[
          { keyName: "enter", label: "install" },
          { keyName: "esc", label: "back" },
        ]}
      />
    );
  }

  const displayRows = rows.length > 0 ? rows : [{
    name: "no plugins",
    version: "—",
    status: "disabled" as const,
    detail: "no plugin records loaded",
  }];
  const confirming = screen.kind === "confirm-uninstall" ? screen.pluginName : null;
  return (
    <MenuModal
      title="plugins"
      count={`${rows.length}`}
      summary={`${enabledCount} enabled · ${disabledCount} disabled`}
      headerRight={headerRight}
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
          {confirming !== null ? (
            <ThemedText color="error" wrap="wrap">
              {`Uninstall ${confirming}? This removes its files and config entry. Press y to confirm, n to cancel.`}
            </ThemedText>
          ) : noticeText ?? (
            <>
              <ThemedText color="text2" wrap="wrap">
                Plugins extend AgenC with slash commands, skills, MCP servers, and runtime hooks.
              </ThemedText>
              <ThemedText color="subtle" wrap="wrap">
                Changes here are written to disk immediately; the running session keeps its loaded plugins until you restart AgenC.
              </ThemedText>
            </>
          )}
        </Box>
      }
      footer={confirming !== null
        ? [
            { keyName: "y", label: "uninstall" },
            { keyName: "n", label: "cancel" },
          ]
        : [
            { keyName: "e", label: "enable/disable" },
            { keyName: "u", label: "uninstall" },
            { keyName: "i", label: "install" },
            { keyName: "q", label: "close" },
          ]}
      hint="plugin / marketplace aliases"
    />
  );
}

function openPluginsMenu(ctx: SlashCommandContext, snapshot: PluginSnapshot): boolean {
  const actions = pluginMenuActionsFromContext(ctx);
  return openLocalJsxCommand(ctx, close => (
    <PluginsMenuView
      snapshot={snapshot}
      actions={actions}
      onPluginsChangedOnDisk={() => markPluginsNeedRefresh(ctx)}
      onDone={close}
    />
  ));
}

export const pluginsCommand: SlashCommand = {
  name: "plugins",
  aliases: ["plugin", "marketplace"],
  description: "Show and manage AgenC plugins",
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
