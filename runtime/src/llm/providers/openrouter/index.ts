import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type OpenRouterProviderConfig = OpenAIProviderConfig;

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_DEFAULT_REFERER = "https://agenc.tech";
export const OPENROUTER_DEFAULT_TITLE = "AgenC";
export const OPENROUTER_MODEL_CATALOG = Object.freeze([
  "openai/gpt-5",
  "openai/gpt-5-mini",
  "x-ai/grok-code-fast-1",
]);

function buildOpenRouterHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return {
    "HTTP-Referer":
      process.env.AGENC_OPENROUTER_HTTP_REFERER?.trim() ||
      OPENROUTER_DEFAULT_REFERER,
    "X-Title":
      process.env.AGENC_OPENROUTER_TITLE?.trim() ||
      OPENROUTER_DEFAULT_TITLE,
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
