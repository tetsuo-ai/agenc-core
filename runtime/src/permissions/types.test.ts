import { describe, expect, test } from "vitest";
import {
  ALL_PERMISSION_MODES,
  EDITABLE_SOURCES,
  PERMISSION_BEHAVIORS,
  PERMISSION_RULE_SOURCES,
  SETTING_SOURCES,
  USER_ADDRESSABLE_PERMISSION_MODES,
  createEmptyToolPermissionContext,
  deepFreeze,
  isPermissionMode,
  isUserAddressablePermissionMode,
} from "./types.js";

describe("permissions/types constants", () => {
  test("PERMISSION_RULE_SOURCES preserves AgenC priority order", () => {
    expect([...PERMISSION_RULE_SOURCES]).toEqual([
      "userSettings",
      "projectSettings",
      "localSettings",
      "flagSettings",
      "policySettings",
      "cliArg",
      "command",
      "session",
    ]);
  });

  test("PERMISSION_RULE_SOURCES is frozen", () => {
    expect(Object.isFrozen(PERMISSION_RULE_SOURCES)).toBe(true);
  });

  test("SETTING_SOURCES is the disk-origin subset in the same order", () => {
    expect([...SETTING_SOURCES]).toEqual([
      "userSettings",
      "projectSettings",
      "localSettings",
      "flagSettings",
      "policySettings",
    ]);
    expect(Object.isFrozen(SETTING_SOURCES)).toBe(true);
  });

  test("EDITABLE_SOURCES excludes flagSettings and policySettings", () => {
    expect([...EDITABLE_SOURCES]).toEqual([
      "userSettings",
      "projectSettings",
      "localSettings",
    ]);
    expect(EDITABLE_SOURCES).not.toContain("flagSettings");
    expect(EDITABLE_SOURCES).not.toContain("policySettings");
  });

  test("PERMISSION_BEHAVIORS lists allow, deny, ask", () => {
    expect([...PERMISSION_BEHAVIORS].sort()).toEqual(
      ["allow", "ask", "deny"].sort(),
    );
    expect(Object.isFrozen(PERMISSION_BEHAVIORS)).toBe(true);
  });

  test("USER_ADDRESSABLE_PERMISSION_MODES excludes internal-only modes", () => {
    expect([...USER_ADDRESSABLE_PERMISSION_MODES]).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "dontAsk",
      "auto",
    ]);
    expect([...USER_ADDRESSABLE_PERMISSION_MODES]).not.toContain("unattended");
    expect([...USER_ADDRESSABLE_PERMISSION_MODES]).not.toContain("bubble");
    expect(USER_ADDRESSABLE_PERMISSION_MODES.length).toBe(6);
  });

  test("ALL_PERMISSION_MODES has exactly 8 variants", () => {
    expect(ALL_PERMISSION_MODES.length).toBe(8);
    for (const mode of [
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "dontAsk",
      "auto",
      "unattended",
      "bubble",
    ] as const) {
      expect(ALL_PERMISSION_MODES).toContain(mode);
    }
  });

});

describe("isPermissionMode", () => {
  test("returns true for every documented mode", () => {
    for (const mode of ALL_PERMISSION_MODES) {
      expect(isPermissionMode(mode)).toBe(true);
    }
  });

  test("returns false for unknown strings", () => {
    expect(isPermissionMode("accept")).toBe(false);
    expect(isPermissionMode("")).toBe(false);
    expect(isPermissionMode("BYPASS")).toBe(false);
  });

  test("returns false for non-strings", () => {
    expect(isPermissionMode(123)).toBe(false);
    expect(isPermissionMode(null)).toBe(false);
    expect(isPermissionMode(undefined)).toBe(false);
    expect(isPermissionMode({})).toBe(false);
  });
});

describe("isUserAddressablePermissionMode", () => {
  test("returns true only for settings and CLI modes", () => {
    for (const mode of USER_ADDRESSABLE_PERMISSION_MODES) {
      expect(isUserAddressablePermissionMode(mode)).toBe(true);
    }
    expect(isUserAddressablePermissionMode("unattended")).toBe(false);
    expect(isUserAddressablePermissionMode("bubble")).toBe(false);
    expect(isUserAddressablePermissionMode("unknown")).toBe(false);
  });
});

describe("deepFreeze", () => {
  test("freezes plain objects recursively", () => {
    const v = deepFreeze({ a: { b: { c: 1 } } });
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v.a)).toBe(true);
    expect(Object.isFrozen(v.a.b)).toBe(true);
  });

  test("freezes arrays", () => {
    const v = deepFreeze([1, [2, [3]]]);
    expect(Object.isFrozen(v)).toBe(true);
    expect(Object.isFrozen(v[1])).toBe(true);
  });

  test("leaves primitives unchanged", () => {
    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze("x")).toBe("x");
    expect(deepFreeze(null)).toBe(null);
  });

  test("is idempotent on already-frozen values", () => {
    const v = Object.freeze({ a: 1 });
    expect(deepFreeze(v)).toBe(v);
  });

  test("freezes Map entries' values (but not the Map itself)", () => {
    const inner = { a: 1 };
    const m = new Map<string, typeof inner>([["k", inner]]);
    deepFreeze(m);
    expect(Object.isFrozen(inner)).toBe(true);
  });
});

describe("createEmptyToolPermissionContext", () => {
  test("returns a frozen default-mode context", () => {
    const ctx = createEmptyToolPermissionContext();
    expect(ctx.mode).toBe("default");
    expect(ctx.isBypassPermissionsModeAvailable).toBe(false);
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  test("applies overrides without mutating inputs", () => {
    const ctx = createEmptyToolPermissionContext({
      mode: "plan",
      isBypassPermissionsModeAvailable: true,
    });
    expect(ctx.mode).toBe("plan");
    expect(ctx.isBypassPermissionsModeAvailable).toBe(true);
  });

  test("additionalWorkingDirectories defaults to an empty Map", () => {
    const ctx = createEmptyToolPermissionContext();
    expect(ctx.additionalWorkingDirectories.size).toBe(0);
  });

  test("all three rule buckets are empty", () => {
    const ctx = createEmptyToolPermissionContext();
    expect(Object.keys(ctx.alwaysAllowRules).length).toBe(0);
    expect(Object.keys(ctx.alwaysDenyRules).length).toBe(0);
    expect(Object.keys(ctx.alwaysAskRules).length).toBe(0);
  });

  test("frozen context cannot be mutated in strict mode", () => {
    const ctx = createEmptyToolPermissionContext();
    expect(() => {
      (ctx as unknown as { mode: string }).mode = "plan";
    }).toThrow(TypeError);
  });
});

describe("source ordering invariants", () => {
  test("userSettings comes before projectSettings before localSettings", () => {
    const u = PERMISSION_RULE_SOURCES.indexOf("userSettings");
    const p = PERMISSION_RULE_SOURCES.indexOf("projectSettings");
    const l = PERMISSION_RULE_SOURCES.indexOf("localSettings");
    expect(u).toBeGreaterThanOrEqual(0);
    expect(u).toBeLessThan(p);
    expect(p).toBeLessThan(l);
  });

  test("cliArg/command/session come after file-backed sources", () => {
    const policy = PERMISSION_RULE_SOURCES.indexOf("policySettings");
    const cli = PERMISSION_RULE_SOURCES.indexOf("cliArg");
    const cmd = PERMISSION_RULE_SOURCES.indexOf("command");
    const session = PERMISSION_RULE_SOURCES.indexOf("session");
    expect(cli).toBeGreaterThan(policy);
    expect(cmd).toBeGreaterThan(cli);
    expect(session).toBeGreaterThan(cmd);
  });

  test("SETTING_SOURCES is a prefix of PERMISSION_RULE_SOURCES", () => {
    for (let i = 0; i < SETTING_SOURCES.length; i++) {
      expect(PERMISSION_RULE_SOURCES[i]).toBe(SETTING_SOURCES[i]);
    }
  });
});

describe("readonly constants", () => {
  test("cannot push to PERMISSION_RULE_SOURCES", () => {
    expect(() => {
      (PERMISSION_RULE_SOURCES as unknown as string[]).push("x");
    }).toThrow();
  });

  test("cannot push to ALL_PERMISSION_MODES", () => {
    expect(() => {
      (ALL_PERMISSION_MODES as unknown as string[]).push("x");
    }).toThrow();
  });

  test("cannot push to EDITABLE_SOURCES", () => {
    expect(() => {
      (EDITABLE_SOURCES as unknown as string[]).push("x");
    }).toThrow();
  });
});
