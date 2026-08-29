import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseToml } from "../../src/config/loader.js";
import { checkConfigV2Migration } from "../../src/config/migration.js";

const temporaryDirectories: string[] = [];

function temp(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), `${prefix}-`));
  temporaryDirectories.push(path);
  return path;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

async function migrateHome(home: string) {
  return checkConfigV2Migration({
    env: {},
    home,
    projectRoot: join(dirname(home), "project"),
    managedConfigPath: join(dirname(home), "managed", "config.toml"),
    managedSettingsPath: join(
      dirname(home),
      "managed",
      "managed-settings.json",
    ),
    globalStatePath: join(dirname(home), "missing-global.json"),
    id: "permission-controls",
  });
}

function migratedConfig(plan: Awaited<ReturnType<typeof migrateHome>>) {
  const content = plan.writes.find((write) => write.kind === "config")?.content;
  expect(content).toBeDefined();
  return parseToml(content ?? "");
}

describe("legacy permission-control migration", () => {
  test("consolidates settings JSON controls into their sole v2 keys", async () => {
    const root = temp("agenc-permission-settings-migration");
    const home = join(root, "home");
    write(
      join(home, "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(git status)"],
          allowBypassPermissionsMode: true,
          disableAutoMode: "disable",
          allowManagedPermissionRulesOnly: true,
        },
      }),
    );

    const plan = await migrateHome(home);

    expect(plan.conflicts).toEqual([]);
    expect(migratedConfig(plan)).toMatchObject({
      config_version: 2,
      disableAutoMode: "disable",
      allowManagedPermissionRulesOnly: true,
      permissions: {
        allow: ["system.bash(git status)"],
        bypassPermissionsMode: "allow",
      },
    });
  });

  test("rewrites retired tool names without changing escaped rule content", async () => {
    const root = temp("agenc-permission-tool-name-migration");
    const home = join(root, "home");
    write(
      join(home, "settings.json"),
      JSON.stringify({
        permissions: {
          allow: [
            "Bash(git \\(status\\))",
            "system.bash(git \\(status\\))",
            "Read",
            "FileReadTool(path \\(one\\))",
            "FileEdit",
            "FileEditTool",
            "FileWrite",
            "FileWriteTool",
            "system.grep",
            "system.glob",
          ],
          deny: ["WebFetch", "Brief", "Task", "KillShell"],
          ask: ["AgentOutputTool", "BashOutputTool", "bash", "desktop.bash", "shell"],
        },
      }),
    );

    const plan = await migrateHome(home);

    expect(plan.conflicts).toEqual([]);
    expect(migratedConfig(plan)).toMatchObject({
      permissions: {
        allow: [
          "system.bash(git \\(status\\))",
          "FileRead",
          "FileRead(path \\(one\\))",
          "Edit",
          "Write",
          "Grep",
          "Glob",
        ],
        deny: ["web_fetch", "SendUserMessage", "spawn_agent", "TaskStop"],
        ask: ["TaskOutput", "system.bash"],
      },
    });
  });

  test("consolidates the v1 TOML aliases into their sole v2 keys", async () => {
    const root = temp("agenc-permission-v1-migration");
    const home = join(root, "home");
    write(
      join(home, "config.toml"),
      [
        "configVersion = 1",
        "[permissions]",
        'disableBypassPermissionsMode = "disable"',
        'disableAutoMode = "disable"',
        "allowManagedPermissionRulesOnly = true",
        "",
      ].join("\n"),
    );

    const plan = await migrateHome(home);

    expect(plan.conflicts).toEqual([]);
    expect(migratedConfig(plan)).toMatchObject({
      config_version: 2,
      disableAutoMode: "disable",
      allowManagedPermissionRulesOnly: true,
      permissions: { bypassPermissionsMode: "disable" },
    });
  });

  test("fails closed when legacy bypass aliases disagree", async () => {
    const root = temp("agenc-permission-conflict-migration");
    const home = join(root, "home");
    write(
      join(home, "config.toml"),
      [
        "configVersion = 1",
        "[permissions]",
        'disableBypassPermissionsMode = "disable"',
        "allowBypassPermissionsMode = true",
        "",
      ].join("\n"),
    );

    const plan = await migrateHome(home);

    expect(plan.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        field: "permissions",
        reason: expect.stringMatching(/conflict|losslessly/u),
      }),
    ]));
    expect(plan.writes).toEqual([]);
  });
});
