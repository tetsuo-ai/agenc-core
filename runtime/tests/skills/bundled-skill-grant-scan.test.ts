/**
 * Built-in (bundled) skills pre-approve only allowlisted built-in tools.
 * Every registry that turns a built-in definition into a skill drops any
 * other `allowed-tools` entry with a warning. The scan below loads every
 * shipped built-in skill and fails when one declares a grant outside the
 * allowlist: the guard would drop it and warn.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ConfigStore } from "../../src/config/store.js";
import { parseRuleString } from "../../src/permissions/rules.js";
import {
  clearBuiltinPlugins,
  getBuiltinPluginSkillCommands,
  registerBuiltinPlugin,
} from "../../src/plugins/builtinPlugins.js";
import { BUNDLED_SKILL_GRANTABLE_TOOLS } from "../../src/skills/bundled-skill-grants.js";
import {
  getBundledSkills,
  registerBundledSkill,
} from "../../src/skills/bundledSkills.js";
import { runWithCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";

const debugLog = vi.hoisted(() => ({ calls: [] as Array<[string, unknown]> }));

vi.mock("../../src/utils/debug.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/utils/debug.js")>();
  return {
    ...original,
    logForDebugging: (message: string, options?: unknown) => {
      debugLog.calls.push([message, options]);
      return original.logForDebugging(message, options as never);
    },
  };
});

function guardWarnings(): string[] {
  return debugLog.calls
    .map(([message]) => message)
    .filter((message) => message.startsWith("Built-in skill "));
}

function grantsOutsideAllowlist(allowedTools: readonly string[] | undefined): string[] {
  return (allowedTools ?? []).filter(
    (rule) => !BUNDLED_SKILL_GRANTABLE_TOOLS.has(parseRuleString(rule)?.toolName ?? rule),
  );
}

const roots: string[] = [];

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  debugLog.calls.length = 0;
  clearBuiltinPlugins();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const OUT_OF_LIST_ALLOWED_TOOLS = [
  "FileRead",
  "exec_command(git status:*)",
  "system.bash, Write",
  "PowerShell",
  "write_stdin",
  "kill_process",
  "Monitor",
  "js_repl",
  "Bash(git:*)",
  "mcp__terminal__exec_command",
  "mcp__terminal",
  "mcp__terminal__*",
  "MCP__Terminal__Exec_Command",
  "*",
  "WebFetch",
];

describe("built-in skills and their grants", () => {
  test("every grant a shipped built-in skill declares is on the allowlist", async () => {
    // Load the built-in registries afresh so their registration-time guard
    // runs inside this test and its warnings are captured.
    vi.resetModules();
    debugLog.calls.length = 0;
    const { loadLocalSkillsSnapshot } = await import("../../src/skills/local-loader.js");
    const bundled = await import("../../src/skills/bundledSkills.js");
    const agencHome = tempRoot("bundled-grants-home-");
    const workspaceRoot = tempRoot("bundled-grants-workspace-");
    const snapshot = await loadLocalSkillsSnapshot({
      agencHome,
      pluginStorageRoot: join(agencHome, "plugins"),
      workspaceRoot,
      config: {},
      env: {},
    });
    const local = snapshot.skills.filter((skill) => skill.source === "bundled");
    const registry = bundled.getBundledSkills();
    // The scan covers every built-in: the local loader's eleven and the registry's.
    expect(local.map((skill) => skill.name)).toEqual(expect.arrayContaining([
      "update-config", "keybindings", "debug", "simplify", "batch", "loop",
      "agenc-in-browser", "schedule-agents", "agenc-api", "ledger-wallet-cli", "verify",
    ]));
    expect(registry.length).toBeGreaterThan(0);

    // A declared grant outside the allowlist is dropped with this warning.
    expect(guardWarnings()).toEqual([]);
    const offenders = [
      ...local.map((skill) => [skill.name, grantsOutsideAllowlist(skill.allowedTools)] as const),
      ...registry.map((command) => [
        command.name,
        grantsOutsideAllowlist((command as { allowedTools?: readonly string[] }).allowedTools),
      ] as const),
    ].filter(([, grants]) => grants.length > 0);
    expect(offenders).toEqual([]);

    // Their read and file-edit grants stay as declared.
    const allowed = (name: string) => local.find((skill) => skill.name === name)?.allowedTools;
    expect(allowed("update-config")).toEqual(["FileRead", "Write", "Edit", "MultiEdit"]);
    expect(allowed("keybindings")).toEqual(["FileRead", "Write", "Edit", "MultiEdit"]);
    expect(allowed("debug")).toEqual(["FileRead", "Grep", "Glob"]);
    expect(allowed("ledger-wallet-cli")).toEqual([
      "ledger_wallet_cli_status",
      "install_ledger_wallet_cli",
    ]);
  });

  test("a registered built-in skill keeps only allowlisted grants, with a warning per other entry", () => {
    registerBundledSkill({
      name: "grant-probe",
      description: "Probe built-in skill",
      allowedTools: OUT_OF_LIST_ALLOWED_TOOLS,
      getPromptForCommand: async () => [],
    });
    const probe = getBundledSkills().find((command) => command.name === "grant-probe");
    expect((probe as { allowedTools?: readonly string[] }).allowedTools).toEqual([
      "FileRead",
      "Write",
    ]);
    const warnings = guardWarnings();
    expect(warnings).toHaveLength(14);
    expect(warnings).toContainEqual(
      expect.stringContaining("grant-probe cannot pre-approve exec_command(git status:*)"),
    );
    expect(warnings).toContainEqual(
      expect.stringContaining("grant-probe cannot pre-approve mcp__terminal__*: built-in skills never pre-approve MCP"),
    );
  });

  test("a built-in plugin's skill keeps only allowlisted grants", async () => {
    const pluginRoot = tempRoot("bundled-grants-plugin-");
    mkdirSync(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    writeFileSync(
      join(pluginRoot, ".agenc-plugin", "plugin.json"),
      JSON.stringify({ name: "grant-plugin" }),
    );
    registerBuiltinPlugin({
      root: pluginRoot,
      skills: [{
        name: "plugin-grant-probe",
        description: "Probe built-in plugin skill",
        allowedTools: OUT_OF_LIST_ALLOWED_TOOLS,
        getPromptForCommand: async () => [],
      }],
    });
    const settingsRoot = tempRoot("bundled-grants-settings-");
    writeFileSync(join(settingsRoot, "config.toml"), "config_version = 2\n", "utf8");
    const store = new ConfigStore({
      home: join(settingsRoot, "home"),
      cwd: settingsRoot,
      projectRoot: settingsRoot,
      projectTrusted: false,
      env: { AGENC_HOME: join(settingsRoot, "home"), HOME: settingsRoot },
      userConfigPath: join(settingsRoot, "config.toml"),
    });
    await store.reload();
    const commands = await runWithCanonicalSettingsAuthority(store, () =>
      getBuiltinPluginSkillCommands()
    );
    const probe = commands.find((command) => command.name === "plugin-grant-probe");
    expect((probe as { allowedTools?: readonly string[] }).allowedTools).toEqual([
      "FileRead",
      "Write",
    ]);
  });
});
