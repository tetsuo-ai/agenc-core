import type { EnvSnapshot } from "../config/env.js";
import { normalizeProviderSlug, type ProviderSlug } from "../config/resolve-provider.js";
import type { AgenCConfig } from "../config/schema.js";
import {
  hasEntitledRemoteAuthSessionSync,
  hasRemoteAuthSessionSync,
  remoteAuthSessionSubscriptionTierSync,
} from "../auth/session-state.js";
import type { AuthSubscriptionTier } from "../auth/backend.js";
import { OPENROUTER_FREE_MODEL_IDS } from "../llm/registry/openrouter-free-models.js";

export const SUBSCRIPTION_MANAGED_DEFAULT_PROVIDER: ProviderSlug = "openrouter";
const HIDDEN_SUBSCRIPTION_MANAGED_MODEL_IDS = new Set<string>([
  "openrouter/free",
]);

const OPENROUTER_PAID_MODELS = [
  "x-ai/grok-4.5",
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
] as const;

const LIVE_SUBSCRIPTION_MODELS: Readonly<Record<string, readonly string[]>> = {
  openrouter: [
    ...OPENROUTER_PAID_MODELS,
    ...OPENROUTER_FREE_MODEL_IDS,
  ],
};

const FREE_SUBSCRIPTION_MODELS: Readonly<Record<string, readonly string[]>> = {
  openrouter: OPENROUTER_FREE_MODEL_IDS,
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

export function subscriptionManagedModelsForTier(
  provider: ProviderSlug | string,
  tier: AuthSubscriptionTier | undefined,
): readonly string[] {
  const normalized = normalizeProviderSlug(provider) ?? provider.trim().toLowerCase();
  if (tier === "free") return FREE_SUBSCRIPTION_MODELS[normalized] ?? [];
  if (tier === "pro" || tier === "team" || tier === "enterprise") {
    return LIVE_SUBSCRIPTION_MODELS[normalized] ?? [];
  }
  return [];
}

export function visibleSubscriptionManagedModelsForTier(
  provider: ProviderSlug | string,
  tier: AuthSubscriptionTier | undefined,
): readonly string[] {
  return subscriptionManagedModelsForTier(provider, tier).filter(
    (model) => !HIDDEN_SUBSCRIPTION_MANAGED_MODEL_IDS.has(model),
  );
}

export function providerHasLiveSubscriptionRoute(
  provider: ProviderSlug | string,
): boolean {
  return subscriptionManagedModels(provider).length > 0;
}

export function hasHostedSubscriptionAccess(
  config: AgenCConfig | undefined,
  env: EnvSnapshot = process.env,
): boolean {
  return (
    config?.auth?.managedKeys?.enabled === true &&
    hasEntitledRemoteAuthSessionSync(env)
  );
}

export function hasHostedManagedAccess(
  config: AgenCConfig | undefined,
  env: EnvSnapshot = process.env,
): boolean {
  return (
    config?.auth?.managedKeys?.enabled === true &&
    hasRemoteAuthSessionSync(env)
  );
}

export function hostedManagedSubscriptionTier(
  env: EnvSnapshot = process.env,
): AuthSubscriptionTier | undefined {
  return remoteAuthSessionSubscriptionTierSync(env);
}

export function subscriptionManagedDefaultModel(
  provider: ProviderSlug | string,
): string | undefined {
  return subscriptionManagedModels(provider)[0];
}

export function subscriptionManagedDefaultModelForTier(
  provider: ProviderSlug | string,
  tier: AuthSubscriptionTier | undefined,
): string | undefined {
  return visibleSubscriptionManagedModelsForTier(provider, tier)[0];
}

export function isSubscriptionManagedModel(
  provider: ProviderSlug | string,
  model: string,
): boolean {
  const normalizedModel = normalizeModelId(model);
  return subscriptionManagedModels(provider).includes(normalizedModel);
}

export function isFreeSubscriptionManagedModel(
  provider: ProviderSlug | string,
  model: string,
): boolean {
  const normalizedModel = normalizeModelId(model);
  const normalized = normalizeProviderSlug(provider) ?? provider.trim().toLowerCase();
  return (FREE_SUBSCRIPTION_MODELS[normalized] ?? []).includes(normalizedModel);
}

export function formatSubscriptionManagedModels(): string {
  return Object.entries(LIVE_SUBSCRIPTION_MODELS)
    .flatMap(([provider, models]) =>
      models.map((model) => `/model ${provider}:${model}`)
    )
    .join(" or ");
}
