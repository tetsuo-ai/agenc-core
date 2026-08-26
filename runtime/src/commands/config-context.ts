import { join } from "node:path";

import { resolveHomeContext } from "../config/home.js";
import type { EnvSnapshot } from "../config/env.js";
import type { AgenCConfig } from "../config/schema.js";
import type { ConfigStore } from "../config/store.js";
import type { RemoteAuthSessionReadContext } from "../auth/session-state.js";
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
  return readConfigStoreCurrent(configStoreFromCommandContext(ctx));
}

/** Resolve the one ConfigStore authority exposed through command ingress. */
export function configStoreFromCommandContext(
  ctx: SlashCommandContext,
): ConfigStore | null {
  const sessionRecord = asRecord(ctx.session);
  const services = asRecord(sessionRecord?.services);
  const sessionStore = services?.configStore;
  const contextStore = ctx.configStore;
  if (
    asRecord(sessionStore) !== null &&
    asRecord(contextStore) !== null &&
    sessionStore !== contextStore
  ) {
    throw new Error(
      "Slash command received conflicting ConfigStore authorities",
    );
  }
  const store = asRecord(sessionStore) !== null ? sessionStore : contextStore;
  return asRecord(store) === null ? null : store as ConfigStore;
}

export function requireCommandConfigStore(
  ctx: SlashCommandContext,
): ConfigStore {
  const store = configStoreFromCommandContext(ctx);
  if (store === null) {
    throw new Error(
      "Slash command requires the canonical ConfigStore authority",
    );
  }
  return store;
}

/** Resolve the one immutable provider environment available to this session kind. */
export function providerEnvironmentFromCommandContext(
  ctx: SlashCommandContext,
): EnvSnapshot {
  const services = asRecord(asRecord(ctx.session)?.services);
  const providerService = asRecord(services?.providerService);
  const environment = providerService?.environment;
  if (typeof environment === "function") {
    return environment.call(services?.providerService) as EnvSnapshot;
  }
  const bridgeEnvironment = services?.providerEnvironment;
  if (asRecord(bridgeEnvironment) !== null) {
    return bridgeEnvironment as EnvSnapshot;
  }
  throw new Error(
    "Slash command requires the session's captured provider environment",
  );
}

export function remoteAuthContextFromCommandContext(
  ctx: SlashCommandContext,
): RemoteAuthSessionReadContext {
  return Object.freeze({
    home: requireCommandConfigStore(ctx).homeContext,
    environment: providerEnvironmentFromCommandContext(ctx),
  });
}

export function agencHomeFromCommandContext(ctx: SlashCommandContext): string {
  return resolveHomeContext(
    ctx.agencHome === undefined ? {} : { AGENC_HOME: ctx.agencHome },
    { platformHome: ctx.home },
  ).path;
}

export function getConfigFilePath(agencHome: string): string {
  return join(agencHome, "config.toml");
}

export function configFilePathFromCommandContext(
  ctx: SlashCommandContext,
): string {
  return getConfigFilePath(agencHomeFromCommandContext(ctx));
}
