import { describe, expect, it } from "vitest";

import { providerOutageDelayMs } from "../../src/session/run-turn.js";

describe("providerOutageDelayMs", () => {
  it("doubles the base delay per retry and caps at ten times the base", () => {
    expect(providerOutageDelayMs(1000, 0)).toBe(1000);
    expect(providerOutageDelayMs(1000, 1)).toBe(2000);
    expect(providerOutageDelayMs(1000, 3)).toBe(8000);
    expect(providerOutageDelayMs(1000, 4)).toBe(10_000);
    expect(providerOutageDelayMs(1000, 10)).toBe(10_000);
    expect(providerOutageDelayMs(500, 4)).toBe(5000);
  });
});
