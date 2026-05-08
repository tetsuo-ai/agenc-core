import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";
import type { AgenCConfig, LspServerConfigInput, McpServerConfig } from "../config/schema.js";
import type { Command } from "../commands.js";
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
  readonly commands?: readonly Command[];
  readonly skills?: readonly Command[];
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
  try {
    // Literal specifiers so tsup discovers and bundles these modules.
    // Variable-specifier dynamic imports are skipped by the bundler.
    const [settingsSync, changeDetector] = await Promise.all([
      import("../services/settingsSync/index.js") as Promise<{
        redownloadUserSettings?: () => Promise<boolean>;
      }>,
      import("../utils/settings/changeDetector.js") as Promise<{
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function promptBlockText(block: unknown): string | null {
  if (typeof block === "string") return block;
  if (!isRecord(block)) return null;
  if (block.type === "text" && typeof block.text === "string") {
    return block.text;
  }
  return null;
}

function promptContentFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) {
    return promptBlockText(blocks) ?? "";
  }
  return blocks
    .map(promptBlockText)
    .filter((text): text is string => text !== null && text.length > 0)
    .join("\n");
}

function pluginCommandToSlashCommand(command: Command): SlashCommand | null {
  if (command.type !== "prompt") return null;
  return {
    name: command.name,
    description: command.description,
    ...(command.aliases ? { aliases: [...command.aliases] } : {}),
    ...(command.isEnabled ? { isEnabled: command.isEnabled } : {}),
    ...(command.userInvocable !== undefined
      ? { userInvocable: command.userInvocable }
      : {}),
    ...(command.isSensitive !== undefined ? { sensitive: command.isSensitive } : {}),
    execute: (ctx) =>
      safeExecute(async () => {
        if (typeof command.getPromptForCommand !== "function") {
          return {
            kind: "error",
            message: `/${command.name} cannot render prompt content.`,
          };
        }
        const blocks = await command.getPromptForCommand(ctx.argsRaw, {
          sessionId: ctx.session.conversationId,
          cwd: ctx.cwd,
          home: ctx.home,
          agencHome: ctx.agencHome,
          session: ctx.session,
          configStore: ctx.configStore,
        });
        const content = promptContentFromBlocks(blocks);
        if (content.length === 0) {
          return {
            kind: "error",
            message: `/${command.name} produced no prompt content.`,
          };
        }
        return {
          kind: "prompt",
          content: `<command-name>${command.name}</command-name>\n${content}`,
        };
      }),
  };
}

function refreshDispatcherPluginCommands(
  ctx: SlashCommandContext,
  result: ActivePluginRefreshResult,
): void {
  const registry = ctx.commandRegistry;
  if (typeof registry?.replaceDynamicCommands !== "function") return;
  const commands = [...(result.commands ?? []), ...(result.skills ?? [])]
    .map(pluginCommandToSlashCommand)
    .filter((command): command is SlashCommand => command !== null);
  registry.replaceDynamicCommands("plugins", commands);
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
  refreshDispatcherPluginCommands(ctx, result);

  const configStore = ctx.configStore ?? ctx.session.services.configStore;
  const config = configStore?.current?.();
  const refreshedConfig = withPluginServerConfig(config, result);
  if (ctx.session.services.mcpManager.refreshFromConfig && refreshedConfig !== undefined) {
    await ctx.session.services.mcpManager.refreshFromConfig(refreshedConfig);
  }
  if (ctx.session.services.lspManager?.refreshFromConfig && refreshedConfig !== undefined) {
    await ctx.session.services.lspManager.refreshFromConfig(refreshedConfig);
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
