import { describe, expect, test } from "vitest";

import {
  collectPluginCapabilities,
  evaluatePluginPolicy,
  getManagedPluginNames,
  isPluginBlockedByPolicy,
  isPluginCapabilityAllowed,
} from "./policy.js";

describe("plugin policy", () => {
  test("blocks plugins disabled by managed policy or configured entries", () => {
    expect(
      isPluginBlockedByPolicy("tooling@team", {
        enabledPlugins: {
          "tooling@team": false,
        },
      }),
    ).toBe(true);
    expect(
      isPluginBlockedByPolicy("tooling@team", {
        plugins: {
          enabled: {
            "tooling@team": { enabled: false },
          },
        },
      }),
    ).toBe(true);
    expect(
      isPluginBlockedByPolicy("tooling@team", {
        enabledPlugins: {
          "tooling@team": true,
        },
      }),
    ).toBe(false);
  });

  test("returns managed plugin names only for boolean marketplace entries", () => {
    expect(
      getManagedPluginNames({
        enabledPlugins: {
          "alpha@market": true,
          "beta@market": false,
          "legacy-array": ["owner/repo"],
          "local-only": true,
          "object@market": { enabled: false },
        },
      }),
    ).toEqual(new Set(["alpha", "beta"]));
    expect(getManagedPluginNames({ enabledPlugins: { local: true } })).toBeNull();
  });

  test("evaluates capability allow and deny decisions", () => {
    expect(isPluginCapabilityAllowed("mcp", { deny: ["network"] })).toBe(true);
    expect(isPluginCapabilityAllowed("network", { deny: ["network"] })).toBe(false);
    expect(isPluginCapabilityAllowed("mcp", { allow: ["commands"] })).toBe(false);
    expect(isPluginCapabilityAllowed("mcp", { allow: ["*"] })).toBe(true);

    expect(
      evaluatePluginPolicy({
        pluginId: "net@market",
        capabilities: ["mcp", "network"],
        capabilityPolicy: { deny: ["network"] },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "capability-denied",
      deniedCapabilities: ["network"],
    });
  });

  test("normalizes manifest capabilities before policy evaluation", () => {
    const plugin = {
      manifest: {
        interface: {
          capabilities: [" mcp ", "mcp", "", "commands"],
        },
      },
    };

    expect(collectPluginCapabilities(plugin)).toEqual(["mcp", "commands"]);
    expect(
      evaluatePluginPolicy({
        pluginId: "blocked@market",
        plugin,
        settings: { enabledPlugins: { "blocked@market": false } },
      }),
    ).toMatchObject({
      allowed: false,
      reason: "blocked-by-policy",
      capabilities: ["mcp", "commands"],
    });
  });
});
