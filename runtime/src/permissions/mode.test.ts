/**
 * Tests for the permission-mode FSM (T11 Wave 1-B / I-3).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  EXTERNAL_PERMISSION_MODES,
  INTERNAL_PERMISSION_MODES,
  PermissionModeRegistry,
  __setAutoModeGateResolverForTesting,
  __setPlanAutoModeResolverForTesting,
  canCycleToAuto,
  cyclePermissionMode,
  getNextPermissionMode,
  isAutoModeGateEnabled,
  isDangerousBashPermission,
  isExternalPermissionMode,
  prepareContextForPlanMode,
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
  transitionPermissionMode,
  shouldPlanUseAutoMode,
} from "./mode.js";
import type { PermissionMode, ToolPermissionContext } from "./types.js";

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
  it("EXTERNAL_PERMISSION_MODES excludes dontAsk and bubble", () => {
    expect(EXTERNAL_PERMISSION_MODES).toEqual([
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "auto",
    ]);
    expect(EXTERNAL_PERMISSION_MODES).not.toContain("dontAsk");
    expect(EXTERNAL_PERMISSION_MODES).not.toContain("bubble");
  });

  it("INTERNAL_PERMISSION_MODES lists all 7 modes", () => {
    expect(INTERNAL_PERMISSION_MODES).toHaveLength(7);
    for (const m of [
      "default",
      "acceptEdits",
      "plan",
      "bypassPermissions",
      "dontAsk",
      "auto",
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

  it("dontAsk and bubble fall back to default", () => {
    const ctx = baseCtx();
    expect(getNextPermissionMode("dontAsk", ctx)).toBe("default");
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
      alwaysAllowRules: { userSettings: ["Read(src/**)"] },
      strippedDangerousRules: { userSettings: ["Bash(*)"] },
    });
    const exited = transitionPermissionMode("plan", "default", inPlan);
    expect(exited.autoModeActive).toBe(false);
    expect(exited.prePlanMode).toBeUndefined();
    expect(exited.alwaysAllowRules.userSettings).toEqual([
      "Read(src/**)",
      "Bash(*)",
    ]);
  });

  it("re-entering plan is a no-op (does not double-stash prePlanMode)", () => {
    const inPlan = baseCtx({ mode: "plan", prePlanMode: "acceptEdits" });
    const after = transitionPermissionMode("plan", "plan", inPlan);
    expect(after).toBe(inPlan);
    expect(after.prePlanMode).toBe("acceptEdits");
  });
});

describe("transitionPermissionMode — auto enter/leave", () => {
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
        userSettings: ["Bash(python:*)", "Read(src/**)"],
      },
    });
    withGateEnabled(true, () => {
      const next = transitionPermissionMode("default", "auto", ctx);
      expect(next.autoModeActive).toBe(true);
      expect(next.alwaysAllowRules.userSettings).toEqual(["Read(src/**)"]);
      expect(next.strippedDangerousRules?.userSettings).toEqual([
        "Bash(python:*)",
      ]);
    });
  });

  it("leaving auto restores stashed rules and clears autoModeActive", () => {
    const ctx = baseCtx({
      mode: "auto",
      autoModeActive: true,
      alwaysAllowRules: { userSettings: ["Read(src/**)"] },
      strippedDangerousRules: { userSettings: ["Bash(python:*)"] },
    });
    const next = transitionPermissionMode("auto", "default", ctx);
    expect(next.autoModeActive).toBe(false);
    expect(next.alwaysAllowRules.userSettings).toEqual([
      "Read(src/**)",
      "Bash(python:*)",
    ]);
    expect(next.strippedDangerousRules).toBeUndefined();
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
      alwaysAllowRules: {
        userSettings: ["Bash(*)"],
      },
    });
    const next = prepareContextForPlanMode(ctx, { shouldUseAutoInPlan: true });
    expect(next.prePlanMode).toBe("default");
    expect(next.autoModeActive).toBe(true);
    expect(next.strippedDangerousRules?.userSettings).toEqual(["Bash(*)"]);
    expect(next.alwaysAllowRules.userSettings).toBeUndefined();
  });

  it("does not strip dangerous rules entering plan from bypass", () => {
    const ctx = baseCtx({
      mode: "bypassPermissions",
      alwaysAllowRules: { userSettings: ["Bash(*)"] },
    });
    const next = prepareContextForPlanMode(ctx, { shouldUseAutoInPlan: true });
    expect(next.alwaysAllowRules.userSettings).toEqual(["Bash(*)"]);
    expect(next.autoModeActive).toBeUndefined();
    expect(next.strippedDangerousRules).toBeUndefined();
  });

  it("re-entering plan is a no-op", () => {
    const ctx = baseCtx({ mode: "plan", prePlanMode: "acceptEdits" });
    expect(prepareContextForPlanMode(ctx)).toBe(ctx);
  });

  it("preserves existing auto-mode state entering plan from auto", () => {
    const ctx = baseCtx({
      mode: "auto",
      autoModeActive: true,
      alwaysAllowRules: { userSettings: ["Read(src/**)"] },
    });
    const next = prepareContextForPlanMode(ctx, { shouldUseAutoInPlan: true });
    expect(next.prePlanMode).toBe("auto");
    expect(next.autoModeActive).toBe(true);
    expect(next.alwaysAllowRules.userSettings).toEqual(["Read(src/**)"]);
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
            alwaysAllowRules: { userSettings: ["Bash(*)", "Read(src/**)"] },
          }),
        );
        expect("error" in next).toBe(false);
        if ("error" in next) return;
        expect(next.autoModeActive).toBe(true);
        expect(next.alwaysAllowRules.userSettings).toEqual(["Read(src/**)"]);
      } finally {
        restore();
      }
    });
  });
});

describe("stripDangerousPermissionsForAutoMode / restoreDangerousPermissions", () => {
  it("round-trips: strip then restore reproduces the original allow set", () => {
    const original = baseCtx({
      alwaysAllowRules: {
        userSettings: ["Bash(python:*)", "Read(src/**)", "Agent(worker)"],
        projectSettings: ["Bash(*)", "Write(/tmp/**)"],
      },
    });
    const stripped = stripDangerousPermissionsForAutoMode(original);
    expect(stripped.alwaysAllowRules.userSettings).toEqual(["Read(src/**)"]);
    expect(stripped.alwaysAllowRules.projectSettings).toEqual(["Write(/tmp/**)"]);
    expect(stripped.strippedDangerousRules?.userSettings?.sort()).toEqual(
      ["Agent(worker)", "Bash(python:*)"].sort(),
    );
    expect(stripped.strippedDangerousRules?.projectSettings).toEqual(["Bash(*)"]);

    const restored = restoreDangerousPermissions(stripped);
    expect(restored.strippedDangerousRules).toBeUndefined();
    const us = [...(restored.alwaysAllowRules.userSettings ?? [])].sort();
    const ps = [...(restored.alwaysAllowRules.projectSettings ?? [])].sort();
    expect(us).toEqual(
      ["Bash(python:*)", "Read(src/**)", "Agent(worker)"].sort(),
    );
    expect(ps).toEqual(["Bash(*)", "Write(/tmp/**)"].sort());
  });

  it("restoreDangerousPermissions is a no-op when stash is absent", () => {
    const ctx = baseCtx({ alwaysAllowRules: { userSettings: ["Read(*)"] } });
    expect(restoreDangerousPermissions(ctx)).toBe(ctx);
  });

  it("strip sets an empty stash when no dangerous rules exist", () => {
    const ctx = baseCtx({ alwaysAllowRules: { userSettings: ["Read(src/**)"] } });
    const next = stripDangerousPermissionsForAutoMode(ctx);
    expect(next.strippedDangerousRules).toEqual({});
    expect(next.alwaysAllowRules).toBe(ctx.alwaysAllowRules);
  });
});

describe("isDangerousBashPermission", () => {
  it("flags tool-level allow (Bash with no content)", () => {
    expect(isDangerousBashPermission("Bash", undefined)).toBe(true);
    expect(isDangerousBashPermission("Bash", "")).toBe(true);
  });

  it("flags Bash(*)", () => {
    expect(isDangerousBashPermission("Bash", "*")).toBe(true);
  });

  it("flags interpreter prefix rules", () => {
    expect(isDangerousBashPermission("Bash", "python:*")).toBe(true);
    expect(isDangerousBashPermission("Bash", "node*")).toBe(true);
    expect(isDangerousBashPermission("Bash", "npm run:*")).toBe(true);
    expect(isDangerousBashPermission("Bash", "python -c*")).toBe(true);
  });

  it("ignores non-Bash tools", () => {
    expect(isDangerousBashPermission("Read", "*")).toBe(false);
  });

  it("allows narrow Bash rules", () => {
    expect(isDangerousBashPermission("Bash", "ls -la")).toBe(false);
    expect(isDangerousBashPermission("Bash", "git status")).toBe(false);
  });
});

describe("cyclePermissionMode", () => {
  it("returns the nextMode and the post-transition context", () => {
    const start = baseCtx({ mode: "default" });
    const { nextMode, context } = cyclePermissionMode("default", start);
    expect(nextMode).toBe("acceptEdits");
    // Transitioning default -> acceptEdits does not enter plan or auto so no
    // context mutations occur.
    expect(context).toBe(start);
  });

  it("enters plan mode through cycle and stashes prePlanMode", () => {
    const start = baseCtx({ mode: "acceptEdits" });
    const { nextMode, context } = cyclePermissionMode("acceptEdits", start);
    expect(nextMode).toBe("plan");
    expect(context.prePlanMode).toBe("acceptEdits");
  });
});

describe("PermissionModeRegistry", () => {
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
});

describe("transitionPermissionMode — bypassPermissions consent gate", () => {
  it("refuses bypassPermissions without prior consent for the workspace", () => {
    const ctx = baseCtx({
      mode: "default",
      isBypassPermissionsModeAvailable: true,
    });
    const result = transitionPermissionMode(
      "default",
      "bypassPermissions",
      ctx,
      { requireBypassConsent: true, workspacePath: "/workspace/new" },
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
      bypassPermissionsAcceptedIn: ["/workspace/trusted"],
    });
    const result = transitionPermissionMode(
      "default",
      "bypassPermissions",
      ctx,
      { requireBypassConsent: true, workspacePath: "/workspace/trusted" },
    );
    expect("error" in result).toBe(false);
    if ("error" in result) return;
    // The workspace entry remains pinned on the returned context so
    // follow-up transitions in the same session pass without re-asking.
    expect(result.bypassPermissionsAcceptedIn).toContain("/workspace/trusted");
  });

  it("opts.requireBypassConsent=false bypasses the gate", () => {
    const ctx = baseCtx({
      mode: "default",
      isBypassPermissionsModeAvailable: true,
    });
    const result = transitionPermissionMode(
      "default",
      "bypassPermissions",
      ctx,
      { requireBypassConsent: false, workspacePath: "/workspace/new" },
    );
    expect("error" in result).toBe(false);
  });

  it("legacy callers without opts keep unconditional bypass transitions", () => {
    // cyclePermissionMode and other internal callers (plan-mode restore)
    // rely on the legacy 3-arg invocation. Those callsites must not be
    // broken by the new gate.
    const ctx = baseCtx({
      mode: "plan",
      prePlanMode: "bypassPermissions",
      isBypassPermissionsModeAvailable: true,
    });
    const result = transitionPermissionMode(
      "plan",
      "bypassPermissions",
      ctx,
    );
    expect("error" in result).toBe(false);
  });

  it("refuses bypassPermissions when workspacePath is missing from opts", () => {
    const ctx = baseCtx({
      mode: "default",
      isBypassPermissionsModeAvailable: true,
    });
    const result = transitionPermissionMode(
      "default",
      "bypassPermissions",
      ctx,
      { requireBypassConsent: true },
    );
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
