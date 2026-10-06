import { describe, expect, test } from "vitest";

import {
  trustActivatedRepositoryKeys,
  type ConfigLayerSnapshot,
} from "./repository.js";
import type { AgenCConfig } from "./schema.js";

function layer(
  scope: ConfigLayerSnapshot["scope"],
  config: AgenCConfig,
): ConfigLayerSnapshot {
  return { scope, label: `${scope} layer`, config };
}

const ACTIVATED_BY_TRUST: AgenCConfig = {
  model: "repo-model",
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "./notify.sh" }] }],
  },
  mcp_servers: {
    github: { transport: "stdio", command: "npx" },
  },
  shell_environment_policy: { set: { SECRET_KEY: "secret-token" } },
  tools_config: { enabled_tools: ["WebSearch"] },
  browser: { no_sandbox: true },
};

const NEVER_ACTIVATED_BY_TRUST: AgenCConfig = {
  approval_policy: "never",
  project_root_markers: [".git"],
  plugins: { enabled: true },
  providers: { openai: { base_url: "https://example.invalid" } },
  statusLine: { type: "command", command: "echo status" },
  agents: {},
  availableModels: [],
  autonomous_mode: true,
  disableAllHooks: false,
};

const ALREADY_LIVE_WHEN_UNTRUSTED: AgenCConfig = {
  configVersion: 2,
  permissions: { deny: ["system.bash(rm:*)"] },
  sandbox_mode: "read-only",
  sandbox: { network_access: false },
};

describe("trustActivatedRepositoryKeys", () => {
  test("lists only repository keys that stay inactive until the root is trusted", () => {
    expect(trustActivatedRepositoryKeys(layer("project", ACTIVATED_BY_TRUST))).toEqual([
      "browser",
      "hooks",
      "mcp_servers",
      "model",
      "shell_environment_policy",
      "tools_config",
    ]);
  });

  test("does not advertise keys a repository can never turn on, even after trust", () => {
    expect(
      trustActivatedRepositoryKeys(layer("project", NEVER_ACTIVATED_BY_TRUST)),
    ).toEqual([]);
  });

  test("does not list restrictions that already apply in an untrusted root", () => {
    expect(
      trustActivatedRepositoryKeys(layer("project", ALREADY_LIVE_WHEN_UNTRUSTED)),
    ).toEqual([]);
  });

  test("treats project and local layers the same and ignores operator scopes", () => {
    const mixed = {
      ...ACTIVATED_BY_TRUST,
      ...NEVER_ACTIVATED_BY_TRUST,
      ...ALREADY_LIVE_WHEN_UNTRUSTED,
    };
    expect(trustActivatedRepositoryKeys(layer("local", mixed))).toEqual([
      "browser",
      "hooks",
      "mcp_servers",
      "model",
      "shell_environment_policy",
      "tools_config",
    ]);
    expect(trustActivatedRepositoryKeys(layer("user", ACTIVATED_BY_TRUST))).toEqual([]);
    expect(trustActivatedRepositoryKeys(layer("managed", ACTIVATED_BY_TRUST))).toEqual([]);
    expect(trustActivatedRepositoryKeys(layer("project", {}))).toEqual([]);
  });
});
