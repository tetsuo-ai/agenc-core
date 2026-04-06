import { describe, expect, it } from "vitest";

import {
  buildModelRoutingPolicy,
  resolveModelRoute,
} from "./model-routing-policy.js";
import { buildRuntimeEconomicsPolicy } from "./run-budget.js";
import type { LLMProvider } from "./types.js";
import type { GatewayLLMConfig } from "../gateway/types.js";

function createProvider(name: string): LLMProvider {
  return {
    name,
    async chat() {
      throw new Error("not used");
    },
    async chatStream() {
      throw new Error("not used");
    },
    async healthCheck() {
      return true;
    },
  };
}

function buildPressure() {
  return {
    tokenRatio: 0,
    latencyRatio: 0,
    spendRatio: 0,
    hardExceeded: false,
    shouldDowngrade: false,
  } as const;
}

describe("resolveModelRoute", () => {
  it("reroutes structured-output-plus-tools planner phases off incompatible xAI models", () => {
    const primary: GatewayLLMConfig = {
      provider: "grok",
      apiKey: "test-key",
      model: "grok-code-fast-1",
    };
    const fallback: GatewayLLMConfig = {
      provider: "grok",
      apiKey: "test-key",
      model: "grok-4-1-fast-non-reasoning",
    };
    const policy = buildModelRoutingPolicy({
      providers: [createProvider("grok"), createProvider("grok")],
      economicsPolicy: buildRuntimeEconomicsPolicy({}),
      llmConfig: {
        ...primary,
        fallback: [fallback],
      },
      providerConfigs: [primary, fallback],
    });

    const decision = resolveModelRoute({
      policy,
      runClass: "planner",
      pressure: buildPressure(),
      requirements: {
        structuredOutputRequired: true,
        routedToolNames: ["system.readFile"],
      },
    });

    expect(decision.selectedModel).toBe("grok-4-1-fast-non-reasoning");
    expect(decision.reason).toBe("capability_reroute");
    expect(decision.rerouted).toBe(true);
  });

  it("keeps the user-selected model when the phase does not need structured outputs with tools", () => {
    const primary: GatewayLLMConfig = {
      provider: "grok",
      apiKey: "test-key",
      model: "grok-code-fast-1",
    };
    const fallback: GatewayLLMConfig = {
      provider: "grok",
      apiKey: "test-key",
      model: "grok-4-1-fast-non-reasoning",
    };
    const policy = buildModelRoutingPolicy({
      providers: [createProvider("grok"), createProvider("grok")],
      economicsPolicy: buildRuntimeEconomicsPolicy({}),
      llmConfig: {
        ...primary,
        fallback: [fallback],
      },
      providerConfigs: [primary, fallback],
    });

    const decision = resolveModelRoute({
      policy,
      runClass: "executor",
      pressure: buildPressure(),
      requirements: {
        structuredOutputRequired: false,
        routedToolNames: ["system.readFile"],
      },
    });

    expect(decision.selectedModel).toBe("grok-code-fast-1");
    expect(decision.reason).toBe("default_route");
  });
});
