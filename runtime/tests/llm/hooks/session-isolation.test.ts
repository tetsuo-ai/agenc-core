/**
 * Regression tests for audit finding 5 (bug-audit-2026-07-11): configured
 * lifecycle hooks (SessionStart/SessionEnd/PreCompact/PostCompact/
 * SubagentStop/Notification) used to be registered into the process-global
 * registry, so two concurrent daemon sessions fired each other's hooks.
 * They now live in a per-session `LifecycleHookRegistry` owned by the
 * session's hooks service; dispatch resolves the session's registry
 * (explicit `registry` opt or the ambient runtime session) and only adds
 * process-global registry hooks on top.
 */
import { afterEach, describe, expect, it } from "vitest";

import { dispatchSessionEnd } from "./dispatcher.js";
import {
  LifecycleHookRegistry,
  registerSessionEndHook,
  resetLifecycleHookRegistry,
} from "./registry.js";
import type { SessionEndHookInput } from "./types.js";
import { createHooksService } from "../../bin/bootstrap-services.js";
import {
  clearCurrentRuntimeSession,
  runWithCurrentRuntimeSession,
} from "../../session/current-session.js";
import type { Session } from "../../session/session.js";

afterEach(() => {
  resetLifecycleHookRegistry();
  clearCurrentRuntimeSession();
});

function sessionEndInput(sessionId: string): SessionEndHookInput {
  return {
    hook_event_name: "SessionEnd",
    reason: "exit",
    session_id: sessionId,
  };
}

describe("per-session lifecycle hook isolation", () => {
  it("two sessions with different configured SessionEnd hooks do not fire each other's", async () => {
    // Two concurrent daemon sessions, each with its own configured
    // SessionEnd hook (the real registration path: hooksService.add*Hook,
    // as driven by ConfiguredHooksRuntime.rebuildTarget). Before the fix
    // both registrations landed in the process-global registry, so
    // session B's shutdown ran session A's hook (and vice versa).
    const serviceA = createHooksService();
    const serviceB = createHooksService();
    const fired: Array<{ owner: string; session_id?: string }> = [];
    serviceA.addSessionEndHook(async (input) => {
      fired.push({ owner: "A", session_id: input.session_id });
      return { succeeded: true, output: "" };
    });
    serviceB.addSessionEndHook(async (input) => {
      fired.push({ owner: "B", session_id: input.session_id });
      return { succeeded: true, output: "" };
    });

    await dispatchSessionEnd(sessionEndInput("conv-b"), {
      registry: serviceB.lifecycleHooks,
    });
    expect(fired).toEqual([{ owner: "B", session_id: "conv-b" }]);

    await dispatchSessionEnd(sessionEndInput("conv-a"), {
      registry: serviceA.lifecycleHooks,
    });
    expect(fired).toEqual([
      { owner: "B", session_id: "conv-b" },
      { owner: "A", session_id: "conv-a" },
    ]);
  });

  it("resolves the dispatching session's registry from the ambient runtime session", async () => {
    const regA = new LifecycleHookRegistry();
    const regB = new LifecycleHookRegistry();
    const fired: string[] = [];
    regA.addSessionEnd(async () => {
      fired.push("A");
      return { succeeded: true, output: "" };
    });
    regB.addSessionEnd(async () => {
      fired.push("B");
      return { succeeded: true, output: "" };
    });
    const mockSession = (registry: LifecycleHookRegistry): Session =>
      ({
        services: { hooks: { lifecycleHooks: registry } },
      }) as unknown as Session;

    await runWithCurrentRuntimeSession(mockSession(regB), () =>
      dispatchSessionEnd(sessionEndInput("conv-b")),
    );
    expect(fired).toEqual(["B"]);

    await runWithCurrentRuntimeSession(mockSession(regA), () =>
      dispatchSessionEnd(sessionEndInput("conv-a")),
    );
    expect(fired).toEqual(["B", "A"]);
  });

  it("process-global registry hooks still fire for every session, after the session's own", async () => {
    const service = createHooksService();
    const fired: string[] = [];
    service.addSessionEndHook(async () => {
      fired.push("session");
      return { succeeded: true, output: "" };
    });
    registerSessionEndHook(async () => {
      fired.push("global");
      return { succeeded: true, output: "" };
    });

    await dispatchSessionEnd(sessionEndInput("conv-a"), {
      registry: service.lifecycleHooks,
    });
    expect(fired).toEqual(["session", "global"]);

    // A different session without configured hooks still runs the global.
    fired.length = 0;
    const other = createHooksService();
    await dispatchSessionEnd(sessionEndInput("conv-b"), {
      registry: other.lifecycleHooks,
    });
    expect(fired).toEqual(["global"]);
  });

  it("executePreCompact runs only the owning session's configured PreCompact hooks", async () => {
    const serviceA = createHooksService();
    const serviceB = createHooksService();
    serviceA.addPreCompactHook(() => ({
      succeeded: true,
      output: "instructions from A",
    }));

    const resultA = (await serviceA.executePreCompact({
      trigger: "manual",
    })) as { newCustomInstructions?: string };
    expect(resultA.newCustomInstructions).toBe("instructions from A");

    const resultB = (await serviceB.executePreCompact({
      trigger: "manual",
    })) as { newCustomInstructions?: string };
    expect(resultB.newCustomInstructions).toBeUndefined();
  });

  it("clearConfiguredLifecycleHooks clears only that session's hooks", async () => {
    const serviceA = createHooksService();
    const serviceB = createHooksService();
    const fired: string[] = [];
    serviceA.addSessionEndHook(async () => {
      fired.push("A");
      return { succeeded: true, output: "" };
    });
    serviceB.addSessionEndHook(async () => {
      fired.push("B");
      return { succeeded: true, output: "" };
    });

    serviceA.clearConfiguredLifecycleHooks();

    await dispatchSessionEnd(sessionEndInput("conv-a"), {
      registry: serviceA.lifecycleHooks,
    });
    expect(fired).toEqual([]);

    await dispatchSessionEnd(sessionEndInput("conv-b"), {
      registry: serviceB.lifecycleHooks,
    });
    expect(fired).toEqual(["B"]);
  });
});
