import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";

export type GroqProviderConfig = OpenAIProviderConfig;

const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
export const GROQ_MODEL_CATALOG = Object.freeze([
  GROQ_DEFAULT_MODEL,
  "llama-3.1-8b-instant",
  "mixtral-8x7b-32768",
]);

export class GroqProvider extends OpenAIProvider {
  constructor(config: GroqProviderConfig) {
    super({
      ...config,
      providerName: "groq",
      apiKeyEnvLabel: "GROQ_API_KEY",
      useResponsesApi: false,
      baseURL: config.baseURL ?? DEFAULT_GROQ_BASE_URL,
    });
  }
}
