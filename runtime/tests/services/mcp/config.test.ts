import { beforeEach, describe, expect, test, vi } from "vitest";

const projectConfig: {
  enabledMcpServers?: string[];
  disabledMcpServers?: string[];
} = {};

vi.mock("../../../src/utils/config.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    getCurrentProjectConfig: () => projectConfig,
    saveCurrentProjectConfig: (update: (current: unknown) => unknown) => {
      Object.assign(projectConfig, update({ ...projectConfig }));
    },
  };
});

import {
  dedupPluginMcpServers,
  isMcpServerDisabled,
  pluginMcpDuplicateSuppressionError,
  setMcpServerEnabled,
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

describe("a plugin's MCP server is opt-in", () => {
  beforeEach(() => {
    delete projectConfig.enabledMcpServers;
    delete projectConfig.disabledMcpServers;
  });

  test("arrives disabled, because installing is not approving", () => {
    // A stdio server is a command core spawns. Installing a plugin used to be
    // the same act as running whatever it declared.
    expect(isMcpServerDisabled("plugin:ledger:agenc-market")).toBe(true);
  });

  test("a hand-configured server is untouched — it was already a decision", () => {
    expect(isMcpServerDisabled("my-own-server")).toBe(false);
  });

  test("enabling writes the list the check reads", () => {
    // The two halves have to agree on which list governs. Toggling the
    // disabled list here reported success and changed nothing.
    setMcpServerEnabled("plugin:ledger:agenc-market", true);
    expect(projectConfig.enabledMcpServers).toContain(
      "plugin:ledger:agenc-market",
    );
    expect(isMcpServerDisabled("plugin:ledger:agenc-market")).toBe(false);
  });

  test("and disabling takes it back off", () => {
    setMcpServerEnabled("plugin:ledger:agenc-market", true);
    setMcpServerEnabled("plugin:ledger:agenc-market", false);
    expect(isMcpServerDisabled("plugin:ledger:agenc-market")).toBe(true);
  });

  test("one plugin's approval does not carry to another", () => {
    setMcpServerEnabled("plugin:ledger:agenc-market", true);
    expect(isMcpServerDisabled("plugin:iot-builder:iot-serial")).toBe(true);
  });
});
