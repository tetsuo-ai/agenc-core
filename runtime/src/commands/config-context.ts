import { join } from "node:path";

import type { AgenCConfig } from "../config/schema.js";
import type { SlashCommandContext } from "./types.js";

export function readCommandConfig(
  ctx: SlashCommandContext,
): AgenCConfig | undefined {
  return (
    ctx.configStore?.current() ??
    (ctx.session as unknown as {
      services?: { configStore?: { current?: () => AgenCConfig } };
    }).services?.configStore?.current?.()
  );
}

export function agencHomeFromCommandContext(ctx: SlashCommandContext): string {
  return ctx.agencHome ?? join(ctx.home, ".agenc");
}

export function getConfigFilePath(agencHome: string): string {
  return join(agencHome, "config.toml");
}

export function configFilePathFromCommandContext(
  ctx: SlashCommandContext,
): string {
  return getConfigFilePath(agencHomeFromCommandContext(ctx));
}
