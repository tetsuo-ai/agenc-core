import { describe, expect, it } from "vitest";
import {
  buildModelRoutingPolicy,
  resolveModelRoute,
} from "./model-routing-policy.js";
import type { LLMProvider } from "./types.js";

const NOOP_ECONOMICS_POLICY = {} as Parameters<
  typeof buildModelRoutingPolicy
>[0]["economicsPolicy"];

function makeProvider(name: string): LLMProvider {
  return {
    name,
    chat: (async () => ({})) as unknown as LLMProvider["chat"],
    chatStream: (async () => ({})) as unknown as LLMProvider["chatStream"],
    healthCheck: (async () => true) as unknown as LLMProvider["healthCheck"],
  };
}

describe("model-routing-policy — xAI structured-output capability", () => {
  it("marks grok-code-fast-1 as NOT supporting structured outputs with tools", () => {
    const policy = buildModelRoutingPolicy({
      providers: [makeProvider("grok")],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        { provider: "grok", model: "grok-code-fast-1" },
      ],
    });
    expect(policy.providers[0]?.supportsStructuredOutputWithTools).toBe(false);
  });

  it("marks grok-4 family models as supporting structured outputs with tools", () => {
    const policy = buildModelRoutingPolicy({
      providers: [makeProvider("grok")],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        { provider: "grok", model: "grok-4-1-fast-non-reasoning" },
      ],
    });
    expect(policy.providers[0]?.supportsStructuredOutputWithTools).toBe(true);
  });

  it("preserves generic non-grok structured-output defaulting (enabled unless explicitly disabled)", () => {
    const generic = makeProvider("generic-provider");
    const policy = buildModelRoutingPolicy({
      providers: [generic],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        { provider: "generic-provider", model: "generic-model-v1" },
      ],
    });
    expect(policy.providers[0]?.supportsStructuredOutputWithTools).toBe(true);

    const policyDisabled = buildModelRoutingPolicy({
      providers: [generic],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        {
          provider: "generic-provider",
          model: "generic-model-v1",
          structuredOutputs: { enabled: false },
        },
      ],
    });
    expect(policyDisabled.providers[0]?.supportsStructuredOutputWithTools).toBe(
      false,
    );
  });
});

describe("model-routing-policy — session-pinned primary, no silent model swap", () => {
  it("keeps the session's primary selected when structured outputs are requested, even with a capable fallback available", () => {
    const codeFast = makeProvider("grok");
    const grok4 = makeProvider("grok");
    const policy = buildModelRoutingPolicy({
      providers: [codeFast, grok4],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        { provider: "grok", model: "grok-code-fast-1" },
        { provider: "grok", model: "grok-4-1-fast-non-reasoning" },
      ],
    });

    const decision = resolveModelRoute({
      policy,
      runClass: "executor",
      requirements: { structuredOutputRequired: true },
    });

    // Primary stays selected. The incompatibility between the session's
    // primary and a structured-output-with-tools request is resolved by
    // the adapter-level fail-closed gate
    // (`assertXaiStructuredOutputToolCompatibility`), not by silently
    // hopping to the fallback mid-session.
    expect(decision.selectedModel).toBe("grok-code-fast-1");
    expect(decision.rerouted).toBe(false);
    expect(decision.reason).toBe("default");
    expect(decision.selectedProviderRouteKey).toBe("grok:grok-code-fast-1");
  });

  it("keeps the primary selected when structured outputs are NOT required", () => {
    const codeFast = makeProvider("grok");
    const grok4 = makeProvider("grok");
    const policy = buildModelRoutingPolicy({
      providers: [codeFast, grok4],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        { provider: "grok", model: "grok-code-fast-1" },
        { provider: "grok", model: "grok-4-1-fast-non-reasoning" },
      ],
    });

    const decision = resolveModelRoute({
      policy,
      runClass: "executor",
      requirements: { structuredOutputRequired: false },
    });

    expect(decision.selectedModel).toBe("grok-code-fast-1");
    expect(decision.rerouted).toBe(false);
  });

  it("returns the same session-pinned model across repeated calls regardless of run class or requirements", () => {
    const codeFast = makeProvider("grok");
    const grok4 = makeProvider("grok");
    const policy = buildModelRoutingPolicy({
      providers: [codeFast, grok4],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        { provider: "grok", model: "grok-code-fast-1" },
        { provider: "grok", model: "grok-4-1-fast-non-reasoning" },
      ],
    });

    const selections = new Set(
      [
        resolveModelRoute({ policy, runClass: "executor" }),
        resolveModelRoute({
          policy,
          runClass: "executor",
          requirements: { structuredOutputRequired: true },
        }),
        resolveModelRoute({
          policy,
          runClass: "executor",
          requirements: { statefulContinuationRequired: true },
        }),
        resolveModelRoute({ policy, runClass: "planner" }),
        resolveModelRoute({ policy, runClass: "verifier" }),
      ].map((decision) => decision.selectedProviderRouteKey),
    );
    // One model variant per session — all calls resolve to the same
    // primary route key.
    expect([...selections]).toEqual(["grok:grok-code-fast-1"]);
  });

  it("falls back to a healthy secondary only when the primary is explicitly degraded", () => {
    const primary = makeProvider("grok");
    const secondary = makeProvider("grok-secondary");
    const policy = buildModelRoutingPolicy({
      providers: [primary, secondary],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        { provider: "grok", model: "grok-code-fast-1" },
        { provider: "grok-secondary", model: "grok-4-1-fast-non-reasoning" },
      ],
    });

    const stable = resolveModelRoute({
      policy,
      runClass: "executor",
    });
    expect(stable.selectedProviderRouteKey).toBe("grok:grok-code-fast-1");

    const degraded = resolveModelRoute({
      policy,
      runClass: "executor",
      degradedProviderNames: ["grok"],
    });
    expect(degraded.selectedProviderName).toBe("grok-secondary");
    expect(degraded.rerouted).toBe(true);
    expect(degraded.reason).toBe("degraded_provider");
  });
});
