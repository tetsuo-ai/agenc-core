import { describe, expect, it } from "vitest";
import { terminalTitle } from "../../src/tui/terminal-title.js";

const session = (provider: string, model: string) => ({
  sessionConfiguration: { provider: { slug: provider }, collaborationMode: { model } },
});

describe("terminal title", () => {
  it("names the startup provider and model before any switch", () => {
    expect(terminalTitle({
      session: session("openai", "gpt-6.1-sol"),
      startupModel: "gpt-6.1-sol",
      startupProvider: "openai",
      liveModel: "gpt-6.1-sol",
    })).toBe("AgenC openai/gpt-6.1-sol");
  });

  it("follows a model switch instead of keeping the startup model", () => {
    // Owner screenshot (0.19.36): title "AgenC openai/gpt-6.1-sol" while the
    // status line said "gpt-6-astra". The session selection already names
    // the new pair; the title must too.
    expect(terminalTitle({
      session: session("openai", "gpt-6-astra"),
      startupModel: "gpt-6.1-sol",
      startupProvider: "openai",
      liveModel: "gpt-6-astra",
    })).toBe("AgenC openai/gpt-6-astra");
  });

  it("drops the provider rather than pairing a stale one with the new model", () => {
    expect(terminalTitle({
      session: session("openai", "gpt-6.1-sol"),
      startupModel: "gpt-6.1-sol",
      startupProvider: "openai",
      liveModel: "deepseek-v4.1-flash",
    })).toBe("AgenC deepseek-v4.1-flash");
  });

  it("falls back to the startup model and to a bare name", () => {
    expect(terminalTitle({ session: {}, startupModel: "m1", startupProvider: "p1" })).toBe("AgenC p1/m1");
    expect(terminalTitle({ session: {} })).toBe("AgenC");
  });
});
