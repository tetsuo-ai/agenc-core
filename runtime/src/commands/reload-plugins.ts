import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export interface ActivePluginRefreshResult {
  readonly enabled_count: number;
  readonly disabled_count: number;
  readonly command_count: number;
  readonly agent_count: number;
  readonly hook_count: number;
  readonly mcp_count: number;
  readonly lsp_count: number;
  readonly error_count: number;
}

export type ActivePluginRefresher = (
  ctx: SlashCommandContext,
) => Promise<ActivePluginRefreshResult>;

let activePluginRefresherForTesting: ActivePluginRefresher | undefined;

export function setActivePluginRefresherForTesting(
  refresher: ActivePluginRefresher | undefined,
): () => void {
  const previous = activePluginRefresherForTesting;
  activePluginRefresherForTesting = refresher;
  return () => {
    activePluginRefresherForTesting = previous;
  };
}

function emptyAppState() {
  return {
    plugins: {
      enabled: [],
      disabled: [],
      commands: [],
      errors: [],
      needsRefresh: false,
    },
    agentDefinitions: { allAgents: [] },
    mcp: { pluginReconnectKey: 0 },
  };
}

async function clearRuntimeCommandCaches(ctx: SlashCommandContext): Promise<void> {
  ctx.session.services.skillsManager.clearSkillCaches?.();
  const commands = await import("../commands.js");
  commands.clearCommandMemoizationCaches();
}

async function defaultActivePluginRefresher(
  ctx: SlashCommandContext,
): Promise<ActivePluginRefreshResult> {
  const refreshModulePath = "../agenc/upstream/utils/plugins/refresh.js";
  const pluginRefresh = await import(refreshModulePath) as {
    refreshActivePlugins: (
      setAppState: (updater: (prev: never) => never) => void,
    ) => Promise<ActivePluginRefreshResult>;
  };
  let fallbackState = emptyAppState();
  const setAppState = (updater: (prev: unknown) => unknown) => {
    const liveSetAppState = ctx.appState?.setAppState;
    if (liveSetAppState) {
      liveSetAppState(updater);
      return;
    }
    fallbackState = updater(fallbackState) as ReturnType<typeof emptyAppState>;
  };
  return pluginRefresh.refreshActivePlugins(setAppState as never);
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
    `  ${plural(result.error_count, "error")}`,
  ].join("\n");
}

export async function reloadPluginSurfaces(
  ctx: SlashCommandContext,
): Promise<string> {
  await clearRuntimeCommandCaches(ctx);
  const result = await (activePluginRefresherForTesting ?? defaultActivePluginRefresher)(ctx);

  const configStore = ctx.configStore ?? ctx.session.services.configStore;
  const config = configStore?.current?.();
  if (ctx.session.services.mcpManager.refreshFromConfig && config !== undefined) {
    await ctx.session.services.mcpManager.refreshFromConfig(config);
  }

  return formatPluginRefreshSummary(result);
}

export const reloadPluginsCommand: SlashCommand = {
  name: "reload-plugins",
  description: "Reload plugin and skill command surfaces",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({
      kind: "text",
      text: await reloadPluginSurfaces(ctx),
    })),
};

export default reloadPluginsCommand;
