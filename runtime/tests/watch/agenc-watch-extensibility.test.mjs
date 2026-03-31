import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatchExtensibilityReport,
  updateWatchMcpServerState,
  updateWatchTrustedPluginPackage,
} from "../../src/watch/agenc-watch-extensibility.mjs";

test("buildWatchExtensibilityReport summarizes config and live skills", () => {
  const report = buildWatchExtensibilityReport({
    projectRoot: "/workspace/demo",
    watchState: {
      lastStatus: {
        channelStatuses: [
          { name: "webchat", enabled: true, active: true, health: "healthy" },
        ],
      },
      skillCatalog: [
        {
          name: "browser",
          description: "Drive MCP browser flows",
          enabled: true,
          available: true,
          tier: "user",
          primaryEnv: "node",
          tags: ["browser", "mcp"],
        },
      ],
      hookCatalog: [
        {
          event: "tool:after",
          name: "tool-audit-logger",
          priority: 90,
          source: "builtin",
          kind: "lifecycle",
          handlerType: "builtin",
          target: "tool-audit-logger",
          supported: true,
        },
      ],
    },
    configSnapshot: {
      configPath: "/home/tester/.agenc/config.json",
      source: "pid",
      config: {
        plugins: {
          trustedPackages: [{ packageName: "@demo/plugin", allowedSubpaths: ["channel"] }],
        },
        mcp: {
          servers: [{ name: "browser", command: "npx", args: ["@demo/browser"], enabled: true }],
        },
      },
    },
    localSkillCatalog: {
      userSkillsPath: "/home/tester/.agenc/skills",
      skills: ["browser"],
      error: null,
    },
  });

  assert.match(report, /Trusted packages: 1/);
  assert.match(report, /MCP servers: 1/);
  assert.match(report, /Runtime skills: 1/);
  assert.match(report, /Runtime hooks: 1/);
});

test("updateWatchTrustedPluginPackage writes a trusted package entry", () => {
  const writes = [];
  const fs = {
    readFileSync: () => JSON.stringify({ plugins: { trustedPackages: [] } }),
    mkdirSync: () => {},
    writeFileSync: (_path, value) => writes.push(String(value)),
  };

  const result = updateWatchTrustedPluginPackage({
    fs,
    configPath: "/tmp/agenc.json",
    packageName: "@demo/plugin",
    allowedSubpaths: ["channel", "hooks"],
  });

  assert.equal(result.trustedPackages.length, 1);
  assert.match(writes[0], /@demo\/plugin/);
  assert.match(writes[0], /channel/);
});

test("updateWatchMcpServerState toggles the selected server", () => {
  const writes = [];
  const fs = {
    readFileSync: () =>
      JSON.stringify({
        mcp: {
          servers: [
            { name: "browser", command: "npx", args: ["@demo/browser"], enabled: false },
          ],
        },
      }),
    mkdirSync: () => {},
    writeFileSync: (_path, value) => writes.push(String(value)),
  };

  const result = updateWatchMcpServerState({
    fs,
    configPath: "/tmp/agenc.json",
    serverName: "browser",
    enabled: true,
  });

  assert.equal(result.enabled, true);
  assert.match(writes[0], /"enabled": true/);
});
