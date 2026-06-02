import { describe, expect, it } from "vitest";
import {
  getOpenAICompatibleContextWindow,
  getOpenAICompatibleMaxOutputTokens,
} from "src/llm/openai-compatible-token-limits.js";

// gaphunt3 #13: prefix lookup must enforce a separator boundary so a model id
// that merely begins with a shorter table key (but is a different model) is not
// silently assigned that key's window/output limits.
describe("gaphunt3 #13 — openai-compatible token table prefix boundary", () => {
  it("does not match gpt-4.5-preview against the shorter 'gpt-4' key", () => {
    // 'gpt-4.5-preview' startsWith 'gpt-4' but is a distinct model (a version
    // continuation via '.'); before the fix it resolved to gpt-4's 8_192 window.
    expect(getOpenAICompatibleContextWindow("gpt-4.5-preview")).toBeUndefined();
    expect(
      getOpenAICompatibleMaxOutputTokens("gpt-4.5-preview"),
    ).toBeUndefined();
  });

  it("still resolves boundary-correct dated variants via prefix match", () => {
    // 'gpt-4o-2024-08-06' should resolve to gpt-4o (boundary '-'), not gpt-4.
    expect(getOpenAICompatibleContextWindow("gpt-4o-2024-08-06")).toBe(128_000);
    expect(getOpenAICompatibleMaxOutputTokens("gpt-4o-2024-08-06")).toBe(
      16_384,
    );
  });

  it("does not match unrelated 'o1xyz' against the short 'o1' key", () => {
    // 'o1xyz' startsWith 'o1' with no separator boundary; must not inherit o1's
    // 200_000 window.
    expect(getOpenAICompatibleContextWindow("o1xyz")).toBeUndefined();
    expect(getOpenAICompatibleMaxOutputTokens("o1xyz")).toBeUndefined();
  });

  it("treats '.' as a version continuation, not a separator boundary", () => {
    // Hypothetical sibling of an existing key: must not inherit the shorter
    // key's limits across a '.' version bump.
    expect(getOpenAICompatibleContextWindow("gpt-5.9-preview")).toBeUndefined();
    expect(getOpenAICompatibleContextWindow("glm-5.9")).toBeUndefined();
  });

  it("preserves exact-key and other separator matches", () => {
    expect(getOpenAICompatibleContextWindow("gpt-4o")).toBe(128_000);
    expect(getOpenAICompatibleContextWindow("gpt-4-turbo-preview")).toBe(
      128_000,
    );
    expect(getOpenAICompatibleContextWindow("o1-mini")).toBe(128_000);
  });
});
