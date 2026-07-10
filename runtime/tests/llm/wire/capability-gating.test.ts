import { describe, expect, test } from "vitest";

import { chatCompletionsCapabilityHintsForProvider } from "./capability-gating.js";
import { buildChatCompletionsRequest } from "./chat-completions.js";

describe("chatCompletionsCapabilityHintsForProvider", () => {
  describe("acceptsReasoningEffort", () => {
    test("openai reasoning-family models accept reasoning_effort", () => {
      // branding-scan: allow real model identifiers used as test fixtures
      expect(
        chatCompletionsCapabilityHintsForProvider("openai", "gpt-5")
          .acceptsReasoningEffort,
      ).toBe(true);
      expect(
        chatCompletionsCapabilityHintsForProvider("openai", "o3")
          .acceptsReasoningEffort,
      ).toBe(true);
      expect(
        chatCompletionsCapabilityHintsForProvider("openai", "o4-mini")
          .acceptsReasoningEffort,
      ).toBe(true);
    });

    test("openai non-reasoning models do not accept reasoning_effort", () => {
      // branding-scan: allow real model identifiers used as test fixtures
      expect(
        chatCompletionsCapabilityHintsForProvider("openai", "gpt-4o")
          .acceptsReasoningEffort,
      ).toBe(false);
      expect(
        chatCompletionsCapabilityHintsForProvider("openai", "gpt-4-turbo")
          .acceptsReasoningEffort,
      ).toBe(false);
    });

    test("documented grok reasoning models accept reasoning_effort", () => {
      // branding-scan: allow real model identifiers used as test fixtures
      expect(
        chatCompletionsCapabilityHintsForProvider("grok", "grok-4.3")
          .acceptsReasoningEffort,
      ).toBe(true);
      expect(
        chatCompletionsCapabilityHintsForProvider("grok", "grok-4.5")
          .acceptsReasoningEffort,
      ).toBe(true);
      expect(
        chatCompletionsCapabilityHintsForProvider(
          "grok",
          "grok-4.20-multi-agent",
        ).acceptsReasoningEffort,
      ).toBe(true);
    });

    test.each(["low", "medium", "high"] as const)(
      "grok-4.5 chat completions serializes reasoning_effort=%s",
      (reasoningEffort) => {
        const request = buildChatCompletionsRequest({
          model: "grok-4.5",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
          options: { reasoningEffort },
          providerCapabilityHints:
            chatCompletionsCapabilityHintsForProvider("grok", "grok-4.5"),
        });

        expect(request.reasoning_effort).toBe(reasoningEffort);
      },
    );

    test("undocumented grok models do not accept reasoning_effort", () => {
      // branding-scan: allow real model identifiers used as test fixtures
      expect(
        chatCompletionsCapabilityHintsForProvider("grok", "grok-4")
          .acceptsReasoningEffort,
      ).toBe(false);
      expect(
        chatCompletionsCapabilityHintsForProvider("grok", "grok-code-fast-1")
          .acceptsReasoningEffort,
      ).toBe(false);
    });

    test("xai slug normalizes to grok", () => {
      // branding-scan: allow real model identifiers used as test fixtures
      expect(
        chatCompletionsCapabilityHintsForProvider(
          "xai",
          "grok-4.20-multi-agent",
        ).acceptsReasoningEffort,
      ).toBe(true);
    });

    test("non-openai non-grok providers never accept reasoning_effort", () => {
      // branding-scan: allow real model identifiers used as test fixtures
      const providers = [
        "lmstudio",
        "ollama",
        "openrouter",
        "deepseek",
        "groq",
        "mistral",
        "nvidia-nim",
        "github",
        "minimax",
      ];
      for (const provider of providers) {
        expect(
          chatCompletionsCapabilityHintsForProvider(provider, "any-model")
            .acceptsReasoningEffort,
        ).toBe(false);
      }
    });
  });

  describe("acceptsServiceTier", () => {
    test("only real openai accepts service_tier", () => {
      expect(
        chatCompletionsCapabilityHintsForProvider("openai", "gpt-4o")
          .acceptsServiceTier,
      ).toBe(true);
      expect(
        chatCompletionsCapabilityHintsForProvider("azure-openai", "gpt-4o")
          .acceptsServiceTier,
      ).toBe(true);
    });

    test("every other provider strips service_tier", () => {
      const providers = [
        "lmstudio",
        "ollama",
        "openrouter",
        "deepseek",
        "groq",
        "mistral",
        "grok",
        "xai",
        "anthropic",
        "gemini",
      ];
      for (const provider of providers) {
        expect(
          chatCompletionsCapabilityHintsForProvider(provider, "any-model")
            .acceptsServiceTier,
        ).toBe(false);
      }
    });
  });

  describe("acceptsStreamUsage", () => {
    test("openai-compat providers default to including stream_options", () => {
      const providers = [
        "openai",
        "lmstudio",
        "openrouter",
        "deepseek",
        "groq",
        "mistral",
        "grok",
        "github",
      ];
      for (const provider of providers) {
        expect(
          chatCompletionsCapabilityHintsForProvider(provider, "any-model")
            .acceptsStreamUsage,
        ).toBe(true);
      }
    });

    test("default permissive: even providers that historically misbehaved accept stream_options today", () => {
      // The incompatibility set is intentionally empty. Losing
      // usage tracking on every streamed response is a meaningful
      // regression, so the default leans permissive. Operators
      // observing breakage on a specific install should override
      // via `providerCapabilityHints.acceptsStreamUsage = false` on
      // their adapter rather than blanket-disabling.
      expect(
        chatCompletionsCapabilityHintsForProvider("ollama", "qwen3:8b")
          .acceptsStreamUsage,
      ).toBe(true);
      expect(
        chatCompletionsCapabilityHintsForProvider("gemini", "gemini-2.5-pro")
          .acceptsStreamUsage,
      ).toBe(true);
    });
  });

  test("undefined provider name resolves to safe defaults", () => {
    const hints = chatCompletionsCapabilityHintsForProvider(undefined, "x");
    expect(hints.acceptsReasoningEffort).toBe(false);
    expect(hints.acceptsServiceTier).toBe(false);
    // Permissive default for unknown providers — most openai-compat
    // servers accept stream_options. Only known-incompatible ones
    // strip.
    expect(hints.acceptsStreamUsage).toBe(true);
  });
});
