import { describe, expect, test } from "vitest";

import { parseClaudeModelId } from "../../../src/utils/model/claudeModelId.js";
import { firstPartyNameToCanonical } from "../../../src/utils/model/model.js";
import { findProfileForModel } from "../../../src/utils/model/bedrock.js";
import { getModelCosts } from "../../../src/utils/modelCost.js";
import {
  computeUsdCostWithResolution,
  DEFAULT_MODEL_COSTS,
  type ModelUsage,
} from "../../../src/session/cost.js";
import { isAlwaysOnThinkingAnthropicModel } from "../../../src/utils/model/alwaysOnThinking.js";
import {
  anthropicAcceptsSamplingParameters,
  anthropicEffortLevels,
  anthropicThinkingControl,
} from "../../../src/utils/model/anthropicThinkingControl.js";
import { anthropicSupportsFastMode } from "../../../src/llm/providers/anthropic/fast-mode.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";

const OPUS_55_SPELLINGS = [
  "claude-opus-5-5",
  "claude-opus-5.5",
  "claude-opus-5-5-20260922",
  "anthropic/claude-opus-5-5",
  "anthropic.claude-opus-5-5",
  "us.anthropic.claude-opus-5-5-v1:0",
  "us.anthropic.agenc-opus-5-5-v1",
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-opus-5-5",
  "claude-opus-5-5@20260922",
  "claude-opus-5-5[1m]",
];

const OPUS_5_SPELLINGS = [
  "claude-opus-5",
  "claude-opus-5-20260601",
  "anthropic:claude-opus-5",
  "anthropic.claude-opus-5",
  "us.anthropic.agenc-opus-5-v1",
  "claude-opus-5[1m]",
];

function usage(model: string): ModelUsage {
  return {
    model,
    inputTokens: 1_000_000,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    totalTokens: 1_000_000,
    turns: 1,
  };
}

describe("parseClaudeModelId", () => {
  test("reads the Claude API, Bedrock, Vertex and dotted spellings", () => {
    for (const model of OPUS_55_SPELLINGS) {
      expect(parseClaudeModelId(model), model).toMatchObject({
        family: "opus",
        major: 5,
        minor: 5,
        canonical: "claude-opus-5-5",
      });
    }
    for (const model of OPUS_5_SPELLINGS) {
      const id = parseClaudeModelId(model);
      expect(id?.canonical, model).toBe("claude-opus-5");
      expect(id?.minor, model).toBeUndefined();
    }
    expect(parseClaudeModelId("claude-opus-5-20260601")?.snapshot).toBe("20260601");
    expect(parseClaudeModelId("claude-opus-5-5@20260922")).toMatchObject({
      platform: "vertex",
      snapshot: "20260922",
    });
    expect(parseClaudeModelId("us.anthropic.agenc-opus-5-5-v1")?.platform).toBe("bedrock");
    expect(parseClaudeModelId("anthropic/claude-opus-5-5")?.platform).toBe("anthropic");
    // Older generations read the same way.
    expect(parseClaudeModelId("claude-opus-4-1-20250805")?.canonical).toBe("claude-opus-4-1");
    expect(parseClaudeModelId("claude-opus-4-20250514")?.canonical).toBe("claude-opus-4");
    expect(parseClaudeModelId("anthropic.claude-sonnet-4-5-20250929-v1:0")?.canonical)
      .toBe("claude-sonnet-4-5");
    expect(parseClaudeModelId("claude-fable-5-1")?.canonical).toBe("claude-fable-5-1");
  });

  test("keeps an unknown minor distinct and rejects what it cannot read", () => {
    expect(parseClaudeModelId("claude-opus-5-50")?.canonical).toBe("claude-opus-5-50");
    expect(parseClaudeModelId("claude-fable-5-10")?.canonical).toBe("claude-fable-5-10");
    for (const model of [
      "claude-opus-5-5-preview",
      "claude-opus-5-500",
      "claude-3-7-sonnet-20250219",
      "claude-mythos-preview",
      "gpt-5.5",
      "grok-4.5",
      "opus-5-5",
    ]) {
      expect(parseClaudeModelId(model), model).toBeUndefined();
    }
  });
});

describe("Opus 5 and Opus 5.5 never stand in for each other", () => {
  test("in canonical names", () => {
    for (const model of OPUS_55_SPELLINGS) {
      expect(firstPartyNameToCanonical(model as never), model).toBe("claude-opus-5-5");
    }
    for (const model of OPUS_5_SPELLINGS) {
      expect(firstPartyNameToCanonical(model as never), model).toBe("claude-opus-5");
    }
    // An unknown minor borrows neither neighbour; the same holds for Fable.
    expect(firstPartyNameToCanonical("claude-opus-5-50" as never)).toBe("claude-opus-5-50");
    expect(firstPartyNameToCanonical("claude-fable-5-10" as never)).toBe("claude-fable-5-10");
    expect(firstPartyNameToCanonical("claude-fable-5-1" as never)).toBe("claude-fable-5-1");
  });

  test("in the legacy cost table", () => {
    const zero = { input_tokens: 0, output_tokens: 0 } as never;
    for (const model of OPUS_55_SPELLINGS) {
      expect(getModelCosts(model, zero).inputTokens, model).toBe(4);
    }
    for (const model of OPUS_5_SPELLINGS) {
      expect(getModelCosts(model, zero).inputTokens, model).toBe(5);
    }
    // Unknown: the $5/$25 fallback, never Opus 5.5's $4/$20.
    expect(getModelCosts("claude-opus-5-50", zero).inputTokens).toBe(5);
  });

  test("in the session cost table", () => {
    for (const model of OPUS_55_SPELLINGS) {
      const resolved = computeUsdCostWithResolution(usage(model), DEFAULT_MODEL_COSTS);
      expect(resolved.known, model).toBe(true);
      expect(resolved.costUsd, model).toBeCloseTo(4, 6);
    }
    for (const model of OPUS_5_SPELLINGS) {
      const resolved = computeUsdCostWithResolution(usage(model), DEFAULT_MODEL_COSTS);
      expect(resolved.known, model).toBe(true);
      expect(resolved.costUsd, model).toBeCloseTo(5, 6);
    }
    expect(
      computeUsdCostWithResolution(usage("claude-opus-5-50"), DEFAULT_MODEL_COSTS).known,
    ).toBe(false);
  });

  test("in capabilities", () => {
    for (const model of OPUS_55_SPELLINGS) {
      expect(isAlwaysOnThinkingAnthropicModel(model), model).toBe(true);
      expect(anthropicThinkingControl(model), model).toBe("always_on");
      expect(anthropicAcceptsSamplingParameters(model), model).toBe(false);
      expect(anthropicEffortLevels(model), model).toEqual(["low", "medium", "high", "xhigh", "max"]);
    }
    for (const model of [...OPUS_5_SPELLINGS, "claude-opus-5-50"]) {
      expect(isAlwaysOnThinkingAnthropicModel(model), model).toBe(false);
      expect(anthropicThinkingControl(model), model).toBe("adaptive");
    }
    // Fast mode is Claude API only: the API spellings qualify, the Bedrock
    // and Vertex spellings never do.
    for (const model of ["claude-opus-5-5", "claude-opus-5.5", "claude-opus-5-5-20260922", "anthropic/claude-opus-5-5"]) {
      expect(anthropicSupportsFastMode(model), model).toBe(true);
    }
    for (const model of ["anthropic.claude-opus-5-5", "us.anthropic.agenc-opus-5-5-v1", "claude-opus-5-5@20260922", "claude-opus-5-50"]) {
      expect(anthropicSupportsFastMode(model), model).toBe(false);
    }
  });
});

describe("one identity for pricing and capabilities", () => {
  test("gives the Opus 5.5 contract exactly to the ids priced as Opus 5.5", () => {
    for (const model of [
      ...OPUS_55_SPELLINGS,
      ...OPUS_5_SPELLINGS,
      "claude-opus-5-50",
      "claude-opus-5-5-preview",
      "claude-opus-5-5x",
    ]) {
      const pricedAsOpus55 =
        computeUsdCostWithResolution(usage(model), DEFAULT_MODEL_COSTS).matchedKey ===
          "claude-opus-5-5";
      expect(isAlwaysOnThinkingAnthropicModel(model), model).toBe(pricedAsOpus55);
    }
  });

  test.each([
    ["the Opus 5.5 spellings", OPUS_55_SPELLINGS],
    ["other ids", [...OPUS_5_SPELLINGS, "claude-opus-5-50", "claude-opus-5-5-preview", "claude-opus-5-5-fast", "claude-opus-5-5x"]],
  ])("gives the Anthropic catalog row exactly to the Claude API ids priced as Opus 5.5 (%s)", (_label, models) => {
    for (const model of models) {
      const id = parseClaudeModelId(model);
      const claudeApiOpus55 =
        id?.platform === "anthropic" &&
        computeUsdCostWithResolution(usage(model), DEFAULT_MODEL_COSTS).matchedKey ===
          "claude-opus-5-5";
      expect(
        resolveRegisteredModelCatalogEntry({ provider: "anthropic", model })?.model,
        model,
      ).toBe(claudeApiOpus55 ? "claude-opus-5-5" : undefined);
    }
  });
});

describe("Bedrock inference profile selection", () => {
  const opus55 = "us.anthropic.claude-opus-5-5-v1:0";
  const opus5 = "us.anthropic.claude-opus-5-v1:0";
  const fable51 = "global.anthropic.claude-fable-5-1";
  const fable5 = "global.anthropic.claude-fable-5";

  test("returns the profile for the exact model in either listing order", () => {
    for (const profiles of [[opus55, opus5, fable51, fable5], [fable5, fable51, opus5, opus55]]) {
      expect(findProfileForModel(profiles, "claude-opus-5"), profiles.join()).toBe(opus5);
      expect(findProfileForModel(profiles, "claude-opus-5-5"), profiles.join()).toBe(opus55);
      expect(findProfileForModel(profiles, "claude-fable-5"), profiles.join()).toBe(fable5);
      expect(findProfileForModel(profiles, "claude-fable-5-1"), profiles.join()).toBe(fable51);
    }
  });

  test("finds nothing rather than a neighbour", () => {
    expect(findProfileForModel([opus55], "claude-opus-5")).toBeNull();
    expect(findProfileForModel([opus5], "claude-opus-5-5")).toBeNull();
    expect(findProfileForModel([fable51], "claude-fable-5")).toBeNull();
  });

  test("requires the snapshot of a dated model and keeps Claude 3 substring matching", () => {
    const profiles = [
      "us.anthropic.claude-opus-4-1-20250805-v1:0",
      "us.anthropic.claude-opus-4-20250514-v1:0",
      "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    ];
    expect(findProfileForModel(profiles, "claude-opus-4-20250514")).toBe(profiles[1]);
    expect(findProfileForModel(profiles, "claude-opus-4-1-20250805")).toBe(profiles[0]);
    expect(findProfileForModel(profiles, "claude-3-7-sonnet-20250219")).toBe(profiles[2]);
  });
});
