import { describe, expect, test } from "vitest";

import {
  dedupPluginMcpServers,
  pluginMcpDuplicateSuppressionError,
} from "../../../src/services/mcp/config.js";
import type { ScopedMcpServerConfig } from "../../../src/services/mcp/types.js";

describe("MCP config plugin duplicate suppression", () => {
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
