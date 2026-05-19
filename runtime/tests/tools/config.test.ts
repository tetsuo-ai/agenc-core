import { describe, expect, test } from "vitest";
import {
  resolvePerToolConfig,
  toolConfigAllowsTool,
} from "./config.js";

describe("tools_config per-tool resolution", () => {
  test("boolean entries enable or disable exact tool names", () => {
    const config = {
      exec_command: false,
      Write: true,
    };

    expect(toolConfigAllowsTool(config, "exec_command")).toBe(false);
    expect(toolConfigAllowsTool(config, "Write")).toBe(true);
    expect(toolConfigAllowsTool(config, "FileRead")).toBe(true);
  });

  test("object entries carry enabled and default_permission_mode", () => {
    const config = {
      Edit: {
        enabled: true,
        default_permission_mode: "never",
      },
    };

    expect(resolvePerToolConfig(config, "Edit")).toEqual({
      enabled: true,
      defaultPermissionMode: "never",
    });
  });

  test("dotted TOML tables resolve to dotted tool names", () => {
    const config = {
      system: {
        bash: {
          enabled: false,
          defaultPermissionMode: "untrusted",
        },
      },
    };

    expect(toolConfigAllowsTool(config, "system.bash")).toBe(false);
    expect(resolvePerToolConfig(config, "system.bash")).toEqual({
      enabled: false,
      defaultPermissionMode: "untrusted",
    });
  });

  test("enabled_tools and disabled_tools are applied before per-tool defaults", () => {
    const config = {
      enabled_tools: ["FileRead", "Grep"],
      disabled_tools: ["Grep"],
    };

    expect(toolConfigAllowsTool(config, "FileRead")).toBe(true);
    expect(toolConfigAllowsTool(config, "Grep")).toBe(false);
    expect(toolConfigAllowsTool(config, "Write")).toBe(false);
  });

  test("web_search shorthand aliases model-facing and provider-native names", () => {
    const config = {
      web_search: false,
    };

    expect(toolConfigAllowsTool(config, "WebSearch")).toBe(false);
    expect(toolConfigAllowsTool(config, "web_search")).toBe(false);
  });

  test("approval_mode compatibility alias maps approve and prompt", () => {
    expect(
      resolvePerToolConfig(
        { "mcp.docs.search": { approval_mode: "approve" } },
        "mcp.docs.search",
      ),
    ).toEqual({ defaultPermissionMode: "never" });
    expect(
      resolvePerToolConfig(
        { "mcp.docs.delete": { approval_mode: "prompt" } },
        "mcp.docs.delete",
      ),
    ).toEqual({ defaultPermissionMode: "untrusted" });
  });
});
