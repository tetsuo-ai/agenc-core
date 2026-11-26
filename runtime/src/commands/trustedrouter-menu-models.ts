/**
 * TrustedRouter's live model list for the `/providers` and `/model` menus.
 *
 * TrustedRouter publishes hundreds of models plus `trustedrouter/*` presets
 * and `nyte/*` aliases at `GET /v1/models`; the bundled snapshot is only the
 * offline fallback when that list cannot be read. The menus run in the TUI
 * process, which has no models manager (the session lives in the daemon), so
 * they read TrustedRouter here with the key the session would use:
 * `TRUSTEDROUTER_API_KEY` from the environment, a key just entered in the menu
 * (it lands in the session's provider environment), or the key saved on this
 * computer.
 *
 * @module
 */

import { createHash } from "node:crypto";

import { readLocalByokCredential } from "../auth/native-credentials.js";
import { readProviderConfig } from "../config/resolve-provider.js";
import type { AgenCConfig } from "../config/schema.js";
import { ModelMetadataResolver } from "../llm/model-metadata.js";
import {
  TRUSTEDROUTER_MODELS,
  type TrustedRouterModel,
} from "../llm/registry/trustedrouter-models.js";
import {
  providerEnvironmentFromCommandContext,
  readCommandConfig,
  requireCommandConfigStore,
} from "./config-context.js";
import type { SlashCommandContext } from "./types.js";

/** Shown under the list when TrustedRouter's own list could not be read. */
export const TRUSTEDROUTER_MODEL_LIST_UNAVAILABLE_NOTE =
  "Could not load TrustedRouter's model list, showing the bundled ones.";

export type TrustedRouterMenuModels =
  | { readonly source: "live"; readonly models: readonly TrustedRouterModel[] }
  | {
      readonly source: "bundled";
      /** No key to ask with, or the request failed. */
      readonly reason: "no-key" | "unavailable";
      readonly models: readonly TrustedRouterModel[];
    };

/** A list read from TrustedRouter is reused this long before the menu asks again. */
const LIVE_LIST_REUSE_MS = 10 * 60_000;
/** The menu shows progress while it waits, so it can wait longer than a turn's lookup. */
const MENU_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_REMEMBERED_LISTS = 8;

interface Lookup {
  /** Digest of the home, endpoint and key: a new key never reuses an old list. */
  readonly identity: string;
  readonly config: AgenCConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
}

const remembered = new Map<
  string,
  { readonly at: number; readonly models: readonly TrustedRouterModel[] }
>();
const inFlight = new Map<string, Promise<TrustedRouterMenuModels>>();

function lookupFor(ctx: SlashCommandContext): Lookup | undefined {
  let environment: Readonly<Record<string, string | undefined>>;
  try {
    environment = providerEnvironmentFromCommandContext(ctx);
  } catch {
    // A context without a captured provider environment has no key to use.
    return undefined;
  }
  const config = readCommandConfig(ctx) ?? {};
  const home = requireCommandConfigStore(ctx).homeContext;
  // The session reads the environment key first and the saved key only
  // without one (provider-options), so the menu asks with the same key.
  const apiKey = nonEmpty(environment.TRUSTEDROUTER_API_KEY) ?? savedKey(ctx);
  if (apiKey === undefined) return undefined;
  const identity = createHash("sha256")
    .update(
      JSON.stringify([
        home.identityKey,
        nonEmpty(environment.TRUSTEDROUTER_BASE_URL) ?? null,
        nonEmpty(readProviderConfig(config, "trustedrouter")?.base_url) ?? null,
        apiKey,
      ]),
    )
    .digest("hex");
  return {
    identity,
    config,
    env: { ...environment, TRUSTEDROUTER_API_KEY: apiKey },
  };
}

function savedKey(ctx: SlashCommandContext): string | undefined {
  try {
    return nonEmpty(
      readLocalByokCredential(
        requireCommandConfigStore(ctx).homeContext,
        "trustedrouter",
      )?.apiKey,
    );
  } catch {
    // An unreadable store leaves the menu on the bundled list, not broken.
    return undefined;
  }
}

function fresh(identity: string): readonly TrustedRouterModel[] | undefined {
  const entry = remembered.get(identity);
  return entry !== undefined && Date.now() - entry.at < LIVE_LIST_REUSE_MS
    ? entry.models
    : undefined;
}

/**
 * The list the menu last read from TrustedRouter with this context's key and
 * endpoint, while it is fresh. Synchronous and offline: menus call it while
 * they render; `loadTrustedRouterMenuModels` does the asking.
 */
export function readTrustedRouterMenuModels(
  ctx: SlashCommandContext,
): readonly TrustedRouterModel[] | undefined {
  // Nothing read yet: skip the key lookup (a saved key is a keychain read).
  if (remembered.size === 0) return undefined;
  const lookup = lookupFor(ctx);
  return lookup === undefined ? undefined : fresh(lookup.identity);
}

/** Ask TrustedRouter for its public chat models, reusing a fresh answer for the same key. */
export async function loadTrustedRouterMenuModels(
  ctx: SlashCommandContext,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<TrustedRouterMenuModels> {
  const lookup = lookupFor(ctx);
  if (lookup === undefined) {
    return {
      source: "bundled",
      reason: "no-key",
      models: TRUSTEDROUTER_MODELS,
    };
  }
  const known = fresh(lookup.identity);
  if (known !== undefined) return { source: "live", models: known };
  const pending = inFlight.get(lookup.identity);
  if (pending !== undefined) return await pending;
  const request = discover(lookup, options.fetchImpl ?? globalThis.fetch);
  inFlight.set(lookup.identity, request);
  try {
    return await request;
  } finally {
    inFlight.delete(lookup.identity);
  }
}

async function discover(
  lookup: Lookup,
  fetchImpl: typeof fetch,
): Promise<TrustedRouterMenuModels> {
  let models: readonly TrustedRouterModel[] | undefined;
  try {
    models = await new ModelMetadataResolver({
      fetchImpl,
      env: lookup.env,
      timeoutMs: MENU_DISCOVERY_TIMEOUT_MS,
    }).discoverTrustedRouterModels(lookup.config);
  } catch {
    models = undefined;
  }
  if (models === undefined || models.length === 0) {
    return {
      source: "bundled",
      reason: "unavailable",
      models: TRUSTEDROUTER_MODELS,
    };
  }
  remembered.delete(lookup.identity);
  remembered.set(lookup.identity, { at: Date.now(), models });
  while (remembered.size > MAX_REMEMBERED_LISTS) {
    remembered.delete(remembered.keys().next().value!);
  }
  return { source: "live", models };
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
