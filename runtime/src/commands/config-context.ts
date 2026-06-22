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
