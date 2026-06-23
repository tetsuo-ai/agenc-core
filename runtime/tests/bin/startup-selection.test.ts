import { describe, expect, it } from "vitest";

import { defaultConfig } from "../config/schema.js";
import {
  readStartupCliFlags,
  resolveStartupSelection,
} from "./startup-selection.js";

describe("resolveStartupSelection", () => {
  it("uses Bedrock model env when selected by provider", () => {
    const resolved = resolveStartupSelection({
      config: defaultConfig(),
      env: {
        AGENC_PROVIDER: "amazon-bedrock",
        AWS_BEDROCK_MODEL: "amazon.nova-lite-v1:0",
        AWS_ACCESS_KEY_ID: "bedrock-access-key",
      },
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("amazon-bedrock");
    expect(resolved.model).toBe("amazon.nova-lite-v1:0");
    expect(resolved.apiKey).toBe("bedrock-access-key");
  });

  it("resolves config.model over providers.grok.default_model (config set model is honored)", () => {
    // Regression for the daemon-session model bug: with config.model set via
    // `agenc config set model` and a `[providers.grok] default_model`, the
    // session/startup resolution (which seeds collaborationMode.model) must
    // resolve to the configured model, not the provider default.
    const resolved = resolveStartupSelection({
      config: {
        ...defaultConfig(),
        model: "grok-build-0.1",
        model_provider: "grok",
        providers: { grok: { default_model: "grok-4.3" } },
      },
      env: {},
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("grok");
    expect(resolved.model).toBe("grok-build-0.1");
  });

  it("falls back to grok-4.3 when no config.model is set", () => {
    const resolved = resolveStartupSelection({
      config: defaultConfig(),
      env: {},
      argv: ["node", "agenc"],
    });

    expect(resolved.provider).toBe("grok");
    expect(resolved.model).toBe("grok-4.3");
  });
});

describe("readStartupCliFlags --permission-mode validation", () => {
  it("accepts a valid --permission-mode value", () => {
    const flags = readStartupCliFlags([
      "node",
      "agenc",
      "--permission-mode",
      "plan",
    ]);
    expect(flags.permissionMode).toBe("plan");
  });

  it("defaults (undefined) when --permission-mode is absent", () => {
    const flags = readStartupCliFlags(["node", "agenc"]);
    expect(flags.permissionMode).toBeUndefined();
  });

  it("throws on an invalid --permission-mode typo (no silent drop)", () => {
    // Regression: a typo toward a MORE restrictive mode must NOT silently
    // coerce to undefined (which boots in the LESS restrictive DEFAULT mode).
    expect(() =>
      readStartupCliFlags(["node", "agenc", "--permission-mode", "plann"]),
    ).toThrow(/unknown permission mode 'plann'\. Expected one of:/);
  });

  it("throws on a wrong-case --permission-mode value", () => {
    expect(() =>
      readStartupCliFlags(["node", "agenc", "--permission-mode", "Plan"]),
    ).toThrow(/unknown permission mode 'Plan'\. Expected one of:/);
  });

  it("ignores a valid-but-internal mode (unattended) without throwing", () => {
    // `unattended` IS a valid PermissionMode but is not user-addressable at
    // the startup CLI surface. The existing contract silently ignores it
    // (returns undefined) rather than erroring like a real typo.
    const flags = readStartupCliFlags([
      "node",
      "agenc",
      "--permission-mode",
      "unattended",
    ]);
    expect(flags.permissionMode).toBeUndefined();
  });
});
