import type { GatewayLLMConfig } from "../gateway/types.js";
import type { LLMProvider } from "./types.js";
import type {
  RuntimeBudgetPressure,
  RuntimeEconomicsPolicy,
  RuntimeRunClass,
} from "./run-budget.js";

export interface ProviderRouteDescriptor {
  readonly index: number;
  readonly providerName: string;
  readonly model?: string;
  readonly provider: LLMProvider;
  readonly reasoning: boolean;
  readonly costWeight: number;
  readonly latencyWeight: number;
}

export interface ModelRoutingPolicy {
  readonly providers: readonly ProviderRouteDescriptor[];
  readonly economicsPolicy: RuntimeEconomicsPolicy;
}

export interface ModelRouteDecision {
  readonly runClass: RuntimeRunClass;
  readonly providers: readonly LLMProvider[];
  readonly selectedProviderName: string;
  readonly selectedModel?: string;
  readonly rerouted: boolean;
  readonly downgraded: boolean;
  readonly reason: string;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function modelLooksReasoning(model: string | undefined): boolean {
  const normalized = model?.toLowerCase() ?? "";
  return normalized.includes("reasoning") && !normalized.includes("non-reasoning");
}

function estimateCostWeight(provider: string, model?: string): number {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = model?.toLowerCase() ?? "";
  if (normalizedProvider === "ollama") return 0.2;
  if (modelLooksReasoning(model)) return 1.35;
  if (normalizedModel.includes("fast") || normalizedModel.includes("non-reasoning")) {
    return 0.7;
  }
  return 0.9;
}

function estimateLatencyWeight(provider: string, model?: string): number {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModel = model?.toLowerCase() ?? "";
  if (normalizedProvider === "ollama") return 1.2;
  if (modelLooksReasoning(model)) return normalizedModel.includes("fast") ? 1 : 1.15;
  if (normalizedModel.includes("fast")) return 0.8;
  return 0.95;
}

export function buildModelRoutingPolicy(params: {
  readonly providers: readonly LLMProvider[];
  readonly economicsPolicy: RuntimeEconomicsPolicy;
  readonly llmConfig?: GatewayLLMConfig;
}): ModelRoutingPolicy {
  const configs = params.llmConfig
    ? [params.llmConfig, ...(params.llmConfig.fallback ?? [])]
    : [];
  return {
    economicsPolicy: params.economicsPolicy,
    providers: params.providers.map((provider, index) => {
      const config = configs[index];
      const model = config?.model;
      return {
        index,
        providerName: provider.name,
        model,
        provider,
        reasoning: modelLooksReasoning(model),
        costWeight: estimateCostWeight(provider.name, model),
        latencyWeight: estimateLatencyWeight(provider.name, model),
      };
    }),
  };
}

function sortByOriginalOrder(
  providers: readonly ProviderRouteDescriptor[],
): ProviderRouteDescriptor[] {
  return [...providers].sort((left, right) => left.index - right.index);
}

function chooseDefaultCandidate(
  runClass: RuntimeRunClass,
  candidates: readonly ProviderRouteDescriptor[],
  requiredCapabilities?: readonly string[],
): ProviderRouteDescriptor | undefined {
  if (candidates.length === 0) return undefined;
  if (runClass === "child") {
    const highRisk = (requiredCapabilities ?? []).some((capability) =>
      /wallet|solana|desktop|system\.(?:bash|writeFile|delete|execute|applescript)/i.test(
        capability,
      )
    );
    if (highRisk) {
      return sortByOriginalOrder(candidates)[0];
    }
    return [...candidates].sort((left, right) =>
      left.costWeight - right.costWeight ||
      left.latencyWeight - right.latencyWeight ||
      left.index - right.index
    )[0];
  }
  if (runClass === "planner" || runClass === "verifier") {
    return [...candidates].sort((left, right) => {
      if (left.reasoning !== right.reasoning) return left.reasoning ? -1 : 1;
      return left.index - right.index;
    })[0];
  }
  return sortByOriginalOrder(candidates)[0];
}

function chooseDowngradedCandidate(
  candidates: readonly ProviderRouteDescriptor[],
): ProviderRouteDescriptor | undefined {
  return [...candidates].sort((left, right) =>
    left.costWeight - right.costWeight ||
    left.latencyWeight - right.latencyWeight ||
    left.index - right.index
  )[0];
}

export function resolveModelRoute(params: {
  readonly policy: ModelRoutingPolicy;
  readonly runClass: RuntimeRunClass;
  readonly pressure: RuntimeBudgetPressure;
  readonly degradedProviderNames?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
}): ModelRouteDecision {
  const degraded = new Set(
    (params.degradedProviderNames ?? []).map((entry) => entry.toLowerCase()),
  );
  const healthyCandidates = params.policy.providers.filter((candidate) =>
    !degraded.has(candidate.providerName.toLowerCase())
  );
  const routePool = healthyCandidates.length > 0
    ? healthyCandidates
    : params.policy.providers;
  const defaultCandidate = chooseDefaultCandidate(
    params.runClass,
    routePool,
    params.requiredCapabilities,
  );
  const downgradedCandidate = params.pressure.shouldDowngrade
    ? chooseDowngradedCandidate(routePool)
    : undefined;
  const chosen = downgradedCandidate ?? defaultCandidate ?? routePool[0];

  if (!chosen) {
    throw new Error("Model routing policy requires at least one provider");
  }

  const rerouted =
    chosen.index !== 0 || degraded.has(params.policy.providers[0]?.providerName.toLowerCase() ?? "");
  const downgraded = Boolean(
    downgradedCandidate &&
      (downgradedCandidate.index !== defaultCandidate?.index ||
        downgradedCandidate.model !== defaultCandidate?.model),
  );
  const reason = downgraded
    ? "budget_pressure_downgrade"
    : rerouted
    ? "degraded_provider_reroute"
    : "default_route";
  const orderedFallbacks = [
    chosen,
    ...params.policy.providers.filter((candidate) => candidate.index !== chosen.index),
  ];

  return {
    runClass: params.runClass,
    providers: orderedFallbacks.map((candidate) => candidate.provider),
    selectedProviderName: chosen.providerName,
    selectedModel: chosen.model,
    rerouted,
    downgraded,
    reason,
  };
}

export function estimateDelegationStepSpendUnits(input: {
  readonly budgetMinutes: number;
  readonly mutable: boolean;
  readonly shellObservationOnly: boolean;
  readonly verifierCost: number;
  readonly retryCost: number;
}): number {
  const minuteWeight = Math.max(0.2, Math.min(4, input.budgetMinutes / 4));
  const mutationWeight = input.mutable ? 1.1 : input.shellObservationOnly ? 0.7 : 0.5;
  const verifierWeight = 1 + clamp01(input.verifierCost) * 0.4;
  const retryWeight = 1 + clamp01(input.retryCost) * 0.35;
  return Number((minuteWeight * mutationWeight * verifierWeight * retryWeight).toFixed(4));
}
