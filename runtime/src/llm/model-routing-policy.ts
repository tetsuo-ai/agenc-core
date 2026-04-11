import type { GatewayLLMConfig } from "../gateway/types.js";
import type { LLMProvider } from "./types.js";
import type {
  RuntimeEconomicsPolicy,
  RuntimeRunClass,
} from "./run-budget.js";

interface ProviderRouteDescriptor {
  readonly index: number;
  readonly providerName: string;
  readonly model?: string;
  readonly routeKey: string;
  readonly provider: LLMProvider;
  readonly reasoning: boolean;
  readonly costWeight: number;
  readonly latencyWeight: number;
  readonly parallelToolCallsConfigured?: boolean;
  readonly supportsStructuredOutputWithTools: boolean;
}

export interface ModelRoutingPolicy {
  readonly providers: readonly ProviderRouteDescriptor[];
  readonly economicsPolicy: RuntimeEconomicsPolicy;
}

interface ModelRouteDecision {
  readonly runClass: RuntimeRunClass;
  readonly providers: readonly LLMProvider[];
  readonly selectedProviderName: string;
  readonly selectedModel?: string;
  readonly selectedProviderRouteKey: string;
  readonly rerouted: boolean;
  readonly downgraded: boolean;
  readonly reason: string;
}

interface ModelRouteRequirements {
  readonly statefulContinuationRequired?: boolean;
  readonly structuredOutputRequired?: boolean;
  readonly routedToolNames?: readonly string[];
}

interface ProviderRoutingConfigLike {
  readonly provider?: string;
  readonly model?: string;
  readonly parallelToolCalls?: boolean;
  readonly structuredOutputs?: {
    readonly enabled?: boolean;
  };
  readonly reasoningEffort?: string;
}

function buildProviderRouteKey(
  providerName: string,
  model?: string,
): string {
  const providerPart = providerName.trim().toLowerCase() || "unknown";
  const modelPart = model?.trim().toLowerCase();
  return modelPart ? providerPart + ":" + modelPart : providerPart;
}

export function getProviderRouteKey(
  provider: LLMProvider,
  modelHint?: string,
): string {
  const providerModel =
    modelHint ??
    ((provider as { config?: { model?: string } }).config?.model as
      | string
      | undefined);
  return buildProviderRouteKey(provider.name, providerModel);
}

function asProviderRoutingConfigLike(
  value: unknown,
): ProviderRoutingConfigLike | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as ProviderRoutingConfigLike;
}

function selectProviderConfig(
  providerName: string,
  index: number,
  llmConfig: GatewayLLMConfig | undefined,
  providerConfigs: readonly unknown[] | undefined,
): ProviderRoutingConfigLike | undefined {
  const direct = asProviderRoutingConfigLike(providerConfigs?.[index]);
  if (direct?.provider === providerName) {
    return direct;
  }

  if (providerConfigs && providerConfigs.length > 0) {
    for (const candidate of providerConfigs) {
      const config = asProviderRoutingConfigLike(candidate);
      if (config?.provider === providerName) {
        return config;
      }
    }
  }

  if (index === 0 && llmConfig?.provider === providerName) {
    return llmConfig;
  }

  return undefined;
}

function buildProviderDescriptor(
  provider: LLMProvider,
  index: number,
  llmConfig: GatewayLLMConfig | undefined,
  providerConfigs: readonly unknown[] | undefined,
): ProviderRouteDescriptor {
  const config = selectProviderConfig(
    provider.name,
    index,
    llmConfig,
    providerConfigs,
  );
  const model = config?.model;
  const supportsStructuredOutputWithTools =
    provider.name === "grok" ||
    config?.structuredOutputs?.enabled !== false;

  return {
    index,
    providerName: provider.name,
    model,
    routeKey: buildProviderRouteKey(provider.name, model),
    provider,
    reasoning: Boolean(config?.reasoningEffort),
    costWeight: provider.name === "ollama" ? 0.9 : 1,
    latencyWeight: provider.name === "ollama" ? 1.1 : 1,
    parallelToolCallsConfigured: config?.parallelToolCalls,
    supportsStructuredOutputWithTools,
  };
}

export function buildModelRoutingPolicy(params: {
  readonly providers: readonly LLMProvider[];
  readonly economicsPolicy: RuntimeEconomicsPolicy;
  readonly llmConfig?: GatewayLLMConfig;
  readonly providerConfigs?: readonly unknown[];
}): ModelRoutingPolicy {
  const descriptors = params.providers.map((provider, index) =>
    buildProviderDescriptor(
      provider,
      index,
      params.llmConfig,
      params.providerConfigs,
    ),
  );
  return {
    providers: descriptors,
    economicsPolicy: params.economicsPolicy,
  };
}

function findProviderDescriptor(
  policy: ModelRoutingPolicy,
  params: {
    readonly selectedProviderRouteKey?: string;
    readonly selectedProviderName?: string;
  },
): ProviderRouteDescriptor | undefined {
  return policy.providers.find((descriptor) => {
    if (
      params.selectedProviderRouteKey &&
      descriptor.routeKey === params.selectedProviderRouteKey
    ) {
      return true;
    }
    return (
      params.selectedProviderName !== undefined &&
      descriptor.providerName === params.selectedProviderName
    );
  });
}

export function resolveParallelToolCallPolicy(params: {
  readonly policy: ModelRoutingPolicy;
  readonly selectedProviderName?: string;
  readonly selectedProviderRouteKey?: string;
  readonly phase: string;
}): boolean | undefined {
  const descriptor = findProviderDescriptor(params.policy, {
    selectedProviderName: params.selectedProviderName,
    selectedProviderRouteKey: params.selectedProviderRouteKey,
  });
  if (!descriptor) {
    return undefined;
  }
  return descriptor.parallelToolCallsConfigured;
}

function prioritizeStructuredOutputProviders(
  descriptors: readonly ProviderRouteDescriptor[],
): readonly ProviderRouteDescriptor[] {
  const preferred = descriptors.filter(
    (descriptor) => descriptor.supportsStructuredOutputWithTools,
  );
  if (preferred.length === 0 || preferred.length === descriptors.length) {
    return descriptors;
  }
  const deferred = descriptors.filter(
    (descriptor) => !descriptor.supportsStructuredOutputWithTools,
  );
  return [...preferred, ...deferred];
}

function prioritizeHealthyProviders(
  descriptors: readonly ProviderRouteDescriptor[],
  degradedProviderNames: readonly string[] | undefined,
): readonly ProviderRouteDescriptor[] {
  if (!degradedProviderNames || degradedProviderNames.length === 0) {
    return descriptors;
  }
  const degraded = new Set(
    degradedProviderNames.map((providerName) => providerName.trim()),
  );
  const healthy = descriptors.filter(
    (descriptor) => !degraded.has(descriptor.providerName),
  );
  if (healthy.length === 0 || healthy.length === descriptors.length) {
    return descriptors;
  }
  const cooledDown = descriptors.filter((descriptor) =>
    degraded.has(descriptor.providerName),
  );
  return [...healthy, ...cooledDown];
}

export function resolveModelRoute(params: {
  readonly policy: ModelRoutingPolicy;
  readonly runClass: RuntimeRunClass;
  readonly pressure?: unknown;
  readonly degradedProviderNames?: readonly string[];
  readonly requirements?: ModelRouteRequirements;
  readonly requiredCapabilities?: readonly string[];
}): ModelRouteDecision {
  const baseline = params.policy.providers;
  let ordered = baseline;
  let reason = "default";

  if (params.requirements?.structuredOutputRequired) {
    const prioritized = prioritizeStructuredOutputProviders(ordered);
    if (prioritized[0]?.routeKey !== ordered[0]?.routeKey) {
      ordered = prioritized;
      reason = "structured_output_capability";
    }
  }

  const healthyFirst = prioritizeHealthyProviders(
    ordered,
    params.degradedProviderNames,
  );
  if (healthyFirst[0]?.routeKey !== ordered[0]?.routeKey) {
    ordered = healthyFirst;
    reason = "degraded_provider";
  }

  const selected = ordered[0] ?? baseline[0];
  const rerouted =
    Boolean(selected) &&
    Boolean(baseline[0]) &&
    selected.routeKey !== baseline[0].routeKey;

  return {
    runClass: params.runClass,
    providers: ordered.map((descriptor) => descriptor.provider),
    selectedProviderName: selected?.providerName ?? "unknown",
    selectedModel: selected?.model,
    selectedProviderRouteKey: selected?.routeKey ?? "unknown",
    rerouted,
    downgraded: false,
    reason: rerouted ? reason : "default",
  };
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function estimateDelegationStepSpendUnits(
  input: Record<string, unknown>,
): number {
  const budgetMinutes = Math.max(1, asFiniteNumber(input.budgetMinutes, 5));
  const mutable = input.mutable === true;
  const shellObservationOnly = input.shellObservationOnly === true;
  const verifierCost = Math.max(0, Math.min(1, asFiniteNumber(input.verifierCost, 0)));
  const retryCost = Math.max(0, Math.min(1, asFiniteNumber(input.retryCost, 0)));

  let spendUnits = budgetMinutes * 0.06;
  if (mutable) {
    spendUnits += 0.35;
  }
  if (shellObservationOnly) {
    spendUnits *= 0.5;
  }
  spendUnits += verifierCost * 0.2;
  spendUnits += retryCost * 0.2;

  return Number(Math.max(0.05, spendUnits).toFixed(4));
}
