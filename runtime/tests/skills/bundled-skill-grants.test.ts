import { describe, expect, test } from "vitest";

import {
  bundledSkillAllowedTools,
  isShellOrProcessToolRule,
} from "../../src/skills/bundled-skill-grants.js";

describe("built-in skill grant filter", () => {
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
  ])("treats %s as a shell or process tool", (rule) => {
    expect(isShellOrProcessToolRule(rule)).toBe(true);
  });

  test.each([
    "FileRead",
    "Write",
    "Edit(./docs/**)",
    "MultiEdit",
    "Grep",
    "Glob",
    "apply_patch",
    "Skill(deep-review)",
    "ledger_wallet_cli_status",
    "install_ledger_wallet_cli",
    "mcp__docs__search",
  ])("keeps %s", (rule) => {
    expect(isShellOrProcessToolRule(rule)).toBe(false);
  });

  test("splits declared entries and keeps the non-shell rules in order", () => {
    expect(
      bundledSkillAllowedTools("probe", [
        "FileRead, exec_command",
        "Edit(./docs/**) PowerShell",
        "write_stdin",
        "Grep",
      ]),
    ).toEqual(["FileRead", "Edit(./docs/**)", "Grep"]);
    expect(bundledSkillAllowedTools("probe", undefined)).toEqual([]);
  });
});
