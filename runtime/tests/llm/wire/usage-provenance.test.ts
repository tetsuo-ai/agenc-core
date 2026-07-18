import { describe, expect, test } from "vitest";

import { coerceUsage } from "./shared.js";

describe("LLM usage provenance", () => {
  test("distinguishes an authoritative reported zero from missing usage", () => {
    expect(
      coerceUsage({
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      }),
    ).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      availability: "reported",
      provenance: "provider",
    });

    expect(coerceUsage({})).toMatchObject({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      availability: "unknown",
      provenance: "synthetic",
    });
  });

  test("lets partial/error adapters retain observed counts without claiming usage", () => {
    expect(
      coerceUsage({
        promptTokens: 11,
        completionTokens: 3,
        availability: "unknown",
        provenance: "synthetic",
      }),
    ).toMatchObject({
      promptTokens: 11,
      completionTokens: 3,
      totalTokens: 14,
      availability: "unknown",
      provenance: "synthetic",
    });
  });
});
