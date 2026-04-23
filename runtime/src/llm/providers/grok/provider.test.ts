import { describe, expect, test } from "vitest";

import { GrokProvider } from "./index.js";

describe("providers/grok entrypoint", () => {
  test("exports the canonical Grok provider class", () => {
    const provider = new GrokProvider({
      apiKey: "test-key",
      model: "grok-4-fast",
    });

    expect(provider.name).toBe("grok");
  });
});
