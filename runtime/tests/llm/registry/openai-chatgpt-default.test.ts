import { describe, expect, test } from "vitest";

import { chatGptDefaultModel } from "../../../src/llm/registry/openai-chatgpt-default.js";

const at = (day: string): Date => new Date(`${day}T12:00:00.000Z`);

/**
 * On 2026-11-20 a ChatGPT account signed in to Codex on the owner's PC listed
 * only gpt-6-luna and the gpt-5.6 models, not GPT-6.2 Astra.
 */
const PC_ACCOUNT = ["gpt-6-luna", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol"];

describe("the default for a ChatGPT sign-in", () => {
  test("is GPT-6.2 Astra when the account lists it, wherever it lists it", () => {
    expect(chatGptDefaultModel(["gpt-6-luna", "gpt-6.2-astra", "gpt-5.6-sol"])).toBe("gpt-6.2-astra");
    expect(chatGptDefaultModel(["gpt-6.2-astra"])).toBe("gpt-6.2-astra");
  });

  test("is the best model the account lists when Astra is not offered", () => {
    expect(chatGptDefaultModel(PC_ACCOUNT)).toBe("gpt-5.6-sol");
    expect(chatGptDefaultModel(["gpt-5.6-terra", "gpt-6-astra"])).toBe("gpt-6-astra");
    expect(chatGptDefaultModel(["gpt-6-luna", "gpt-6.1-terra"])).toBe("gpt-6.1-terra");
    expect(chatGptDefaultModel(["gpt-5.6-luna", "gpt-6-luna"])).toBe("gpt-6-luna");
    // Past the current lineup, Core's own OpenAI order decides.
    expect(chatGptDefaultModel(["gpt-5.4-mini", "gpt-5.5"])).toBe("gpt-5.5");
  });

  test("never picks a model Core does not list, which selection would refuse", () => {
    expect(chatGptDefaultModel(["gpt-7-preview", "gpt-6-luna"])).toBe("gpt-6-luna");
    expect(chatGptDefaultModel(["gpt-7-preview", "gpt-7-mini"])).toBeUndefined();
  });

  test("never picks a model OpenAI has retired", () => {
    // o3 shuts down on 2026-12-11.
    expect(chatGptDefaultModel(["o3", "gpt-7-preview"], at("2026-12-10"))).toBe("o3");
    expect(chatGptDefaultModel(["o3", "gpt-5.6-luna"], at("2026-12-11"))).toBe("gpt-5.6-luna");
    expect(chatGptDefaultModel(["o3", "gpt-7-preview"], at("2026-12-11"))).toBeUndefined();
  });

  test("is undefined for an empty list", () => {
    expect(chatGptDefaultModel([])).toBeUndefined();
    expect(chatGptDefaultModel(["", "  "])).toBeUndefined();
  });
});
