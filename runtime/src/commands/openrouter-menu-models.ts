import { readLocalByokCredential } from "../auth/native-credentials.js";
import { openRouterCatalogFor, type OpenRouterCatalog } from "../llm/registry/openrouter-live-catalog.js";
import { providerEnvironmentFromCommandContext, requireCommandConfigStore } from "./config-context.js";
import type { SlashCommandContext } from "./types.js";

export function openRouterMenuCatalog(ctx: SlashCommandContext, options: { readonly fetchImpl?: typeof fetch } = {}): OpenRouterCatalog {
  const home = requireCommandConfigStore(ctx).homeContext;
  let apiKey: string | undefined;
  try {
    apiKey = providerEnvironmentFromCommandContext(ctx).OPENROUTER_API_KEY?.trim();
  } catch {
    // The public catalog also works without a credential environment.
  }
  if (!apiKey) {
    try {
      apiKey = readLocalByokCredential(home, "openrouter")?.apiKey;
    } catch {
      // Use the public catalog if the credential store is unavailable.
    }
  }
  return openRouterCatalogFor({ home: home.path, apiKey, fetchImpl: options.fetchImpl });
}
