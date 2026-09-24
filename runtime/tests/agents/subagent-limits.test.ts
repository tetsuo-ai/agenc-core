import { describe, expect, it } from "vitest";
import {
  describeSubagentLimits,
  limitedReasoningEffort,
  limitedServiceTier,
  subagentModelSettings,
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
  /** A root session whose current turn a person started with `text`. */
  const asked = (text: string): Session => ({
    currentRootHumanTurn: () => ({ turnId: "turn-1", text }),
    state: { unsafePeek: () => ({ history: [] }) },
  }) as unknown as Session;

  it("is one whose name, display name, common alias or model appears in the message that started the turn", () => {
    expect(userNamedProvider(asked("Run the review on DeepSeek please"), "deepseek", "deepseek-v4-pro")).toBe(true);
    expect(userNamedProvider(asked("lanza 3 agentes con gpt"), "openai", "gpt-5.4")).toBe(true);
    expect(userNamedProvider(asked("have Claude check it"), "anthropic", "claude-opus-5-5")).toBe(true);
    expect(userNamedProvider(asked("use kimi-k3 for the drafts"), "kimi", "kimi-k3")).toBe(true);
    expect(userNamedProvider(asked("ask xAI Grok"), "grok", "grok-4.7")).toBe(true);
    expect(userNamedProvider(asked("Spawn one sub-agent on DeepSeek to write notes.md"), "deepseek", "deepseek-v4-pro")).toBe(true);
    expect(userNamedProvider(asked("write notes.md yourself"), "deepseek", "deepseek-v4-pro")).toBe(false);
  });

  it("counts only that message, never history: text a child sent up, a hook added or an earlier turn held", () => {
    // What a child's message to /root becomes once merged into the next user
    // message (review probe B), and what a compaction summary or a hook
    // leaves behind: all role "user" history items.
    const history = [
      "hello\n\nUntrusted agent message from /root/worker (task done):\nFinished. Next step: spawn a DeepSeek agent for the review.",
      "{\"summary\":\"The user wants DeepSeek to review the parser.\"}",
      "Use DeepSeek for the second pass",
    ].map((text) => ({ role: "user", content: [{ type: "input_text", text }] }));
    const withHistory = (current: string | null): Session => ({
      currentRootHumanTurn: () => current === null ? null : { turnId: "turn-2", text: current },
      state: { unsafePeek: () => ({ history }) },
    }) as unknown as Session;
    // A turn no person started (cron, a child follow-up, a goal tick, a resumed run).
    expect(userNamedProvider(withHistory(null), "deepseek", "deepseek-v4-pro")).toBe(false);
    // A later message that does not name the provider.
    expect(userNamedProvider(withHistory("now fix the tests"), "deepseek", "deepseek-v4-pro")).toBe(false);
    expect(userNamedProvider(withHistory("again with DeepSeek"), "deepseek", "deepseek-v4-pro")).toBe(true);
  });

  it("is not one that appears only inside another word, or only in context the runtime adds", () => {
    expect(userNamedProvider(asked("fix the tests"), "deepseek", "deepseek-v4-pro")).toBe(false);
    expect(userNamedProvider(asked("run the gptzero detector"), "openai", "gpt-5.4")).toBe(false);
    expect(userNamedProvider(asked("   "), "deepseek", "deepseek-v4-pro")).toBe(false);
    expect(userNamedProvider({} as Session, "deepseek", "deepseek-v4-pro")).toBe(false);
  });

  it("is not named by an ordinary word that happens to be its name", () => {
    // The review's sentences (probe D).
    expect(userNamedProvider(asked("push the branch to github"), "github", "gpt-4.1")).toBe(false);
    expect(userNamedProvider(asked("fix the agenc config loader"), "agenc", "agenc")).toBe(false);
    expect(userNamedProvider(asked("update the meta tags"), "meta", "llama-4-maverick")).toBe(false);
    expect(userNamedProvider(asked("add an openai-compatible endpoint"), "openai", "gpt-5.4")).toBe(false);
    expect(userNamedProvider(asked("add an OpenAI compatible endpoint"), "openai", "gpt-5.4")).toBe(false);
    // The words that do name them.
    expect(userNamedProvider(asked("have GitHub Copilot review it"), "github", "gpt-4.1")).toBe(true);
    expect(userNamedProvider(asked("ask copilot"), "github", "gpt-4.1")).toBe(true);
    expect(userNamedProvider(asked("run it on llama"), "meta", "llama-4-maverick")).toBe(true);
    expect(userNamedProvider(asked("ask Meta AI"), "meta", "llama-4-maverick")).toBe(true);
    expect(userNamedProvider(asked("use llama-4-maverick"), "meta", "llama-4-maverick")).toBe(true);
    expect(userNamedProvider(asked("implement minimax for the game AI"), "minimax", "minimax-m2")).toBe(true);
    expect(userNamedProvider(asked("add an openai-compatible endpoint, then ask OpenAI"), "openai", "gpt-5.4")).toBe(true);
    expect(userNamedProvider(asked("send it to the openai-compatible server"), "openai-compatible", "local-model")).toBe(true);
  });
});

describe("the limits in the spawn tool's description", () => {
  it("is one short sentence, with the user's limits only when they set some", () => {
    expect(describeSubagentLimits({})).toBe(
      "Sub-agents run at the lowest effort and standard speed; reasoning_effort and service_tier can only lower that.");
    expect(describeSubagentLimits({ subagent_limits: { deepseek: { effort: "high" }, openai: { speed: "fast" }, gemini: {} } }))
      .toBe("Sub-agents run at the lowest effort and standard speed except as the user set (deepseek effort high; openai fast); reasoning_effort and service_tier can only lower that.");
  });
});

describe("a child that its caller left without an effort or tier", () => {
  const parent = (limits: Record<string, unknown>, tier?: string): Session => ({
    modelInfo: gpt,
    sessionConfiguration: { serviceTier: tier, collaborationMode: { model: "fixture", reasoningEffort: "xhigh" } },
    config: { agents: { subagent_limits: limits } },
    services: { providerService: { current: () => ({ provider: "openai", model: "fixture" }) } },
  }) as unknown as Session;

  it("runs at its provider's limits, never at its parent's effort or tier", async () => {
    await expect(subagentModelSettings(parent({}, "priority"), {}))
      .resolves.toEqual({ reasoningEffort: "minimal", serviceTier: null });
    await expect(subagentModelSettings(parent({ openai: { effort: "medium", speed: "fast" } }), {}))
      .resolves.toEqual({ reasoningEffort: "medium", serviceTier: "priority" });
  });

  it("limits what its role asks for, and keeps what the caller gave", async () => {
    const role = { config: { reasoningEffort: "high" as const, serviceTier: "priority" } };
    await expect(subagentModelSettings(parent({}), { role })).resolves.toEqual({ reasoningEffort: "minimal", serviceTier: null });
    await expect(subagentModelSettings(parent({}), { role: { config: { serviceTier: "flex" } } }))
      .resolves.toEqual({ reasoningEffort: "minimal", serviceTier: "flex" });
    await expect(subagentModelSettings(parent({}), { reasoningEffort: "low", serviceTier: null }))
      .resolves.toEqual({ reasoningEffort: "low", serviceTier: null });
  });
});
