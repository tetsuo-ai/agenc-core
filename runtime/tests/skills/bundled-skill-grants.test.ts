import { describe, expect, test } from "vitest";

import {
  BUNDLED_SKILL_GRANTABLE_TOOLS,
  bundledSkillAllowedTools,
  bundledSkillGrantRefusal,
  isShellOrProcessToolRule,
} from "../../src/skills/bundled-skill-grants.js";

describe("built-in skill grant allowlist", () => {
  test("the allowlist is what the shipped built-in skills use, with no shell or process tool", () => {
    expect([...BUNDLED_SKILL_GRANTABLE_TOOLS].sort()).toEqual([
      "Edit",
      "FileRead",
      "Glob",
      "Grep",
      "MultiEdit",
      "Write",
      "install_ledger_wallet_cli",
      "ledger_wallet_cli_status",
    ]);
    for (const tool of BUNDLED_SKILL_GRANTABLE_TOOLS) {
      expect(isShellOrProcessToolRule(tool)).toBe(false);
    }
  });

  test.each([
    "FileRead",
    "Write",
    "Edit(./docs/**)",
    "MultiEdit",
    "Grep",
    "Glob",
    "FileRead(*)",
    "ledger_wallet_cli_status",
    "install_ledger_wallet_cli",
  ])("keeps %s", (rule) => {
    expect(bundledSkillGrantRefusal(rule)).toBeNull();
  });

  test.each([
    "exec_command",
    "exec_command(git status:*)",
    "system.bash",
    "system.bash(npm test)",
    "PowerShell",
    "powershell",
    "write_stdin",
    "kill_process",
    "Monitor",
    "js_repl",
    "js_repl_reset",
    "REPL",
    "Bash",
    "Bash(git:*)",
    "bash",
    "shell",
    "desktop.bash",
    "KillShell",
    "BashOutputTool",
  ])("refuses shell or process tool %s", (rule) => {
    expect(isShellOrProcessToolRule(rule)).toBe(true);
    expect(bundledSkillGrantRefusal(rule)).toMatch(/shell or process tools/u);
  });

  test.each([
    "mcp__terminal__exec_command",
    "mcp__terminal",
    "mcp__terminal__*",
    "MCP__Terminal__Exec_Command",
    "Mcp__terminal",
    "mcp.terminal.exec_command",
    "mcp:terminal",
    "mcp",
    "mcp__ledger__ledger_wallet_cli_status",
    "mcp__docs__search",
    "mcp__*",
  ])("refuses MCP grant %s", (rule) => {
    expect(bundledSkillGrantRefusal(rule)).toMatch(/MCP tools or servers/u);
  });

  test.each(["*", "File*", "Fil?Read"])("refuses wildcard grant %s", (rule) => {
    expect(bundledSkillGrantRefusal(rule)).toMatch(/wildcard/u);
  });

  test.each([
    "fileread",
    "Read",
    "apply_patch",
    "WebFetch",
    "Skill(deep-review)",
    "exec_command(git",
  ])("refuses %s, a tool off the allowlist", (rule) => {
    expect(bundledSkillGrantRefusal(rule)).not.toBeNull();
  });

  test("splits declared entries and keeps the allowlisted rules in order", () => {
    expect(
      bundledSkillAllowedTools("probe", [
        "FileRead, exec_command",
        "Edit(./docs/**) PowerShell",
        "mcp__terminal__exec_command mcp__terminal",
        "write_stdin",
        "Grep",
        "WebFetch",
      ]),
    ).toEqual(["FileRead", "Edit(./docs/**)", "Grep"]);
    expect(bundledSkillAllowedTools("probe", undefined)).toEqual([]);
  });
});
