import { normalizeProviderSlug, type ProviderSlug } from "../config/resolve-provider.js";

const LIVE_SUBSCRIPTION_MODELS: Readonly<Record<string, readonly string[]>> = {
  openrouter: [
    "x-ai/grok-4.3",
    "x-ai/grok-build-0.1",
    "openai/gpt-4o-mini",
    "openai/gpt-5-nano",
    "openai/gpt-4.1-nano",
    "openai/gpt-oss-120b",
    "anthropic/claude-haiku-4.5",
    "google/gemini-2.5-flash",
    "google/gemini-2.5-flash-lite",
    "deepseek/deepseek-chat",
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v3.2",
    "qwen/qwen3-coder-30b-a3b-instruct",
    "qwen/qwen3-235b-a22b-2507",
    "mistralai/mistral-small-3.2-24b-instruct",
    "meta-llama/llama-3.3-70b-instruct",
    "meta-llama/llama-4-scout",
    "minimax/minimax-m2.5",
    "z-ai/glm-4.7-flash",
  ],
};

function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  if (trimmed.startsWith("openrouter/")) {
    return trimmed.slice("openrouter/".length);
  }
  if (trimmed.startsWith("xai/")) {
    return `x-ai/${trimmed.slice("xai/".length)}`;
  }
  return trimmed;
}

export function subscriptionManagedModels(
  provider: ProviderSlug | string,
): readonly string[] {
  const normalized = normalizeProviderSlug(provider) ?? provider.trim().toLowerCase();
  return LIVE_SUBSCRIPTION_MODELS[normalized] ?? [];
}

export function providerHasLiveSubscriptionRoute(
  provider: ProviderSlug | string,
): boolean {
  return subscriptionManagedModels(provider).length > 0;
}

export function subscriptionManagedDefaultModel(
  provider: ProviderSlug | string,
): string | undefined {
  return subscriptionManagedModels(provider)[0];
}

export function isSubscriptionManagedModel(
  provider: ProviderSlug | string,
  model: string,
): boolean {
  const normalizedModel = normalizeModelId(model);
  return subscriptionManagedModels(provider).includes(normalizedModel);
}

export function formatSubscriptionManagedModels(): string {
  return Object.entries(LIVE_SUBSCRIPTION_MODELS)
    .flatMap(([provider, models]) =>
      models.map((model) => `/model ${provider}:${model}`)
    )
    .join(" or ");
}
