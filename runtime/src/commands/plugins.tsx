import { isAbsolute, join, relative, resolve } from "node:path";

import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import { requireCommandConfigStore } from "./config-context.js";
import type {
  InstalledPluginSummary,
  PluginOperationOptions,
  PluginScope,
} from "../plugins/cli/pluginOperations.js";
import type {
  Marketplace,
  MarketplaceIndex,
  MarketplaceListOutcome,
  MarketplaceRecord,
} from "../plugins/marketplace/marketplace.js";

export type PluginSnapshot = {
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
  const { listInstalledPlugins } = await import("../plugins/cli/pluginOperations.js");
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
      const { setPluginEnabledOp } = await import("../plugins/cli/pluginOperations.js");
      await setPluginEnabledOp({ ...options, pluginId, enabled });
    },
    uninstall: async (pluginId, pluginRoot) => {
      const scope = await resolveInstalledPluginScope(pluginId, pluginRoot, options);
      const { uninstallPluginOp } = await import("../plugins/cli/pluginOperations.js");
      await uninstallPluginOp({ ...options, pluginId, scope });
    },
    listMarketplaces: async () => {
      const { readMarketplaceIndex, listMarketplaces } = await import("../plugins/marketplace/marketplace.js");
      const index = await readMarketplaceIndex(options);
      const roots = Object.values(index.marketplaces).map(
        (record) => record.installedPath,
      );
      return listMarketplaces(roots);
    },
    installFromMarketplace: async (marketplace, pluginName) => {
      const [
        { readMarketplaceIndex, findInstallableMarketplacePlugin },
        { installPluginOp },
        { installRequiresSignature },
      ] = await Promise.all([
        import("../plugins/marketplace/marketplace.js"),
        import("../plugins/cli/pluginOperations.js"),
        import("../plugins/marketplace/catalog-cli.js"),
      ]);
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
        marketplace: record.name,
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

async function openPluginsMenu(
  ctx: SlashCommandContext,
  snapshot: PluginSnapshot,
): Promise<boolean> {
  const actions = pluginMenuActionsFromContext(ctx);
  if (typeof ctx.appState?.setToolJSX !== "function") return false;
  const { openPluginsMenu: openMenu } = await import("./plugins-menu.js");
  return openMenu(ctx, snapshot, actions, () => markPluginsNeedRefresh(ctx));
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
      if (snapshot && await openPluginsMenu(ctx, snapshot)) {
        return { kind: "skip" };
      }
      return { kind: "text", text: pluginListFromSnapshot(snapshot) };
    }),
};
