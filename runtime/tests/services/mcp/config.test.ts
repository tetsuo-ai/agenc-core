import { describe, expect, test } from "vitest";

import {
  dedupPluginMcpServers,
  pluginMcpDuplicateSuppressionError,
} from "../../../src/services/mcp/config.js";
import type { ScopedMcpServerConfig } from "../../../src/services/mcp/types.js";

describe("MCP config plugin duplicate suppression", () => {
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
