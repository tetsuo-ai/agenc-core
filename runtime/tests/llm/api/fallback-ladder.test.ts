import { describe, expect, test } from "vitest";
import { FallbackTriggeredError } from "../../recovery/api-errors.js";
import {
  evaluateProviderFallback,
  normalizeFallbackRetryBudget,
  normalizeFallbackTargets,
} from "./fallback-ladder.js";

describe("provider fallback ladder", () => {
  test("normalizes targets, skips the active model, and deduplicates", () => {
    expect(
      normalizeFallbackTargets("grok", "grok-4-fast", [
        { model: " " },
        { model: "grok-4-fast" },
        { model: " grok-4 ", reason: " high demand " },
        { provider: " openai ", model: " gpt-5 " },
        { provider: "openai", model: "gpt-5" },
      ]),
    ).toEqual([
      { provider: "grok", model: "grok-4", reason: "high demand" },
      { provider: "openai", model: "gpt-5" },
    ]);
  });

  test("normalizes provider aliases and case before dedupe and active-target skip", () => {
    expect(
      normalizeFallbackTargets(" XAI ", "grok-4-fast", [
        { provider: "grok", model: "grok-4-fast" },
        { provider: " OpenAI ", model: "gpt-5" }, // branding-scan: allow real provider alias input
        { provider: "openai", model: "gpt-5" },
      ]),
    ).toEqual([{ provider: "openai", model: "gpt-5" }]);
  });

  test("normalizes configured fallback retry budgets", () => {
    expect(normalizeFallbackRetryBudget(undefined)).toBe(2);
    expect(normalizeFallbackRetryBudget(Number.NaN)).toBe(2);
    expect(normalizeFallbackRetryBudget(Number.POSITIVE_INFINITY)).toBe(2);
    expect(normalizeFallbackRetryBudget(3.9)).toBe(3);
    expect(normalizeFallbackRetryBudget(0)).toBe(0);
    expect(normalizeFallbackRetryBudget(-4)).toBe(0);
  });

  test("waits for the configured consecutive overload threshold before triggering", () => {
    const base = {
      provider: "grok",
      model: "grok-4-fast",
      targets: [{ model: "grok-4" }],
      error: { status: 529, message: "overloaded" },
    };

    const first = evaluateProviderFallback({
      ...base,
      consecutiveFailures: 0,
    });
    expect(first).toEqual({
      kind: "wait",
      consecutiveFailures: 1,
      failuresRemaining: 2,
    });

    const second = evaluateProviderFallback({
      ...base,
      consecutiveFailures: 1,
    });
    expect(second).toMatchObject({
      kind: "wait",
      consecutiveFailures: 2,
      failuresRemaining: 1,
    });

    const third = evaluateProviderFallback({
      ...base,
      consecutiveFailures: 2,
    });
    expect(third.kind).toBe("trigger");
    if (third.kind === "trigger") {
      expect(third.error).toBeInstanceOf(FallbackTriggeredError);
      expect(third.error).toMatchObject({
        fromModel: "grok-4-fast",
        toModel: "grok-4",
        fromProvider: "grok",
        toProvider: "grok",
        reason: "provider_fallback_ladder",
      });
    }
  });

  test("supports cross-provider fallback targets and custom statuses", () => {
    const decision = evaluateProviderFallback({
      provider: "openai",
      model: "gpt-5",
      targets: [{ provider: "grok", model: "grok-4-fast", reason: "burst" }],
      statuses: [429],
      maxFailures: 1,
      error: { status: 429, message: "rate limited" },
      consecutiveFailures: 0,
    });

    expect(decision.kind).toBe("trigger");
    if (decision.kind === "trigger") {
      expect(decision.target).toEqual({
        provider: "grok",
        model: "grok-4-fast",
        reason: "burst",
      });
      expect(decision.error).toMatchObject({
        fromProvider: "openai",
        toProvider: "grok",
        fromModel: "gpt-5",
        toModel: "grok-4-fast",
        reason: "burst",
      });
    }
  });

  test("treats configured statuses as additive to built-in overload signals", () => {
    const decision = evaluateProviderFallback({
      provider: "openai",
      model: "gpt-5",
      targets: [{ provider: "grok", model: "grok-4-fast" }],
      statuses: [429],
      maxFailures: 1,
      error: { status: 529, message: "overloaded" },
      consecutiveFailures: 0,
    });

    expect(decision.kind).toBe("trigger");
  });

  test("detects structured overloaded_error bodies without a 529 status", () => {
    const decision = evaluateProviderFallback({
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      targets: [{ provider: "grok", model: "grok-4-fast" }],
      maxFailures: 1,
      error: {
        status: 500,
        message: "busy",
        body: { error: { type: "overloaded_error", message: "busy" } },
      },
      consecutiveFailures: 0,
    });

    expect(decision.kind).toBe("trigger");
  });

  test("resets the consecutive counter on non-applicable errors", () => {
    expect(
      evaluateProviderFallback({
        provider: "grok",
        model: "grok-4-fast",
        targets: [{ model: "grok-4" }],
        error: { status: 500, message: "temporary" },
        consecutiveFailures: 2,
      }),
    ).toEqual({ kind: "not_applicable", consecutiveFailures: 0 });
  });
});
