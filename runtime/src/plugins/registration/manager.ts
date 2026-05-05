import { join } from "node:path";

import type { AgenCConfig, HooksMap, LspServerConfigInput, McpServerConfig } from "../../config/schema.js";
import type { SlashCommandContext } from "../../commands/types.js";
import { loadPlugins, type PluginLoadResult } from "../loader.js";
import {
  toPluginLoaderOptions,
  type PluginRuntimeLoadOptions,
} from "./common.js";
import { loadPluginAgents } from "./load-plugin-agents.js";
import { loadPluginCommands, loadPluginSkills } from "./load-plugin-commands.js";
import { loadPluginHooks } from "./load-plugin-hooks.js";
import { loadPluginLspServers } from "./lsp-plugin-integration.js";
import { loadPluginMcpServers } from "./mcp-plugin-integration.js";
import { loadPluginOutputStyles, type PluginOutputStyle } from "./load-plugin-output-styles.js";

export interface PluginRegistrationSnapshot {
  readonly enabled_count: number;
  readonly disabled_count: number;
  readonly command_count: number;
  readonly agent_count: number;
  readonly hook_count: number;
  readonly mcp_count: number;
  readonly lsp_count: number;
  readonly output_style_count: number;
  readonly error_count: number;
  readonly mcp_servers: Readonly<Record<string, McpServerConfig>>;
  readonly lsp_servers: Readonly<Record<string, LspServerConfigInput>>;
  readonly hooks?: HooksMap;
  readonly outputStyles: readonly PluginOutputStyle[];
  readonly loadResult: PluginLoadResult;
}

function countHooks(hooks: HooksMap | undefined): number {
  if (!hooks) return 0;
  return Object.values(hooks).reduce(
    (sum, matchers) =>
      sum + matchers.reduce((inner, matcher) => inner + matcher.hooks.length, 0),
    0,
  );
}

export async function refreshPluginRegistrations(
  options: PluginRuntimeLoadOptions = {},
): Promise<PluginRegistrationSnapshot> {
  const loadResult = await loadPlugins(toPluginLoaderOptions(options));
  const plugins = loadResult.enabled;
  const [
    commands,
    skills,
    agents,
    hooks,
    mcpServers,
    lspServers,
    outputStyles,
  ] = await Promise.all([
    loadPluginCommands({ ...options, plugins }),
    loadPluginSkills({ ...options, plugins }),
    loadPluginAgents({ ...options, plugins }),
    loadPluginHooks({ ...options, plugins }),
    loadPluginMcpServers({ ...options, plugins }),
    loadPluginLspServers({ ...options, plugins }),
    loadPluginOutputStyles({ ...options, plugins }),
  ]);

  return {
    enabled_count: loadResult.enabled.length,
    disabled_count: loadResult.disabled.length,
    command_count: commands.length + skills.length,
    agent_count: agents.length,
    hook_count: countHooks(hooks),
    mcp_count: Object.keys(mcpServers).length,
    lsp_count: Object.keys(lspServers).length,
    output_style_count: outputStyles.length,
    error_count: loadResult.errors.length,
    mcp_servers: mcpServers,
    lsp_servers: lspServers,
    ...(hooks !== undefined ? { hooks } : {}),
    outputStyles,
    loadResult,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function arrayOfPluginNames(result: PluginLoadResult, enabled: boolean): string[] {
  return (enabled ? result.enabled : result.disabled)
    .map((plugin) => plugin.name)
    .sort((a, b) => a.localeCompare(b));
}

function updatePluginAppState(
  setAppState: ((updater: (prev: unknown) => unknown) => void) | undefined,
  snapshot: PluginRegistrationSnapshot,
): void {
  if (!setAppState) return;
  setAppState((prev) => {
    const current = isRecord(prev) ? prev : {};
    const currentPlugins = isRecord(current.plugins) ? current.plugins : {};
    const currentMcp = isRecord(current.mcp) ? current.mcp : {};
    const currentReconnectKey =
      typeof currentMcp.pluginReconnectKey === "number"
        ? currentMcp.pluginReconnectKey
        : 0;
    return {
      ...current,
      plugins: {
        ...currentPlugins,
        enabled: arrayOfPluginNames(snapshot.loadResult, true),
        disabled: arrayOfPluginNames(snapshot.loadResult, false),
        commands: snapshot.command_count,
        outputStyles: snapshot.outputStyles.map((style) => style.name),
        errors: snapshot.loadResult.errors.map((error) => ({
          plugin: error.plugin,
          source: error.source,
          path: error.path,
          message: error.message,
        })),
        needsRefresh: false,
      },
      mcp: {
        ...currentMcp,
        pluginReconnectKey: currentReconnectKey + 1,
      },
    };
  });
}

function currentConfig(ctx: SlashCommandContext): AgenCConfig | undefined {
  return ctx.configStore?.current?.() ?? ctx.session.services.configStore?.current?.();
}

export function pluginRuntimeOptionsFromContext(
  ctx: SlashCommandContext,
): PluginRuntimeLoadOptions {
  const config = currentConfig(ctx);
  return {
    cwd: ctx.cwd,
    workspaceRoot: ctx.cwd,
    agencHome: ctx.agencHome ?? join(ctx.home, ".agenc"),
    ...(config !== undefined ? { config } : {}),
  };
}

export async function refreshActivePlugins(
  ctx: SlashCommandContext,
): Promise<PluginRegistrationSnapshot> {
  const snapshot = await refreshPluginRegistrations(pluginRuntimeOptionsFromContext(ctx));
  updatePluginAppState(ctx.appState?.setAppState, snapshot);
  return snapshot;
}
