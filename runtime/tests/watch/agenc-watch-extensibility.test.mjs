import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatchExtensibilityReport,
  clearWatchXaiApiKey,
  readWatchXaiConfigStatus,
  updateWatchMcpServerState,
  updateWatchTrustedPluginPackage,
  updateWatchXaiApiKey,
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

test("readWatchXaiConfigStatus reports masked local credentials", () => {
  const fs = {
    readFileSync(filePath) {
      if (filePath === "/tmp/agenc.pid") {
        return JSON.stringify({ configPath: "/tmp/agenc.json" });
      }
      return JSON.stringify({
        llm: {
          provider: "grok",
          model: "grok-4-1212",
          baseUrl: "https://api.x.ai/v1",
          apiKey: "xai-super-secret",
        },
      });
    },
  };

  const status = readWatchXaiConfigStatus({
    fs,
    env: {
      AGENC_PID_PATH: "/tmp/agenc.pid",
      AGENC_CONFIG_PATH: "/tmp/fallback.json",
    },
  });

  assert.equal(status.hasApiKey, true);
  assert.equal(status.provider, "grok");
  assert.equal(status.model, "grok-4-1212");
  assert.match(status.maskedApiKey, /^\*+cret$/);
});

test("updateWatchXaiApiKey writes the local grok provider and api key", () => {
  const writes = [];
  const fs = {
    readFileSync: () => JSON.stringify({ llm: { model: "grok-4-fast" } }),
    mkdirSync: () => {},
    writeFileSync: (_path, value) => writes.push(String(value)),
  };

  const result = updateWatchXaiApiKey({
    fs,
    configPath: "/tmp/agenc.json",
    apiKey: "xai-abc123",
  });

  assert.equal(result.provider, "grok");
  assert.equal(result.baseUrl, "https://api.x.ai/v1");
  assert.match(result.maskedApiKey, /^\*+c123$/);
  assert.match(writes[0], /"provider": "grok"/);
  assert.match(writes[0], /"apiKey": "xai-abc123"/);
});

test("clearWatchXaiApiKey removes the local api key and preserves other llm config", () => {
  const writes = [];
  const fs = {
    readFileSync: () =>
      JSON.stringify({
        llm: {
          provider: "grok",
          model: "grok-4-fast",
          baseUrl: "https://api.x.ai/v1",
          apiKey: "xai-abc123",
        },
      }),
    mkdirSync: () => {},
    writeFileSync: (_path, value) => writes.push(String(value)),
  };

  const result = clearWatchXaiApiKey({
    fs,
    configPath: "/tmp/agenc.json",
  });

  assert.equal(result.hadApiKey, true);
  assert.equal(result.provider, "grok");
  assert.equal(result.model, "grok-4-fast");
  assert.equal(result.baseUrl, "https://api.x.ai/v1");
  assert.equal(/"apiKey"/.test(writes[0]), false);
});
