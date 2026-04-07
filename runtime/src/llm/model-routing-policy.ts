/**
 * Model routing policy — collapsed stub (Cut 1.2).
 *
 * Replaces the previous 349-LOC cost-weighted / latency-weighted /
 * pressure-based route selection machinery. The planner subsystem
 * that differentiated planner / verifier / child / executor run
 * classes has been deleted; the runtime now always calls the first
 * available provider, and reroutes are handled downstream by the
 * provider-fallback wrapper in chat-executor-fallback.ts.
 *
 * @module
 */

import type { GatewayLLMConfig } from "../gateway/types.js";
import type { LLMProvider } from "./types.js";
import type {
  RuntimeEconomicsPolicy,
  RuntimeRunClass,
} from "./run-budget.js";

export interface ProviderRouteDescriptor {
  readonly index: number;
  readonly providerName: string;
  readonly model?: string;
  readonly routeKey: string;
  readonly provider: LLMProvider;
  readonly reasoning: boolean;
  readonly costWeight: number;
  readonly latencyWeight: number;
  readonly parallelToolCallsConfigured: boolean;
  readonly supportsStructuredOutputWithTools: boolean;
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
  readonly selectedProviderRouteKey: string;
  readonly rerouted: boolean;
  readonly downgraded: boolean;
  readonly reason: string;
}

export type ModelRoutingWorkflowPhase =
  | "compaction"
  | "initial"
  | "planner"
  | "planner_verifier"
  | "planner_synthesis"
  | "tool_followup"
  | "evaluator"
  | "evaluator_retry";

export interface ModelRouteRequirements {
  readonly statefulContinuationRequired?: boolean;
  readonly structuredOutputRequired?: boolean;
  readonly routedToolNames?: readonly string[];
}

export function buildProviderRouteKey(
  providerName: string,
  model?: string,
): string {
  const providerPart = providerName.trim().toLowerCase() || "unknown";
  const modelPart = model?.trim().toLowerCase();
  return modelPart ? `${providerPart}:${modelPart}` : providerPart;
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

export function buildModelRoutingPolicy(params: {
  readonly providers: readonly LLMProvider[];
  readonly economicsPolicy: RuntimeEconomicsPolicy;
  readonly llmConfig?: GatewayLLMConfig;
  readonly providerConfigs?: readonly unknown[];
}): ModelRoutingPolicy {
  const descriptors: ProviderRouteDescriptor[] = params.providers.map(
    (provider, index) => ({
      index,
      providerName: provider.name,
      routeKey: getProviderRouteKey(provider),
      provider,
      reasoning: false,
      costWeight: 1,
      latencyWeight: 1,
      parallelToolCallsConfigured: false,
      supportsStructuredOutputWithTools: true,
    }),
  );
  return {
    providers: descriptors,
    economicsPolicy: params.economicsPolicy,
  };
}

export function resolveParallelToolCallPolicy(_params: {
  readonly policy: ModelRoutingPolicy;
  readonly selectedProviderName?: string;
  readonly selectedProviderRouteKey?: string;
  readonly phase: string;
}): boolean | undefined {
  return undefined;
}

export function resolveModelRoute(params: {
  readonly policy: ModelRoutingPolicy;
  readonly runClass: RuntimeRunClass;
  readonly pressure?: unknown;
  readonly degradedProviderNames?: readonly string[];
  readonly requirements?: ModelRouteRequirements;
  readonly requiredCapabilities?: readonly string[];
}): ModelRouteDecision {
  const providers = params.policy.providers.map((entry) => entry.provider);
  const first = params.policy.providers[0];
  return {
    runClass: params.runClass,
    providers,
    selectedProviderName: first?.providerName ?? "unknown",
    selectedModel: first?.model,
    selectedProviderRouteKey: first?.routeKey ?? "unknown",
    rerouted: false,
    downgraded: false,
    reason: "default",
  };
}

export function estimateDelegationStepSpendUnits(
  _input: Record<string, unknown>,
): number {
  return 0;
}
