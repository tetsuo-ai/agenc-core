import { normalizeProviderSlug, type ProviderSlug } from "../config/resolve-provider.js";

const LIVE_SUBSCRIPTION_MODELS: Readonly<Record<string, readonly string[]>> = {
  grok: ["grok-4.3", "grok-code-fast-1"],
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
  return subscriptionManagedModels("grok")
    .map((model) => `/model grok:${model}`)
    .join(" or ");
}
