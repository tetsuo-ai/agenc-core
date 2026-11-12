/**
 * The provider's live model list that another process left in a session's
 * home.
 *
 * A process records the provider lists it has read itself
 * (published-model-catalog.ts): the TUI those its menus read, the daemon
 * those its sessions discovered. A model is picked in the TUI and checked
 * again by the daemon, so a rule that takes a model away unless the
 * provider's list has it (model-retirement.ts) must read the same list in
 * both. OpenRouter's list is cached in the home they share, in one file per
 * key: this module finds that file for a session and reads it.
 *
 * Venice's and the other providers' lists are not cached in the home. For
 * them a process knows only what it has read itself.
 *
 * @module
 */

import { readLocalByokCredential } from "../auth/native-credentials.js";
import type { HomeContext } from "../config/home.js";
import { openRouterCatalogFor, type OpenRouterCatalog } from "../llm/registry/openrouter-live-catalog.js";
import { asRecord } from "../utils/record.js";

type Environment = Readonly<Record<string, string | undefined>>;

/**
 * The OpenRouter catalog of a home and the key used there: the key in the
 * environment, else the one saved in the home, else the public list. Every
 * process that asks with the same home and key gets the same cache file.
 */
export function openRouterCatalogForHome(
  home: HomeContext,
  environment: Environment | undefined,
  options: { readonly fetchImpl?: typeof fetch } = {},
): OpenRouterCatalog {
  let apiKey = environment?.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    try {
      apiKey = readLocalByokCredential(home, "openrouter")?.apiKey;
    } catch {
      // Use the public catalog if the credential store is unavailable.
    }
  }
  return openRouterCatalogFor({ home: home.path, apiKey, fetchImpl: options.fetchImpl });
}

/** The home a session keeps its configuration, credentials and caches in. */
function sessionHome(services: Record<string, unknown> | null): HomeContext | undefined {
  const home: unknown = asRecord(services?.configStore)?.homeContext;
  return typeof asRecord(home)?.path === "string" ? (home as HomeContext) : undefined;
}

/** The provider environment a session uses now, with any key added since it was created. */
function sessionProviderEnvironment(services: Record<string, unknown> | null): Environment | undefined {
  const live = asRecord(services?.providerService)?.environment;
  const environment: unknown = typeof live === "function"
    ? live.call(services?.providerService)
    : services?.providerEnvironment;
  return asRecord(environment) === null ? undefined : (environment as Environment);
}

/**
 * Read into this process the live list the session's home holds now for
 * `provider` and the session's key, when it is newer than the one this
 * process has. Local: nothing is requested from the provider. A session with
 * no home, a provider whose list is not cached there, and a home with no
 * usable cache all leave what this process recorded as it was.
 */
export function readSessionCachedLiveModelList(session: unknown, provider: string): void {
  if (provider !== "openrouter") return;
  const services = asRecord(asRecord(session)?.services);
  const home = sessionHome(services);
  if (home === undefined) return;
  openRouterCatalogForHome(home, sessionProviderEnvironment(services)).refreshFromCache();
}
