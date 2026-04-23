import { describe, expect, test } from "vitest";

import { OllamaProvider } from "./index.js";

describe("providers/ollama entrypoint", () => {
  test("exports the canonical Ollama provider class", () => {
    const provider = new OllamaProvider({
      model: "llama3.3",
    });

    expect(provider.name).toBe("ollama");
  });
});
