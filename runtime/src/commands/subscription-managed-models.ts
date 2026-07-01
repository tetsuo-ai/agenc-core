import { normalizeProviderSlug, type ProviderSlug } from "../config/resolve-provider.js";

const LIVE_SUBSCRIPTION_MODELS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ["claude-haiku-4-5-20251001"],
  openai: ["gpt-5-mini"],
  grok: ["grok-4.3", "grok-code-fast-1"],
  gemini: ["gemini-2.5-pro"],
};

function normalizeModelId(model: string): string {
  const trimmed = model.trim();
  if (trimmed.startsWith("xai/")) return trimmed.slice("xai/".length);
  if (trimmed.startsWith("x-ai/")) return trimmed.slice("x-ai/".length);
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
