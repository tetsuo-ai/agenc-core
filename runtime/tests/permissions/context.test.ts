/**
 * Tests for T11 Wave 2-A — permission dialog context, queue, resolve-once.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createPermissionContext,
  createPermissionQueueOps,
  createResolveOnce,
  defaultSupportsPersistence,
  type CreatePermissionContextOpts,
  type PendingPermissionRequest,
} from "./context.js";
import {
  createEmptyToolPermissionContext,
  type PermissionUpdate,
  type ToolPermissionContext,
} from "./types.js";

function buildOpts(
  overrides: Partial<CreatePermissionContextOpts> = {},
): CreatePermissionContextOpts {
  let ctx: ToolPermissionContext = createEmptyToolPermissionContext();
  const ac = new AbortController();
  return {
    tool: {
      name: "Bash",
      inputsEquivalent: (a, b) => JSON.stringify(a) === JSON.stringify(b),
    },
    input: { command: "ls" },
    requestId: "req-1",
    turnId: "turn-1",
    setToolPermissionContext: (c) => {
      ctx = c;
    },
    getToolPermissionContext: () => ctx,
    abortController: ac,
    ...overrides,
  };
}

describe("createResolveOnce", () => {
  it("resolves exactly once", () => {
    const seen: number[] = [];
    const gate = createResolveOnce<number>((v) => seen.push(v));
    gate.resolve(1);
    gate.resolve(2);
    expect(seen).toEqual([1]);
  });

  it("claim() is atomic — only the first caller wins", () => {
    const gate = createResolveOnce<void>(() => {});
    expect(gate.claim()).toBe(true);
    expect(gate.claim()).toBe(false);
    expect(gate.isResolved()).toBe(true);
  });

  it("claim() then resolve() delivers the value once", () => {
    const seen: string[] = [];
    const gate = createResolveOnce<string>((v) => seen.push(v));
    expect(gate.claim()).toBe(true);
    gate.resolve("ok");
    gate.resolve("again");
    expect(seen).toEqual(["ok"]);
  });
});

describe("createPermissionQueueOps", () => {
  it("round-trips push/remove/update via a setter", () => {
    let queue: readonly PendingPermissionRequest[] = [];
    const ops = createPermissionQueueOps((updater) => {
      queue = updater(queue);
    });
    const base: PendingPermissionRequest = {
      requestId: "r1",
      toolName: "Bash",
      toolInput: { command: "ls" },
      message: "ask",
      submittedAt: 1,
      turnId: "t1",
    };
    ops.push(base);
    expect(queue.length).toBe(1);
    ops.update("r1", { message: "updated" });
    expect(queue[0]?.message).toBe("updated");
    ops.remove("r1");
    expect(queue.length).toBe(0);
  });
});

describe("createPermissionContext", () => {
  it("returns a frozen object", () => {
    const ctx = createPermissionContext(buildOpts());
    expect(Object.isFrozen(ctx)).toBe(true);
  });

  it("cancelAndAbort returns a deny decision and aborts when no feedback", () => {
    const ac = new AbortController();
    const ctx = createPermissionContext(
      buildOpts({ abortController: ac }),
    );
    const decision = ctx.cancelAndAbort(undefined, false);
    expect(decision.behavior).toBe("deny");
    expect(ac.signal.aborted).toBe(true);
    expect(decision.message).toContain("rejected");
  });

  it("cancelAndAbort with feedback includes the feedback and does not abort", () => {
    const ac = new AbortController();
    const ctx = createPermissionContext(
      buildOpts({ abortController: ac }),
    );
    const decision = ctx.cancelAndAbort("too risky");
    expect(decision.behavior).toBe("deny");
    if (decision.behavior === "deny") {
      expect(decision.message).toContain("too risky");
    }
    expect(ac.signal.aborted).toBe(false);
  });

  it("tryClassifier returns allow when probe resolves with a reason", async () => {
    const ctx = createPermissionContext(
      buildOpts({
        classifierProbe: async () => ({
          type: "classifier" as const,
          classifier: "bash-classifier",
          reason: "Allowed by prompt rule: \"echo\"",
        }),
      }),
    );
    const decision = await ctx.tryClassifier({ id: "pending-1" }, {
      command: "echo hi",
    });
    expect(decision?.behavior).toBe("allow");
    expect(decision?.decisionReason).toMatchObject({ type: "classifier" });
  });

  it("tryClassifier returns null when no pending check is given", async () => {
    const ctx = createPermissionContext(buildOpts());
    expect(await ctx.tryClassifier(undefined)).toBeNull();
  });

  it("runHooks iterates hooks and returns the first allow/deny", async () => {
    const ctx = createPermissionContext(
      buildOpts({
        hooks: [
          async function* neutral() {
            // yields nothing
          },
          async function* allower() {
            yield { behavior: "allow" as const, updatedInput: { command: "ls -a" } };
          },
          async function* unreachable() {
            yield { behavior: "deny" as const };
          },
        ],
      }),
    );
    const decision = await ctx.runHooks("default", undefined, undefined, 0);
    expect(decision?.behavior).toBe("allow");
    if (decision?.behavior === "allow") {
      expect(decision.updatedInput).toEqual({ command: "ls -a" });
    }
  });

  it("buildAllow and buildDeny constructors normalize behavior", () => {
    const ctx = createPermissionContext(buildOpts());
    const allow = ctx.buildAllow({
      behavior: "allow",
      updatedInput: { command: "ls" },
    });
    expect(allow.behavior).toBe("allow");
    const deny = ctx.buildDeny({
      behavior: "deny",
      message: "no",
      decisionReason: { type: "other", reason: "nope" },
    });
    expect(deny.behavior).toBe("deny");
  });

  it("handleUserAllow marks userModified=false when inputsEquivalent returns true", () => {
    const ctx = createPermissionContext(buildOpts());
    const allow = ctx.handleUserAllow(
      { command: "ls" },
      { type: "user", permanent: false },
    );
    expect(allow.userModified).toBe(false);
  });

  it("handleUserAllow marks userModified=true on different inputs", () => {
    const ctx = createPermissionContext(buildOpts());
    const allow = ctx.handleUserAllow(
      { command: "rm -rf /" },
      { type: "user", permanent: false },
    );
    expect(allow.userModified).toBe(true);
  });

  it("persistPermissions returns true when any update targets a persistent destination", async () => {
    const updates: PermissionUpdate[] = [
      {
        type: "addRules",
        destination: "projectSettings",
        rules: [{ toolName: "Bash", ruleContent: "ls" }],
        behavior: "allow",
      },
    ];
    const persist = vi.fn();
    const ctx = createPermissionContext(
      buildOpts({ persistPermissionUpdates: persist }),
    );
    const result = await ctx.persistPermissions(updates);
    expect(result).toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("persistPermissions returns false when all updates target session-only destinations", async () => {
    const updates: PermissionUpdate[] = [
      {
        type: "addRules",
        destination: "session",
        rules: [{ toolName: "Bash", ruleContent: "ls" }],
        behavior: "allow",
      },
    ];
    const ctx = createPermissionContext(buildOpts());
    expect(await ctx.persistPermissions(updates)).toBe(false);
  });

  it("logDecision routes through the configured sink", () => {
    const seen: unknown[] = [];
    const ctx = createPermissionContext(
      buildOpts({
        logDecisionSink: (event) => {
          seen.push(event);
        },
      }),
    );
    ctx.logDecision({ type: "user", permanent: false });
    expect(seen).toEqual([
      { requestId: "req-1", toolName: "Bash", source: { type: "user", permanent: false } },
    ]);
  });
});

describe("PendingPermissionRequest turnId (I-44)", () => {
  it("carries a turnId stamp as a required readonly field", () => {
    const item: PendingPermissionRequest = {
      requestId: "r2",
      toolName: "Bash",
      toolInput: {},
      message: "x",
      submittedAt: 0,
      turnId: "turn-abc",
    };
    expect(item.turnId).toBe("turn-abc");
  });
});

describe("defaultSupportsPersistence", () => {
  it("accepts on-disk destinations", () => {
    expect(defaultSupportsPersistence("projectSettings")).toBe(true);
    expect(defaultSupportsPersistence("userSettings")).toBe(true);
    expect(defaultSupportsPersistence("localSettings")).toBe(true);
  });

  it("rejects in-memory destinations", () => {
    expect(defaultSupportsPersistence("session")).toBe(false);
    expect(defaultSupportsPersistence("cliArg")).toBe(false);
  });
});
