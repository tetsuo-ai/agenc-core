/**
 * Tests for the permission-mode FSM (T11 Wave 1-B / I-3).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  EXTERNAL_PERMISSION_MODES,
  INTERNAL_PERMISSION_MODES,
  PermissionAuthorityUnavailableError,
  PermissionModeRegistry,
  __setAutoModeGateResolverForTesting,
  __setPlanAutoModeResolverForTesting,
  canCycleToAuto,
  createDisabledAutoModeContext,
  createDisabledBypassPermissionsContext,
  getNextPermissionMode,
  isAutoModeGateEnabled,
  isDangerousBashPermission,
  isExternalPermissionMode,
  prepareContextForPlanMode,
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
  transitionPlanAutoMode,
  transitionPermissionMode,
  shouldPlanUseAutoMode,
} from "./permission-mode.js";
import type { PermissionMode, ToolPermissionContext } from "./types.js";
import { permissionGrantsFromToolPermissionContext } from "./permission-grants.js";
import {
  executionAuthorityForPermissionContext,
  type SessionExecutionAuthority,
} from "../session/configuration.js";

const AUTO_MODE_ENV_KEYS = [
  "XAI_API_KEY",
  "GROK_API_KEY",
  "AGENC_XAI_API_KEY",
] as const;

function withAutoModeEnv<T>(body: () => T): T {
  const previous = Object.fromEntries(
    AUTO_MODE_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as Record<(typeof AUTO_MODE_ENV_KEYS)[number], string | undefined>;
  for (const key of AUTO_MODE_ENV_KEYS) {
    delete process.env[key];
  }
  try {
    return body();
  } finally {
    for (const key of AUTO_MODE_ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withGateEnabled<T>(enabled: boolean, body: () => T): T {
  const restore = __setAutoModeGateResolverForTesting(() => enabled);
  try {
    return body();
  } finally {
    restore();
  }
}

function baseCtx(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return {
    mode: "default",
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  };
}

describe("mode constants", () => {
  it("EXTERNAL_PERMISSION_MODES excludes internal-only modes", () => {
    expect(EXTERNAL_PERMISSION_MODES).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "auto",
    ]);
    expect(EXTERNAL_PERMISSION_MODES).not.toContain("dontAsk");
    expect(EXTERNAL_PERMISSION_MODES).not.toContain("unattended");
    expect(EXTERNAL_PERMISSION_MODES).not.toContain("bubble");
  });

  it("INTERNAL_PERMISSION_MODES lists all 8 modes", () => {
    expect(INTERNAL_PERMISSION_MODES).toHaveLength(8);
    for (const m of [
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "dontAsk",
      "auto",
      "unattended",
      "bubble",
    ] as PermissionMode[]) {
      expect(INTERNAL_PERMISSION_MODES).toContain(m);
    }
  });

  it("isExternalPermissionMode returns true only for the 5 external modes", () => {
    for (const m of EXTERNAL_PERMISSION_MODES) {
      expect(isExternalPermissionMode(m)).toBe(true);
    }
    expect(isExternalPermissionMode("dontAsk")).toBe(false);
    expect(isExternalPermissionMode("unattended")).toBe(false);
    expect(isExternalPermissionMode("bubble")).toBe(false);
  });
});

describe("auto-mode gate", () => {
  it("isAutoModeGateEnabled returns false when xAI is not configured", () => {
    withAutoModeEnv(() => {
      expect(isAutoModeGateEnabled()).toBe(false);
    });
  });

  it("canCycleToAuto requires both the cached flag and the live gate", () => {
    const available = baseCtx({ isAutoModeAvailable: true });
    withAutoModeEnv(() => {
      expect(canCycleToAuto(available)).toBe(false); // gate off
    });
    withGateEnabled(true, () => {
      expect(canCycleToAuto(available)).toBe(true);
      expect(canCycleToAuto(baseCtx({ isAutoModeAvailable: false }))).toBe(
        false,
      );
    });
  });
});

describe("getNextPermissionMode (Shift+Tab cycle)", () => {
  it("cycles default -> acceptEdits -> plan -> default when bypass and auto unavailable", () => {
    const ctx = baseCtx();
    expect(getNextPermissionMode("default", ctx)).toBe("acceptEdits");
    expect(getNextPermissionMode("acceptEdits", ctx)).toBe("plan");
    expect(getNextPermissionMode("plan", ctx)).toBe("default");
  });

  it("cycles plan -> bypassPermissions when bypass is available", () => {
    const ctx = baseCtx({ isBypassPermissionsModeAvailable: true });
    expect(getNextPermissionMode("plan", ctx)).toBe("bypassPermissions");
    expect(getNextPermissionMode("bypassPermissions", ctx)).toBe("default");
  });

  it("cycles plan -> auto when bypass unavailable but canCycleToAuto", () => {
    const ctx = baseCtx({ isAutoModeAvailable: true });
    withGateEnabled(true, () => {
      expect(getNextPermissionMode("plan", ctx)).toBe("auto");
      expect(getNextPermissionMode("auto", ctx)).toBe("default");
    });
  });

  it("cycles the full default->acceptEdits->plan->bypass->auto->default when both available", () => {
    const ctx = baseCtx({
      isBypassPermissionsModeAvailable: true,
      isAutoModeAvailable: true,
    });
    withGateEnabled(true, () => {
      const sequence: PermissionMode[] = ["default"];
      let cur: PermissionMode = "default";
      for (let i = 0; i < 5; i++) {
        cur = getNextPermissionMode(cur, ctx);
        sequence.push(cur);
      }
      expect(sequence).toEqual([
        "default",
        "acceptEdits",
        "plan",
        "bypassPermissions",
        "auto",
        "default",
      ]);
    });
  });

  it("bypassPermissions -> default when canCycleToAuto is false", () => {
    const ctx = baseCtx({ isBypassPermissionsModeAvailable: true });
    expect(getNextPermissionMode("bypassPermissions", ctx)).toBe("default");
  });

  it("dontAsk, unattended, and bubble fall back to default", () => {
    const ctx = baseCtx();
    expect(getNextPermissionMode("dontAsk", ctx)).toBe("default");
    expect(getNextPermissionMode("unattended", ctx)).toBe("default");
    expect(getNextPermissionMode("bubble", ctx)).toBe("default");
  });
});

describe("transitionPermissionMode — plan enter/exit", () => {
  it("sets prePlanMode on enter and clears it on exit", () => {
    const start = baseCtx({ mode: "acceptEdits" });
    const entered = transitionPermissionMode("acceptEdits", "plan", start);
    expect(entered.prePlanMode).toBe("acceptEdits");

    // Caller sets mode on the returned context; simulate for exit.
    const inPlan: ToolPermissionContext = { ...entered, mode: "plan" };
    const exited = transitionPermissionMode("plan", "default", inPlan);
    expect(exited.prePlanMode).toBeUndefined();
  });

  it("preserves prePlanMode on plan-mode re-entry from any non-plan target", () => {
    // Per-turn attachment exit-pulse bookkeeping has moved to
    // AttachmentTrackingState; the FSM now only owns the prePlanMode
    // stash and dangerous-rule restore. Pin the stash semantics here so
    // a regression that drops the stash on re-entry surfaces as a
    // failing test.
    const inPlan = baseCtx({ mode: "plan", prePlanMode: "default" });
    const exited = transitionPermissionMode("plan", "default", inPlan);
    expect(exited.prePlanMode).toBeUndefined();

    const back: ToolPermissionContext = { ...exited, mode: "default" };
    const reEntered = transitionPermissionMode("default", "plan", back);
    expect(reEntered.prePlanMode).toBe("default");
  });

  it("clears plan-scoped auto-mode state on exit back to a non-auto mode", () => {
    const inPlan = baseCtx({
      mode: "plan",
      prePlanMode: "default",
      autoModeActive: true,
      alwaysAllowRules: { userSettings: ["FileRead(src/**)"] },
      strippedDangerousRules: { userSettings: ["system.bash(*)"] },
    });
    const exited = transitionPermissionMode("plan", "default", inPlan);
    expect(exited.autoModeActive).toBe(false);
    expect(exited.prePlanMode).toBeUndefined();
    expect(exited.alwaysAllowRules.userSettings).toEqual([
      "FileRead(src/**)",
      "system.bash(*)",
    ]);
  });

  it("re-entering plan is a no-op (does not double-stash prePlanMode)", () => {
    const inPlan = baseCtx({ mode: "plan", prePlanMode: "acceptEdits" });
    const after = transitionPermissionMode("plan", "plan", inPlan);
    expect(after).toMatchObject({
      mode: "plan",
      prePlanMode: "acceptEdits",
    });
    expect([...after.additionalWorkingDirectories]).toEqual([
      ...inPlan.additionalWorkingDirectories,
    ]);
    expect(Object.isFrozen(after)).toBe(true);
    expect(after.prePlanMode).toBe("acceptEdits");
  });

  it("revokes plan-auto authority on a same-mode plan transition", () => {
    const inPlan = baseCtx({
      mode: "plan",
      prePlanMode: "default",
      autoModeActive: true,
      isAutoModeAvailable: true,
      alwaysAllowRules: { userSettings: ["FileRead(src/**)"] },
      strippedDangerousRules: { userSettings: ["system.bash(*)"] },
    });

    withGateEnabled(true, () => {
      const restorePlanAuto = __setPlanAutoModeResolverForTesting(() => false);
      try {
        const after = transitionPermissionMode("plan", "plan", inPlan);
        expect(after.autoModeActive).toBe(false);
        expect(after.strippedDangerousRules).toBeUndefined();
        expect(after.alwaysAllowRules.userSettings).toEqual([
          "FileRead(src/**)",
          "system.bash(*)",
        ]);
      } finally {
        restorePlanAuto();
      }
    });
  });
});

describe("transitionPermissionMode — auto enter/leave", () => {
  it("refuses auto when canonical configuration disables it even if the live gate is open", () => {
    withGateEnabled(true, () => {
      const ctx = baseCtx({ isAutoModeAvailable: false });
      expect(() => transitionPermissionMode("default", "auto", ctx)).toThrow(
        /disabled by canonical configuration/,
      );
    });
  });

  it("refuses a same-mode auto request after canonical policy disables auto", () => {
    withGateEnabled(true, () => {
      const ctx = baseCtx({
        mode: "auto",
        autoModeActive: true,
        isAutoModeAvailable: false,
      });
      expect(() => transitionPermissionMode("auto", "auto", ctx)).toThrow(
        /disabled by canonical configuration/,
      );
    });
  });

  it("throws if entering auto while gate is disabled", () => {
    withAutoModeEnv(() => {
      const ctx = baseCtx({ isAutoModeAvailable: true });
      expect(() => transitionPermissionMode("default", "auto", ctx)).toThrow(
        /gate is not enabled/,
      );
    });
  });

  it("enters auto when gate enabled, sets autoModeActive, strips dangerous rules", () => {
    const ctx = baseCtx({
      isAutoModeAvailable: true,
      alwaysAllowRules: {
        userSettings: ["system.bash(python:*)", "FileRead(src/**)"],
      },
    });
    withGateEnabled(true, () => {
      const next = transitionPermissionMode("default", "auto", ctx);
      expect(next.autoModeActive).toBe(true);
      expect(next.alwaysAllowRules.userSettings).toEqual(["FileRead(src/**)"]);
      expect(next.strippedDangerousRules?.userSettings).toEqual([
        "system.bash(python:*)",
      ]);
    });
  });

  it("leaving auto restores stashed rules and clears autoModeActive", () => {
    const ctx = baseCtx({
      mode: "auto",
      autoModeActive: true,
      alwaysAllowRules: { userSettings: ["FileRead(src/**)"] },
      strippedDangerousRules: { userSettings: ["system.bash(python:*)"] },
    });
    const next = transitionPermissionMode("auto", "default", ctx);
    expect(next.autoModeActive).toBe(false);
    expect(next.alwaysAllowRules.userSettings).toEqual([
      "FileRead(src/**)",
      "system.bash(python:*)",
    ]);
    expect(next.strippedDangerousRules).toBeUndefined();
  });

  it("keeps classifier semantics and dangerous-rule isolation across auto to plan", () => {
    const ctx = baseCtx({
      mode: "auto",
      autoModeActive: true,
      isAutoModeAvailable: true,
      alwaysAllowRules: { userSettings: ["FileRead(src/**)"] },
      strippedDangerousRules: {
        userSettings: ["system.bash(*)", "spawn_agent(worker)"],
      },
    });

    withGateEnabled(true, () => {
      const restorePlanAuto = __setPlanAutoModeResolverForTesting(() => true);
      try {
        const next = transitionPermissionMode("auto", "plan", ctx);
        expect(next).toMatchObject({
          autoModeActive: true,
          prePlanMode: "auto",
          alwaysAllowRules: { userSettings: ["FileRead(src/**)"] },
          strippedDangerousRules: {
            userSettings: ["system.bash(*)", "spawn_agent(worker)"],
          },
        });
        expect(next.alwaysAllowRules.userSettings).not.toContain(
          "system.bash(*)",
        );
        expect(next.alwaysAllowRules.userSettings).not.toContain(
          "spawn_agent(worker)",
        );
      } finally {
        restorePlanAuto();
      }
    });
  });
});

describe("prepareContextForPlanMode", () => {
  it("stashes current mode as prePlanMode by default", () => {
    const ctx = baseCtx({ mode: "acceptEdits" });
    const next = prepareContextForPlanMode(ctx);
    expect(next.prePlanMode).toBe("acceptEdits");
    expect(next.strippedDangerousRules).toBeUndefined();
  });

  it("strips dangerous rules when shouldUseAutoInPlan is true and mode != bypass", () => {
    const ctx = baseCtx({
      mode: "default",
      isAutoModeAvailable: true,
      alwaysAllowRules: {
        userSettings: ["system.bash(*)"],
      },
    });
    withGateEnabled(true, () => {
      const next = prepareContextForPlanMode(ctx, {
        shouldUseAutoInPlan: true,
      });
      expect(next.prePlanMode).toBe("default");
      expect(next.autoModeActive).toBe(true);
      expect(next.strippedDangerousRules?.userSettings).toEqual([
        "system.bash(*)",
      ]);
      expect(next.alwaysAllowRules.userSettings).toBeUndefined();
    });
  });

  it.each([
    { canonicalAvailable: false, gateEnabled: true },
    { canonicalAvailable: true, gateEnabled: false },
  ])(
    "does not enable plan auto with canonical=$canonicalAvailable gate=$gateEnabled",
    ({ canonicalAvailable, gateEnabled }) => {
      withGateEnabled(gateEnabled, () => {
        const ctx = baseCtx({
          mode: "default",
          isAutoModeAvailable: canonicalAvailable,
          alwaysAllowRules: { userSettings: ["system.bash(*)"] },
        });
        const next = prepareContextForPlanMode(ctx, {
          shouldUseAutoInPlan: true,
        });
        expect(next.prePlanMode).toBe("default");
        expect(next.autoModeActive).not.toBe(true);
        expect(next.strippedDangerousRules).toBeUndefined();
        expect(next.alwaysAllowRules.userSettings).toEqual([
          "system.bash(*)",
        ]);
      });
    },
  );

  it("does not strip dangerous rules entering plan from bypass", () => {
    const ctx = baseCtx({
      mode: "bypassPermissions",
      alwaysAllowRules: { userSettings: ["system.bash(*)"] },
    });
    const next = prepareContextForPlanMode(ctx, { shouldUseAutoInPlan: true });
    expect(next.alwaysAllowRules.userSettings).toEqual(["system.bash(*)"]);
    expect(next.autoModeActive).toBeUndefined();
    expect(next.strippedDangerousRules).toBeUndefined();
  });

  it("re-entering plan is a no-op", () => {
    const ctx = baseCtx({ mode: "plan", prePlanMode: "acceptEdits" });
    const next = prepareContextForPlanMode(ctx);
    expect(next).toMatchObject({ mode: "plan", prePlanMode: "acceptEdits" });
    expect([...next.additionalWorkingDirectories]).toEqual([
      ...ctx.additionalWorkingDirectories,
    ]);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it("preserves existing auto-mode state entering plan from auto", () => {
    const ctx = baseCtx({
      mode: "auto",
      autoModeActive: true,
      isAutoModeAvailable: true,
      alwaysAllowRules: { userSettings: ["FileRead(src/**)"] },
    });
    withGateEnabled(true, () => {
      const next = prepareContextForPlanMode(ctx, {
        shouldUseAutoInPlan: true,
      });
      expect(next.prePlanMode).toBe("auto");
      expect(next.autoModeActive).toBe(true);
      expect(next.alwaysAllowRules.userSettings).toEqual([
        "FileRead(src/**)",
      ]);
    });
  });

  it("uses auto semantics in plan only when both the setting and auto gate are enabled", () => {
    withGateEnabled(false, () => {
      const restore = __setPlanAutoModeResolverForTesting(() => true);
      try {
        expect(shouldPlanUseAutoMode()).toBe(false);
      } finally {
        restore();
      }
    });

    withGateEnabled(true, () => {
      const restore = __setPlanAutoModeResolverForTesting(() => true);
      try {
        expect(shouldPlanUseAutoMode()).toBe(true);
        const next = transitionPermissionMode(
          "default",
          "plan",
          baseCtx({
            isAutoModeAvailable: true,
            alwaysAllowRules: { userSettings: ["system.bash(*)", "FileRead(src/**)"] },
          }),
        );
        expect("error" in next).toBe(false);
        if ("error" in next) return;
        expect(next.autoModeActive).toBe(true);
        expect(next.alwaysAllowRules.userSettings).toEqual(["FileRead(src/**)"]);
      } finally {
        restore();
      }
    });
  });
});

describe("transitionPlanAutoMode", () => {
  it("enables plan auto only when canonical availability and the live gate are present", () => {
    withGateEnabled(true, () => {
      const next = transitionPlanAutoMode(
        baseCtx({
          mode: "plan",
          prePlanMode: "default",
          isAutoModeAvailable: true,
          alwaysAllowRules: { userSettings: ["system.bash(*)", "FileRead"] },
        }),
        true,
      );
      expect(next.autoModeActive).toBe(true);
      expect(next.alwaysAllowRules.userSettings).toEqual(["FileRead"]);
      expect(next.strippedDangerousRules?.userSettings).toEqual([
        "system.bash(*)",
      ]);
    });
  });

  it.each([
    { canonicalAvailable: false, gateEnabled: true },
    { canonicalAvailable: true, gateEnabled: false },
  ])(
    "removes stale plan auto with canonical=$canonicalAvailable gate=$gateEnabled",
    ({ canonicalAvailable, gateEnabled }) => {
      withGateEnabled(gateEnabled, () => {
        const next = transitionPlanAutoMode(
          baseCtx({
            mode: "plan",
            prePlanMode: "default",
            autoModeActive: true,
            isAutoModeAvailable: canonicalAvailable,
            alwaysAllowRules: { userSettings: ["FileRead"] },
            strippedDangerousRules: {
              userSettings: ["system.bash(*)"],
            },
          }),
          true,
        );
        expect(next.autoModeActive).toBe(false);
        expect(next.strippedDangerousRules).toBeUndefined();
        expect(next.alwaysAllowRules.userSettings).toEqual([
          "FileRead",
          "system.bash(*)",
        ]);
      });
    },
  );
});

describe("stripDangerousPermissionsForAutoMode / restoreDangerousPermissions", () => {
  it("round-trips: strip then restore reproduces the original allow set", () => {
    const original = baseCtx({
      alwaysAllowRules: {
        userSettings: ["system.bash(python:*)", "FileRead(src/**)", "spawn_agent(worker)"],
        projectSettings: ["system.bash(*)", "Write(/tmp/**)"],
      },
    });
    const stripped = stripDangerousPermissionsForAutoMode(original);
    expect(stripped.alwaysAllowRules.userSettings).toEqual(["FileRead(src/**)"]);
    expect(stripped.alwaysAllowRules.projectSettings).toEqual(["Write(/tmp/**)"]);
    expect([...(stripped.strippedDangerousRules?.userSettings ?? [])].sort()).toEqual(
      ["spawn_agent(worker)", "system.bash(python:*)"].sort(),
    );
    expect(stripped.strippedDangerousRules?.projectSettings).toEqual(["system.bash(*)"]);

    const restored = restoreDangerousPermissions(stripped);
    expect(restored.strippedDangerousRules).toBeUndefined();
    const us = [...(restored.alwaysAllowRules.userSettings ?? [])].sort();
    const ps = [...(restored.alwaysAllowRules.projectSettings ?? [])].sort();
    expect(us).toEqual(
      ["system.bash(python:*)", "FileRead(src/**)", "spawn_agent(worker)"].sort(),
    );
    expect(ps).toEqual(["system.bash(*)", "Write(/tmp/**)"].sort());
  });

  it("restoreDangerousPermissions is a no-op when stash is absent", () => {
    const ctx = baseCtx({ alwaysAllowRules: { userSettings: ["FileRead(*)"] } });
    const restored = restoreDangerousPermissions(ctx);
    expect(restored).toMatchObject({
      mode: ctx.mode,
      alwaysAllowRules: ctx.alwaysAllowRules,
    });
    expect(Object.isFrozen(restored)).toBe(true);
  });

  it("strip sets an empty stash when no dangerous rules exist", () => {
    const ctx = baseCtx({ alwaysAllowRules: { userSettings: ["FileRead(src/**)"] } });
    const next = stripDangerousPermissionsForAutoMode(ctx);
    expect(next.strippedDangerousRules).toEqual({});
    expect(next.alwaysAllowRules).toEqual(ctx.alwaysAllowRules);
    expect(Object.isFrozen(next.alwaysAllowRules)).toBe(true);
  });

  it("settings disable restores stashed rules and exits auto mode", () => {
    const active = {
      ...stripDangerousPermissionsForAutoMode(
        baseCtx({
          mode: "auto",
          alwaysAllowRules: { userSettings: ["system.bash(python:*)", "FileRead"] },
        }),
      ),
      mode: "auto" as const,
      autoModeActive: true,
      isAutoModeAvailable: true,
    };

    const disabled = createDisabledAutoModeContext(active);
    expect(disabled.mode).toBe("default");
    expect(disabled.autoModeActive).toBe(false);
    expect(disabled.isAutoModeAvailable).toBe(false);
    expect(disabled.strippedDangerousRules).toBeUndefined();
    expect(disabled.alwaysAllowRules.userSettings).toEqual([
      "FileRead",
      "system.bash(python:*)",
    ]);
  });
});

describe("isDangerousBashPermission", () => {
  it("flags tool-level allow (Bash with no content)", () => {
    expect(isDangerousBashPermission("system.bash", undefined)).toBe(true);
    expect(isDangerousBashPermission("system.bash", "")).toBe(true);
  });

  it("flags system.bash(*)", () => {
    expect(isDangerousBashPermission("system.bash", "*")).toBe(true);
  });

  it("flags interpreter prefix rules", () => {
    expect(isDangerousBashPermission("system.bash", "python:*")).toBe(true);
    expect(isDangerousBashPermission("system.bash", "node*")).toBe(true);
    expect(isDangerousBashPermission("system.bash", "npm run:*")).toBe(true);
    expect(isDangerousBashPermission("system.bash", "python -c*")).toBe(true);
  });

  it("uses the live upstream Bash pattern list instead of the old subset", () => {
    if (process.env.USER_TYPE === "ant") {
      expect(isDangerousBashPermission("system.bash", "gh api:*")).toBe(true);
    } else {
      expect(isDangerousBashPermission("system.bash", "gh api:*")).toBe(false);
    }
  });

  it("ignores non-Bash tools", () => {
    expect(isDangerousBashPermission("FileRead", "*")).toBe(false);
  });

  it("allows narrow Bash rules", () => {
    expect(isDangerousBashPermission("system.bash", "ls -la")).toBe(false);
    expect(isDangerousBashPermission("system.bash", "git status")).toBe(false);
  });
});

describe("PowerShell dangerous permission parity", () => {
  it("strips PowerShell rules for cross-platform interpreters", () => {
    const ctx = baseCtx({
      alwaysAllowRules: {
        userSettings: ["PowerShell(python:*)", "FileRead(src/**)"],
      },
    });
    const stripped = stripDangerousPermissionsForAutoMode(ctx);
    expect(stripped.alwaysAllowRules.userSettings).toEqual(["FileRead(src/**)"]);
    expect(stripped.strippedDangerousRules?.userSettings).toEqual([
      "PowerShell(python:*)",
    ]);
  });

  it("strips PowerShell .exe forms derived from shared patterns", () => {
    const ctx = baseCtx({
      alwaysAllowRules: {
        userSettings: ["PowerShell(npm.exe run:*)", "FileRead(src/**)"],
      },
    });
    const stripped = stripDangerousPermissionsForAutoMode(ctx);
    expect(stripped.alwaysAllowRules.userSettings).toEqual(["FileRead(src/**)"]);
    expect(stripped.strippedDangerousRules?.userSettings).toEqual([
      "PowerShell(npm.exe run:*)",
    ]);
  });
});

describe("PermissionModeRegistry", () => {
  it("projects approval bypass and sandbox bypass as independent axes", () => {
    const configured: SessionExecutionAuthority = {
      approvalPolicy: { value: "on_request" },
      sandboxPolicy: { value: "workspace_write" },
      fileSystemSandboxPolicy: {
        allowWrite: ["/workspace"],
        denyWrite: [],
        allowRead: [],
        denyRead: [],
      },
      networkSandboxPolicy: {
        allowlist: [],
        denylist: [],
        allowManagedDomainsOnly: false,
      },
      windowsSandboxLevel: "none",
      sandboxAllowGpu: false,
    };
    const rows = [
      {
        context: baseCtx({ mode: "default" }),
        dangerous: false,
        approval: "on_request",
        sandbox: "workspace_write",
      },
      {
        context: baseCtx({ mode: "bypassPermissions" }),
        dangerous: false,
        approval: "never",
        sandbox: "workspace_write",
      },
      {
        context: baseCtx({ mode: "default" }),
        dangerous: true,
        approval: "on_request",
        sandbox: "danger_full_access",
      },
      {
        context: baseCtx({ mode: "bypassPermissions" }),
        dangerous: true,
        approval: "never",
        sandbox: "danger_full_access",
      },
    ] as const;

    for (const row of rows) {
      const projected = executionAuthorityForPermissionContext(
        configured,
        row.context,
        row.dangerous,
      );
      expect(projected.approvalPolicy.value).toBe(row.approval);
      expect(projected.sandboxPolicy.value).toBe(row.sandbox);
      expect(projected.fileSystemSandboxPolicy.allowWrite).toEqual(
        row.dangerous ? [] : ["/workspace"],
      );
    }
  });

  it("subscribeToModeChange fires once per mode change", async () => {
    const reg = new PermissionModeRegistry(baseCtx({ mode: "default" }));
    const seen: Array<[PermissionMode, PermissionMode]> = [];
    reg.subscribeToModeChange((n, o) => seen.push([n, o]));

    await reg.update(baseCtx({ mode: "acceptEdits" }));
    await reg.update(baseCtx({ mode: "acceptEdits" })); // no-op
    await reg.update(baseCtx({ mode: "plan" }));

    expect(seen).toEqual([
      ["acceptEdits", "default"],
      ["plan", "acceptEdits"],
    ]);
  });

  it("notifies context observers for a same-mode rule commit", async () => {
    const initial = baseCtx({ mode: "default" });
    const reg = new PermissionModeRegistry(initial);
    const ownedInitial = reg.current();
    const contexts = vi.fn();
    const modes = vi.fn();
    reg.subscribeToContextChange(contexts);
    reg.subscribeToModeChange(modes);
    const next = baseCtx({
      mode: "default",
      alwaysDenyRules: { session: ["Write"] },
    });

    await reg.update(next);

    expect(contexts).toHaveBeenCalledOnce();
    const [published, previous] = contexts.mock.calls[0]!;
    expect(published).not.toBe(next);
    expect(published).toMatchObject({
      mode: "default",
      alwaysDenyRules: { session: ["Write"] },
    });
    expect(previous).toBe(ownedInitial);
    expect(modes).not.toHaveBeenCalled();
  });

  it("unsubscribe thunk stops future notifications", async () => {
    const reg = new PermissionModeRegistry(baseCtx({ mode: "default" }));
    const cb = vi.fn();
    const unsub = reg.subscribeToModeChange(cb);
    await reg.update(baseCtx({ mode: "plan" }));
    unsub();
    await reg.update(baseCtx({ mode: "default" }));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("update is atomic under AsyncLock — concurrent updates observe consistent transitions", async () => {
    const reg = new PermissionModeRegistry(baseCtx({ mode: "default" }));
    const transitions: Array<[PermissionMode, PermissionMode]> = [];
    reg.subscribeToModeChange((n, o) => transitions.push([n, o]));

    await Promise.all([
      reg.update(baseCtx({ mode: "acceptEdits" })),
      reg.update(baseCtx({ mode: "plan" })),
      reg.update(baseCtx({ mode: "default" })),
    ]);

    // Three updates with three distinct target modes produce three non-noop
    // transitions. The chain must be well-formed: each new == next's old.
    expect(transitions).toHaveLength(3);
    for (let i = 1; i < transitions.length; i++) {
      expect(transitions[i]![1]).toBe(transitions[i - 1]![0]);
    }
    expect(reg.current().mode).toBe("default");
  });

  it("bypassPermissionsAcceptedIn reflects the current context", async () => {
    const reg = new PermissionModeRegistry(
      baseCtx({ bypassPermissionsAcceptedIn: ["/workspace/a"] }),
    );
    expect(reg.bypassPermissionsAcceptedIn).toEqual(["/workspace/a"]);
    await reg.update(
      baseCtx({
        mode: "acceptEdits",
        bypassPermissionsAcceptedIn: ["/workspace/a", "/workspace/b"],
      }),
    );
    expect(reg.bypassPermissionsAcceptedIn).toEqual([
      "/workspace/a",
      "/workspace/b",
    ]);
  });

  it("keeps external authority fenced until the newest generation publishes", async () => {
    const reg = new PermissionModeRegistry(baseCtx({ mode: "default" }));
    const coordinator = vi.fn(
      async (
        _next: ToolPermissionContext,
        _current: ToolPermissionContext,
        _metadata: unknown,
        publication: { commit(): Promise<void> },
      ) => publication.commit(),
    );
    reg.installPublicationCoordinator(coordinator);
    const observed = vi.fn((next: ToolPermissionContext) => {
      expect(reg.current()).toBe(next);
    });
    reg.subscribeToContextChange(observed);
    const first = reg.beginExternalAuthorityPublication();
    const second = reg.beginExternalAuthorityPublication();

    expect(() => reg.current()).toThrow(
      "permission authority is unavailable while canonical configuration publication is pending",
    );
    await expect(
      first.publish((current) => ({
        next: { ...current, mode: "acceptEdits" },
        result: () => undefined,
      })),
    ).rejects.toThrow("pending permission authority publication was superseded");
    expect(() => reg.current()).toThrow(
      "permission authority is unavailable while canonical configuration publication is pending",
    );
    expect(observed).not.toHaveBeenCalled();
    expect(coordinator).not.toHaveBeenCalled();

    await second.publish((current) => ({
      next: { ...current, mode: "plan" },
      result: () => undefined,
    }));
    expect(reg.current().mode).toBe("plan");
    expect(coordinator).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]?.[0].mode).toBe("plan");
  });

  it("rejects public reads and mutations admitted while external authority is pending", async () => {
    const reg = new PermissionModeRegistry(baseCtx({ mode: "default" }));
    const pending = reg.beginExternalAuthorityPublication();
    const transaction = vi.fn((current: ToolPermissionContext) => ({
      next: null,
      result: () => current.mode,
    }));

    await expect(
      reg.update(baseCtx({ mode: "acceptEdits" })),
    ).rejects.toBeInstanceOf(PermissionAuthorityUnavailableError);
    await expect(reg.transact(transaction)).rejects.toBeInstanceOf(
      PermissionAuthorityUnavailableError,
    );
    expect(transaction).not.toHaveBeenCalled();

    await pending.publish((current) => ({
      next: { ...current, mode: "plan" },
      result: () => undefined,
    }));
    await expect(
      reg.transact((current) => ({
        next: null,
        result: () => current.mode,
      })),
    ).resolves.toBe("plan");
  });

  it("rolls back an external publication superseded during its durability commit", async () => {
    const reg = new PermissionModeRegistry(baseCtx({ mode: "default" }));
    const commitStarted = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    const rollback = vi.fn();
    const observed = vi.fn();
    reg.subscribeToContextChange(observed);
    reg.installBeforeUpdateHook(() => ({
      commit: async () => {
        commitStarted.resolve();
        await releaseCommit.promise;
      },
      rollback,
    }));
    const first = reg.beginExternalAuthorityPublication();
    const firstPublication = first.publish((current) => ({
      next: { ...current, mode: "acceptEdits" },
      result: () => undefined,
    }));
    await commitStarted.promise;

    const second = reg.beginExternalAuthorityPublication();
    releaseCommit.resolve();
    await expect(firstPublication).rejects.toThrow(
      "pending permission authority publication was superseded",
    );
    expect(rollback).toHaveBeenCalledOnce();
    expect(observed).not.toHaveBeenCalled();
    expect(() => reg.current()).toThrow(PermissionAuthorityUnavailableError);

    await second.publish((current) => ({
      next: { ...current, mode: "plan" },
      result: () => undefined,
    }));
    expect(reg.current().mode).toBe("plan");
    expect(rollback).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledOnce();
  });

  it("rolls a public mutation back when an external fence begins during its commit", async () => {
    const reg = new PermissionModeRegistry(baseCtx({ mode: "default" }));
    const commitStarted = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    const rollback = vi.fn();
    reg.installBeforeUpdateHook(() => ({
      commit: async () => {
        commitStarted.resolve();
        await releaseCommit.promise;
      },
      rollback,
    }));

    const update = reg.update(baseCtx({ mode: "acceptEdits" }));
    await commitStarted.promise;
    const pending = reg.beginExternalAuthorityPublication();
    releaseCommit.resolve();

    await expect(update).rejects.toBeInstanceOf(
      PermissionAuthorityUnavailableError,
    );
    expect(rollback).toHaveBeenCalledOnce();
    expect(() => reg.current()).toThrow(PermissionAuthorityUnavailableError);

    await pending.publish((current) => ({
      next: { ...current, mode: "plan" },
      result: () => undefined,
    }));
    expect(reg.current().mode).toBe("plan");
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("keeps public mutations fenced after failure until a later generation recovers", async () => {
    const reg = new PermissionModeRegistry(baseCtx({ mode: "default" }));
    const failure = new Error("injected external publication failure");
    const removeFailure = reg.installBeforeUpdateHook(() => {
      throw failure;
    });
    const failed = reg.beginExternalAuthorityPublication();

    await expect(
      failed.publish((current) => ({
        next: { ...current, mode: "acceptEdits" },
        result: () => undefined,
      })),
    ).rejects.toBe(failure);
    await expect(
      reg.update(baseCtx({ mode: "acceptEdits" })),
    ).rejects.toBeInstanceOf(PermissionAuthorityUnavailableError);

    removeFailure();
    const recovery = reg.beginExternalAuthorityPublication();
    await recovery.publish((current) => ({
      next: { ...current, mode: "plan" },
      result: () => undefined,
    }));
    await expect(
      reg.update(baseCtx({ mode: "acceptEdits" })),
    ).resolves.toBeUndefined();
    expect(reg.current().mode).toBe("acceptEdits");
  });

  it("a throwing subscriber does not prevent other subscribers from firing", async () => {
    const reg = new PermissionModeRegistry(baseCtx({ mode: "default" }));
    const ok = vi.fn();
    reg.subscribeToModeChange(() => {
      throw new Error("boom");
    });
    reg.subscribeToModeChange(ok);
    await reg.update(baseCtx({ mode: "plan" }));
    expect(ok).toHaveBeenCalledWith("plan", "default");
  });

  it("keeps lock-free readers on the old context until prepared durability commits", async () => {
    const initial = baseCtx({
      mode: "default",
      bypassPermissionsAcceptedIn: ["/old-workspace"],
    });
    const next = baseCtx({
      mode: "acceptEdits",
      bypassPermissionsAcceptedIn: ["/new-workspace"],
    });
    const reg = new PermissionModeRegistry(initial);
    const ownedInitial = reg.current();
    const commitEntered = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    reg.installBeforeUpdateHook(() => ({
      commit: async () => {
        commitEntered.resolve();
        await releaseCommit.promise;
      },
    }));

    const update = reg.update(next);
    await commitEntered.promise;
    expect(reg.current()).toBe(ownedInitial);
    expect(reg.bypassPermissionsAcceptedIn).toEqual(
      initial.bypassPermissionsAcceptedIn,
    );

    releaseCommit.resolve();
    await update;
    expect(reg.current()).not.toBe(next);
    expect(reg.current()).toMatchObject({
      mode: "acceptEdits",
      bypassPermissionsAcceptedIn: ["/new-workspace"],
    });
  });

  it("never exposes a prepared context when its durability commit fails", async () => {
    const initial = baseCtx({ mode: "default" });
    const next = baseCtx({ mode: "bypassPermissions" });
    const reg = new PermissionModeRegistry(initial);
    const ownedInitial = reg.current();
    const commitEntered = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    const rollback = vi.fn(() => {
      expect(reg.current()).toBe(ownedInitial);
    });
    reg.installBeforeUpdateHook(() => ({
      commit: async () => {
        commitEntered.resolve();
        await releaseCommit.promise;
        throw new Error("durability commit rejected");
      },
      rollback,
    }));

    const update = reg.update(next);
    await commitEntered.promise;
    expect(reg.current()).toBe(ownedInitial);
    releaseCommit.resolve();
    await expect(update).rejects.toThrow("durability commit rejected");
    expect(reg.current()).toBe(ownedInitial);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("owns a deeply immutable constructor snapshot without changing projections", () => {
    const directory = { path: "/extra", source: "session" as const };
    const directories = new Map([[directory.path, directory]]);
    const rules = ["Read(src/**)"];
    const accepted = ["/workspace"];
    const input = baseCtx({
      mode: "bypassPermissions",
      additionalWorkingDirectories: directories,
      alwaysAllowRules: { session: rules },
      bypassPermissionsAcceptedIn: accepted,
      isBypassPermissionsModeAvailable: true,
      unattendedPolicy: {
        allowlist: ["Read"],
        denylist: ["system.bash"],
      },
    });
    const expectedGrants = permissionGrantsFromToolPermissionContext(input);
    const configured: SessionExecutionAuthority = {
      approvalPolicy: { value: "on_request" },
      sandboxPolicy: { value: "workspace_write" },
      fileSystemSandboxPolicy: {
        allowWrite: ["/workspace"],
        denyWrite: [],
        allowRead: ["/workspace"],
        denyRead: [],
      },
      networkSandboxPolicy: {
        allowlist: [],
        denylist: [],
        allowManagedDomainsOnly: false,
      },
      windowsSandboxLevel: "none",
      sandboxAllowGpu: false,
    };
    const reg = new PermissionModeRegistry(input);
    const owned = reg.current();
    const expectedAuthority = executionAuthorityForPermissionContext(
      configured,
      owned,
    );

    directory.path = "/mutated";
    directories.clear();
    rules.push("Write(**)");
    accepted.push("/later");
    expect(() => {
      (owned as { mode: PermissionMode }).mode = "default";
    }).toThrow(TypeError);
    expect(() => {
      (owned.alwaysAllowRules.session as string[]).push("Write(**)");
    }).toThrow(TypeError);
    expect(() => {
      (owned.unattendedPolicy?.allowlist as string[]).push("Write");
    }).toThrow(TypeError);
    const exposedDirectories =
      owned.additionalWorkingDirectories as unknown as Map<string, unknown>;
    expect(exposedDirectories.set).toBeUndefined();
    expect(exposedDirectories.delete).toBeUndefined();
    expect(exposedDirectories.clear).toBeUndefined();
    expect(() => exposedDirectories.set("/later", {})).toThrow(TypeError);
    expect(() => exposedDirectories.delete("/extra")).toThrow(TypeError);
    expect(() => exposedDirectories.clear()).toThrow(TypeError);
    expect(() =>
      Map.prototype.set.call(owned.additionalWorkingDirectories, "/later", {
        path: "/later",
        source: "session",
      }),
    ).toThrow(TypeError);
    expect(() =>
      Map.prototype.delete.call(owned.additionalWorkingDirectories, "/extra"),
    ).toThrow(TypeError);
    expect(() =>
      Map.prototype.clear.call(owned.additionalWorkingDirectories),
    ).toThrow(TypeError);

    expect(reg.current()).toBe(owned);
    expect(permissionGrantsFromToolPermissionContext(reg.current())).toEqual(
      expectedGrants,
    );
    expect(
      executionAuthorityForPermissionContext(configured, reg.current()),
    ).toEqual(expectedAuthority);
  });

  it("snapshots queued update input before awaiting the registry lock", async () => {
    const reg = new PermissionModeRegistry(baseCtx());
    const firstCommitEntered = Promise.withResolvers<void>();
    const releaseFirstCommit = Promise.withResolvers<void>();
    let commitCount = 0;
    reg.installBeforeUpdateHook(() => ({
      commit: async () => {
        commitCount += 1;
        if (commitCount === 1) {
          firstCommitEntered.resolve();
          await releaseFirstCommit.promise;
        }
      },
    }));

    const first = reg.update(baseCtx({ mode: "acceptEdits" }));
    await firstCommitEntered.promise;
    const candidateRules = ["Read(src/**)"];
    const candidateDirectories = new Map([
      ["/extra", { path: "/extra", source: "session" as const }],
    ]);
    const candidate = baseCtx({
      mode: "plan",
      alwaysAllowRules: { session: candidateRules },
      additionalWorkingDirectories: candidateDirectories,
    });
    const second = reg.update(candidate);
    candidateRules.push("Write(**)");
    candidateDirectories.clear();
    (candidate as { mode: PermissionMode }).mode = "default";
    releaseFirstCommit.resolve();
    await Promise.all([first, second]);

    expect(reg.current().mode).toBe("plan");
    expect(reg.current().alwaysAllowRules.session).toEqual(["Read(src/**)"]);
    expect(reg.current().additionalWorkingDirectories.has("/extra")).toBe(true);
  });

  it("publishes immutable transact snapshots and subscriber arguments", async () => {
    const reg = new PermissionModeRegistry(baseCtx());
    const commitEntered = Promise.withResolvers<void>();
    const releaseCommit = Promise.withResolvers<void>();
    let published:
      | { next: ToolPermissionContext; current: ToolPermissionContext }
      | undefined;
    reg.subscribeToContextChange((next, current) => {
      published = { next, current };
    });
    reg.installBeforeUpdateHook(() => ({
      commit: async () => {
        commitEntered.resolve();
        await releaseCommit.promise;
      },
    }));
    const rules = ["Read(src/**)"];
    const transactionCandidate = baseCtx({
      mode: "acceptEdits",
      alwaysAllowRules: { session: rules },
    });
    const transaction = reg.transact(() => {
      queueMicrotask(() => {
        rules.push("Write(**)");
        (transactionCandidate as { mode: PermissionMode }).mode = "plan";
      });
      return {
        next: transactionCandidate,
        result: () => "committed" as const,
      };
    });
    await commitEntered.promise;
    releaseCommit.resolve();

    await expect(transaction).resolves.toBe("committed");
    expect(reg.current().mode).toBe("acceptEdits");
    expect(reg.current().alwaysAllowRules.session).toEqual(["Read(src/**)"]);
    expect(published).toBeDefined();
    expect(() => {
      (published!.next as { mode: PermissionMode }).mode = "default";
    }).toThrow(TypeError);
    expect(() => {
      (published!.next.alwaysAllowRules.session as string[]).push("Write(**)");
    }).toThrow(TypeError);
    expect(() => {
      (published!.current as { mode: PermissionMode }).mode = "plan";
    }).toThrow(TypeError);
    const subscriberDirectories =
      published!.next.additionalWorkingDirectories as unknown as Map<
        string,
        unknown
      >;
    expect(() => subscriberDirectories.set("/later", {})).toThrow(TypeError);
    expect(() => subscriberDirectories.delete("/later")).toThrow(TypeError);
    expect(() => subscriberDirectories.clear()).toThrow(TypeError);
    expect(() =>
      Map.prototype.set.call(
        published!.next.additionalWorkingDirectories,
        "/later",
        {},
      ),
    ).toThrow(TypeError);
    expect(() =>
      Map.prototype.delete.call(
        published!.next.additionalWorkingDirectories,
        "/later",
      ),
    ).toThrow(TypeError);
    expect(() =>
      Map.prototype.clear.call(published!.next.additionalWorkingDirectories),
    ).toThrow(TypeError);
    expect(reg.current().mode).toBe("acceptEdits");
  });

  it("rolls registry and prepared side effects back when the owner coordinator rejects after publication", async () => {
    const initial = baseCtx({ mode: "default" });
    const next = baseCtx({ mode: "bypassPermissions" });
    const reg = new PermissionModeRegistry(initial);
    const ownedInitial = reg.current();
    const events: string[] = [];
    reg.installBeforeUpdateHook(() => ({
      commit: () => events.push(`durable:${reg.current().mode}`),
      rollback: () => events.push(`compensate:${reg.current().mode}`),
      settle: () => events.push("settled"),
    }));
    reg.installPublicationCoordinator(async (_next, _current, _metadata, publication) => {
      events.push(`coordinator:${reg.current().mode}`);
      await publication.commit();
      events.push(`published:${reg.current().mode}`);
      await publication.rollback();
      throw new Error("participant resume failed");
    });

    await expect(reg.update(next)).rejects.toThrow("participant resume failed");

    expect(reg.current()).toBe(ownedInitial);
    expect(events).toEqual([
      "coordinator:default",
      "durable:default",
      "published:bypassPermissions",
      "compensate:default",
      "settled",
    ]);
  });

  it("keeps failed prepared compensation fail-closed across repeated rollback", async () => {
    const initial = baseCtx({ mode: "default" });
    const reg = new PermissionModeRegistry(initial);
    const ownedInitial = reg.current();
    const compensationFailure = new Error("durable compensation failed");
    const rollback = vi.fn(() => {
      throw compensationFailure;
    });
    let repeatedFailure: unknown;
    reg.installBeforeUpdateHook(() => ({
      commit: () => {
        throw new Error("durable commit failed");
      },
      rollback,
    }));
    reg.installPublicationCoordinator(async (_next, _current, _metadata, publication) => {
      try {
        await publication.commit();
      } catch {
        try {
          await publication.rollback();
        } catch (error) {
          repeatedFailure = error;
        }
        throw repeatedFailure;
      }
    });

    await expect(
      reg.update(baseCtx({ mode: "bypassPermissions" })),
    ).rejects.toThrow(/rollback incomplete/u);

    expect(reg.current()).toBe(ownedInitial);
    expect(rollback).toHaveBeenCalledOnce();
    expect(repeatedFailure).toBe(compensationFailure);
  });
});

describe("transitionPermissionMode — bypassPermissions consent gate", () => {
  it("refuses exact-cwd consent when session availability was revoked", () => {
    const result = transitionPermissionMode(
      "default",
      "bypassPermissions",
      baseCtx({
        bypassPermissionsAcceptedIn: [process.cwd()],
        isBypassPermissionsModeAvailable: false,
      }),
      { workspacePath: process.cwd() },
    );
    expect(result).toMatchObject({ error: "bypass_consent_required" });
  });

  it("policy disable clears active and plan-stashed bypass authority", () => {
    const disabled = createDisabledBypassPermissionsContext(
      baseCtx({
        mode: "plan",
        prePlanMode: "bypassPermissions",
        isBypassPermissionsModeAvailable: true,
        bypassPermissionsAcceptedIn: [process.cwd()],
      }),
    );
    expect(disabled).toMatchObject({
      mode: "plan",
      prePlanMode: "default",
      isBypassPermissionsModeAvailable: false,
      bypassPermissionsModeDisabledByPolicy: true,
      bypassPermissionsAcceptedIn: [],
    });
    const exited = transitionPermissionMode("plan", "default", disabled);
    expect({ ...exited, mode: "default" }).toMatchObject({
      mode: "default",
      prePlanMode: undefined,
      isBypassPermissionsModeAvailable: false,
    });
  });

  it("refuses bypassPermissions without prior consent for the workspace", () => {
    const ctx = baseCtx({
      mode: "default",
      isBypassPermissionsModeAvailable: true,
    });
    const result = transitionPermissionMode(
      "default",
      "bypassPermissions",
      ctx,
      { workspacePath: "/workspace/new" },
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBe("bypass_consent_required");
    expect(result.workspacePath).toBe("/workspace/new");
  });

  it("accepts bypassPermissions after the workspace is registered", () => {
    const ctx = baseCtx({
      mode: "default",
      isBypassPermissionsModeAvailable: true,
      bypassPermissionsAcceptedIn: [process.cwd()],
    });
    const result = transitionPermissionMode(
      "default",
      "bypassPermissions",
      ctx,
      { workspacePath: process.cwd() },
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    // The workspace entry remains pinned on the returned context so
    // follow-up transitions in the same session pass without re-asking.
    expect(result.bypassPermissionsAcceptedIn).toContain(process.cwd());
  });

  it("restores plan mode to bypass only when exact cwd consent remains bound", () => {
    const ctx = baseCtx({
      mode: "plan",
      prePlanMode: "bypassPermissions",
      isBypassPermissionsModeAvailable: true,
      bypassPermissionsAcceptedIn: [process.cwd()],
    });
    const result = transitionPermissionMode(
      "plan",
      "bypassPermissions",
      ctx,
      { workspacePath: process.cwd() },
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    expect(result.prePlanMode).toBeUndefined();
    expect(result.bypassPermissionsAcceptedIn).toEqual([process.cwd()]);
  });

  it("does not expose an option that bypasses the consent gate", () => {
    const ctx = baseCtx({
      mode: "default",
      isBypassPermissionsModeAvailable: true,
    });
    const result = transitionPermissionMode(
      "default",
      "bypassPermissions",
      ctx,
      { workspacePath: process.cwd() },
    );
    expect("error" in result).toBe(true);
  });

  it("refuses three-argument bypass transitions", () => {
    const ctx = baseCtx({
      mode: "plan",
      prePlanMode: "bypassPermissions",
      isBypassPermissionsModeAvailable: true,
    });
    // @ts-expect-error the public API requires transition authority options.
    const result = transitionPermissionMode(
      "plan",
      "bypassPermissions",
      ctx,
    );
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toBe("bypass_consent_required");
  });

  it("refuses bypassPermissions when workspacePath is missing from opts", () => {
    const ctx = baseCtx({
      mode: "default",
      isBypassPermissionsModeAvailable: true,
    });
    // @ts-expect-error bypass-capable transitions require workspace authority.
    const result = transitionPermissionMode(
      "default",
      "bypassPermissions",
      ctx,
      {},
    );
    expect("error" in result).toBe(true);
  });

  it("requires authority for a dynamically typed target", () => {
    const target: PermissionMode = "bypassPermissions";
    const ctx = baseCtx({ mode: "default" });
    // @ts-expect-error a dynamic target might activate bypassPermissions.
    const result = transitionPermissionMode("default", target, ctx);
    expect("error" in result).toBe(true);
  });
});

describe("isAutoModeGateEnabled env behaviour", () => {
  it("ignores unrelated env and stays false without an xAI key", () => {
    const previous = process.env.AGENC_YOLO_GATE;
    process.env.AGENC_YOLO_GATE = "1";
    try {
      withAutoModeEnv(() => {
        expect(isAutoModeGateEnabled()).toBe(false);
      });
    } finally {
      if (previous === undefined) delete process.env.AGENC_YOLO_GATE;
      else process.env.AGENC_YOLO_GATE = previous;
    }
  });
});
