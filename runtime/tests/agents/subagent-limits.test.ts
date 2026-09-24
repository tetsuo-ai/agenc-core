import { describe, expect, it } from "vitest";
import {
  describeSubagentLimits,
  limitedReasoningEffort,
  limitedServiceTier,
  userNamedProvider,
} from "../../src/agents/subagent-limits.js";
import type { Session } from "../../src/session/session.js";
import type { ModelInfo } from "../../src/session/turn-context.js";

const model = (levels: readonly string[], tiers: readonly string[] = []): ModelInfo => ({
  slug: "fixture",
  supportedReasoningLevels: levels,
  serviceTiers: tiers.map((id) => ({ id, name: id, description: id })),
}) as unknown as ModelInfo;
const deepseek = model(["low", "high", "max"]);
const gpt = model(["minimal", "low", "medium", "high"], ["priority", "flex"]);
const cerebras = model(["none", "low", "medium", "high"]);

describe("sub-agent effort", () => {
  it("is each model's lowest level other than none when the user set no limit, whatever the model asks", () => {
    expect(limitedReasoningEffort(deepseek, undefined, undefined)).toBe("low");
    expect(limitedReasoningEffort(gpt, undefined, undefined)).toBe("minimal");
    expect(limitedReasoningEffort(cerebras, undefined, undefined)).toBe("low");
    expect(limitedReasoningEffort(gpt, "high", undefined)).toBe("minimal");
  });

  it("is the limit, as the model's nearest level at or below it, and lower only when asked", () => {
    expect(limitedReasoningEffort(deepseek, undefined, "medium")).toBe("low");
    expect(limitedReasoningEffort(deepseek, undefined, "xhigh")).toBe("high");
    expect(limitedReasoningEffort(deepseek, "max", "high")).toBe("high");
    expect(limitedReasoningEffort(gpt, "low", "high")).toBe("low");
    expect(limitedReasoningEffort(gpt, undefined, "max")).toBe("high");
  });

  it("turns thinking off only when asked for and offered", () => {
    expect(limitedReasoningEffort(cerebras, "none", "high")).toBe("none");
    expect(limitedReasoningEffort(deepseek, "none", "high")).toBe("low");
  });

  it("gives no effort to a model without levels", () => {
    expect(limitedReasoningEffort(model([]), "high", "max")).toBeUndefined();
    expect(limitedReasoningEffort(undefined, "high", "max")).toBeUndefined();
  });
});

describe("sub-agent speed", () => {
  it("is standard unless the limit is fast and the model offers the priority tier", () => {
    expect(limitedServiceTier(gpt, undefined, undefined)).toBeUndefined();
    expect(limitedServiceTier(gpt, "priority", "standard")).toBeUndefined();
    expect(limitedServiceTier(gpt, undefined, "fast")).toBe("priority");
    expect(limitedServiceTier(gpt, "priority", "fast")).toBe("priority");
    expect(limitedServiceTier(deepseek, undefined, "fast")).toBeUndefined();
  });

  it("allows flex, which costs less than standard, wherever the model offers it", () => {
    expect(limitedServiceTier(gpt, "flex", undefined)).toBe("flex");
    expect(limitedServiceTier(gpt, "flex", "fast")).toBe("flex");
    expect(limitedServiceTier(deepseek, "flex", "fast")).toBeUndefined();
  });
});

describe("a provider the user named", () => {
  const typed = (...texts: string[]): Session => ({
    state: { unsafePeek: () => ({ history: texts.map((text) => ({ role: "user", content: [{ type: "input_text", text }] })) }) },
  }) as unknown as Session;

  it("is one whose name, display name, common alias or model appears in a user message", () => {
    expect(userNamedProvider(typed("Run the review on DeepSeek please"), "deepseek", "deepseek-v4-pro")).toBe(true);
    expect(userNamedProvider(typed("lanza 3 agentes con gpt"), "openai", "gpt-5.4")).toBe(true);
    expect(userNamedProvider(typed("have Claude check it"), "anthropic", "claude-opus-5-5")).toBe(true);
    expect(userNamedProvider(typed("draft it", "use kimi-k3 for the drafts"), "kimi", "kimi-k3")).toBe(true);
    expect(userNamedProvider(typed("ask xAI Grok"), "grok", "grok-4.7")).toBe(true);
  });

  it("is not one that appears only inside another word, or only in context the runtime adds", () => {
    expect(userNamedProvider(typed("fix the tests"), "deepseek", "deepseek-v4-pro")).toBe(false);
    expect(userNamedProvider(typed("run the gptzero detector"), "openai", "gpt-5.4")).toBe(false);
    expect(userNamedProvider(typed("<environment_context>provider: deepseek</environment_context>"),
      "deepseek", "deepseek-v4-pro")).toBe(false);
    expect(userNamedProvider({} as Session, "deepseek", "deepseek-v4-pro")).toBe(false);
  });
});

describe("the limits in the spawn tool's description", () => {
  it("names the limits the user set and the default for every other provider", () => {
    expect(describeSubagentLimits({})).toBe("Every provider is at its lowest effort and standard speed.");
    expect(describeSubagentLimits({ subagent_limits: { deepseek: { effort: "high" }, openai: { speed: "fast" } } }))
      .toBe("Set by the user: deepseek effort high, speed standard; openai effort lowest, speed fast. Every other provider is at its lowest effort and standard speed.");
  });
});
