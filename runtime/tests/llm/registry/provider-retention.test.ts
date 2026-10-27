import { describe, expect, it } from "vitest";

import { builtInProviderIds } from "./provider-info.js";
import {
  PROVIDER_RETENTION,
  PROVIDER_RETENTION_CHECKED_ON,
} from "./provider-retention.js";

/**
 * The classification read from each provider's documentation on 2026-10-22.
 * A change here is a change of what the status line tells people about their
 * data, so it must be deliberate and cite the provider's page.
 */
const EXPECTED_CLASSES = {
  grok: "account-level",
  openai: "account-level",
  anthropic: "account-level",
  ollama: "local",
  lmstudio: "local",
  "openai-compatible": "local",
  openrouter: "request-zdr",
  venice: "per-model",
  abliteration: "no-retention",
  groq: "account-level",
  deepseek: "retains",
  meta: "account-level",
  qwen: "account-level",
  "qwen-token-plan": "retains",
  "ollama-cloud": "no-retention",
  cerebras: "no-retention",
  zai: "retains",
  "zai-coding-plan": "retains",
  gemini: "retains",
  kimi: "account-level",
  mistral: "account-level",
  "nvidia-nim": "retains",
  minimax: "retains",
  github: "account-level",
  "amazon-bedrock": "account-level",
} as const;

describe("provider retention classification", () => {
  it("classifies every built-in provider and nothing else", () => {
    expect(Object.keys(PROVIDER_RETENTION).sort()).toEqual([...builtInProviderIds()].sort());
    expect(Object.fromEntries(
      Object.entries(PROVIDER_RETENTION).map(([provider, facts]) => [provider, facts.retention]),
    )).toEqual(EXPECTED_CLASSES);
  });

  it("only OpenRouter has a request-level zero data retention control", () => {
    const requestLevel = Object.entries(PROVIDER_RETENTION)
      .filter(([, facts]) => facts.retention === "request-zdr")
      .map(([provider]) => provider);
    expect(requestLevel).toEqual(["openrouter"]);
    expect(PROVIDER_RETENTION.openrouter.requestPrivacy).toEqual(["provider.zdr: true"]);
  });

  it("records the request privacy parameters AgenC already sends", () => {
    const sent = Object.fromEntries(
      Object.entries(PROVIDER_RETENTION)
        .filter(([, facts]) => facts.requestPrivacy !== undefined)
        .map(([provider, facts]) => [provider, facts.requestPrivacy]),
    );
    expect(sent).toEqual({
      openai: ["store: false"],
      openrouter: ["provider.zdr: true"],
      meta: ["store: false"],
    });
  });

  it("cites the provider's own documentation for every hosted provider", () => {
    expect(PROVIDER_RETENTION_CHECKED_ON).toBe("2026-10-22");
    for (const [provider, facts] of Object.entries(PROVIDER_RETENTION)) {
      expect(facts.summary.length, provider).toBeGreaterThan(0);
      expect(facts.summary, provider).not.toContain("—");
      for (const url of facts.docs) {
        expect(url, provider).toMatch(/^https:\/\//u);
      }
      if (facts.retention !== "local") {
        expect(facts.docs.length, provider).toBeGreaterThan(0);
      }
    }
  });
});
