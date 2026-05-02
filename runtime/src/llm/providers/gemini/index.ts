/**
 * Gemini provider module.
 *
 * @module
 */

import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type GeminiProviderConfig = OpenAIProviderConfig;

const DEFAULT_GEMINI_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta";

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
      authStrategy: config.authStrategy ?? "bearer",
      useResponsesApi: false,
      baseURL: normalizeGeminiBaseURL(config.baseURL) ?? DEFAULT_GEMINI_BASE_URL,
      basePath: config.basePath ?? "/openai",
    });
  }
}
