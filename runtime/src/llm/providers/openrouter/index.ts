import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type OpenRouterProviderConfig = OpenAIProviderConfig;

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

function buildOpenRouterHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return {
    "HTTP-Referer":
      process.env.AGENC_OPENROUTER_HTTP_REFERER?.trim() ||
      "https://github.com/tetsuo-ai/agenc-core",
    "X-Title":
      process.env.AGENC_OPENROUTER_TITLE?.trim() ||
      "AgenC",
    ...(headers ?? {}),
  };
}

export class OpenRouterProvider extends OpenAIProvider {
  constructor(config: OpenRouterProviderConfig) {
    super({
      ...config,
      providerName: "openrouter",
      apiKeyEnvLabel: "OPENROUTER_API_KEY",
      useResponsesApi: false,
      baseURL: config.baseURL ?? DEFAULT_OPENROUTER_BASE_URL,
      defaultHeaders: buildOpenRouterHeaders(config.defaultHeaders),
    });
  }
}
