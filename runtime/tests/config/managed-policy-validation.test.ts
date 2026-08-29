import { describe, expect, test } from "vitest";

import {
  type AgenCConfig,
  validateAgenCConfigBlocks,
} from "../../src/config/schema.js";

function malformed(field: string, value: unknown): AgenCConfig {
  return { [field]: value } as unknown as AgenCConfig;
}

describe("canonical managed-policy validation", () => {
  test.each([
    ["availableModels", ["grok", 7]],
    ["modelOverrides", { grok: false }],
    ["allowedMcpServers", [{ serverName: "bad name" }]],
    ["deniedMcpServers", [{ serverName: "ok", serverUrl: "https://example.com" }]],
    ["disableAllHooks", "true"],
    ["allowManagedHooksOnly", 1],
    ["allowedHttpHookUrls", [false]],
    ["httpHookAllowedEnvVars", ["TOKEN", null]],
    ["allowManagedPermissionRulesOnly", "yes"],
    ["allowManagedMcpServersOnly", []],
    ["strictPluginOnlyCustomization", ["commands"]],
    ["strictKnownMarketplaces", [{ source: "file", path: "/ok", extra: true }]],
    ["blockedMarketplaces", [{ source: "unknown" }]],
    ["forceLoginOrgUUID", 1],
    ["skipWebFetchPreflight", "false"],
    ["minimumVersion", false],
    ["disableAutoMode", "enable"],
    ["agencMdExcludes", ["**/vendor/**", 3]],
    ["pluginTrustMessage", {}],
    ["autoFix", { enabled: true, lint: "eslint .", surprise: true }],
  ])("rejects malformed %s", (field, value) => {
    expect(() => validateAgenCConfigBlocks(malformed(field, value))).toThrow();
  });

  test("accepts a fully typed managed policy projection", () => {
    const config = validateAgenCConfigBlocks({
      availableModels: ["grok"],
      modelOverrides: { grok: "grok-enterprise" },
      allowedMcpServers: [{ serverName: "internal" }],
      deniedMcpServers: [{ serverUrl: "https://blocked.example/*" }],
      disableAllHooks: true,
      allowManagedHooksOnly: true,
      allowedHttpHookUrls: ["https://hooks.example/*"],
      httpHookAllowedEnvVars: ["HOOK_TOKEN"],
      allowManagedPermissionRulesOnly: true,
      allowManagedMcpServersOnly: true,
      strictPluginOnlyCustomization: ["skills", "hooks"],
      strictKnownMarketplaces: [{ source: "github", repo: "org/plugins" }],
      blockedMarketplaces: [{ source: "hostPattern", hostPattern: "^bad\\.example$" }],
      forceLoginOrgUUID: "org-id",
      skipWebFetchPreflight: true,
      minimumVersion: "0.17.0",
      disableAutoMode: "disable",
      agencMdExcludes: ["**/vendor/**"],
      pluginTrustMessage: "Approved sources only.",
      autoFix: { enabled: true, lint: "eslint ." },
    });

    expect(config.availableModels).toEqual(["grok"]);
  });
});
