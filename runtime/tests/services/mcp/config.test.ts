import { describe, expect, test } from "vitest";

import {
  dedupPluginMcpServers,
  getMcpServerSignature,
  pluginMcpDuplicateSuppressionError,
} from "../../../src/services/mcp/config.js";
import type { ScopedMcpServerConfig } from "../../../src/services/mcp/types.js";
import { mcpServerDefinitionId } from "../../../src/services/mcp/utils.js";

describe("MCP config plugin duplicate suppression", () => {
  test("snapshot launch fields do not change the installed definition identity", () => {
    const installed: ScopedMcpServerConfig = {
      scope: "dynamic", command: "node", args: ["/plugins/sample/server.mjs"], cwd: "/plugins/sample",
      pluginServer: { pluginName: "sample", serverName: "main", pluginRoot: "/plugins/sample",
        snapshotRoot: "/cache/digest" },
    };
    const withLaunch: ScopedMcpServerConfig = { ...installed, pluginServer: {
      ...installed.pluginServer!, snapshotLaunch: { command: "node", args: ["/cache/digest/server.mjs"], cwd: "/cache/digest" },
    } };
    expect(mcpServerDefinitionId("plugin:sample:main", withLaunch))
      .toBe(mcpServerDefinitionId("plugin:sample:main", installed));
    expect(getMcpServerSignature(withLaunch)).toBe(getMcpServerSignature(installed));
  });
  test("keeps identical relative entry points from different plugin directories", () => {
    const common = { scope: "dynamic" as const, command: "node", args: ["./server/main.mjs"] };
    const plugins = {
      "plugin:first:api": { ...common, cwd: "/plugins/first" },
      "plugin:second:api": { ...common, cwd: "/plugins/second" },
    };
    const result = dedupPluginMcpServers(plugins, {});
    expect(result.servers).toEqual(plugins);
    expect(result.suppressed).toEqual([]);
  });

  test.each([undefined, "/workspaces/project"])(
    "does not equate a plugin directory with a manual cwd of %s",
    (cwd) => {
      const plugin: ScopedMcpServerConfig = {
        scope: "dynamic", command: "node", args: ["server.mjs"], cwd: "/plugins/sample",
      };
      const result = dedupPluginMcpServers({ plugin }, {
        manual: { scope: "user", command: "node", args: ["server.mjs"], ...(cwd === undefined ? {} : { cwd }) },
      });
      expect(result.servers).toEqual({ plugin });
      expect(result.suppressed).toEqual([]);
    },
  );

  test("still suppresses duplicate launches with the same explicit directory", () => {
    const plugin: ScopedMcpServerConfig = {
      scope: "dynamic", command: "node", args: ["server.mjs"], cwd: "/plugins/sample",
    };
    expect(dedupPluginMcpServers({ first: plugin, second: plugin }, {}).suppressed)
      .toMatchObject([{ name: "second", duplicateOf: "first" }]);
    expect(dedupPluginMcpServers({ plugin }, { manual: { ...plugin, scope: "user" } }).suppressed)
      .toMatchObject([{ name: "plugin", duplicateOf: "manual" }]);
  });

  test("reports raw plugin server identity for normalized scoped keys", () => {
    const pluginServer: ScopedMcpServerConfig = {
      scope: "dynamic",
      command: "node",
      args: ["server.js"],
      pluginSource: "sample@official",
      pluginServer: {
        pluginName: "sample",
        serverName: "123/../Escape Server!",
      },
    };

    const result = dedupPluginMcpServers(
      {
        "plugin:sample:cmd_123_escape_server": pluginServer,
      },
      {
        local: {
          scope: "user",
          command: "node",
          args: ["server.js"],
        },
      },
    );

    expect(result.servers).toEqual({});
    expect(result.suppressed).toHaveLength(1);
    expect(pluginMcpDuplicateSuppressionError(result.suppressed[0]!))
      .toMatchObject({
        type: "mcp-server-suppressed-duplicate",
        source: "plugin:sample:cmd_123_escape_server",
        plugin: "sample",
        serverName: "123/../Escape Server!",
        duplicateOf: "local",
      });
  });
});
