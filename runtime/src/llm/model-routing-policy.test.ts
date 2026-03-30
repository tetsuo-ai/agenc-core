import { describe, expect, it, vi } from "vitest";

import {
  buildProviderRouteKey,
  buildModelRoutingPolicy,
  resolveModelRoute,
  resolveParallelToolCallPolicy,
} from "./model-routing-policy.js";
import { buildRuntimeEconomicsPolicy } from "./run-budget.js";
import type { LLMProvider } from "./types.js";

function createMockProvider(
  name: "grok" | "ollama",
  statefulPreviousResponseId: boolean,
  model?: string,
): LLMProvider {
  return {
    name,
    ...(model ? { config: { model } } : {}),
    chat: vi.fn(),
    chatStream: vi.fn(),
    healthCheck: vi.fn(),
    getCapabilities: () => ({
      provider: name,
      stateful: {
        assistantPhase: false,
        previousResponseId: statefulPreviousResponseId,
        encryptedReasoning: name === "grok",
        storedResponseRetrieval: name === "grok",
        storedResponseDeletion: name === "grok",
        opaqueCompaction: false,
        deterministicFallback: true,
      },
    }),
  };
}

const pressure = {
  tokenRatio: 0,
  latencyRatio: 0,
  spendRatio: 0,
  hardExceeded: false,
  shouldDowngrade: false,
} as const;

describe("model-routing-policy", () => {
  it("reroutes away from Grok multi-agent models when client-side tools are required", () => {
    const policy = buildModelRoutingPolicy({
      providers: [
        createMockProvider("grok", true),
        createMockProvider("ollama", false),
      ],
      economicsPolicy: buildRuntimeEconomicsPolicy({ mode: "enforce" }),
      llmConfig: {
        provider: "grok",
        model: "grok-4.20-multi-agent-beta-0309",
        fallback: [
          {
            provider: "ollama",
            model: "llama3",
          },
        ],
      },
    });

    const route = resolveModelRoute({
      policy,
      runClass: "executor",
      pressure,
      requirements: {
        routedToolNames: ["system.bash"],
      },
    });

    expect(route.selectedProviderName).toBe("ollama");
  });

  it("fails closed when no provider can honor required stateful continuation", () => {
    const policy = buildModelRoutingPolicy({
      providers: [createMockProvider("ollama", false)],
      economicsPolicy: buildRuntimeEconomicsPolicy({ mode: "enforce" }),
      llmConfig: {
        provider: "ollama",
        model: "llama3",
      },
    });

    expect(() =>
      resolveModelRoute({
        policy,
        runClass: "executor",
        pressure,
        requirements: {
          statefulContinuationRequired: true,
        },
      })
    ).toThrow(/stateful continuation/i);
  });

  it("uses provider configs for auto-added grok fallback capability routing", () => {
    const policy = buildModelRoutingPolicy({
      providers: [
        createMockProvider("grok", true, "grok-code-fast-1"),
        createMockProvider("grok", true, "grok-4-1-fast-non-reasoning"),
      ],
      economicsPolicy: buildRuntimeEconomicsPolicy({ mode: "enforce" }),
      llmConfig: {
        provider: "grok",
        model: "grok-code-fast-1",
      },
      providerConfigs: [
        {
          provider: "grok",
          model: "grok-code-fast-1",
        },
        {
          provider: "grok",
          model: "grok-4-1-fast-non-reasoning",
        },
      ],
    });

    const route = resolveModelRoute({
      policy,
      runClass: "planner",
      pressure,
      requirements: {
        structuredOutputRequired: true,
        routedToolNames: ["system.bash"],
      },
    });

    expect(route.selectedProviderName).toBe("grok");
    expect(route.selectedModel).toBe("grok-4-1-fast-non-reasoning");
    expect(route.selectedProviderRouteKey).toBe(
      buildProviderRouteKey("grok", "grok-4-1-fast-non-reasoning"),
    );
  });

  it("degrades only the failing model route when duplicate provider families exist", () => {
    const policy = buildModelRoutingPolicy({
      providers: [
        createMockProvider("grok", true, "grok-code-fast-1"),
        createMockProvider("grok", true, "grok-4-1-fast-non-reasoning"),
      ],
      economicsPolicy: buildRuntimeEconomicsPolicy({ mode: "enforce" }),
      llmConfig: {
        provider: "grok",
        model: "grok-code-fast-1",
      },
      providerConfigs: [
        {
          provider: "grok",
          model: "grok-code-fast-1",
        },
        {
          provider: "grok",
          model: "grok-4-1-fast-non-reasoning",
        },
      ],
    });

    const route = resolveModelRoute({
      policy,
      runClass: "executor",
      pressure,
      degradedProviderNames: [
        buildProviderRouteKey("grok", "grok-4-1-fast-non-reasoning"),
      ],
      requirements: {
        routedToolNames: ["system.bash"],
      },
    });

    expect(route.selectedModel).toBe("grok-code-fast-1");
  });

  it("makes parallel tool-call policy explicit per workflow phase", () => {
    const policy = buildModelRoutingPolicy({
      providers: [createMockProvider("grok", true)],
      economicsPolicy: buildRuntimeEconomicsPolicy({ mode: "enforce" }),
      llmConfig: {
        provider: "grok",
        model: "grok-4-1-fast-reasoning",
        parallelToolCalls: true,
      },
    });

    expect(
      resolveParallelToolCallPolicy({
        policy,
        selectedProviderName: "grok",
        selectedProviderRouteKey: buildProviderRouteKey(
          "grok",
          "grok-4-1-fast-reasoning",
        ),
        phase: "initial",
      }),
    ).toBe(true);
    expect(
      resolveParallelToolCallPolicy({
        policy,
        selectedProviderName: "grok",
        selectedProviderRouteKey: buildProviderRouteKey(
          "grok",
          "grok-4-1-fast-reasoning",
        ),
        phase: "planner",
      }),
    ).toBe(false);
    expect(
      resolveParallelToolCallPolicy({
        policy,
        selectedProviderName: "grok",
        selectedProviderRouteKey: buildProviderRouteKey(
          "grok",
          "grok-4-1-fast-reasoning",
        ),
        phase: "tool_followup",
      }),
    ).toBe(true);
  });
});
