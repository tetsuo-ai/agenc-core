import { describe, expect, test } from "vitest";
import {
  NON_INTERACTIVE_HIDDEN_TOOLS,
  resolvePerToolConfig,
  toolConfigAllowsTool,
  withDisabledTools,
} from "./config.js";

describe("tools_config per-tool resolution", () => {
  test("only canonical list fields enable or disable exact tool names", () => {
    const config = {
      enabled_tools: ["exec_command", "Write"],
      disabled_tools: ["Write"],
    };

    expect(toolConfigAllowsTool(config, "exec_command")).toBe(true);
    expect(toolConfigAllowsTool(config, "Write")).toBe(false);
    expect(toolConfigAllowsTool(config, "FileRead")).toBe(false);
  });

  test("per-tool objects carry only default_permission_mode", () => {
    const config = {
      Edit: {
        default_permission_mode: "never",
      },
    };

    expect(resolvePerToolConfig(config, "Edit")).toEqual({
      defaultPermissionMode: "never",
    });
  });

  test("dotted dispatch names must be represented as exact keys", () => {
    const config = {
      disabled_tools: ["system.bash"],
      "system.bash": {
        default_permission_mode: "untrusted",
      },
    };

    expect(toolConfigAllowsTool(config, "system.bash")).toBe(false);
    expect(resolvePerToolConfig(config, "system.bash")).toEqual({
      defaultPermissionMode: "untrusted",
    });
    expect(resolvePerToolConfig({ system: { bash: {
      default_permission_mode: "never",
    } } }, "system.bash")).toEqual({});
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

  test("list matching does not alias provider-native and dispatch names", () => {
    const config = {
      disabled_tools: ["WebSearch"],
    };

    expect(toolConfigAllowsTool(config, "WebSearch")).toBe(false);
    expect(toolConfigAllowsTool(config, "web_search")).toBe(true);
  });
});

describe("withDisabledTools", () => {
  test("hides the non-interactive tools on top of an absent config", () => {
    const config = withDisabledTools(undefined, NON_INTERACTIVE_HIDDEN_TOOLS);

    expect(config.disabled_tools).toEqual(["AskUserQuestion"]);
    expect(toolConfigAllowsTool(config, "AskUserQuestion")).toBe(false);
    expect(toolConfigAllowsTool(config, "exec_command")).toBe(true);
  });

  test("keeps the operator's lists and per-tool defaults, without duplicates", () => {
    const config = withDisabledTools(
      {
        enabled_tools: ["AskUserQuestion", "FileRead"],
        disabled_tools: ["Write", "AskUserQuestion"],
        Edit: { default_permission_mode: "never" },
      },
      ["AskUserQuestion", "TodoWrite"],
    );

    expect(config.disabled_tools).toEqual(["Write", "AskUserQuestion", "TodoWrite"]);
    expect(config.enabled_tools).toEqual(["AskUserQuestion", "FileRead"]);
    expect(resolvePerToolConfig(config, "Edit")).toEqual({
      defaultPermissionMode: "never",
    });
    // An allowlist entry does not bring a hidden tool back.
    expect(toolConfigAllowsTool(config, "AskUserQuestion")).toBe(false);
    expect(toolConfigAllowsTool(config, "FileRead")).toBe(true);
  });
});
