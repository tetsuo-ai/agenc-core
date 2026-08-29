import { resolveProviderSlug, type ProviderSlug } from "../config/resolve-provider.js";
import { normalizeProviderIdentity } from "../provider-identity.js";
import type { AgenCConfig } from "../config/schema.js";
import {
  hasEntitledRemoteAuthSessionSync,
  hasRemoteAuthSessionSync,
  remoteAuthSessionSubscriptionTierSync,
  type RemoteAuthSessionReadContext,
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

function subscriptionProviderIdentity(
  provider: ProviderSlug | string,
): string | undefined {
  return (
    resolveProviderSlug(provider) ??
    normalizeProviderIdentity(provider, "subscription model provider")
  );
}

export function subscriptionManagedModels(
  provider: ProviderSlug | string,
): readonly string[] {
  const normalized = subscriptionProviderIdentity(provider);
  if (normalized === undefined) return [];
  return LIVE_SUBSCRIPTION_MODELS[normalized] ?? [];
}

export function subscriptionManagedModelsForTier(
  provider: ProviderSlug | string,
  tier: AuthSubscriptionTier | undefined,
): readonly string[] {
  const normalized = subscriptionProviderIdentity(provider);
  if (normalized === undefined) return [];
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
  context: RemoteAuthSessionReadContext,
): boolean {
  return (
    config?.auth?.managedKeys?.enabled === true &&
    hasEntitledRemoteAuthSessionSync(context)
  );
}

export function hasHostedManagedAccess(
  config: AgenCConfig | undefined,
  context: RemoteAuthSessionReadContext,
): boolean {
  return (
    config?.auth?.managedKeys?.enabled === true &&
    hasRemoteAuthSessionSync(context)
  );
}

export function hostedManagedSubscriptionTier(
  context: RemoteAuthSessionReadContext,
): AuthSubscriptionTier | undefined {
  return remoteAuthSessionSubscriptionTierSync(context);
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

export function resolveSubscriptionManagedModelRequest(params: {
  readonly provider: ProviderSlug | string;
  readonly explicitModel?: string;
  readonly managedAccess: boolean;
  readonly providerApiKey?: string;
  readonly tier: AuthSubscriptionTier | undefined;
}): string | undefined {
  if (params.explicitModel !== undefined) return params.explicitModel;
  if (!params.managedAccess) return undefined;
  if (params.providerApiKey?.trim()) return undefined;
  return subscriptionManagedDefaultModelForTier(params.provider, params.tier);
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
  const normalized = subscriptionProviderIdentity(provider);
  if (normalized === undefined) return false;
  return (FREE_SUBSCRIPTION_MODELS[normalized] ?? []).includes(normalizedModel);
}

export function formatSubscriptionManagedModels(): string {
  return Object.entries(LIVE_SUBSCRIPTION_MODELS)
    .flatMap(([provider, models]) =>
      models.map((model) => `/model ${provider}:${model}`)
    )
    .join(" or ");
}
