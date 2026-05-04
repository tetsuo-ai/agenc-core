import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export async function reloadPluginSurfaces(
  ctx: SlashCommandContext,
): Promise<string> {
  const lines: string[] = [];
  ctx.session.services.skillsManager.clearSkillCaches?.();
  lines.push("skill caches cleared");

  const configStore = ctx.configStore ?? ctx.session.services.configStore;
  const config = configStore?.current();
  if (ctx.session.services.mcpManager.refreshFromConfig && config !== undefined) {
    await ctx.session.services.mcpManager.refreshFromConfig(config);
    lines.push("MCP config refreshed");
  } else {
    lines.push("MCP refresh unavailable");
  }

  return `Reloaded plugin surfaces:\n  ${lines.join("\n  ")}`;
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
