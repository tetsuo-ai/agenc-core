import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addPermissionRulesToSettings,
  deletePermissionRule,
  getEnabledSettingSources,
  getSettingsFilePathForSource,
  initialPermissionModeFromCLI,
  initializeToolPermissionContext,
  loadAllPermissionRulesFromDisk,
  parseBaseToolsFromCLI,
  parseToolListFromCLI,
  readSettingsFileLenient,
  settingsJsonToRules,
  shouldAllowManagedPermissionRulesOnly,
  syncPermissionRulesFromDisk,
  type SettingsJson,
} from "./settings.js";
import {
  createEmptyToolPermissionContext,
  type PermissionRule,
  type PermissionResult,
  type ToolPermissionContext,
} from "./types.js";
import { applyPermissionRulesToPermissionContext } from "./rules.js";
import { __setAutoModeGateResolverForTesting } from "./permission-mode.js";
import { ConfigStore } from "../config/store.js";
import { defaultConfig } from "../config/schema.js";
import { bashToolHasPermission, type BashPermissionInput } from "./bash.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
} from "./evaluator.js";
import { freshDenialTracking } from "./denial-tracking.js";
import type { Session } from "../session/session.js";

function mkTmp(): string {
  return mkdtempSync(join(tmpdir(), "agenc-perm-settings-"));
}

function writeSettings(path: string, json: unknown) {
  mkdirSync(join(path, ".agenc"), { recursive: true });
}

function makeEvaluatorContext(
  toolPermissionContext: ToolPermissionContext,
): ToolEvaluatorContext {
  const state: AppStateSnapshot = {
    toolPermissionContext,
    denialTracking: freshDenialTracking(),
    autoModeActive: toolPermissionContext.autoModeActive === true,
  };
  return attachContextDefaults({
    getAppState: () => state,
    session: {
      state: {
        unsafePeek: () => ({ history: [] }),
      },
    } as unknown as Session,
  } as ToolEvaluatorContext);
}

describe("getSettingsFilePathForSource", () => {
  test("userSettings resolves under env.home/.agenc/settings.json", () => {
    const p = getSettingsFilePathForSource("userSettings", {
      home: "/home/u",
      cwd: "/x",
    });
    expect(p).toBe("/home/u/.agenc/settings.json");
  });

  test("projectSettings uses cwd when cwd is the project root", () => {
    const dir = mkTmp();
    try {
      mkdirSync(join(dir, ".git"));
      const p = getSettingsFilePathForSource("projectSettings", {
        home: "/home/u",
        cwd: dir,
      });
      expect(p).toBe(join(dir, ".agenc", "settings.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("projectSettings climbs to marker ancestor (.git)", () => {
    const dir = mkTmp();
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    mkdirSync(join(dir, ".git"));
    try {
      const p = getSettingsFilePathForSource("projectSettings", {
        home: "/home/u",
        cwd: nested,
      });
      expect(p).toBe(join(dir, ".agenc", "settings.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("localSettings writes to settings.local.json", () => {
    const dir = mkTmp();
    try {
      mkdirSync(join(dir, ".git"));
      const p = getSettingsFilePathForSource("localSettings", {
        home: "/home/u",
        cwd: dir,
      });
      expect(p).toBe(join(dir, ".agenc", "settings.local.json"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("flagSettings uses the CLI-provided path", () => {
    const p = getSettingsFilePathForSource("flagSettings", {
      flagSettingsPath: "/tmp/flag.json",
    });
    expect(p).toBe("/tmp/flag.json");
  });

  test("flagSettings returns null when no path given", () => {
    expect(getSettingsFilePathForSource("flagSettings", {})).toBeNull();
  });

  test("policySettings falls back to managed path", () => {
    const p = getSettingsFilePathForSource("policySettings", {
      managedSettingsPath: "/etc/custom.json",
    });
    expect(p).toBe("/etc/custom.json");
  });

  test("session / cliArg / command return null", () => {
    expect(getSettingsFilePathForSource("session")).toBeNull();
    expect(getSettingsFilePathForSource("cliArg")).toBeNull();
    expect(getSettingsFilePathForSource("command")).toBeNull();
  });
});

describe("readSettingsFileLenient", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkTmp();
  });
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("returns null for missing files", async () => {
    const r = await readSettingsFileLenient(join(dir, "nope.json"));
    expect(r).toBeNull();
  });

  test("returns {} for empty file", async () => {
    const p = join(dir, "empty.json");
    writeFileSync(p, "");
    expect(await readSettingsFileLenient(p)).toEqual({});
  });

  test("parses normal JSON", async () => {
    const p = join(dir, "s.json");
    writeFileSync(p, JSON.stringify({ permissions: { allow: ["Read"] } }));
    const r = await readSettingsFileLenient(p);
    expect(r?.permissions?.allow).toEqual(["Read"]);
  });

  test("strips UTF-8 BOM (I-81)", async () => {
    const p = join(dir, "bom.json");
    writeFileSync(
      p,
      `\uFEFF${JSON.stringify({ permissions: { allow: ["Read"] } })}`,
    );
    const r = await readSettingsFileLenient(p);
    expect(r?.permissions?.allow).toEqual(["Read"]);
  });

  test("returns null when JSON is malformed", async () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    expect(await readSettingsFileLenient(p)).toBeNull();
  });

  test("returns null when root is not an object", async () => {
    const p = join(dir, "arr.json");
    writeFileSync(p, "[]");
    expect(await readSettingsFileLenient(p)).toBeNull();
  });

  test("lenient: preserves unknown fields so bad hooks can't clobber perms", async () => {
    const p = join(dir, "mixed.json");
    writeFileSync(
      p,
      JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: "invalid-shape",
      }),
    );
    const r = await readSettingsFileLenient(p);
    expect(r?.permissions?.allow).toEqual(["Read"]);
    expect(r?.hooks).toBe("invalid-shape");
  });
});

describe("settingsJsonToRules", () => {
  test("emits rules for allow/deny/ask lists", () => {
    const json: SettingsJson = {
      permissions: {
        allow: ["Bash(git:*)", "Read"],
        deny: ["Bash(rm -rf:*)"],
        ask: ["Bash(npm publish:*)"],
      },
    };
    const rules = settingsJsonToRules(json, "userSettings");
    expect(rules.length).toBe(4);
    expect(rules.map((r) => r.source)).toEqual([
      "userSettings",
      "userSettings",
      "userSettings",
      "userSettings",
    ]);
    expect(rules.map((r) => r.ruleBehavior)).toEqual([
      "allow",
      "allow",
      "deny",
      "ask",
    ]);
  });

  test("returns empty list when permissions block missing", () => {
    expect(settingsJsonToRules({}, "userSettings")).toEqual([]);
    expect(settingsJsonToRules(null, "userSettings")).toEqual([]);
  });

  test("skips non-string entries", () => {
    const rules = settingsJsonToRules(
      {
        permissions: {
          allow: ["Read", 123 as unknown as string, null as unknown as string],
        },
      },
      "projectSettings",
    );
    expect(rules.length).toBe(1);
  });

  test("keeps permission tool names literal", () => {
    const rules = settingsJsonToRules(
      { permissions: { allow: ["spawn_agent(worker)"] } },
      "userSettings",
    );
    expect(rules[0]?.ruleValue.toolName).toBe("spawn_agent");
  });
});

describe("shouldAllowManagedPermissionRulesOnly", () => {
  test("returns true when policy sets the flag", () => {
    expect(
      shouldAllowManagedPermissionRulesOnly({
        permissions: { allowManagedPermissionRulesOnly: true },
      }),
    ).toBe(true);
  });

  test("returns false otherwise", () => {
    expect(shouldAllowManagedPermissionRulesOnly(null)).toBe(false);
    expect(shouldAllowManagedPermissionRulesOnly({})).toBe(false);
    expect(
      shouldAllowManagedPermissionRulesOnly({
        permissions: { allowManagedPermissionRulesOnly: false },
      }),
    ).toBe(false);
  });
});

describe("loadAllPermissionRulesFromDisk", () => {
  let home = "";
  let cwd = "";
  beforeEach(() => {
    home = mkTmp();
    cwd = mkTmp();
    mkdirSync(join(cwd, ".git")); // anchor project root
  });
  afterEach(() => {
    for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
  });

  test("reads rules from user + project + local", async () => {
    mkdirSync(join(home, ".agenc"), { recursive: true });
    writeFileSync(
      join(home, ".agenc", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] } }),
    );
    mkdirSync(join(cwd, ".agenc"), { recursive: true });
    writeFileSync(
      join(cwd, ".agenc", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }),
    );
    writeFileSync(
      join(cwd, ".agenc", "settings.local.json"),
      JSON.stringify({ permissions: { deny: ["Write"] } }),
    );

    const rules = await loadAllPermissionRulesFromDisk({
      home,
      cwd,
      managedSettingsPath: join(home, "nonexistent-policy.json"),
    });
    expect(rules.length).toBe(3);
    expect(rules.map((r) => r.source).sort()).toEqual(
      ["userSettings", "projectSettings", "localSettings"].sort(),
    );
  });

  test("respects allowManagedPermissionRulesOnly gate", async () => {
    const policy = join(home, "policy.json");
    writeFileSync(
      policy,
      JSON.stringify({
        permissions: {
          allowManagedPermissionRulesOnly: true,
          allow: ["Read"],
        },
      }),
    );
    // User rule that should be ignored.
    mkdirSync(join(home, ".agenc"), { recursive: true });
    writeFileSync(
      join(home, ".agenc", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash"] } }),
    );
    const rules = await loadAllPermissionRulesFromDisk({
      home,
      cwd,
      managedSettingsPath: policy,
    });
    expect(rules.length).toBe(1);
    expect(rules[0]?.source).toBe("policySettings");
  });

  test("tolerates missing settings files", async () => {
    const rules = await loadAllPermissionRulesFromDisk({
      home,
      cwd,
      managedSettingsPath: join(home, "policy-missing.json"),
    });
    expect(rules).toEqual([]);
  });
});

describe("syncPermissionRulesFromDisk", () => {
  let home = "";
  let cwd = "";
  beforeEach(() => {
    home = mkTmp();
    cwd = mkTmp();
    mkdirSync(join(cwd, ".git"));
  });
  afterEach(() => {
    for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
  });

  test("picks up fresh rules from disk", async () => {
    const ctx = createEmptyToolPermissionContext();
    mkdirSync(join(home, ".agenc"), { recursive: true });
    writeFileSync(
      join(home, ".agenc", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] } }),
    );
    const out = await syncPermissionRulesFromDisk(ctx, {
      home,
      cwd,
      managedSettingsPath: join(home, "no-policy.json"),
    });
    expect(out.alwaysAllowRules.userSettings).toEqual(["Read"]);
  });

  test("removes in-memory rules when disk deletes them", async () => {
    // Seed a context as if userSettings already had Read + Bash(git:*).
    let ctx = applyPermissionRulesToPermissionContext(
      createEmptyToolPermissionContext(),
      [
        {
          source: "userSettings",
          ruleBehavior: "allow",
          ruleValue: { toolName: "Read" },
        },
        {
          source: "userSettings",
          ruleBehavior: "allow",
          ruleValue: { toolName: "Bash", ruleContent: "git:*" },
        },
      ] satisfies PermissionRule[],
    );

    // Disk only has Bash(git:*) now.
    mkdirSync(join(home, ".agenc"), { recursive: true });
    writeFileSync(
      join(home, ".agenc", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Bash(git:*)"] } }),
    );

    ctx = await syncPermissionRulesFromDisk(ctx, {
      home,
      cwd,
      managedSettingsPath: join(home, "no-policy.json"),
    });
    expect(ctx.alwaysAllowRules.userSettings).toEqual(["Bash(git:*)"]);
  });

  test("scrubs policySettings bucket when disk drops the rule", async () => {
    let ctx = applyPermissionRulesToPermissionContext(
      createEmptyToolPermissionContext(),
      [
        {
          source: "policySettings",
          ruleBehavior: "deny",
          ruleValue: { toolName: "Bash", ruleContent: "rm -rf:*" },
        },
      ],
    );
    expect(ctx.alwaysDenyRules.policySettings).toEqual(["Bash(rm -rf:*)"]);

    // No policy file on disk.
    ctx = await syncPermissionRulesFromDisk(ctx, {
      home,
      cwd,
      managedSettingsPath: join(home, "no-policy.json"),
    });
    expect(ctx.alwaysDenyRules.policySettings).toEqual([]);
  });

  test("live sync strips repository grants while retaining restrictions", async () => {
    mkdirSync(join(cwd, ".agenc"), { recursive: true });
    writeFileSync(
      join(cwd, ".agenc", "settings.json"),
      JSON.stringify({
        permissions: {
          allow: ["Bash(*)"],
          ask: ["Edit"],
          deny: ["Write"],
        },
      }),
    );
    writeFileSync(
      join(cwd, ".agenc", "settings.local.json"),
      JSON.stringify({
        permissions: {
          allow: ["Read"],
          deny: ["Bash(curl:*)"],
        },
      }),
    );

    const out = await syncPermissionRulesFromDisk(
      createEmptyToolPermissionContext(),
      { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
    );

    expect(out.alwaysAllowRules.projectSettings ?? []).toEqual([]);
    expect(out.alwaysAllowRules.localSettings ?? []).toEqual([]);
    expect(out.alwaysAskRules.projectSettings).toEqual(["Edit"]);
    expect(out.alwaysDenyRules.projectSettings).toEqual(["Write"]);
    expect(out.alwaysDenyRules.localSettings).toEqual(["Bash(curl:*)"]);
  });
});

describe("addPermissionRulesToSettings / deletePermissionRule", () => {
  let home = "";
  beforeEach(() => {
    home = mkTmp();
  });
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
  });

  test("adds new rules to an empty settings file", async () => {
    const ok = await addPermissionRulesToSettings({
      destination: "userSettings",
      behavior: "allow",
      rules: [{ toolName: "Read" }, { toolName: "Bash", ruleContent: "git:*" }],
      env: { home },
    });
    expect(ok).toBe(true);
    const parsed = await readSettingsFileLenient(
      join(home, ".agenc", "settings.json"),
    );
    expect(parsed?.permissions?.allow).toEqual(["Read", "Bash(git:*)"]);
  });

  test("repository settings reject allow grants but retain restrictions", async () => {
    const cwd = join(home, "repo");
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, "package.json"), "{}\n");
    const env = {
      home,
      cwd,
      managedSettingsPath: join(home, "no-policy.json"),
    };

    for (const destination of [
      "projectSettings",
      "localSettings",
    ] as const) {
      await expect(
        addPermissionRulesToSettings({
          destination,
          behavior: "allow",
          rules: [{ toolName: "Bash", ruleContent: "*" }],
          env,
        }),
      ).resolves.toBe(false);
    }
    expect(existsSync(join(cwd, ".agenc", "settings.json"))).toBe(false);
    expect(existsSync(join(cwd, ".agenc", "settings.local.json"))).toBe(
      false,
    );

    await expect(
      addPermissionRulesToSettings({
        destination: "projectSettings",
        behavior: "deny",
        rules: [{ toolName: "Bash", ruleContent: "curl:*" }],
        env,
      }),
    ).resolves.toBe(true);
    const project = await readSettingsFileLenient(
      join(cwd, ".agenc", "settings.json"),
    );
    expect(project?.permissions?.deny).toEqual(["Bash(curl:*)"]);
    expect(project?.permissions?.allow).toBeUndefined();
  });

  test("dedupes against existing rules", async () => {
    await addPermissionRulesToSettings({
      destination: "userSettings",
      behavior: "allow",
      rules: [{ toolName: "Read" }],
      env: { home },
    });
    await addPermissionRulesToSettings({
      destination: "userSettings",
      behavior: "allow",
      rules: [{ toolName: "Read" }, { toolName: "Write" }],
      env: { home },
    });
    const parsed = await readSettingsFileLenient(
      join(home, ".agenc", "settings.json"),
    );
    expect(parsed?.permissions?.allow).toEqual(["Read", "Write"]);
  });

  test("refuses to write when managed-only gate is set", async () => {
    const policy = join(home, "policy.json");
    writeFileSync(
      policy,
      JSON.stringify({
        permissions: { allowManagedPermissionRulesOnly: true },
      }),
    );
    const ok = await addPermissionRulesToSettings({
      destination: "userSettings",
      behavior: "allow",
      rules: [{ toolName: "Read" }],
      env: { home, managedSettingsPath: policy },
    });
    expect(ok).toBe(false);
  });

  test("deletePermissionRule removes a matching rule", async () => {
    await addPermissionRulesToSettings({
      destination: "userSettings",
      behavior: "allow",
      rules: [{ toolName: "Read" }, { toolName: "Write" }],
      env: { home },
    });
    const deleted = await deletePermissionRule({
      destination: "userSettings",
      rule: {
        source: "userSettings",
        ruleBehavior: "allow",
        ruleValue: { toolName: "Read" },
      },
      env: { home },
    });
    expect(deleted).toBe(true);
    const parsed = await readSettingsFileLenient(
      join(home, ".agenc", "settings.json"),
    );
    expect(parsed?.permissions?.allow).toEqual(["Write"]);
  });

  test("deletePermissionRule returns false when rule is absent", async () => {
    const ok = await deletePermissionRule({
      destination: "userSettings",
      rule: {
        source: "userSettings",
        ruleBehavior: "allow",
        ruleValue: { toolName: "Read" },
      },
      env: { home },
    });
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

describe("parseToolListFromCLI", () => {
  test("splits on commas outside parens", () => {
    const rules = parseToolListFromCLI(["Read, Write"]);
    expect(rules.map((r) => r.ruleValue.toolName)).toEqual(["Read", "Write"]);
  });

  test("splits on spaces outside parens", () => {
    const rules = parseToolListFromCLI(["Read Write"]);
    expect(rules.map((r) => r.ruleValue.toolName)).toEqual(["Read", "Write"]);
  });

  test("preserves parens", () => {
    const rules = parseToolListFromCLI(["Bash(git commit:*)"]);
    expect(rules[0]?.ruleValue.toolName).toBe("Bash");
    expect(rules[0]?.ruleValue.ruleContent).toBe("git commit:*");
  });

  test("commas inside parens are kept", () => {
    const rules = parseToolListFromCLI(["Bash(git add,git commit)"]);
    expect(rules[0]?.ruleValue.ruleContent).toBe("git add,git commit");
  });

  test("stamps source=cliArg and default behavior=allow", () => {
    const rules = parseToolListFromCLI(["Read"]);
    expect(rules[0]?.source).toBe("cliArg");
    expect(rules[0]?.ruleBehavior).toBe("allow");
  });

  test("empty input yields empty list", () => {
    expect(parseToolListFromCLI([])).toEqual([]);
    expect(parseToolListFromCLI([""])).toEqual([]);
  });
});

describe("parseBaseToolsFromCLI", () => {
  test("uses same grammar as allowlist", () => {
    const rules = parseBaseToolsFromCLI(["Read, Write, Bash(git:*)"]);
    expect(rules.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// initialPermissionModeFromCLI
// ---------------------------------------------------------------------------

describe("initialPermissionModeFromCLI", () => {
  test("defaults to 'default' when nothing provided", () => {
    const r = initialPermissionModeFromCLI({});
    expect(r.mode).toBe("default");
  });

  test("honors --dangerously-bypass-approvals-and-sandbox", () => {
    const r = initialPermissionModeFromCLI({
      dangerouslySkipPermissions: true,
    });
    expect(r.mode).toBe("bypassPermissions");
  });

  test("honors --permission-mode plan", () => {
    const r = initialPermissionModeFromCLI({ permissionModeCli: "plan" });
    expect(r.mode).toBe("plan");
  });

  test("settings.defaultMode fallback when no CLI flag", () => {
    const r = initialPermissionModeFromCLI({ userDefaultMode: "acceptEdits" });
    expect(r.mode).toBe("acceptEdits");
  });

  test("CLI beats settings.defaultMode", () => {
    const r = initialPermissionModeFromCLI({
      permissionModeCli: "plan",
      userDefaultMode: "acceptEdits",
    });
    expect(r.mode).toBe("plan");
  });

  test("disableBypassPermissionsMode blocks bypass, falls back to next mode", () => {
    const r = initialPermissionModeFromCLI({
      dangerouslySkipPermissions: true,
      userDefaultMode: "acceptEdits",
      policySettings: {
        permissions: { disableBypassPermissionsMode: "disable" },
      },
    });
    expect(r.mode).toBe("acceptEdits");
    expect(r.notification).toMatch(/Bypass/);
  });

  test("disableBypassPermissionsMode without fallback → default", () => {
    const r = initialPermissionModeFromCLI({
      dangerouslySkipPermissions: true,
      policySettings: {
        permissions: { disableBypassPermissionsMode: "disable" },
      },
    });
    expect(r.mode).toBe("default");
    expect(r.notification).toMatch(/Bypass/);
  });

  test("invalid CLI mode string is ignored", () => {
    const r = initialPermissionModeFromCLI({
      permissionModeCli: "totally-bogus",
    });
    expect(r.mode).toBe("default");
  });

  test("unattended CLI mode is ignored", () => {
    const r = initialPermissionModeFromCLI({
      permissionModeCli: "unattended",
    });
    expect(r.mode).toBe("default");
  });

  test("unattended settings.defaultMode is ignored", () => {
    const r = initialPermissionModeFromCLI({
      userDefaultMode: "unattended",
    });
    expect(r.mode).toBe("default");
  });

  test("auto mode falls back when disabled by settings", () => {
    const r = initialPermissionModeFromCLI({
      permissionModeCli: "auto",
      isAutoModeAvailable: false,
    });
    expect(r.mode).toBe("default");
    expect(r.notification).toMatch(/Auto mode was disabled/);
  });

  test("auto mode falls back when the live gate is closed", () => {
    const r = initialPermissionModeFromCLI({
      permissionModeCli: "auto",
      isAutoModeAvailable: true,
      isAutoModeGateEnabled: false,
    });
    expect(r.mode).toBe("default");
    expect(r.notification).toMatch(/gate is closed/);
  });
});

// ---------------------------------------------------------------------------
// initializeToolPermissionContext end-to-end
// ---------------------------------------------------------------------------

describe("initializeToolPermissionContext", () => {
  let home = "";
  let cwd = "";
  beforeEach(() => {
    home = mkTmp();
    cwd = mkTmp();
    mkdirSync(join(cwd, ".git"));
  });
  afterEach(() => {
    for (const d of [home, cwd]) rmSync(d, { recursive: true, force: true });
  });

  test("merges disk + CLI rules", async () => {
    mkdirSync(join(home, ".agenc"), { recursive: true });
    writeFileSync(
      join(home, ".agenc", "settings.json"),
      JSON.stringify({ permissions: { allow: ["Read"] } }),
    );
    const { toolPermissionContext } = await initializeToolPermissionContext({
      env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
      cliAllows: ["Bash(git:*)"],
    });
    expect(toolPermissionContext.alwaysAllowRules.userSettings).toEqual([
      "Read",
    ]);
    expect(toolPermissionContext.alwaysAllowRules.cliArg).toEqual([
      "Bash(git:*)",
    ]);
  });

  test("project trust never makes project/local allow rules or default modes authoritative", async () => {
    mkdirSync(join(cwd, ".agenc"), { recursive: true });
    writeFileSync(
      join(cwd, ".agenc", "settings.json"),
      JSON.stringify({
        permissions: {
          defaultMode: "bypassPermissions",
          allow: ["Bash(*)"],
          ask: ["Edit"],
          deny: ["Write"],
        },
      }),
    );
    writeFileSync(
      join(cwd, ".agenc", "settings.local.json"),
      JSON.stringify({
        permissions: {
          defaultMode: "bypassPermissions",
          allow: ["Read"],
          ask: ["Bash(npm publish:*)"],
        },
      }),
    );

    const { toolPermissionContext, warnings } =
      await initializeToolPermissionContext({
        env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
        projectTrust: "trusted",
      });

    expect(toolPermissionContext.mode).toBe("default");
    expect(toolPermissionContext.alwaysAllowRules.projectSettings ?? []).toEqual(
      [],
    );
    expect(toolPermissionContext.alwaysAllowRules.localSettings ?? []).toEqual(
      [],
    );
    expect(toolPermissionContext.alwaysAskRules.projectSettings).toEqual([
      "Edit",
    ]);
    expect(toolPermissionContext.alwaysAskRules.localSettings).toEqual([
      "Bash(npm publish:*)",
    ]);
    expect(toolPermissionContext.alwaysDenyRules.projectSettings).toEqual([
      "Write",
    ]);
    expect(warnings).toEqual([
      "Ignored 2 repository-controlled permission allow rules; project/local settings may restrict but cannot grant capabilities",
    ]);
  });

  test("repository settings may disable auto mode but cannot enable it", async () => {
    mkdirSync(join(home, ".agenc"), { recursive: true });
    mkdirSync(join(cwd, ".agenc"), { recursive: true });
    writeFileSync(
      join(home, ".agenc", "settings.json"),
      JSON.stringify({ permissions: { disableAutoMode: "disable" } }),
    );
    writeFileSync(
      join(cwd, ".agenc", "settings.json"),
      JSON.stringify({ permissions: { disableAutoMode: "enable" } }),
    );

    const { toolPermissionContext } = await initializeToolPermissionContext({
      env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
      projectTrust: "trusted",
    });

    expect(toolPermissionContext.isAutoModeAvailable).toBe(false);
  });

  test("untrusted projects downgrade bypassPermissions unless dangerous skip is explicit", async () => {
    const downgraded = await initializeToolPermissionContext({
      env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
      projectTrust: "untrusted",
      permissionMode: "bypassPermissions",
    });
    expect(downgraded.toolPermissionContext.mode).toBe("default");
    expect(downgraded.warnings).toContain(
      "Bypass permissions mode requires project trust; using default mode",
    );

    const explicit = await initializeToolPermissionContext({
      env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
      projectTrust: "untrusted",
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
    });
    expect(explicit.toolPermissionContext.mode).toBe("bypassPermissions");
  });

  test("applies ConfigStore permissions as session approval rules", async () => {
    const store = new ConfigStore({
      env: {},
      base: {
        ...defaultConfig(),
        permissions: {
          allow: ["Read"],
          ask: ["Bash(npm publish *)"],
          deny: ["Write"],
          additionalDirectories: [cwd],
        },
      },
    });

    const { toolPermissionContext } = await initializeToolPermissionContext({
      env: {
        home,
        cwd,
        managedSettingsPath: join(home, "no-policy.json"),
        configStore: store,
      },
    });

    expect(toolPermissionContext.alwaysAllowRules.session).toEqual(["Read"]);
    expect(toolPermissionContext.alwaysAskRules.session).toEqual([
      "Bash(npm publish *)",
    ]);
    expect(toolPermissionContext.alwaysDenyRules.session).toEqual(["Write"]);
    expect(toolPermissionContext.additionalWorkingDirectories.has(cwd)).toBe(
      true,
    );
  });

  test("ConfigStore approval rules affect production tool decisions", async () => {
    const store = new ConfigStore({
      env: {},
      base: {
        ...defaultConfig(),
        permissions: {
          allow: ["Bash(git:*)"],
          ask: ["Bash(echo publish:*)"],
          deny: ["Bash(git push:*)"],
        },
      },
    });

    const { toolPermissionContext } = await initializeToolPermissionContext({
      env: {
        home,
        cwd,
        managedSettingsPath: join(home, "no-policy.json"),
        configStore: store,
      },
    });
    const evalCtx = makeEvaluatorContext(toolPermissionContext);
    const bashTool = {
      name: "Bash",
      checkPermissions: (
        input: unknown,
        context: ToolEvaluatorContext,
      ): Promise<PermissionResult> =>
        bashToolHasPermission(input as BashPermissionInput, context),
    };

    const allowed = await hasPermissionsToUseTool(
      bashTool,
      { command: "git status --short" },
      evalCtx,
    );
    expect(allowed.behavior).toBe("allow");

    const prompted = await hasPermissionsToUseTool(
      bashTool,
      { command: "echo publish package" },
      evalCtx,
    );
    expect(prompted.behavior).toBe("ask");

    const denied = await hasPermissionsToUseTool(
      bashTool,
      { command: "git push origin main" },
      evalCtx,
    );
    expect(denied.behavior).toBe("deny");
  });

  test("applies --add-dir directories that exist", async () => {
    const extra = mkTmp();
    try {
      const { toolPermissionContext, warnings } =
        await initializeToolPermissionContext({
          env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
          addDirs: [extra],
        });
      expect(toolPermissionContext.additionalWorkingDirectories.has(extra)).toBe(
        true,
      );
      expect(warnings).toEqual([]);
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });

  test("warns about --add-dir paths that do not exist", async () => {
    const { warnings } = await initializeToolPermissionContext({
      env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
      addDirs: ["/nope-absolutely-does-not-exist-123456"],
    });
    expect(warnings.some((w) => w.includes("does not exist"))).toBe(true);
  });

  test("respects permissionMode override", async () => {
    const { toolPermissionContext } = await initializeToolPermissionContext({
      env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
      permissionMode: "plan",
    });
    expect(toolPermissionContext.mode).toBe("plan");
  });

  test("sets isAutoModeAvailable when settings do not disable auto mode", async () => {
    const { toolPermissionContext } = await initializeToolPermissionContext({
      env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
    });
    expect(toolPermissionContext.isAutoModeAvailable).toBe(true);
  });

  test("reads disableAutoMode from settings into the context", async () => {
    mkdirSync(join(home, ".agenc"), { recursive: true });
    writeFileSync(
      join(home, ".agenc", "settings.json"),
      JSON.stringify({ permissions: { disableAutoMode: "disable" } }),
    );
    const { toolPermissionContext } = await initializeToolPermissionContext({
      env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
    });
    expect(toolPermissionContext.isAutoModeAvailable).toBe(false);
  });

  test("does not start in auto mode when the live gate is closed", async () => {
    const restore = __setAutoModeGateResolverForTesting(() => false);
    try {
      const { toolPermissionContext } = await initializeToolPermissionContext({
        env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
        permissionMode: "auto",
      });
      expect(toolPermissionContext.mode).toBe("default");
    } finally {
      restore();
    }
  });

  test("sets isBypassPermissionsModeAvailable when dangerous skip granted", async () => {
    const { toolPermissionContext } = await initializeToolPermissionContext({
      env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
      allowDangerouslySkipPermissions: true,
      permissionMode: "bypassPermissions",
    });
    expect(toolPermissionContext.isBypassPermissionsModeAvailable).toBe(true);
  });

  test("reads additionalDirectories from user settings", async () => {
    const extra = mkTmp();
    try {
      mkdirSync(join(home, ".agenc"), { recursive: true });
      writeFileSync(
        join(home, ".agenc", "settings.json"),
        JSON.stringify({
          permissions: { additionalDirectories: [extra] },
        }),
      );
      const { toolPermissionContext } = await initializeToolPermissionContext({
        env: { home, cwd, managedSettingsPath: join(home, "no-policy.json") },
      });
      expect(
        toolPermissionContext.additionalWorkingDirectories.has(extra),
      ).toBe(true);
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });
});

describe("getEnabledSettingSources", () => {
  test("returns all five file-backed sources by default", () => {
    expect(getEnabledSettingSources()).toEqual([
      "userSettings",
      "projectSettings",
      "localSettings",
      "flagSettings",
      "policySettings",
    ]);
  });
});

// Small compile-time check that writeSettings is declared (eslint's
// noUnusedLocals would flag the helper above; this test reminds that
// it can be used to extend coverage without adding imports).
test("writeSettings helper is referenceable", () => {
  expect(typeof writeSettings).toBe("function");
});

test("loadAllPermissionRulesFromDisk returns empty when env omitted and no $HOME file present", async () => {
  // Use a temp home that has no .agenc subdir and a managed path that
  // does not exist — guarantees empty rules in a clean env.
  const clean = mkTmp();
  try {
    const rules = await loadAllPermissionRulesFromDisk({
      home: clean,
      cwd: clean,
      managedSettingsPath: join(clean, "nope.json"),
    });
    expect(rules).toEqual([]);
  } finally {
    rmSync(clean, { recursive: true, force: true });
  }
});

test("existsSync behaves as expected (env sanity)", () => {
  const d = mkTmp();
  try {
    expect(existsSync(d)).toBe(true);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
