import { join } from "node:path";

import type { AgenCConfig } from "../config/schema.js";
import { asRecord } from "../utils/record.js";
import type { SlashCommandContext } from "./types.js";

function readConfigStoreCurrent(store: unknown): AgenCConfig | undefined {
  const record = asRecord(store);
  const current = record?.current;
  return typeof current === "function"
    ? (current.call(store) as AgenCConfig | undefined)
    : undefined;
}

export function readCommandConfig(
  ctx: SlashCommandContext,
): AgenCConfig | undefined {
  const direct = readConfigStoreCurrent(ctx.configStore);
  if (direct !== undefined) return direct;
  const sessionRecord = asRecord(ctx.session);
  const services = asRecord(sessionRecord?.services);
  return readConfigStoreCurrent(services?.configStore);
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
