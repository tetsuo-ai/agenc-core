import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import {
  BUILT_IN_PROVIDER_API_KEY_ENVS,
  BUILT_IN_PROVIDER_BASE_URLS,
} from "../../registry/provider-info.js";

export type OpenRouterProviderConfig = OpenAIProviderConfig;

export const OPENROUTER_DEFAULT_REFERER = "https://agenc.tech";
export const OPENROUTER_DEFAULT_TITLE = "AgenC";

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
      apiKeyEnvLabel: BUILT_IN_PROVIDER_API_KEY_ENVS.openrouter,
      useResponsesApi: false,
      baseURL: config.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS.openrouter,
      defaultHeaders: buildOpenRouterHeaders(config.defaultHeaders),
    });
  }
}
