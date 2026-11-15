import { describe, expect, test } from "vitest";

import { defaultLightModelVerbosity } from "../../src/llm/openai-light-verbosity.js";

const light = { services: { runtimeOptions: { lightMode: true } } };

describe("defaultLightModelVerbosity", () => {
  test("asks GPT-6 Light sessions on OpenAI for low verbosity", () => {
    for (const model of ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna", "gpt-6-sol"]) {
      expect(defaultLightModelVerbosity(light, "openai", model)).toBe("low");
    }
  });

  test("leaves other providers, models and modes alone", () => {
    expect(defaultLightModelVerbosity(light, "deepseek", "gpt-6.1-sol")).toBeUndefined();
    expect(defaultLightModelVerbosity(light, "openrouter", "openai/gpt-6.1-sol")).toBeUndefined();
    expect(defaultLightModelVerbosity(light, "openai", "gpt-5")).toBeUndefined();
    expect(defaultLightModelVerbosity(light, "openai", "unlisted-gpt-6-thing")).toBeUndefined();
    expect(defaultLightModelVerbosity(light, "openai", undefined)).toBeUndefined();
    expect(defaultLightModelVerbosity({ services: { runtimeOptions: { lightMode: false } } }, "openai", "gpt-6.1-sol"))
      .toBeUndefined();
    expect(defaultLightModelVerbosity({ services: { runtimeOptions: { lightMode: true, simpleMode: true } } }, "openai", "gpt-6.1-sol"))
      .toBeUndefined();
    expect(defaultLightModelVerbosity({}, "openai", "gpt-6.1-sol")).toBeUndefined();
  });
});
