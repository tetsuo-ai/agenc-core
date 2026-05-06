import { describe, it, expect } from "vitest";

import { buildPendingProviderSwitch } from "./model-switch.js";

describe("buildPendingProviderSwitch (TUI model picker → runtime switch)", () => {
  it("returns the spec when the session has a configured provider", () => {
    const session = {
      sessionConfiguration: {
        provider: { slug: "anthropic" },
      },
    };
    const got = buildPendingProviderSwitch(session, "claude-sonnet-4-6");
    expect(got).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });

  it("returns null when the session has no provider", () => {
    const session = { sessionConfiguration: undefined };
    expect(buildPendingProviderSwitch(session, "any")).toBeNull();
  });

  it("returns null when sessionConfiguration is present but provider is missing", () => {
    const session = { sessionConfiguration: {} };
    expect(buildPendingProviderSwitch(session, "any")).toBeNull();
  });

  it("returns null when provider object is present but slug is missing", () => {
    const session = {
      sessionConfiguration: { provider: {} },
    };
    expect(buildPendingProviderSwitch(session, "any")).toBeNull();
  });

  it("preserves the model verbatim", () => {
    const session = {
      sessionConfiguration: { provider: { slug: "openai" } },
    };
    const got = buildPendingProviderSwitch(session, "gpt-5-codex");
    expect(got?.model).toBe("gpt-5-codex");
  });

  it("passes an empty provider slug through verbatim — runtime is the validator", () => {
    const session = {
      sessionConfiguration: { provider: { slug: "" } },
    };
    const got = buildPendingProviderSwitch(session, "any-model");
    expect(got).toEqual({ provider: "", model: "any-model" });
  });
});
