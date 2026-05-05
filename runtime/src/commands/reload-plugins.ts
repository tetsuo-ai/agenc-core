import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import type { AgenCConfig, LspServerConfigInput, McpServerConfig } from "../config/schema.js";
import { refreshActivePlugins } from "../plugins/registration/manager.js";

export interface ActivePluginRefreshResult {
  readonly enabled_count: number;
  readonly disabled_count: number;
  readonly command_count: number;
  readonly agent_count: number;
  readonly hook_count: number;
  readonly mcp_count: number;
  readonly lsp_count: number;
  readonly output_style_count: number;
  readonly error_count: number;
  readonly mcp_servers?: Readonly<Record<string, McpServerConfig>>;
  readonly lsp_servers?: Readonly<Record<string, LspServerConfigInput>>;
}

export type ActivePluginRefresher = (
  ctx: SlashCommandContext,
) => Promise<ActivePluginRefreshResult>;

let activePluginRefresherForTesting: ActivePluginRefresher | undefined;

export interface RemoteSettingsSync {
  readonly redownloadUserSettings: () => Promise<boolean>;
  readonly notifySettingsChange: (source: "userSettings") => void;
}

let remoteSettingsSyncForTesting: RemoteSettingsSync | undefined;

export function setActivePluginRefresherForTesting(
  refresher: ActivePluginRefresher | undefined,
): () => void {
  const previous = activePluginRefresherForTesting;
  activePluginRefresherForTesting = refresher;
  return () => {
    activePluginRefresherForTesting = previous;
  };
}

export function setRemoteSettingsSyncForTesting(
  sync: RemoteSettingsSync | undefined,
): () => void {
  const previous = remoteSettingsSyncForTesting;
  remoteSettingsSyncForTesting = sync;
  return () => {
    remoteSettingsSyncForTesting = previous;
  };
}

async function clearRuntimeCommandCaches(ctx: SlashCommandContext): Promise<void> {
  ctx.session.services.skillsManager.clearSkillCaches?.();
  const commands = await import("../commands.js");
  commands.clearCommandMemoizationCaches();
}

function isEnvTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  return !["", "0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

async function loadRemoteSettingsSync(): Promise<RemoteSettingsSync | null> {
  if (remoteSettingsSyncForTesting) return remoteSettingsSyncForTesting;
  const settingsSyncModulePath: string =
    "../agenc/upstream/services/settingsSync/index.js";
  const settingsChangeModulePath: string =
    "../agenc/upstream/utils/settings/changeDetector.js";
  try {
    const [settingsSync, changeDetector] = await Promise.all([
      import(settingsSyncModulePath) as Promise<{
        redownloadUserSettings?: () => Promise<boolean>;
      }>,
      import(settingsChangeModulePath) as Promise<{
        settingsChangeDetector?: {
          notifyChange?: (source: "userSettings") => void;
        };
      }>,
    ]);
    if (typeof settingsSync.redownloadUserSettings !== "function") return null;
    return {
      redownloadUserSettings: settingsSync.redownloadUserSettings,
      notifySettingsChange: source =>
        changeDetector.settingsChangeDetector?.notifyChange?.(source),
    };
  } catch {
    return null;
  }
}

async function refreshRemoteUserSettingsIfNeeded(): Promise<boolean> {
  if (!isEnvTruthy(process.env.AGENC_REMOTE)) return false;
  const sync = await loadRemoteSettingsSync();
  if (!sync) return false;
  const applied = await sync.redownloadUserSettings().catch(() => false);
  if (applied) sync.notifySettingsChange("userSettings");
  return applied;
}

async function defaultActivePluginRefresher(
  ctx: SlashCommandContext,
): Promise<ActivePluginRefreshResult> {
  return refreshActivePlugins(ctx);
}

function plural(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

export function formatPluginRefreshSummary(
  result: ActivePluginRefreshResult,
): string {
  return [
    "Reloaded plugin surfaces:",
    `  ${plural(result.enabled_count, "enabled plugin")}`,
    `  ${plural(result.disabled_count, "disabled plugin")}`,
    `  ${plural(result.command_count, "skill command")}`,
    `  ${plural(result.agent_count, "agent")}`,
    `  ${plural(result.hook_count, "hook")}`,
    `  ${plural(result.mcp_count, "plugin MCP server")}`,
    `  ${plural(result.lsp_count, "plugin LSP server")}`,
    `  ${plural(result.output_style_count, "plugin output style")}`,
    `  ${plural(result.error_count, "error")}`,
  ].join("\n");
}

export async function reloadPluginSurfaces(
  ctx: SlashCommandContext,
): Promise<string> {
  await refreshRemoteUserSettingsIfNeeded();
  await clearRuntimeCommandCaches(ctx);
  const result = await (activePluginRefresherForTesting ?? defaultActivePluginRefresher)(ctx);

  const configStore = ctx.configStore ?? ctx.session.services.configStore;
  const config = configStore?.current?.();
  const refreshedConfig = withPluginServerConfig(config, result);
  if (ctx.session.services.mcpManager.refreshFromConfig && refreshedConfig !== undefined) {
    await ctx.session.services.mcpManager.refreshFromConfig(refreshedConfig);
  }

  return formatPluginRefreshSummary(result);
}

function withPluginServerConfig(
  config: AgenCConfig | undefined,
  result: ActivePluginRefreshResult,
): AgenCConfig | undefined {
  const hasMcp = result.mcp_servers !== undefined &&
    Object.keys(result.mcp_servers).length > 0;
  const hasLsp = result.lsp_servers !== undefined &&
    Object.keys(result.lsp_servers).length > 0;
  if (!hasMcp && !hasLsp) return config;
  return {
    ...(config ?? {}),
    ...(hasMcp
      ? {
          mcp_servers: {
            ...(config?.mcp_servers ?? {}),
            ...result.mcp_servers,
          },
        }
      : {}),
    ...(hasLsp
      ? {
          lsp_servers: {
            ...(config?.lsp_servers ?? {}),
            ...result.lsp_servers,
          },
        }
      : {}),
  } as AgenCConfig;
}

export const reloadPluginsCommand: SlashCommand = {
  name: "reload-plugins",
  description: "Reload plugin and skill command surfaces",
  immediate: true,
  supportsNonInteractive: false,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({
      kind: "text",
      text: await reloadPluginSurfaces(ctx),
    })),
};

export default reloadPluginsCommand;
