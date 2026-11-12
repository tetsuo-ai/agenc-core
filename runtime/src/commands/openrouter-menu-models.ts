import type { OpenRouterCatalog } from "../llm/registry/openrouter-live-catalog.js";
import { openRouterCatalogForHome } from "../session/cached-live-model-list.js";
import { providerEnvironmentFromCommandContext, requireCommandConfigStore } from "./config-context.js";
import type { SlashCommandContext } from "./types.js";

export function openRouterMenuCatalog(ctx: SlashCommandContext, options: { readonly fetchImpl?: typeof fetch } = {}): OpenRouterCatalog {
  const home = requireCommandConfigStore(ctx).homeContext;
  let environment: Readonly<Record<string, string | undefined>> | undefined;
  try {
    environment = providerEnvironmentFromCommandContext(ctx);
  } catch {
    // The public catalog also works without a credential environment.
  }
  // The same home and key as the selection check reads the cached list with.
  return openRouterCatalogForHome(home, environment, options);
}
