import { describe, expect, it } from "vitest";

import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { createPlanningTools } from "../../src/tools/system/planning.js";

describe("planning permission-mode transactions", () => {
  it("uses one owner publication coordinator for a daemon-style plan transition", async () => {
    const registry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "default" }),
    );
    const projections: string[] = [];
    registry.installPublicationCoordinator(
      async (next, current, _metadata, publication) => {
        projections.push(`${current.mode}->${next.mode}`);
        await publication.commit();
      },
    );
    const enterPlan = createPlanningTools({
      workflowController: {
        getPermissionModeRegistry: () => registry,
      },
    }).find((candidate) => candidate.name === "EnterPlanMode");
    if (!enterPlan) throw new Error("EnterPlanMode tool not registered");

    await expect(enterPlan.execute({})).resolves.toMatchObject({
      metadata: { fromMode: "default", toMode: "plan", changed: true },
    });
    expect(registry.current().mode).toBe("plan");
    expect(projections).toEqual(["default->plan"]);
  });

  it("enters plan from the latest committed context and publishes side effects afterward", async () => {
    const initial = createEmptyToolPermissionContext({ mode: "default" });
    const registry = new PermissionModeRegistry(initial);
    const ownedInitial = registry.current();
    const concurrentUpdateEntered = Promise.withResolvers<void>();
    const releaseConcurrentUpdate = Promise.withResolvers<void>();
    const events: string[] = [];

    registry.installBeforeUpdateHook(async (next, current, metadata) => {
      const source = metadata === "concurrent-update" ? "concurrent" : "planning";
      events.push(`${source}:before:${next.mode}`);
      if (source === "concurrent") {
        concurrentUpdateEntered.resolve();
        await releaseConcurrentUpdate.promise;
      }
      return () => {
        expect(registry.current()).toBe(current);
        events.push(`${source}:committed:${next.mode}`);
      };
    });

    const enterPlan = createPlanningTools({
      workflowController: {
        getPermissionModeRegistry: () => registry,
        emitWarning: (cause) => {
          expect(registry.current().mode).toBe("plan");
          events.push(`warning:${cause}`);
        },
      },
    }).find((candidate) => candidate.name === "EnterPlanMode");
    if (!enterPlan) throw new Error("EnterPlanMode tool not registered");

    const latest = {
      ...initial,
      mode: "acceptEdits" as const,
      alwaysAskRules: {
        userSettings: ["system.bash(npm test)"],
      },
    };
    const concurrentUpdate = registry.update(latest, "concurrent-update");
    await concurrentUpdateEntered.promise;

    const planningResult = enterPlan.execute({});
    await Promise.resolve();

    expect(registry.current()).toBe(ownedInitial);
    expect(events).toEqual(["concurrent:before:acceptEdits"]);

    releaseConcurrentUpdate.resolve();
    await concurrentUpdate;
    const result = await planningResult;

    expect(result.isError).not.toBe(true);
    expect(result.metadata).toMatchObject({
      fromMode: "acceptEdits",
      toMode: "plan",
      changed: true,
    });
    expect(registry.current()).toMatchObject({
      mode: "plan",
      prePlanMode: "acceptEdits",
      alwaysAskRules: {
        userSettings: ["system.bash(npm test)"],
      },
    });
    expect(events).toEqual([
      "concurrent:before:acceptEdits",
      "concurrent:committed:acceptEdits",
      "planning:before:plan",
      "planning:committed:plan",
      "warning:mode_changed_to_plan",
    ]);
  });

  it("exits plan through the latest committed pre-plan mode", async () => {
    const initial = {
      ...createEmptyToolPermissionContext({ mode: "plan" }),
      prePlanMode: "default" as const,
    };
    const registry = new PermissionModeRegistry(initial);
    const ownedInitial = registry.current();
    const concurrentUpdateEntered = Promise.withResolvers<void>();
    const releaseConcurrentUpdate = Promise.withResolvers<void>();
    const events: string[] = [];

    registry.installBeforeUpdateHook(async (next, current, metadata) => {
      const source = metadata === "concurrent-update" ? "concurrent" : "planning";
      events.push(`${source}:before:${next.mode}`);
      if (source === "concurrent") {
        concurrentUpdateEntered.resolve();
        await releaseConcurrentUpdate.promise;
      }
      return () => {
        expect(registry.current()).toBe(current);
        events.push(`${source}:committed:${next.mode}`);
      };
    });

    const exitPlan = createPlanningTools({
      workflowController: {
        getPermissionModeRegistry: () => registry,
        emitWarning: (cause) => {
          expect(registry.current().mode).toBe("acceptEdits");
          events.push(`warning:${cause}`);
        },
        emitPlanExited: () => {
          expect(registry.current().mode).toBe("acceptEdits");
          events.push("plan:exited");
        },
      },
    }).find((candidate) => candidate.name === "ExitPlanMode");
    if (!exitPlan) throw new Error("ExitPlanMode tool not registered");

    const latest = {
      ...initial,
      prePlanMode: "acceptEdits" as const,
      alwaysAskRules: {
        userSettings: ["system.bash(npm test)"],
      },
    };
    const concurrentUpdate = registry.update(latest, "concurrent-update");
    await concurrentUpdateEntered.promise;

    const planningResult = exitPlan.execute({});
    await Promise.resolve();

    expect(registry.current()).toBe(ownedInitial);
    expect(events).toEqual(["concurrent:before:plan"]);

    releaseConcurrentUpdate.resolve();
    await concurrentUpdate;
    const result = await planningResult;

    expect(result.isError).not.toBe(true);
    expect(result.metadata).toMatchObject({
      fromMode: "plan",
      toMode: "acceptEdits",
      changed: true,
    });
    expect(registry.current()).toMatchObject({
      mode: "acceptEdits",
      alwaysAskRules: {
        userSettings: ["system.bash(npm test)"],
      },
    });
    expect(events).toEqual([
      "concurrent:before:plan",
      "concurrent:committed:plan",
      "planning:before:acceptEdits",
      "planning:committed:acceptEdits",
      "warning:mode_exited_plan",
      "plan:exited",
    ]);
  });
});
