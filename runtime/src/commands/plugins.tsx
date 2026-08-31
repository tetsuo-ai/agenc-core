import React from "react";
import { isAbsolute, join, relative, resolve } from "node:path";

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
import { requireCommandConfigStore } from "./config-context.js";
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
  installRequiresSignature,
} from "../plugins/marketplace/catalog-cli.js";
import {
  findInstallableMarketplacePlugin,
  listMarketplaces,
  readMarketplaceIndex,
  type Marketplace,
  type MarketplaceIndex,
  type MarketplaceListOutcome,
  type MarketplacePlugin,
  type MarketplaceRecord,
} from "../plugins/marketplace/marketplace.js";

type PluginRow = {
  readonly id: string;
  readonly name: string;
  readonly root?: string;
  readonly version: string;
  readonly status: "enabled" | "disabled" | "error";
  readonly detail: string;
};

type PluginSnapshot = {
  readonly enabled: readonly {
    readonly id?: string;
    readonly name?: string;
    readonly root?: string;
    readonly version?: string;
  }[];
  readonly disabled: readonly {
    readonly id?: string;
    readonly name?: string;
    readonly root?: string;
    readonly version?: string;
  }[];
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
  readonly uninstall: (pluginId: string, pluginRoot?: string) => Promise<void>;
  readonly listMarketplaces: () => Promise<MarketplaceListOutcome>;
  readonly installFromMarketplace: (
    marketplace: Marketplace,
    pluginName: string,
  ) => Promise<InstalledPluginSummary>;
}

/**
 * Uninstall targets the selected install root. Workspace plugin roots map to
 * project scope, while roots under pluginStorageRoot map to user scope. When
 * one ID exists in both scopes, the caller must provide the selected root.
 */
async function resolveInstalledPluginScope(
  pluginId: string,
  pluginRoot: string | undefined,
  options: PluginOperationOptions,
): Promise<PluginScope> {
  if (options.workspaceRoot === undefined) {
    throw new Error("Plugin uninstall requires an explicit workspace root");
  }
  const listed = await listInstalledPlugins(options);
  const matches = listed.plugins.filter((plugin) => plugin.id === pluginId);
  const match = pluginRoot === undefined
    ? matches.length === 1 ? matches[0] : undefined
    : matches.find((plugin) => resolve(plugin.root) === resolve(pluginRoot));
  if (match === undefined) {
    if (matches.length > 1 && pluginRoot === undefined) {
      throw new Error(
        `plugin ${pluginId} is installed in multiple scopes. Select an exact install.`,
      );
    }
    throw new Error(`plugin is not installed: ${pluginId}`);
  }
  const selectedRoot = resolve(match.root);
  const projectRoot = resolve(join(options.workspaceRoot, ".agents", "plugins"));
  if (isPathInside(selectedRoot, projectRoot)) {
    return "project";
  }
  const userRoot = resolve(options.pluginStorageRoot);
  if (isPathInside(selectedRoot, userRoot)) {
    return "user";
  }
  throw new Error(`plugin install is outside the managed scopes: ${pluginId}`);
}

function isPathInside(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath === "" ||
    (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function marketplaceRecordForMenuSelection(
  index: MarketplaceIndex,
  marketplace: Marketplace,
): MarketplaceRecord {
  const selectedManifest = resolve(marketplace.path);
  const selectedRoot = resolve(marketplace.root);
  const matches = Object.values(index.marketplaces).filter(
    (record) =>
      resolve(record.manifestPath) === selectedManifest &&
      resolve(record.installedPath) === selectedRoot,
  );
  if (matches.length !== 1) {
    throw new Error(
      "marketplace selection no longer matches configured inventory; reopen /plugins and try again",
    );
  }
  return matches[0]!;
}

export function createPluginMenuActions(
  options: PluginOperationOptions,
): PluginMenuActions {
  return {
    setEnabled: async (pluginId, enabled) => {
      await setPluginEnabledOp({ ...options, pluginId, enabled });
    },
    uninstall: async (pluginId, pluginRoot) => {
      const scope = await resolveInstalledPluginScope(pluginId, pluginRoot, options);
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
      const index = await readMarketplaceIndex(options);
      const record = marketplaceRecordForMenuSelection(index, marketplace);
      const resolved = await findInstallableMarketplacePlugin(
        record.manifestPath,
        pluginName,
        undefined,
        record.name,
      );
      const source = resolved.source.type === "local"
        ? resolved.source.path
        : resolved.source;
      const installed = await installPluginOp({
        ...options,
        source,
        name: resolved.pluginId,
        requireSignature: installRequiresSignature(record),
      });
      return installed.plugin;
    },
  };
}

function pluginMenuActionsFromContext(ctx: SlashCommandContext): PluginMenuActions {
  const runtimeOptions = ctx.session.services.runtimeOptions;
  if (runtimeOptions === undefined) {
    throw new Error(
      "Plugin menu requires captured runtime-options authority",
    );
  }
  const configStore = requireCommandConfigStore(ctx);
  return createPluginMenuActions({
    agencHome: configStore.agencHome,
    pluginStorageRoot: runtimeOptions.pluginStorageRoot,
    sessionTempRoot: runtimeOptions.sessionTempRoot,
    workspaceRoot: configStore.projectRoot,
    configStore,
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
      enabled?: readonly { id?: string; name?: string; root?: string; version?: string }[];
      disabled?: readonly { id?: string; name?: string; root?: string; version?: string }[];
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
    ...snapshot.enabled.map((plugin): PluginRow => {
      const name = plugin.name ?? "(unnamed)";
      const id = plugin.id ?? name;
      return {
        id,
        name,
        ...(plugin.root !== undefined ? { root: plugin.root } : {}),
        version: plugin.version ?? "—",
        status: "enabled",
        detail: id === name ? "loaded" : `manifest ${name}, loaded`,
      };
    }),
    ...snapshot.disabled.map((plugin): PluginRow => {
      const name = plugin.name ?? "(unnamed)";
      const id = plugin.id ?? name;
      return {
        id,
        name,
        ...(plugin.root !== undefined ? { root: plugin.root } : {}),
        version: plugin.version ?? "—",
        status: "disabled",
        detail: id === name ? "disabled" : `manifest ${name}, disabled`,
      };
    }),
    ...snapshot.errors.map((error, index): PluginRow => ({
      id: `error-${index + 1}`,
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
      const name = plugin.name ?? "(unnamed)";
      const id = plugin.id ?? name;
      const manifestName = id === name ? "" : ` (manifest ${name})`;
      lines.push(`  ${id}${manifestName}${plugin.version ? ` ${plugin.version}` : ""}`);
    }
  }
  if (disabled.length > 0) {
    lines.push("", "Disabled:");
    for (const plugin of disabled) {
      const name = plugin.name ?? "(unnamed)";
      const id = plugin.id ?? name;
      const manifestName = id === name ? "" : ` (manifest ${name})`;
      lines.push(`  ${id}${manifestName}${plugin.version ? ` ${plugin.version}` : ""}`);
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
  | { readonly kind: "confirm-uninstall"; readonly plugin: PluginRow }
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
      await actions.setEnabled(row.id, nextEnabled);
      setRows((current) => current.map((candidate) =>
        candidate.id === row.id && candidate.status !== "error"
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
        text: `${row.id} ${nextEnabled ? "enabled" : "disabled"}. Restart AgenC to apply.`,
      });
    });
  };

  const uninstallConfirmed = (plugin: PluginRow) => {
    runPluginOperation(async () => {
      await actions.uninstall(plugin.id, plugin.root);
      setRows((current) => current.filter((row) =>
        row.id !== plugin.id ||
        (plugin.root !== undefined && row.root !== plugin.root)
      ));
      markChanged();
      setNotice({
        tone: "info",
        text: `${plugin.id} uninstalled. Restart AgenC to apply.`,
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
        ...current.filter((row) => row.id !== installed.id),
        {
          id: installed.id,
          name: installed.name,
          root: installed.root,
          version: installed.version ?? "—",
          status: "enabled",
          detail: installed.id === installed.name
            ? "installed, restart to load"
            : `manifest ${installed.name}, installed, restart to load`,
        },
      ]);
      markChanged();
      setNotice({
        tone: "info",
        text: `Installed ${installed.id}. Restart AgenC to load it.`,
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
        uninstallConfirmed(screen.plugin);
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
        setScreen({ kind: "confirm-uninstall", plugin: row });
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
    id: "no plugins",
    name: "no plugins",
    version: "—",
    status: "disabled" as const,
    detail: "no plugin records loaded",
  }];
  const confirming = screen.kind === "confirm-uninstall" ? screen.plugin.id : null;
  return (
    <MenuModal
      title="plugins"
      count={`${rows.length}`}
      summary={`${enabledCount} enabled · ${disabledCount} disabled`}
      headerRight={headerRight}
      columns={[3, 12, 18, 12, 36]}
      headers={["", "status", "id", "version", "detail"]}
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
          {row.id}
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
