/**
 * Data for the `/providers` screen: every built-in provider with one plain
 * status ("key saved", "env DEEPSEEK_API_KEY", "running", "not set"), how it
 * connects, and the model Enter would use. Built on the provider menu
 * snapshot, so availability and credential checks stay those of the runtime
 * switch; this module only words them for a person and orders the list.
 *
 * @module
 */

import { hasSavedProviderKey } from "../auth/provider-keys.js";
import type { ProviderSlug } from "../config/provider-model-authority.js";
import {
  providerCredentialEnvironmentLabel,
  resolveBuiltInProviderInfo,
  type BuiltInProviderOnboardingAccess,
} from "../llm/registry/provider-info.js";
import { requireCommandConfigStore } from "./config-context.js";
import { readModelMenuSnapshot } from "./model-menu-snapshot.js";
import {
  readProviderMenuSnapshot,
  type ProviderMenuRow,
} from "./provider-menu-snapshot.js";
import type { SlashCommandContext } from "./types.js";

/** Where a provider stands, for ordering and the row's dot. */
export type ProvidersHubConnection = "current" | "connected" | "not-set" | "error";

export type ProvidersHubRow = {
  readonly provider: ProviderSlug;
  readonly name: string;
  /** How a person connects it: paste a key, run it locally, set env, sign in. */
  readonly access: BuiltInProviderOnboardingAccess;
  readonly connection: ProvidersHubConnection;
  /** One plain phrase for the row. */
  readonly status: string;
  /** The model Enter would use: current, configured, or the default. */
  readonly model: string;
  /** A key saved on this computer, which the screen can remove. */
  readonly keySaved: boolean;
  /** Environment variables that would connect it, for the help text. */
  readonly envLabel?: string;
};

export type ProvidersHubSnapshot = {
  readonly currentProvider: ProviderSlug;
  readonly currentModel: string;
  readonly rows: readonly ProvidersHubRow[];
};

export type ProvidersHubModelRow = {
  readonly model: string;
  readonly displayModel: string;
  readonly current: boolean;
  readonly isDefault: boolean;
};

function plainStatus(row: ProviderMenuRow, keySaved: boolean): string {
  if (row.authState === "managed") return "AgenC account";
  const source = row.credentialSource;
  if (keySaved || source === "native secure storage") return "key saved";
  if (source.startsWith("env ")) return source;
  if (source === "native sign-in") return "signed in";
  if (row.runtimeState === "local") return "local";
  if (row.runtimeState === "unverified") return "checked when used";
  return "ready";
}

function connectionFor(row: ProviderMenuRow): ProvidersHubConnection {
  if (row.status === "current") return "current";
  // A deferred switch has no key yet: the old menu let it through and let the
  // first request fail. Here it reads as not set, and Enter asks for the key.
  if (row.runtimeState === "unverified" && row.authState === "missing") {
    return "not-set";
  }
  switch (row.runtimeState) {
    case "error":
    case "unavailable":
      return "error";
    case "unauthenticated":
      return "not-set";
    default:
      return "connected";
  }
}

function notSetStatus(access: BuiltInProviderOnboardingAccess): string {
  switch (access) {
    case "environment":
      return "needs AWS credentials";
    case "managed":
      return "sign in with /login";
    case "local":
      return "not running";
    default:
      return "not set";
  }
}

function rank(connection: ProvidersHubConnection): number {
  switch (connection) {
    case "current":
      return 0;
    case "connected":
      return 1;
    case "not-set":
      return 2;
    case "error":
      return 3;
  }
}

export function readProvidersHubSnapshot(ctx: SlashCommandContext): ProvidersHubSnapshot {
  const menu = readProviderMenuSnapshot(ctx);
  const home = requireCommandConfigStore(ctx).homeContext;
  const rows = menu.rows.map((row): ProvidersHubRow => {
    const info = resolveBuiltInProviderInfo(row.provider);
    const access = info?.onboarding.access ?? "api-key";
    const keySaved = access === "api-key" && hasSavedProviderKey(home, row.provider);
    const connection = connectionFor(row);
    const envLabel = providerCredentialEnvironmentLabel(row.provider);
    return {
      provider: row.provider,
      name: row.name,
      access,
      connection,
      status:
        connection === "error"
          ? row.detail
          : connection === "not-set"
            ? notSetStatus(access)
            : plainStatus(row, keySaved),
      model: row.model,
      keySaved,
      ...(envLabel === undefined ? {} : { envLabel }),
    };
  });
  const order = (provider: ProviderSlug): number =>
    resolveBuiltInProviderInfo(provider)?.onboarding.order ?? Number.MAX_SAFE_INTEGER;
  const sorted = [...rows].sort(
    (left, right) =>
      rank(left.connection) - rank(right.connection) ||
      order(left.provider) - order(right.provider) ||
      left.name.localeCompare(right.name),
  );
  return {
    currentProvider: menu.currentProvider,
    currentModel: menu.currentModel,
    rows: sorted,
  };
}

/**
 * Local providers count as connected only while their server answers. The
 * menu snapshot cannot probe (it is synchronous), so the screen applies the
 * probe result when it arrives.
 */
export function withLocalProbe(
  snapshot: ProvidersHubSnapshot,
  running: ReadonlySet<ProviderSlug>,
): ProvidersHubSnapshot {
  const rows = snapshot.rows.map((row): ProvidersHubRow => {
    if (row.access !== "local" || row.connection === "error") return row;
    if (running.has(row.provider)) {
      return {
        ...row,
        connection: row.connection === "current" ? "current" : "connected",
        status: "running",
      };
    }
    return {
      ...row,
      connection: row.connection === "current" ? "current" : "not-set",
      status: "not running",
    };
  });
  const position = new Map(snapshot.rows.map((row, index) => [row.provider, index]));
  return {
    ...snapshot,
    rows: [...rows].sort(
      (left, right) =>
        rank(left.connection) - rank(right.connection) ||
        (position.get(left.provider) ?? 0) - (position.get(right.provider) ?? 0),
    ),
  };
}

/** Rows whose name or slug contains the filter text, case-insensitive. */
export function filterProvidersHubRows(
  rows: readonly ProvidersHubRow[],
  filter: string,
): readonly ProvidersHubRow[] {
  const needle = filter.trim().toLowerCase();
  if (needle.length === 0) return rows;
  return rows.filter(
    (row) =>
      row.name.toLowerCase().includes(needle) ||
      row.provider.toLowerCase().includes(needle),
  );
}

/** The selectable models for one provider, as the model menu offers them. */
export function readProvidersHubModels(
  ctx: SlashCommandContext,
  provider: ProviderSlug,
): readonly ProvidersHubModelRow[] {
  const snapshot = readModelMenuSnapshot(ctx);
  return snapshot.rows
    .filter((row) => row.provider === provider && row.selectable)
    .map((row) => ({
      model: row.model,
      displayModel: row.displayModel,
      current: row.status === "current",
      isDefault: row.status === "default",
    }));
}
