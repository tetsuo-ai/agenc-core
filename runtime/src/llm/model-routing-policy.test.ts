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

  it("reorders a capable grok-4 model ahead of grok-code-fast-1 when structured outputs are required", () => {
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

    expect(decision.selectedModel).toBe("grok-4-1-fast-non-reasoning");
    expect(decision.rerouted).toBe(true);
    expect(decision.reason).toBe("structured_output_capability");
  });

  it("leaves grok-code-fast-1 selected when no capable grok-4 is configured, even if structured outputs are required", () => {
    const codeFast = makeProvider("grok");
    const policy = buildModelRoutingPolicy({
      providers: [codeFast],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        { provider: "grok", model: "grok-code-fast-1" },
      ],
    });

    const decision = resolveModelRoute({
      policy,
      runClass: "executor",
      requirements: { structuredOutputRequired: true },
    });

    expect(decision.selectedModel).toBe("grok-code-fast-1");
    expect(decision.rerouted).toBe(false);
  });

  it("does not reorder when structured outputs are NOT required, even with mixed grok models", () => {
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

  it("preserves non-grok structured-output defaulting (enabled unless explicitly disabled)", () => {
    const anthropic = makeProvider("anthropic");
    const policy = buildModelRoutingPolicy({
      providers: [anthropic],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        { provider: "anthropic", model: "claude-sonnet" },
      ],
    });
    expect(policy.providers[0]?.supportsStructuredOutputWithTools).toBe(true);

    const policyDisabled = buildModelRoutingPolicy({
      providers: [anthropic],
      economicsPolicy: NOOP_ECONOMICS_POLICY,
      providerConfigs: [
        {
          provider: "anthropic",
          model: "claude-sonnet",
          structuredOutputs: { enabled: false },
        },
      ],
    });
    expect(policyDisabled.providers[0]?.supportsStructuredOutputWithTools).toBe(
      false,
    );
  });
});
