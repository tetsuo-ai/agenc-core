import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type OpenRouterProviderConfig = OpenAIProviderConfig;

export const OPENROUTER_DEFAULT_REFERER = "https://agenc.tech";
export const OPENROUTER_DEFAULT_TITLE = "AgenC";

function buildOpenRouterHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return {
    "HTTP-Referer": OPENROUTER_DEFAULT_REFERER,
    "X-Title": OPENROUTER_DEFAULT_TITLE,
    ...(headers ?? {}),
  };
}

/**
 * Request-level zero data retention: `provider.zdr = true` restricts routing
 * to endpoints with a zero-data-retention policy (OR-ed with the account
 * setting on OpenRouter's side). A model with no such endpoint is refused by
 * OpenRouter rather than silently served elsewhere.
 * https://openrouter.ai/docs/features/provider-routing
 */
export function openRouterExtraBody(
  config: Pick<OpenRouterProviderConfig, "zeroDataRetention" | "extraBody">,
): Readonly<Record<string, unknown>> | undefined {
  if (config.zeroDataRetention !== true) return config.extraBody;
  const existingProvider = config.extraBody?.provider;
  const provider =
    existingProvider !== null &&
    typeof existingProvider === "object" &&
    !Array.isArray(existingProvider)
      ? { ...(existingProvider as Record<string, unknown>), zdr: true }
      : { zdr: true };
  return { ...(config.extraBody ?? {}), provider };
}

export class OpenRouterProvider extends OpenAIProvider {
  constructor(config: OpenRouterProviderConfig) {
    const extraBody = openRouterExtraBody(config);
    super({
      ...config,
      providerName: "openrouter",
      useResponsesApi: false,
      defaultHeaders: buildOpenRouterHeaders(config.defaultHeaders),
      ...(extraBody !== undefined ? { extraBody } : {}),
    });
  }
}
