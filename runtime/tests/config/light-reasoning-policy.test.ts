import { describe, expect, test } from "vitest";
import { applyEnvOverrides } from "../../src/config/env.js";
import { resolveProfile } from "../../src/config/profiles.js";
import {
  defaultConfig,
  validateAgenCConfigBlocks,
  type AgenCConfig,
} from "../../src/config/schema.js";
import { sessionConfigurationFromAgenCConfig } from "../../src/session/configuration.js";
import {
  collectDaemonClientEnvOverrides,
  mergeDaemonClientEnvironment,
} from "../../src/app-server/client-env-snapshot.js";
import { snapshotProviderEnvironment } from "../../src/llm/provider-options.js";

describe("Light reasoning policy configuration", () => {
  test("absent configuration and the default snapshot both preserve fixed effort", () => {
    expect(defaultConfig().light_reasoning_policy).toBe("fixed");
    const projected = sessionConfigurationFromAgenCConfig({
      config: { reasoning_effort: "low" },
      workspaceRoot: "/tmp/light-policy", model: "gpt-6-luna", provider: "openai",
    });
    expect(projected.lightReasoningPolicy).toBe("fixed");
    expect(projected.collaborationMode.reasoningEffort).toBe("low");
  });

  test.each(["fixed", "adaptive"] as const)("validates and projects %s at root and profile", policy => {
    const config = { ...defaultConfig(), light_reasoning_policy: policy,
      profiles: { recovery: { light_reasoning_policy: policy } } };
    expect(() => validateAgenCConfigBlocks(config)).not.toThrow();
    expect(sessionConfigurationFromAgenCConfig({
      config: resolveProfile(config, "recovery"),
      workspaceRoot: "/tmp/light-policy", model: "gpt-6-luna", provider: "openai",
    }).lightReasoningPolicy).toBe(policy);
  });

  test.each(["auto", "medium", "", true, 1, null])("rejects invalid root and profile policy %j", policy => {
    expect(() => validateAgenCConfigBlocks({ light_reasoning_policy: policy } as AgenCConfig))
      .toThrow(/light_reasoning_policy/);
    expect(() => validateAgenCConfigBlocks({ profiles: { test: { light_reasoning_policy: policy } } } as AgenCConfig))
      .toThrow(/light_reasoning_policy/);
  });

  test("profile wins over root; explicit environment wins over profile without mutation", () => {
    const root: AgenCConfig = { ...defaultConfig(), light_reasoning_policy: "adaptive",
      profiles: { bounded: { light_reasoning_policy: "fixed" } } };
    const profiled = resolveProfile(root, "bounded");
    expect(profiled.light_reasoning_policy).toBe("fixed");
    expect(applyEnvOverrides(profiled, {}).light_reasoning_policy).toBe("fixed");
    expect(applyEnvOverrides(profiled, { AGENC_LIGHT_REASONING_POLICY: "adaptive" }).light_reasoning_policy).toBe("adaptive");
    expect(root.light_reasoning_policy).toBe("adaptive");
    expect(profiled.light_reasoning_policy).toBe("fixed");
  });

  test.each(["auto", "true", "1", "low", "", "  "])("rejects invalid environment policy %j", policy => {
    expect(() => applyEnvOverrides(defaultConfig(), { AGENC_LIGHT_REASONING_POLICY: policy }))
      .toThrow(/AGENC_LIGHT_REASONING_POLICY/);
  });

  test("forwards each daemon client's captured policy and clears a previous client's opt-in", () => {
    const client = { AGENC_LIGHT_REASONING_POLICY: "adaptive" };
    const captured = collectDaemonClientEnvOverrides(client);
    client.AGENC_LIGHT_REASONING_POLICY = "fixed";
    const providerSnapshot = snapshotProviderEnvironment(captured);
    expect(providerSnapshot.AGENC_LIGHT_REASONING_POLICY).toBe("adaptive");
    const merged = mergeDaemonClientEnvironment({}, captured);
    expect(merged?.AGENC_LIGHT_REASONING_POLICY).toBe("adaptive");
    expect(applyEnvOverrides(defaultConfig(), merged ?? {}).light_reasoning_policy).toBe("adaptive");

    const next = mergeDaemonClientEnvironment(
      { AGENC_LIGHT_REASONING_POLICY: "adaptive" }, collectDaemonClientEnvOverrides({}),
    );
    expect(next).not.toHaveProperty("AGENC_LIGHT_REASONING_POLICY");
    expect(applyEnvOverrides(defaultConfig(), next ?? {}).light_reasoning_policy).toBe("fixed");
  });
});
