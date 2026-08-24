import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { parseToml } from "../../src/config/loader.js";
import { ConfigStore } from "../../src/config/store.js";
import {
  addPermissionRulesToConfig,
  deletePermissionRule,
  getEnabledSettingSources,
  getSettingsFilePathForSource,
  initialPermissionModeFromCLI,
  initializeToolPermissionContext,
  loadAllPermissionRulesFromConfig,
  parseBaseToolsFromCLI,
  parseToolListFromCLI,
  readCanonicalPermissionConfig,
  permissionSettingsToRules,
  shouldAllowManagedPermissionRulesOnly,
  syncPermissionRulesFromConfig,
  type DiskEnv,
} from "../../src/permissions/settings.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "agenc-permission-config-"));
  temporaryDirectories.push(path);
  return path;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function canonicalEnv(params: {
  readonly user?: string;
  readonly project?: string;
  readonly local?: string;
  readonly managed?: string;
} = {}): Promise<DiskEnv & { readonly configStore: ConfigStore }> {
  const root = temporaryDirectory();
  const home = join(root, "home");
  const projectRoot = join(root, "repo");
  mkdirSync(join(projectRoot, ".git"), { recursive: true });
  if (params.user) write(join(home, "config.toml"), params.user);
  if (params.project) write(join(projectRoot, ".agenc", "config.toml"), params.project);
  if (params.local) write(join(projectRoot, ".agenc", "config.local.toml"), params.local);
  const managedConfigPath = join(root, "managed", "config.toml");
  if (params.managed) write(managedConfigPath, params.managed);
  const configStore = new ConfigStore({
    home,
    cwd: projectRoot,
    projectRoot,
    projectTrusted: true,
    managedConfigPath,
    managedDropInDir: join(root, "managed", "config.d"),
    env: { ...process.env, AGENC_HOME: home },
  });
  await configStore.reload();
  return { home, cwd: projectRoot, managedConfigPath, configStore };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("canonical permission paths", () => {
  test("resolves only TOML-backed editable sources", () => {
    const env = { home: "/agenc-home", cwd: "/repo" };
    expect(getSettingsFilePathForSource("userSettings", env)).toBe("/agenc-home/config.toml");
    expect(getSettingsFilePathForSource("projectSettings", env)).toBe("/repo/.agenc/config.toml");
    expect(getSettingsFilePathForSource("localSettings", env)).toBe("/repo/.agenc/config.local.toml");
    expect(getSettingsFilePathForSource("session", env)).toBeNull();
  });

  test("reads an explicit strict TOML permission layer", async () => {
    const root = temporaryDirectory();
    const path = join(root, "config.toml");
    write(path, 'config_version = 2\n[permissions]\nallow = ["FileRead"]\n');
    await expect(readCanonicalPermissionConfig(path, "user")).resolves.toMatchObject({
      permissions: { allow: ["FileRead"] },
    });
    write(path, 'config_version = 2\nunknown_permission_authority = true\n');
    await expect(readCanonicalPermissionConfig(path, "user")).rejects.toThrow(/unknown/u);
  });
});

describe("canonical permission projection", () => {
  test("converts allow, deny, and ask rules with source provenance", () => {
    const rules = permissionSettingsToRules({
      permissions: { allow: ["FileRead"], deny: ["system.bash(rm:*)"], ask: ["Edit"] },
    }, "userSettings");
    expect(rules.map((rule) => [rule.source, rule.ruleBehavior])).toEqual([
      ["userSettings", "allow"],
      ["userSettings", "deny"],
      ["userSettings", "ask"],
    ]);
  });

  test("recognizes the sole top-level managed-only policy gate", () => {
    expect(shouldAllowManagedPermissionRulesOnly({ allowManagedPermissionRulesOnly: true })).toBe(true);
    expect(shouldAllowManagedPermissionRulesOnly(null)).toBe(false);
  });

  test("loads every strict layer and preserves source provenance", async () => {
    const env = await canonicalEnv({
      user: 'config_version = 2\n[permissions]\nallow = ["FileRead"]\n',
      project: 'config_version = 2\n[permissions]\nask = ["Edit"]\n',
      local: 'config_version = 2\n[permissions]\ndeny = ["system.bash(rm:*)"]\n',
    });
    const rules = await loadAllPermissionRulesFromConfig(env);
    expect(rules.map((rule) => rule.source)).toEqual([
      "userSettings",
      "projectSettings",
      "localSettings",
    ]);
  });

  test("managed-only policy removes lower-priority and session grants on sync", async () => {
    const env = await canonicalEnv({
      user: 'config_version = 2\n[permissions]\nallow = ["FileRead"]\n',
      managed: 'config_version = 2\nallowManagedPermissionRulesOnly = true\n[permissions]\ndeny = ["system.bash(curl:*)"]\n',
    });
    const current = createEmptyToolPermissionContext({
      alwaysAllowRules: { session: ["Write"], cliArg: ["Edit"] },
    });
    const synced = await syncPermissionRulesFromConfig(current, env);
    expect(synced.alwaysAllowRules.session).toEqual([]);
    expect(synced.alwaysAllowRules.cliArg).toEqual([]);
    expect(synced.alwaysDenyRules.policySettings).toEqual(["system.bash(curl:*)"]);
  });
});

describe("canonical permission persistence", () => {
  test("writes and deletes user rules through config.toml", async () => {
    const env = await canonicalEnv();
    await expect(addPermissionRulesToConfig({
      destination: "userSettings",
      behavior: "allow",
      rules: [{ toolName: "FileRead" }],
      env,
    })).resolves.toBe(true);
    expect(parseToml(readFileSync(join(env.home!, "config.toml"), "utf8"))).toMatchObject({
      config_version: 2,
      permissions: { allow: ["FileRead"] },
    });
    await expect(deletePermissionRule({
      destination: "userSettings",
      rule: { source: "userSettings", ruleBehavior: "allow", ruleValue: { toolName: "FileRead" } },
      env,
    })).resolves.toBe(true);
    expect(parseToml(readFileSync(join(env.home!, "config.toml"), "utf8"))).toMatchObject({
      permissions: { allow: [] },
    });
  });

  test("repository config rejects grants but accepts restrictions", async () => {
    const env = await canonicalEnv();
    await expect(addPermissionRulesToConfig({
      destination: "projectSettings",
      behavior: "allow",
      rules: [{ toolName: "FileRead" }],
      env,
    })).resolves.toBe(false);
    await expect(addPermissionRulesToConfig({
      destination: "projectSettings",
      behavior: "deny",
      rules: [{ toolName: "system.bash", ruleContent: "rm:*" }],
      env,
    })).resolves.toBe(true);
    expect(parseToml(readFileSync(join(env.cwd!, ".agenc", "config.toml"), "utf8"))).toMatchObject({
      permissions: { deny: ["system.bash(rm:*)"] },
    });
  });
});

describe("permission CLI/mode helpers", () => {
  test("parses comma and whitespace separated rules without splitting parentheses", () => {
    expect(parseToolListFromCLI(["FileRead, system.bash(git commit:*) Write"]).map((rule) => rule.ruleValue)).toEqual([
      { toolName: "FileRead" },
      { toolName: "system.bash", ruleContent: "git commit:*" },
      { toolName: "Write" },
    ]);
    expect(parseBaseToolsFromCLI(["FileRead Edit"])).toHaveLength(2);
  });

  test("uses explicit dangerous bypass first unless managed policy disables it", () => {
    expect(initialPermissionModeFromCLI({ dangerouslySkipPermissions: true })).toEqual({
      mode: "bypassPermissions",
      notification: undefined,
    });
    expect(initialPermissionModeFromCLI({
      dangerouslySkipPermissions: true,
      permissionModeCli: "plan",
      policySettings: { permissions: { bypassPermissionsMode: "disable" } },
    })).toEqual({
      mode: "plan",
      notification: "Bypass permissions mode was disabled by configuration",
    });
  });

  test("initialization ignores repository grants while retaining restrictions", async () => {
    const env = await canonicalEnv({
      project: 'config_version = 2\n[permissions]\nallow = ["FileRead"]\nask = ["Edit"]\n',
      local: 'config_version = 2\n[permissions]\ndeny = ["system.bash(rm:*)"]\n',
    });
    const { toolPermissionContext, warnings } = await initializeToolPermissionContext({ env });
    expect(toolPermissionContext.alwaysAllowRules.projectSettings ?? []).toEqual([]);
    expect(toolPermissionContext.alwaysAskRules.projectSettings).toEqual(["Edit"]);
    expect(toolPermissionContext.alwaysDenyRules.localSettings).toEqual(["system.bash(rm:*)"]);
    expect(warnings.join(" ")).toMatch(/Ignored 1 repository-controlled/u);
  });

  test("initialization cannot reintroduce grants after managed-only filtering", async () => {
    const env = await canonicalEnv({
      user: [
        "config_version = 2",
        "[permissions]",
        'allow = ["Write"]',
        'additionalDirectories = ["/user-extra"]',
        "",
      ].join("\n"),
      managed: [
        "config_version = 2",
        "allowManagedPermissionRulesOnly = true",
        "[permissions]",
        'allow = ["FileRead"]',
        'deny = ["system.bash(curl:*)"]',
        'additionalDirectories = ["/managed-extra"]',
        "",
      ].join("\n"),
    });

    const { toolPermissionContext, warnings } =
      await initializeToolPermissionContext({
        env,
        cliAllows: ["Edit"],
        addDirs: ["/cli-extra"],
      });

    expect(toolPermissionContext.alwaysAllowRules.userSettings ?? []).toEqual([]);
    expect(toolPermissionContext.alwaysAllowRules.cliArg ?? []).toEqual([]);
    expect(toolPermissionContext.alwaysAllowRules.session ?? []).toEqual([]);
    expect(toolPermissionContext.alwaysAllowRules.policySettings).toEqual(["FileRead"]);
    expect(toolPermissionContext.alwaysDenyRules.policySettings).toEqual([
      "system.bash(curl:*)",
    ]);
    expect([...toolPermissionContext.additionalWorkingDirectories.values()])
      .toEqual([{ path: "/managed-extra", source: "policySettings" }]);
    expect(warnings).toContain(
      "Ignored --add-dir because managed policy allows only managed permission rules",
    );
  });

  test("enumerates only the five canonical file-backed source projections", () => {
    expect(getEnabledSettingSources()).toEqual([
      "userSettings",
      "projectSettings",
      "localSettings",
      "flagSettings",
      "policySettings",
    ]);
  });
});
