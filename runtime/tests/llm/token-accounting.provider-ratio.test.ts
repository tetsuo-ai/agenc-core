import { describe, expect, it } from "vitest";

import { conservativeBytesPerTokenForProvider } from "../../src/llm/token-accounting.js";

describe("conservative bytes per token by provider", () => {
  it("uses a measured ratio for known tokenizer families", () => {
    expect(conservativeBytesPerTokenForProvider("grok")).toBe(3.5);
    expect(conservativeBytesPerTokenForProvider("Grok ")).toBe(3.5);
    expect(conservativeBytesPerTokenForProvider("openai")).toBe(3.5);
    expect(conservativeBytesPerTokenForProvider("anthropic")).toBe(2.8);
  });

  it("keeps the floor of two for unknown providers", () => {
    expect(conservativeBytesPerTokenForProvider("ollama")).toBe(2);
    expect(conservativeBytesPerTokenForProvider(undefined)).toBe(2);
    expect(conservativeBytesPerTokenForProvider("")).toBe(2);
  });
});
