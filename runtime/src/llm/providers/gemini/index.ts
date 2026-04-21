/**
 * Gemini provider module.
 *
 * @module
 */

import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type GeminiProviderConfig = OpenAIProviderConfig;

function normalizeGeminiBaseURL(baseURL: string | undefined): string | undefined {
  const normalized = baseURL?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.replace(/\/openai\/?$/i, "");
}

export class GeminiProvider extends OpenAIProvider {
  constructor(config: GeminiProviderConfig) {
    super({
      ...config,
      providerName: "gemini",
      apiKeyEnvLabel: "GEMINI_API_KEY",
      authStrategy: config.authStrategy ?? "google_api_key",
      useResponsesApi: false,
      baseURL: normalizeGeminiBaseURL(config.baseURL),
      basePath: config.basePath ?? "/openai",
    });
  }
}
