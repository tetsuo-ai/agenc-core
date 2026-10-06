import { describe, expect, it } from "vitest";
import { isKnownEmptyProviderReasoning } from "../../src/llm/types.js";

const GLM_MODELS = [
  "glm-5",
  "glm-5-turbo",
  "glm-5.1",
  "glm-5.1-flash",
  "glm-5.1-flashx",
  "glm-5.2",
  "glm-5.2-flash",
  "glm-5.2-flashx",
  "glm-5.3",
  "glm-5.3-flash",
  "glm-5.3-flashx",
  "glm-4.5",
  "glm-4.5-air",
  "glm-4.6",
  "glm-4.7",
  "zai/glm-5.3-flash",
  "org:GLM-5.3-FLASH",
] as const;

const NON_GLM_MODELS = [
  "glm-4",
  "glm-4.4",
  "glm-4.8",
  "glm-5.4",
  "glm-5.3-flash-preview",
  "xglm-5.3-flash",
  "qwen3",
  "",
] as const;

describe("isKnownEmptyProviderReasoning", () => {
  it.each(["zai", "zai-coding-plan", " ZAI ", "Zai-Coding-Plan"] as const)(
    "accepts an empty GLM replay from %s",
    (provider) => {
      for (const model of GLM_MODELS) {
        expect(isKnownEmptyProviderReasoning("", { provider, model }), model).toBe(true);
      }
    },
  );

  it.each(["qwen", "openai", "zai-chat", "", " "] as const)(
    "rejects empty reasoning from provider %s",
    (provider) => {
      expect(isKnownEmptyProviderReasoning("", { provider, model: "glm-5.3-flash" })).toBe(false);
    },
  );

  it.each(NON_GLM_MODELS)("rejects empty reasoning from model %s", (model) => {
    expect(isKnownEmptyProviderReasoning("", { provider: "zai", model })).toBe(false);
  });

  it("requires exactly empty string content and a record provenance", () => {
    const provenance = { provider: "zai", model: "glm-5.3-flash" };
    expect(isKnownEmptyProviderReasoning(" ", provenance)).toBe(false);
    expect(isKnownEmptyProviderReasoning("later", provenance)).toBe(false);
    expect(isKnownEmptyProviderReasoning(undefined, provenance)).toBe(false);
    expect(isKnownEmptyProviderReasoning(null, provenance)).toBe(false);
    expect(isKnownEmptyProviderReasoning("", null)).toBe(false);
    expect(isKnownEmptyProviderReasoning("", "zai")).toBe(false);
    expect(isKnownEmptyProviderReasoning("", { provider: "zai" })).toBe(false);
    expect(isKnownEmptyProviderReasoning("", { model: "glm-5.3-flash" })).toBe(false);
  });
});
