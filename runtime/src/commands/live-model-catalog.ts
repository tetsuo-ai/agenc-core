import { openRouterMenuCatalog } from "./openrouter-menu-models.js";
/**
 * The provider's own model rows for the TUI process.
 *
 * The session runs in the daemon, which reads Venice's, Ollama Cloud's and
 * OpenRouter's live lists when it starts. The TUI process decides what
 * `/effort` offers and what the status line shows from the same registered
 * catalog, so it reads those lists too before it answers: Venice with the
 * session's key (through the menu loader), Ollama Cloud and OpenRouter from
 * their public endpoints, and a local Ollama's installed models from its own
 * server. While OpenRouter requests ask for zero data retention, it also
 * reads OpenRouter's list of zero-retention endpoints, so the picker and the
 * status line can tell which models still work. Best effort: the bundled
 * rows answer offline.
 *
 * @module
 */

import { readCommandConfig, providerEnvironmentFromCommandContext } from "./config-context.js";
import { loadVeniceMenuModels } from "./venice-menu-models.js";
import { loadOllamaMenuModels } from "./ollama-menu-models.js";
import { ModelMetadataResolver } from "../llm/model-metadata.js";
import { openRouterZdrEndpointsKnown } from "../llm/registry/openrouter-zdr-endpoints.js";
import { openRouterZeroDataRetentionEnabled } from "../llm/zero-data-retention.js";
import type { SlashCommandContext } from "./types.js";

/** One read per provider and model is reused this long. */
const REUSE_MS = 10 * 60_000;
const DISCOVERY_TIMEOUT_MS = 5_000;
const fresh = new Map<string, number>();

/** Shown in the picker when OpenRouter's zero-retention list cannot be read. */
export const OPENROUTER_ZDR_LIST_UNAVAILABLE_NOTE =
  "Could not load OpenRouter's zero-retention list, so models are not checked.";

function resolverFor(
  ctx: SlashCommandContext,
  fetchImpl: typeof fetch | undefined,
): ModelMetadataResolver {
  let env: Readonly<Record<string, string | undefined>> = {};
  try {
    env = providerEnvironmentFromCommandContext(ctx);
  } catch {
    // Public endpoints answer without a key.
  }
  return new ModelMetadataResolver({
    fetchImpl: fetchImpl ?? (process.env.NODE_ENV === "test" ? undefined : globalThis.fetch.bind(globalThis)),
    env,
    timeoutMs: DISCOVERY_TIMEOUT_MS,
  });
}

/**
 * Read OpenRouter's zero-retention endpoint list when requests ask for zero
 * data retention and the list is not fresh. Resolves to whether the list is
 * known afterwards (true when there is nothing to read).
 */
export async function ensureOpenRouterZdrEndpoints(
  ctx: SlashCommandContext,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  if (!openRouterZeroDataRetentionEnabled(readCommandConfig(ctx))) return true;
  const key = "openrouter-zdr";
  const at = fresh.get(key);
  if (at !== undefined && Date.now() - at < REUSE_MS) return true;
  try {
    if (await resolverFor(ctx, options.fetchImpl).discoverOpenRouterZdrEndpoints()) {
      fresh.set(key, Date.now());
      return true;
    }
  } catch {
    // An unreadable list leaves the models unchecked, never broken.
  }
  return openRouterZdrEndpointsKnown();
}

export async function ensureLiveModelCatalog(
  ctx: SlashCommandContext,
  provider: string,
  model: string,
  options: { readonly fetchImpl?: typeof fetch } = {},
): Promise<void> {
  // A local Ollama session: read which models are installed (the server keeps
  // its own short reuse window), so /model offers them.
  if (provider === "ollama") {
    await loadOllamaMenuModels(ctx, options);
    return;
  }
  if (provider === "openrouter") {
    await Promise.all([openRouterMenuCatalog(ctx, options).refresh(), ensureOpenRouterZdrEndpoints(ctx, options)]);
    return;
  }
  if (provider !== "venice" && provider !== "ollama-cloud") return;
  const key = `${provider}\n${provider === "ollama-cloud" ? model : ""}`;
  const at = fresh.get(key);
  if (at !== undefined && Date.now() - at < REUSE_MS) return;
  try {
    if (provider === "venice") {
      const result = await loadVeniceMenuModels(ctx, options);
      if (result.source === "live") fresh.set(key, Date.now());
      return;
    }
    const resolver = resolverFor(ctx, options.fetchImpl);
    const found = (await resolver.discoverOllamaCloudModels(readCommandConfig(ctx) ?? {}, model)) !== undefined;
    if (found) fresh.set(key, Date.now());
  } catch {
    // The bundled catalog answers while the provider's list cannot be read.
  }
}
