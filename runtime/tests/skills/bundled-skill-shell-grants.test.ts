/**
 * Built-in (bundled) skills never pre-approve shell or process tools. Every
 * registry that turns a built-in definition into a skill drops such
 * `allowed-tools` entries with a warning; the shipped built-ins declare none.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { ConfigStore } from "../../src/config/store.js";
import {
  clearBuiltinPlugins,
  getBuiltinPluginSkillCommands,
  registerBuiltinPlugin,
} from "../../src/plugins/builtinPlugins.js";
import {
  getBundledSkills,
  registerBundledSkill,
} from "../../src/skills/bundledSkills.js";
import { loadLocalSkillsSnapshot } from "../../src/skills/local-loader.js";
import { parseToolRuleStringsFromCLI } from "../../src/permissions/settings.js";
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

/** Shell and process tools, lowercased: shell family, REPL tools, retired shell names. */
const SHELL_OR_PROCESS_TOOLS = new Set([
  "exec_command",
  "system.bash",
  "write_stdin",
  "kill_process",
  "powershell",
  "monitor",
  "js_repl",
  "js_repl_reset",
  "repl",
  "bash",
  "shell",
  "desktop.bash",
  "killshell",
  "bashoutputtool",
]);

function shellGrants(allowedTools: readonly string[] | undefined): string[] {
  return parseToolRuleStringsFromCLI([...(allowedTools ?? [])]).filter((rule) => {
    const open = rule.indexOf("(");
    const tool = (open === -1 ? rule : rule.slice(0, open)).trim().toLowerCase();
    return SHELL_OR_PROCESS_TOOLS.has(tool);
  });
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

const SHELL_HEAVY_ALLOWED_TOOLS = [
  "FileRead",
  "exec_command(git status:*)",
  "system.bash, Write",
  "PowerShell",
  "write_stdin",
  "kill_process",
  "Monitor",
  "js_repl",
  "Bash(git:*)",
];

describe("built-in skills and shell grants", () => {
  test("no shipped built-in skill pre-approves a shell or process tool", async () => {
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
    const registry = getBundledSkills();
    // The scan covers every built-in: the local loader's eleven and the registry's.
    expect(local.map((skill) => skill.name)).toEqual(expect.arrayContaining([
      "update-config", "keybindings", "debug", "simplify", "batch", "loop",
      "agenc-in-browser", "schedule-agents", "agenc-api", "ledger-wallet-cli", "verify",
    ]));
    expect(registry.length).toBeGreaterThan(0);

    const offenders = [
      ...local.map((skill) => [skill.name, shellGrants(skill.allowedTools)] as const),
      ...registry.map((command) => [
        command.name,
        shellGrants((command as { allowedTools?: readonly string[] }).allowedTools),
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

  test("a registered built-in skill loses shell and process grants with a warning", () => {
    registerBundledSkill({
      name: "shell-grant-probe",
      description: "Probe built-in skill",
      allowedTools: SHELL_HEAVY_ALLOWED_TOOLS,
      getPromptForCommand: async () => [],
    });
    const probe = getBundledSkills().find((command) => command.name === "shell-grant-probe");
    expect((probe as { allowedTools?: readonly string[] }).allowedTools).toEqual([
      "FileRead",
      "Write",
    ]);
    expect(debugLog.calls).toContainEqual([
      expect.stringContaining("shell-grant-probe cannot pre-approve exec_command(git status:*)"),
      { level: "warn" },
    ]);
  });

  test("a built-in plugin's skill loses shell and process grants", async () => {
    const pluginRoot = tempRoot("bundled-grants-plugin-");
    mkdirSync(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    writeFileSync(
      join(pluginRoot, ".agenc-plugin", "plugin.json"),
      JSON.stringify({ name: "shell-grant-plugin" }),
    );
    registerBuiltinPlugin({
      root: pluginRoot,
      skills: [{
        name: "plugin-shell-probe",
        description: "Probe built-in plugin skill",
        allowedTools: SHELL_HEAVY_ALLOWED_TOOLS,
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
    const probe = commands.find((command) => command.name === "plugin-shell-probe");
    expect((probe as { allowedTools?: readonly string[] }).allowedTools).toEqual([
      "FileRead",
      "Write",
    ]);
  });
});
