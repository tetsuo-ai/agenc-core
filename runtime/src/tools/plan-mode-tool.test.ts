/**
 * Tests for EnterPlanMode / ExitPlanMode tools (T11 W2 Agent C).
 */

import { describe, expect, it } from "vitest";
import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  checkEnterPlanModePermissions,
  checkExitPlanModePermissions,
  createPlanModeTools,
} from "./plan-mode-tool.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import type { Session } from "../session/session.js";
import type { Event } from "../session/event-log.js";

interface Harness {
  readonly session: Session;
  readonly events: Event[];
  readonly registry: PermissionModeRegistry;
}

function mkHarness(opts: {
  readonly initialMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  readonly bypassAvailable?: boolean;
  readonly prePlanMode?: "default" | "acceptEdits";
} = {}): Harness {
  const ctx = createEmptyToolPermissionContext({
    mode: opts.initialMode ?? "default",
    isBypassPermissionsModeAvailable: opts.bypassAvailable ?? false,
    prePlanMode: opts.prePlanMode,
  });
  const registry = new PermissionModeRegistry(ctx);
  const events: Event[] = [];
  let subId = 0;
  const session = {
    conversationId: "conv-plan-tool",
    nextInternalSubId: () => `s-${++subId}`,
    emit: (event: Event) => {
      events.push(event);
    },
  } as unknown as Session;
  return { session, events, registry };
}

describe("checkEnterPlanModePermissions", () => {
  it("allows when current mode is not plan", () => {
    const ctx = createEmptyToolPermissionContext({ mode: "default" });
    const decision = checkEnterPlanModePermissions(ctx);
    expect(decision.behavior).toBe("allow");
  });

  it("denies when already in plan mode", () => {
    const ctx = createEmptyToolPermissionContext({ mode: "plan" });
    const decision = checkEnterPlanModePermissions(ctx);
    expect(decision.behavior).toBe("deny");
    if (decision.behavior === "deny") {
      expect(decision.reason).toBe("already_in_plan_mode");
    }
  });
});

describe("checkExitPlanModePermissions", () => {
  it("denies when not in plan mode", () => {
    const ctx = createEmptyToolPermissionContext({ mode: "default" });
    const decision = checkExitPlanModePermissions(ctx);
    expect(decision.behavior).toBe("deny");
    if (decision.behavior === "deny") {
      expect(decision.reason).toBe("not_in_plan_mode");
    }
  });

  it("allows when in plan mode", () => {
    const ctx = createEmptyToolPermissionContext({ mode: "plan" });
    const decision = checkExitPlanModePermissions(ctx);
    expect(decision.behavior).toBe("allow");
  });

  it("remains allow when in plan mode even with bypassPermissions available", () => {
    // Bypass-immune: the presence of bypass mode must NOT short-circuit
    // the exit path. The only predicate is ctx.mode === "plan".
    const ctx = createEmptyToolPermissionContext({
      mode: "plan",
      isBypassPermissionsModeAvailable: true,
    });
    const decision = checkExitPlanModePermissions(ctx);
    expect(decision.behavior).toBe("allow");
  });
});

describe("createPlanModeTools — metadata", () => {
  it("registers the documented tool names and exclusive concurrency", () => {
    const { session, registry } = mkHarness();
    const { enterPlanModeTool, exitPlanModeTool } = createPlanModeTools(
      session,
      registry,
    );
    expect(enterPlanModeTool.name).toBe(ENTER_PLAN_MODE_TOOL_NAME);
    expect(exitPlanModeTool.name).toBe(EXIT_PLAN_MODE_TOOL_NAME);
    expect(enterPlanModeTool.concurrencyClass).toEqual({ kind: "exclusive" });
    expect(exitPlanModeTool.concurrencyClass).toEqual({ kind: "exclusive" });
    expect(enterPlanModeTool.isReadOnly).toBe(true);
  });
});

describe("EnterPlanMode execute", () => {
  it("transitions the registry to plan + stashes prePlanMode + emits warning", async () => {
    const h = mkHarness({ initialMode: "default" });
    const { enterPlanModeTool } = createPlanModeTools(h.session, h.registry);
    const res = await enterPlanModeTool.execute({});
    expect(res.isError).toBeFalsy();
    expect(h.registry.current().mode).toBe("plan");
    expect(h.registry.current().prePlanMode).toBe("default");
    const warn = h.events.find(
      (e) => e.msg.type === "warning" && e.msg.payload.cause === "mode_changed_to_plan",
    );
    expect(warn).toBeDefined();
  });

  it("denies when already in plan mode (returns error ToolResult)", async () => {
    const h = mkHarness({ initialMode: "plan" });
    const { enterPlanModeTool } = createPlanModeTools(h.session, h.registry);
    const res = await enterPlanModeTool.execute({});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("already_in_plan_mode");
    // Mode unchanged.
    expect(h.registry.current().mode).toBe("plan");
  });

  it("records optional `reason` argument in the emitted warning", async () => {
    const h = mkHarness({ initialMode: "default" });
    const { enterPlanModeTool } = createPlanModeTools(h.session, h.registry);
    await enterPlanModeTool.execute({ reason: "design caching" });
    const warn = h.events.find(
      (e) => e.msg.type === "warning" && e.msg.payload.cause === "mode_changed_to_plan",
    );
    expect(warn).toBeDefined();
    if (warn && warn.msg.type === "warning") {
      expect(warn.msg.payload.message).toContain("design caching");
    }
  });
});

describe("ExitPlanMode execute", () => {
  it("restores the prePlanMode + sets hasExitedPlanModeInSession", async () => {
    const h = mkHarness({
      initialMode: "plan",
      prePlanMode: "acceptEdits",
    });
    const { exitPlanModeTool } = createPlanModeTools(h.session, h.registry);
    const res = await exitPlanModeTool.execute({});
    expect(res.isError).toBeFalsy();
    const after = h.registry.current();
    expect(after.mode).toBe("acceptEdits");
    expect(after.hasExitedPlanModeInSession).toBe(true);
    expect(after.prePlanMode).toBeUndefined();
    // Exit warning event fired.
    const warn = h.events.find(
      (e) => e.msg.type === "warning" && e.msg.payload.cause === "mode_exited_plan",
    );
    expect(warn).toBeDefined();
  });

  it("falls back to `default` when no prePlanMode was stashed", async () => {
    const h = mkHarness({ initialMode: "plan" });
    const { exitPlanModeTool } = createPlanModeTools(h.session, h.registry);
    await exitPlanModeTool.execute({});
    expect(h.registry.current().mode).toBe("default");
  });

  it("denies when not in plan mode", async () => {
    const h = mkHarness({ initialMode: "default" });
    const { exitPlanModeTool } = createPlanModeTools(h.session, h.registry);
    const res = await exitPlanModeTool.execute({});
    expect(res.isError).toBe(true);
    expect(res.content).toContain("not_in_plan_mode");
  });

  it("is bypass-immune: still works when bypassPermissions is available", async () => {
    const h = mkHarness({
      initialMode: "plan",
      bypassAvailable: true,
      prePlanMode: "default",
    });
    const { exitPlanModeTool } = createPlanModeTools(h.session, h.registry);
    const res = await exitPlanModeTool.execute({});
    expect(res.isError).toBeFalsy();
    expect(h.registry.current().mode).toBe("default");
    expect(h.registry.current().hasExitedPlanModeInSession).toBe(true);
  });

  it("records optional `summary` argument in the emitted warning", async () => {
    const h = mkHarness({ initialMode: "plan", prePlanMode: "default" });
    const { exitPlanModeTool } = createPlanModeTools(h.session, h.registry);
    await exitPlanModeTool.execute({ summary: "plan done — exit" });
    const warn = h.events.find(
      (e) => e.msg.type === "warning" && e.msg.payload.cause === "mode_exited_plan",
    );
    expect(warn).toBeDefined();
    if (warn && warn.msg.type === "warning") {
      expect(warn.msg.payload.message).toContain("plan done");
    }
  });
});
