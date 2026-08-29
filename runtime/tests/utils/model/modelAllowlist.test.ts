import { describe, expect, test } from "vitest";

import { isModelAllowed } from "../../../src/utils/model/modelAllowlist.js";

describe("managed model allowlist", () => {
  test("distinguishes an absent policy from an explicit empty policy", () => {
    expect(isModelAllowed("grok", "private-model", {})).toBe(true);
    expect(
      isModelAllowed("grok", "private-model", { availableModels: [] }),
    ).toBe(false);
  });

  test("matches exact IDs without case or surrounding-whitespace drift", () => {
    expect(
      isModelAllowed("minimax", "MiniMax-M3", {
        availableModels: ["  minimax-m3  "],
      }),
    ).toBe(true);
  });

  test("keeps family aliases broad unless a version entry narrows them", () => {
    expect(
      isModelAllowed("anthropic", "claude-opus-4-8", {
        availableModels: ["opus"],
      }),
    ).toBe(true);
    expect(
      isModelAllowed("anthropic", "claude-opus-4-8", {
        availableModels: ["opus", "opus-4-7"],
      }),
    ).toBe(false);
    expect(
      isModelAllowed("anthropic", "claude-opus-4-7-20260801", {
        availableModels: ["opus", "opus-4-7"],
      }),
    ).toBe(true);
  });

  test("preserves bidirectional alias equivalence", () => {
    expect(
      isModelAllowed("anthropic", "opus", {
        availableModels: ["claude-opus-4-7"],
      }),
    ).toBe(true);
    expect(
      isModelAllowed("anthropic", "claude-opus-4-7", {
        availableModels: ["best"],
      }),
    ).toBe(true);
  });

  test("matches configured override values through their canonical IDs", () => {
    expect(
      isModelAllowed("amazon-bedrock", "arn:aws:bedrock:example:opus", {
        availableModels: ["claude-opus-4-7"],
        modelOverrides: {
          "claude-opus-4-7": "arn:aws:bedrock:example:opus",
        },
      }),
    ).toBe(true);
  });

  test("accepts either a provider-local or collision-safe catalog spelling", () => {
    const routed = "github:copilot:gpt-5.4";
    expect(
      isModelAllowed("github", "gpt-5.4", { availableModels: [routed] }),
    ).toBe(true);
    expect(
      isModelAllowed("openai", "gpt-5.4", { availableModels: [routed] }),
    ).toBe(false);
    expect(
      isModelAllowed("github", routed, { availableModels: ["gpt-5.4"] }),
    ).toBe(true);
  });

  test("keeps accepted Copilot default aliases out of selectable catalog data", () => {
    expect(
      isModelAllowed("github", "gpt-5.3-codex", {
        availableModels: ["github:copilot"],
      }),
    ).toBe(true);
    expect(
      isModelAllowed("github", "gpt-5.3-codex", {
        availableModels: ["copilot"],
      }),
    ).toBe(true);
  });

  test("does not expand ordinary exact IDs into sibling models", () => {
    expect(
      isModelAllowed("openai", "gpt-5", {
        availableModels: ["gpt-5"],
      }),
    ).toBe(true);
    expect(
      isModelAllowed("github", "gpt-5-mini", {
        availableModels: ["gpt-5"],
      }),
    ).toBe(false);
  });
});
