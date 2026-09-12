import { describe, expect, it } from "vitest";

import {
  PROVIDER_AUTH_ENV,
  providerAuthPreference,
  providerAuthSelection,
} from "../../src/llm/provider-auth-selection.js";

describe("providerAuthPreference", () => {
  it("treats missing, empty, and whitespace values as auto", () => {
    expect(providerAuthPreference("openai", {})).toBe("auto");
    expect(providerAuthPreference("grok", { GROK_AUTH_MODE: "" })).toBe("auto");
    expect(providerAuthPreference("openai", { OPENAI_AUTH_MODE: "  auto  " }))
      .toBe("auto");
    expect(providerAuthPreference("grok", { GROK_AUTH_MODE: "   " })).toBe(
      "auto",
    );
  });

  it.each(["oauth", "api-key"] as const)(
    "honors an explicit %s preference for both selectable providers",
    (mode) => {
      expect(
        providerAuthPreference("openai", { OPENAI_AUTH_MODE: `  ${mode}  ` }),
      ).toBe(mode);
      expect(
        providerAuthPreference("grok", { GROK_AUTH_MODE: mode }),
      ).toBe(mode);
    },
  );

  it("fails closed on an unrecognized mode and names the provider env var", () => {
    expect(() =>
      providerAuthPreference("openai", { OPENAI_AUTH_MODE: "typo" }),
    ).toThrow("OPENAI_AUTH_MODE must be auto, oauth, or api-key");
    expect(() =>
      providerAuthPreference("grok", { GROK_AUTH_MODE: "password" }),
    ).toThrow("GROK_AUTH_MODE must be auto, oauth, or api-key");
  });

  it("keeps the env names pinned to the selectable providers", () => {
    expect(PROVIDER_AUTH_ENV).toEqual({
      openai: "OPENAI_AUTH_MODE",
      grok: "GROK_AUTH_MODE",
    });
    expect(Object.isFrozen(PROVIDER_AUTH_ENV)).toBe(true);
  });
});

describe("providerAuthSelection", () => {
  const both = { oauth: true, apiKey: true };
  const oauthOnly = { oauth: true, apiKey: false };
  const apiKeyOnly = { oauth: false, apiKey: true };
  const neither = { oauth: false, apiKey: false };

  it("prefers OAuth in auto when both credentials exist", () => {
    expect(providerAuthSelection("grok", {}, both)).toEqual({
      version: 1,
      preference: "auto",
      effectiveMode: "oauth",
      available: both,
    });
  });

  it("uses the remaining credential in auto, or none when both are missing", () => {
    expect(providerAuthSelection("openai", {}, oauthOnly).effectiveMode).toBe(
      "oauth",
    );
    expect(providerAuthSelection("openai", {}, apiKeyOnly).effectiveMode).toBe(
      "api-key",
    );
    expect(providerAuthSelection("openai", {}, neither).effectiveMode).toBeNull();
  });

  it("does not fall back when an explicit preference is unavailable", () => {
    expect(
      providerAuthSelection("grok", { GROK_AUTH_MODE: "oauth" }, apiKeyOnly)
        .effectiveMode,
    ).toBeNull();
    expect(
      providerAuthSelection("openai", { OPENAI_AUTH_MODE: "api-key" }, oauthOnly)
        .effectiveMode,
    ).toBeNull();
  });

  it("lets automaticMode override auto, but not an explicit preference", () => {
    expect(
      providerAuthSelection("openai", {}, both, "api-key").effectiveMode,
    ).toBe("api-key");
    expect(
      providerAuthSelection(
        "openai",
        { OPENAI_AUTH_MODE: "oauth" },
        both,
        "api-key",
      ).effectiveMode,
    ).toBe("oauth");
  });

  it("freezes the returned selection and available snapshot", () => {
    const available = { oauth: true, apiKey: false };
    const selection = providerAuthSelection("grok", {}, available);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(selection.available)).toBe(true);
    available.oauth = false;
    expect(selection.available.oauth).toBe(true);
  });
});
