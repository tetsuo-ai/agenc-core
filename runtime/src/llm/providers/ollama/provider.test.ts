import { describe, expect, test } from "vitest";

import { OllamaProvider } from "./index.js";

describe("providers/ollama entrypoint", () => {
  test("exports the canonical Ollama provider class", () => {
    const provider = new OllamaProvider({
      model: "llama3.3",
    });

    expect(provider.name).toBe("ollama");
  });

  test("honors request-scoped model overrides when building requests", () => {
    const provider = new OllamaProvider({
      model: "llama3.3",
    });

    const params = (provider as any).buildParams(
      [{ role: "user", content: "review" }],
      { model: "qwen-reviewer" },
    );

    expect(params.model).toBe("qwen-reviewer");
  });
});
