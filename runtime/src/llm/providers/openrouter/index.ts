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

export class OpenRouterProvider extends OpenAIProvider {
  constructor(config: OpenRouterProviderConfig) {
    super({
      ...config,
      providerName: "openrouter",
      useResponsesApi: false,
      defaultHeaders: buildOpenRouterHeaders(config.defaultHeaders),
    });
  }
}
