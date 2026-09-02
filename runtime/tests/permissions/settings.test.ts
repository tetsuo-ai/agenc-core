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

import {
  getAllowedSettingSources,
  setAllowedSettingSources,
} from "../../src/bootstrap/state.js";
import { parseToml } from "../../src/config/loader.js";
import { resolveHomeContext } from "../../src/config/home.js";
import { RuntimeStateRepository } from "../../src/config/runtime-state-repository.js";
import { ConfigStore } from "../../src/config/store.js";
import type { AgenCConfig } from "../../src/config/schema.js";
import {
  SETTING_SOURCES as CANONICAL_SETTING_SOURCES,
  getEnabledSettingSources,
} from "../../src/utils/settings/constants.js";
import {
  addPermissionRulesToConfig,
  deletePermissionRule,
  initialPermissionModeFromCLI,
  initializeToolPermissionContext,
  loadAllPermissionRulesFromConfig,
  loadPermissionRulesSnapshot,
  parseBaseToolsFromCLI,
  parseToolListFromCLI,
  permissionSettingsToRules,
  shouldAllowManagedPermissionRulesOnly,
  syncPermissionRulesFromConfig,
  type DiskEnv,
} from "../../src/permissions/settings.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
} from "../../src/permissions/types.js";
import {
  __setAutoModeGateResolverForTesting,
  transitionPermissionMode,
} from "../../src/permissions/permission-mode.js";
import {
  canonicalizeBypassPermissionsCwd,
  loadBypassPermissionsConsent,
  recordBypassPermissionsConsent,
} from "../../src/permissions/bypass-consent-state.js";

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
  readonly diskState?: boolean;
  readonly cliOverrides?: AgenCConfig;
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
  const stateRepository = params.diskState === true
    ? new RuntimeStateRepository(
        resolveHomeContext(
          { AGENC_HOME: home, HOME: root },
          { platformHome: root },
        ),
        { storage: "disk" },
      )
    : undefined;
  const configStore = new ConfigStore({
    home,
    cwd: projectRoot,
    projectRoot,
    projectTrusted: true,
    managedConfigPath,
    managedDropInDir: join(root, "managed", "config.d"),
    env: { ...process.env, AGENC_HOME: home },
    ...(params.cliOverrides !== undefined
      ? { cliOverrides: params.cliOverrides }
      : {}),
    ...(stateRepository !== undefined ? { stateRepository } : {}),
  });
  await configStore.reload();
  return { home, cwd: projectRoot, managedConfigPath, configStore };
}

async function restartCanonicalEnv(
  env: DiskEnv & { readonly configStore: ConfigStore },
  cwd = env.cwd!,
): Promise<DiskEnv & { readonly configStore: ConfigStore }> {
  env.configStore.stateRepository.close();
  const stateRepository = new RuntimeStateRepository(
    resolveHomeContext({ AGENC_HOME: env.home, HOME: env.home }),
    { storage: "disk" },
  );
  const configStore = new ConfigStore({
    home: env.home,
    cwd,
    projectRoot: cwd,
    projectTrusted: true,
    managedConfigPath: env.managedConfigPath,
    managedDropInDir: join(dirname(env.managedConfigPath!), "config.d"),
    env: { ...process.env, AGENC_HOME: env.home },
    stateRepository,
  });
  await configStore.reload();
  return { ...env, cwd, configStore };
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("canonical permission projection", () => {
  test("preserves canonical global precedence for every enabled subset", () => {
    const originalSources = [...getAllowedSettingSources()];
    try {
      const configurable = [
        "userSettings",
        "projectSettings",
        "localSettings",
      ] as const;
      for (let mask = 0; mask < 1 << configurable.length; mask += 1) {
        const subset = configurable
          .filter((_, index) => (mask & (1 << index)) !== 0)
          .reverse();
        setAllowedSettingSources(subset);
        const enabled = new Set([
          ...subset,
          "flagSettings" as const,
          "policySettings" as const,
        ]);
        expect(getEnabledSettingSources()).toEqual(
          CANONICAL_SETTING_SOURCES.filter((source) => enabled.has(source)),
        );
        expect(getEnabledSettingSources().at(-1)).toBe("policySettings");
      }
    } finally {
      setAllowedSettingSources(originalSources);
    }
  });

  test("managed defaultMode overrides the flag layer", async () => {
    const env = await canonicalEnv({
      managed:
        'config_version = 2\n[permissions]\ndefaultMode = "default"\n',
      cliOverrides: {
        permissions: { defaultMode: "acceptEdits" },
      },
    });

    const { toolPermissionContext } =
      await initializeToolPermissionContext({ env });

    expect(toolPermissionContext.mode).toBe("default");
  });

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

  test("managed bypass disable normalizes a plan restore target", async () => {
    const env = await canonicalEnv({
      managed:
        'config_version = 2\n[permissions]\nbypassPermissionsMode = "disable"\n',
    });
    const current = createEmptyToolPermissionContext({
      mode: "plan",
      prePlanMode: "bypassPermissions",
      isBypassPermissionsModeAvailable: true,
      bypassPermissionsAcceptedIn: [env.cwd!],
    });
    const synced = await syncPermissionRulesFromConfig(current, env);
    expect(synced).toMatchObject({
      mode: "plan",
      prePlanMode: "default",
      isBypassPermissionsModeAvailable: false,
      bypassPermissionsModeDisabledByPolicy: true,
      bypassPermissionsAcceptedIn: [],
    });
  });

  test("managed-only reload replaces the active-auto dangerous-rule stash", async () => {
    const env = await canonicalEnv({
      managed: [
        "config_version = 2",
        "allowManagedPermissionRulesOnly = true",
        "[permissions]",
        'allow = ["system.bash(node:*)", "FileRead"]',
        "",
      ].join("\n"),
    });
    const active = createEmptyToolPermissionContext({
      mode: "auto",
      autoModeActive: true,
      isAutoModeAvailable: true,
      alwaysAllowRules: {
        userSettings: ["FileRead(old-user)"],
        session: ["FileRead(old-session)"],
      },
      strippedDangerousRules: {
        userSettings: ["system.bash(python:*)"],
        session: ["system.bash(npm:*)"],
      },
    });

    const synced = await syncPermissionRulesFromConfig(active, env);

    expect(synced).toMatchObject({
      mode: "auto",
      autoModeActive: true,
      alwaysAllowRules: { policySettings: ["FileRead"] },
      strippedDangerousRules: {
        policySettings: ["system.bash(node:*)"],
      },
    });
    expect(synced.alwaysAllowRules.userSettings ?? []).toEqual([]);
    expect(synced.alwaysAllowRules.session ?? []).toEqual([]);
    expect(synced.strippedDangerousRules?.userSettings).toBeUndefined();
    expect(synced.strippedDangerousRules?.session).toBeUndefined();

    const exited = transitionPermissionMode("auto", "default", synced);
    expect(exited.alwaysAllowRules).toMatchObject({
      policySettings: ["FileRead", "system.bash(node:*)"],
    });
    expect(exited.alwaysAllowRules.userSettings ?? []).toEqual([]);
    expect(exited.alwaysAllowRules.session ?? []).toEqual([]);
  });

  test("managed auto disable cannot restore stale user or session grants", async () => {
    const env = await canonicalEnv({
      managed: [
        "config_version = 2",
        'disableAutoMode = "disable"',
        "allowManagedPermissionRulesOnly = true",
        "[permissions]",
        'allow = ["FileRead"]',
        "",
      ].join("\n"),
    });
    const active = createEmptyToolPermissionContext({
      mode: "auto",
      autoModeActive: true,
      isAutoModeAvailable: true,
      strippedDangerousRules: {
        userSettings: ["system.bash(python:*)"],
        session: ["system.bash(npm:*)"],
      },
    });

    const synced = await syncPermissionRulesFromConfig(active, env);

    expect(synced).toMatchObject({
      mode: "default",
      autoModeActive: false,
      isAutoModeAvailable: false,
      alwaysAllowRules: { policySettings: ["FileRead"] },
    });
    expect(synced.strippedDangerousRules).toBeUndefined();
    expect(synced.alwaysAllowRules.userSettings ?? []).toEqual([]);
    expect(synced.alwaysAllowRules.session ?? []).toEqual([]);
  });

  test("replaces stale managed directory grants with the final managed layer", async () => {
    const env = await canonicalEnv({
      managed: [
        "config_version = 2",
        "[permissions]",
        'additionalDirectories = ["/stale-managed"]',
        "",
      ].join("\n"),
    });
    write(
      join(dirname(env.managedConfigPath!), "config.d", "20-permissions.toml"),
      [
        "config_version = 2",
        "[permissions]",
        'additionalDirectories = ["/active-managed"]',
        "",
      ].join("\n"),
    );
    await env.configStore.reload();

    const current = createEmptyToolPermissionContext({
      additionalWorkingDirectories: new Map([
        [
          "/stale-managed",
          { path: "/stale-managed", source: "policySettings" as const },
        ],
        [
          "/session-extra",
          { path: "/session-extra", source: "session" as const },
        ],
      ]),
    });
    const synced = await syncPermissionRulesFromConfig(current, env);

    expect([...synced.additionalWorkingDirectories.values()]).toEqual([
      { path: "/session-extra", source: "session" },
      { path: "/active-managed", source: "policySettings" },
    ]);
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
  test("persists exact-cwd bypass consent when a trusted session starts in bypass mode", async () => {
    // A desktop session created with permissionMode "bypassPermissions" was
    // authorized in memory only; after a daemon restart its resume was
    // refused with "restored bypass permission mode requires persisted
    // exact-cwd consent". Explicit startup bypass now records the consent.
    let env = await canonicalEnv({ diskState: true });
    const canonicalCwd = canonicalizeBypassPermissionsCwd(env.cwd!);
    const { toolPermissionContext } = await initializeToolPermissionContext({
      env,
      projectTrust: "trusted",
      permissionMode: "bypassPermissions",
    });
    expect(toolPermissionContext).toMatchObject({
      mode: "bypassPermissions",
      bypassPermissionsAcceptedIn: [canonicalCwd],
    });
    env = await restartCanonicalEnv(env);
    expect(
      loadBypassPermissionsConsent(
        env.configStore.stateRepository,
        env.cwd!,
        { reload: true },
      ),
    ).toEqual([canonicalCwd]);
    env.configStore.stateRepository.close();
  });

  test("does not persist bypass consent for an untrusted project", async () => {
    let env = await canonicalEnv({ diskState: true });
    await initializeToolPermissionContext({
      env,
      projectTrust: "untrusted",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    env = await restartCanonicalEnv(env);
    expect(
      loadBypassPermissionsConsent(
        env.configStore.stateRepository,
        env.cwd!,
        { reload: true },
      ),
    ).toEqual([]);
    env.configStore.stateRepository.close();
  });

  test("restores exact-cwd bypass consent on trusted restart before a later mode switch", async () => {
    let env = await canonicalEnv({ diskState: true });
    const canonicalCwd = canonicalizeBypassPermissionsCwd(env.cwd!);
    recordBypassPermissionsConsent(env.configStore.stateRepository, env.cwd!);
    env = await restartCanonicalEnv(env);
    expect(
      loadBypassPermissionsConsent(
        env.configStore.stateRepository,
        env.cwd!,
        { reload: true },
      ),
    ).toEqual([canonicalCwd]);

    const { toolPermissionContext } = await initializeToolPermissionContext({
      env,
      projectTrust: "trusted",
    });

    expect(toolPermissionContext).toMatchObject({
      mode: "default",
      isBypassPermissionsModeAvailable: true,
      bypassPermissionsAcceptedIn: [canonicalCwd],
    });
    expect(Object.isFrozen(toolPermissionContext)).toBe(true);
    expect(() => {
      (toolPermissionContext as { mode: PermissionMode }).mode = "plan";
    }).toThrow(TypeError);
    const switched = transitionPermissionMode(
      "default",
      "bypassPermissions",
      toolPermissionContext,
      { workspacePath: env.cwd! },
    );
    expect(switched).not.toHaveProperty("error");
    expect({ ...switched, mode: "bypassPermissions" as const }).toMatchObject({
      mode: "bypassPermissions",
      isBypassPermissionsModeAvailable: true,
      bypassPermissionsAcceptedIn: [canonicalCwd],
    });
    env.configStore.stateRepository.close();
  });

  test("does not restore durable bypass consent into a different cwd", async () => {
    let env = await canonicalEnv({ diskState: true });
    recordBypassPermissionsConsent(env.configStore.stateRepository, env.cwd!);
    const differentCwd = join(dirname(env.cwd!), "different-repo");
    mkdirSync(join(differentCwd, ".git"), { recursive: true });
    env = await restartCanonicalEnv(env, differentCwd);

    const { toolPermissionContext } = await initializeToolPermissionContext({
      env,
      projectTrust: "trusted",
    });

    expect(toolPermissionContext).toMatchObject({
      mode: "default",
      isBypassPermissionsModeAvailable: false,
    });
    expect(toolPermissionContext.bypassPermissionsAcceptedIn ?? []).toEqual([]);
    expect(
      transitionPermissionMode(
        "default",
        "bypassPermissions",
        toolPermissionContext,
        { workspacePath: differentCwd },
      ),
    ).toMatchObject({ error: expect.any(String) });
    env.configStore.stateRepository.close();
  });

  test("managed disable suppresses durable bypass consent after restart", async () => {
    let env = await canonicalEnv({
      diskState: true,
      managed:
        'config_version = 2\n[permissions]\nbypassPermissionsMode = "disable"\n',
    });
    recordBypassPermissionsConsent(env.configStore.stateRepository, env.cwd!);
    env = await restartCanonicalEnv(env);

    const { toolPermissionContext } = await initializeToolPermissionContext({
      env,
      projectTrust: "trusted",
    });

    expect(toolPermissionContext).toMatchObject({
      mode: "default",
      isBypassPermissionsModeAvailable: false,
      bypassPermissionsModeDisabledByPolicy: true,
      bypassPermissionsAcceptedIn: [],
    });
    expect(
      transitionPermissionMode(
        "default",
        "bypassPermissions",
        toolPermissionContext,
        { workspacePath: env.cwd! },
      ),
    ).toMatchObject({ error: expect.any(String) });
    env.configStore.stateRepository.close();
  });

  test("startup auto mode strips dangerous grants only after rules are loaded", async () => {
    const env = await canonicalEnv({
      user: [
        "config_version = 2",
        "[permissions]",
        'defaultMode = "auto"',
        'allow = ["system.bash(python:*)", "spawn_agent(worker)", "FileRead"]',
        "",
      ].join("\n"),
    });
    const restore = __setAutoModeGateResolverForTesting(() => true);
    try {
      const { toolPermissionContext } =
        await initializeToolPermissionContext({ env });
      expect(toolPermissionContext).toMatchObject({
        mode: "auto",
        autoModeActive: true,
      });
      expect(Object.isFrozen(toolPermissionContext)).toBe(true);
      expect(() => {
        (toolPermissionContext as { mode: PermissionMode }).mode = "default";
      }).toThrow(TypeError);
      expect(toolPermissionContext.alwaysAllowRules.userSettings).toEqual([
        "FileRead",
      ]);
      expect(toolPermissionContext.strippedDangerousRules?.userSettings).toEqual([
        "system.bash(python:*)",
        "spawn_agent(worker)",
      ]);
    } finally {
      restore();
    }
  });

  test("startup auto mode falls back cleanly when its gate is closed", async () => {
    const env = await canonicalEnv({
      user: [
        "config_version = 2",
        "[permissions]",
        'defaultMode = "auto"',
        'allow = ["system.bash(python:*)", "FileRead"]',
        "",
      ].join("\n"),
    });
    const restore = __setAutoModeGateResolverForTesting(() => false);
    try {
      const { toolPermissionContext } =
        await initializeToolPermissionContext({ env });
      expect(toolPermissionContext.mode).toBe("default");
      expect(toolPermissionContext.autoModeActive).not.toBe(true);
      expect(toolPermissionContext.strippedDangerousRules).toBeUndefined();
      expect(toolPermissionContext.alwaysAllowRules.userSettings).toEqual([
        "system.bash(python:*)",
        "FileRead",
      ]);
    } finally {
      restore();
    }
  });

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

  test("returns an immutable explicit-bypass startup context", async () => {
    const env = await canonicalEnv();
    const { toolPermissionContext } = await initializeToolPermissionContext({
      env,
      allowDangerouslySkipPermissions: true,
    });

    expect(toolPermissionContext.mode).toBe("bypassPermissions");
    expect(Object.isFrozen(toolPermissionContext)).toBe(true);
    expect(() => {
      (toolPermissionContext as { mode: PermissionMode }).mode = "default";
    }).toThrow(TypeError);
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

  test("managed-only rules retain repository auto and bypass restrictions at startup", async () => {
    const env = await canonicalEnv({
      project: [
        "config_version = 2",
        'disableAutoMode = "disable"',
        "[permissions]",
        'bypassPermissionsMode = "disable"',
        'deny = ["system.bash(rm:*)"]',
        "",
      ].join("\n"),
      managed: [
        "config_version = 2",
        "allowManagedPermissionRulesOnly = true",
        "[permissions]",
        'deny = ["system.bash(curl:*)"]',
        "",
      ].join("\n"),
    });
    const snapshot = await loadPermissionRulesSnapshot(env);
    expect(snapshot).toMatchObject({
      managedOnly: true,
      disableAutoMode: true,
      bypassPermissionsModeDisabled: true,
    });
    expect(snapshot.rules.map((rule) => rule.source)).toEqual([
      "policySettings",
    ]);

    const restoreGate = __setAutoModeGateResolverForTesting(() => true);
    try {
      const auto = await initializeToolPermissionContext({
        env,
        permissionMode: "auto",
      });
      expect(auto.toolPermissionContext).toMatchObject({
        mode: "default",
        isAutoModeAvailable: false,
      });

      const bypass = await initializeToolPermissionContext({
        env,
        allowDangerouslySkipPermissions: true,
      });
      expect(bypass.toolPermissionContext).toMatchObject({
        mode: "default",
        isBypassPermissionsModeAvailable: false,
        bypassPermissionsModeDisabledByPolicy: true,
        bypassPermissionsAcceptedIn: [],
      });
    } finally {
      restoreGate();
    }
  });

  test("honors source isolation for rules, directories, and the default mode", async () => {
    const originalSources = [...getAllowedSettingSources()];
    try {
      setAllowedSettingSources([]);
      const env = await canonicalEnv({
        user: [
          "config_version = 2",
          "[permissions]",
          'allow = ["FileRead"]',
          'additionalDirectories = ["/user-extra"]',
          'defaultMode = "acceptEdits"',
          "",
        ].join("\n"),
        managed: [
          "config_version = 2",
          "[permissions]",
          'deny = ["system.bash(curl:*)"]',
          'additionalDirectories = ["/managed-extra"]',
          "",
        ].join("\n"),
      });

      const { toolPermissionContext } =
        await initializeToolPermissionContext({ env });

      expect(toolPermissionContext.mode).toBe("default");
      expect(toolPermissionContext.alwaysAllowRules.userSettings ?? []).toEqual([]);
      expect(toolPermissionContext.alwaysDenyRules.policySettings).toEqual([
        "system.bash(curl:*)",
      ]);
      expect([...toolPermissionContext.additionalWorkingDirectories.values()])
        .toEqual([{ path: "/managed-extra", source: "policySettings" }]);
    } finally {
      setAllowedSettingSources(originalSources);
    }
  });
});
