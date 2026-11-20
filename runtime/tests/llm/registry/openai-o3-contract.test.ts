import { describe, expect, test } from "vitest";

import { modelCapabilityTags } from "../../../src/commands/model-capability-tags.js";
import { resolveReasoningEffort } from "../../../src/llm/reasoning-effort.js";
import { resolveRegisteredModelCatalogEntry } from "../../../src/llm/registry/model-catalog.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../../src/llm/registry/provider-info.js";
import { resolveProviderModelSelection } from "../../../src/session/provider-model-selection.js";

const at = (day: string, time = "12:00:00.000"): Date => new Date(`${day}T${time}Z`);
const ON_DEEPSEEK = { provider: "deepseek", model: "deepseek-flash" };

/**
 * Evidence, 2026-11-20: https://developers.openai.com/api/docs/models/o3 gives a
 * 200,000-token window, 100,000 output tokens, text and image input, function
 * calling and structured outputs; /api/docs/deprecations shuts o3 down on
 * 2026-12-11 (replacement gpt-6.1-sol).
 */
describe("OpenAI o3", () => {
  test("is listed with its published contract", () => {
    expect(BUILT_IN_PROVIDER_MODEL_CATALOG.openai).toContain("o3");
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: "o3" })).toMatchObject({
      provider: "openai", model: "o3", contextWindow: 200_000, maxOutputTokens: 100_000,
      inputModalities: ["text", "image"], supportsToolUse: true, supportsStructuredOutput: true,
      supportedReasoningLevels: ["low", "medium", "high"], defaultReasoningLevel: "medium",
      visibility: "list", retiresOn: "2026-12-11",
    });
    expect(resolveReasoningEffort({ provider: "openai", model: "o3" }).levels).toEqual(["low", "medium", "high"]);
  });

  test("lends its contract to its dated snapshot, never to an unknown variant", () => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: "o3-2025-04-16" })?.model).toBe("o3");
    expect(resolveRegisteredModelCatalogEntry({ provider: "openai", model: "o3-unverified" })).toBeUndefined();
    expect(resolveReasoningEffort({ provider: "openai", model: "o3-unverified" }).levels).toEqual([]);
  });

  test("is chosen until OpenAI's shutdown date and refused from it on", () => {
    const layer = { model_provider: "openai", model: "o3" };
    expect(modelCapabilityTags("openai", "o3", at("2026-11-20"))).toContain("retires 2026-12-11");
    expect(resolveProviderModelSelection({}, ON_DEEPSEEK, layer, {}, { now: at("2026-12-10", "23:59:59.999") }))
      .toMatchObject({ provider: "openai", model: "o3" });
    expect(() => resolveProviderModelSelection({}, ON_DEEPSEEK, layer, {}, { now: at("2026-12-11", "00:00:00.000") }))
      .toThrow(new Error("OpenAI retired 'o3' on 2026-12-11. Pick another model."));
  });
});
