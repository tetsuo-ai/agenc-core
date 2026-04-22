import { describe, expect, test } from "vitest";
import {
  HOOK_TIMING_DISPLAY_THRESHOLD_MS,
  mergeHookPermissionDecision,
  resolveHookPermissionDecision,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
  ToolHookRegistry,
  type HookPermissionResult,
  type HookTimingRecord,
  type PermissionDecisionHook,
  type PostToolUseFailureHook,
  type PostToolUseHook,
} from "./hooks.js";
import type { Tool } from "./types.js";
import type { ToolInvocation } from "./context.js";

const stubTool: Tool = {
  name: "stub",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
};
const stubInvocation: ToolInvocation = {
  session: {} as never,
  turn: {} as never,
  tracker: {
    appendFileDiff: () => {},
    snapshot: () => [],
    clear: () => {},
  },
  callId: "c1",
  toolName: { name: "stub" },
  payload: { kind: "function", arguments: "" },
  source: "direct",
};

describe("runPreToolUseHooks", () => {
  test("deny short-circuits subsequent hooks", async () => {
    let hit = 0;
    const decision = await runPreToolUseHooks(
      [
        async () => ({ kind: "deny", reason: "test" }),
        async () => {
          hit += 1;
          return { kind: "continue" };
        },
      ],
      { invocation: stubInvocation, tool: stubTool, args: {} },
    );
    expect(decision.kind).toBe("deny");
    expect(decision.reason).toBe("test");
    expect(hit).toBe(0);
  });

  test("args mutations accumulate", async () => {
    const decision = await runPreToolUseHooks(
      [
        async () => ({ kind: "continue", args: { a: 1 } }),
        async ({ args }) => ({ kind: "continue", args: { ...args, b: 2 } }),
      ],
      { invocation: stubInvocation, tool: stubTool, args: {} },
    );
    expect(decision.kind).toBe("continue");
    expect(decision.args).toEqual({ a: 1, b: 2 });
  });

  test("hook throw is swallowed + reported", async () => {
    const errors: unknown[] = [];
    const decision = await runPreToolUseHooks(
      [
        async () => {
          throw new Error("boom");
        },
        async () => ({ kind: "continue" }),
      ],
      { invocation: stubInvocation, tool: stubTool, args: {} },
      (err) => errors.push(err),
    );
    expect(decision.kind).toBe("continue");
    expect(errors).toHaveLength(1);
  });

  test("stop short-circuits and returns stopReason", async () => {
    const decision = await runPreToolUseHooks(
      [async () => ({ kind: "stop", stopReason: "sigkill" })],
      { invocation: stubInvocation, tool: stubTool, args: {} },
    );
    expect(decision.kind).toBe("stop");
    expect(decision.stopReason).toBe("sigkill");
  });

  test("skip short-circuits with synthResult", async () => {
    const decision = await runPreToolUseHooks(
      [
        async () => ({
          kind: "skip",
          synthResult: { content: "cached" },
        }),
      ],
      { invocation: stubInvocation, tool: stubTool, args: {} },
    );
    expect(decision.kind).toBe("skip");
    expect(decision.synthResult?.content).toBe("cached");
  });

  test("first hook's hookPermissionResult wins", async () => {
    const decision = await runPreToolUseHooks(
      [
        async () => ({
          kind: "continue",
          hookPermissionResult: {
            behavior: "allow",
            hookName: "first",
          },
        }),
        async () => ({
          kind: "continue",
          hookPermissionResult: {
            behavior: "deny",
            hookName: "second",
          },
        }),
      ],
      { invocation: stubInvocation, tool: stubTool, args: {} },
    );
    expect(decision.kind).toBe("continue");
    expect(decision.hookPermissionResult?.behavior).toBe("allow");
    expect(decision.hookPermissionResult?.hookName).toBe("first");
  });

  test("additionalContext entries accumulate across hooks", async () => {
    const decision = await runPreToolUseHooks(
      [
        async () => ({ kind: "continue", additionalContext: ["a"] }),
        async () => ({ kind: "continue", additionalContext: ["b", "c"] }),
      ],
      { invocation: stubInvocation, tool: stubTool, args: {} },
    );
    expect(decision.additionalContexts).toEqual(["a", "b", "c"]);
  });

  test("hookPermissionResult.updatedInput threads into args", async () => {
    const decision = await runPreToolUseHooks(
      [
        async () => ({
          kind: "continue",
          hookPermissionResult: {
            behavior: "allow",
            updatedInput: { rewritten: true },
          },
        }),
      ],
      { invocation: stubInvocation, tool: stubTool, args: { orig: true } },
    );
    expect(decision.kind).toBe("continue");
    expect(decision.args).toEqual({ rewritten: true });
  });
});

describe("runPostToolUseHooks", () => {
  test("rewrite replaces result for subsequent hooks", async () => {
    const decision = await runPostToolUseHooks(
      [
        async () => ({
          kind: "rewrite",
          result: { content: "fixed" },
        }),
        async ({ result }) => {
          expect(result.content).toBe("fixed");
          return { kind: "continue" };
        },
      ],
      {
        invocation: stubInvocation,
        tool: stubTool,
        args: {},
        result: { content: "original" },
      },
    );
    expect(decision.kind).toBe("continue");
    expect(decision.result.content).toBe("fixed");
  });

  test("additionalContext entries accumulate", async () => {
    const decision = await runPostToolUseHooks(
      [
        async () => ({ kind: "additionalContext", content: ["lint-1"] }),
        async () => ({ kind: "additionalContext", content: ["lint-2"] }),
      ],
      {
        invocation: stubInvocation,
        tool: stubTool,
        args: {},
        result: { content: "ran" },
      },
    );
    expect(decision.kind).toBe("continue");
    expect(decision.additionalContexts).toEqual(["lint-1", "lint-2"]);
  });

  test("stop short-circuits loop and returns stopReason", async () => {
    let secondRan = 0;
    const hooks: PostToolUseHook[] = [
      async () => ({ kind: "stop", stopReason: "abort" }),
      async () => {
        secondRan += 1;
        return { kind: "continue" };
      },
    ];
    const decision = await runPostToolUseHooks(hooks, {
      invocation: stubInvocation,
      tool: stubTool,
      args: {},
      result: { content: "ran" },
    });
    expect(decision.kind).toBe("stop");
    expect(decision.stopReason).toBe("abort");
    expect(secondRan).toBe(0);
  });

  test("preventContinuation short-circuits loop", async () => {
    const decision = await runPostToolUseHooks(
      [
        async () => ({
          kind: "preventContinuation",
          stopReason: "done",
          result: { content: "final" },
        }),
      ],
      {
        invocation: stubInvocation,
        tool: stubTool,
        args: {},
        result: { content: "initial" },
      },
    );
    expect(decision.kind).toBe("preventContinuation");
    expect(decision.stopReason).toBe("done");
    expect(decision.result.content).toBe("final");
  });

  test("hook_blocking_error is recorded and loop continues", async () => {
    let secondRan = 0;
    const decision = await runPostToolUseHooks(
      [
        async () => ({
          kind: "hook_blocking_error",
          blockingError: "lint failed",
        }),
        async () => {
          secondRan += 1;
          return { kind: "continue" };
        },
      ],
      {
        invocation: stubInvocation,
        tool: stubTool,
        args: {},
        result: { content: "ran" },
      },
    );
    expect(decision.kind).toBe("continue");
    expect(decision.blockingErrors).toEqual(["lint failed"]);
    expect(secondRan).toBe(1);
  });

  test("thrown hook is captured as blockingError", async () => {
    const errors: unknown[] = [];
    const decision = await runPostToolUseHooks(
      [
        async () => {
          throw new Error("oops");
        },
        async () => ({ kind: "continue" }),
      ],
      {
        invocation: stubInvocation,
        tool: stubTool,
        args: {},
        result: { content: "ran" },
      },
      (err) => errors.push(err),
    );
    expect(decision.kind).toBe("continue");
    expect(decision.blockingErrors).toHaveLength(1);
    expect(decision.blockingErrors[0]).toContain("oops");
    expect(errors).toHaveLength(1);
  });
});

describe("ToolHookRegistry", () => {
  test("add + getPre + getPost", () => {
    const reg = new ToolHookRegistry();
    reg.addPre(async () => ({ kind: "continue" }));
    reg.addPost(async () => ({ kind: "continue" }));
    expect(reg.getPre()).toHaveLength(1);
    expect(reg.getPost()).toHaveLength(1);
    reg.clear();
    expect(reg.getPre()).toHaveLength(0);
  });

  test("failure + permission hook arrays", () => {
    const reg = new ToolHookRegistry();
    reg.addFailure(() => {});
    reg.addPermission(() => ({ kind: "pass" }));
    expect(reg.getFailure()).toHaveLength(1);
    expect(reg.getPermission()).toHaveLength(1);
    reg.clear();
    expect(reg.getFailure()).toHaveLength(0);
    expect(reg.getPermission()).toHaveLength(0);
  });
});

describe("runPostToolUseFailureHooks", () => {
  test("every hook fires + timing record emitted", async () => {
    const timings: HookTimingRecord[] = [];
    let hits = 0;
    const hooks: PostToolUseFailureHook[] = [
      () => {
        hits += 1;
      },
      () => {
        hits += 1;
      },
    ];
    const records = await runPostToolUseFailureHooks(
      hooks,
      { invocation: stubInvocation, tool: stubTool, args: {}, error: new Error("x") },
      undefined,
      (r) => timings.push(r),
    );
    expect(hits).toBe(2);
    expect(records).toHaveLength(2);
    expect(timings).toHaveLength(2);
    expect(timings[0]?.phase).toBe("failure");
    expect(timings[0]?.overThreshold).toBe(false);
  });

  test("throwing hook is swallowed", async () => {
    const errors: unknown[] = [];
    let second = 0;
    const hooks: PostToolUseFailureHook[] = [
      () => {
        throw new Error("boom");
      },
      () => {
        second += 1;
      },
    ];
    await runPostToolUseFailureHooks(
      hooks,
      { invocation: stubInvocation, tool: stubTool, args: {}, error: new Error("cause") },
      (err) => errors.push(err),
    );
    expect(errors).toHaveLength(1);
    expect(second).toBe(1);
  });
});

describe("resolveHookPermissionDecision", () => {
  test("first non-pass decision wins", async () => {
    const hooks: PermissionDecisionHook[] = [
      () => ({ kind: "pass" }),
      () => ({ kind: "deny", reason: "blocked" }),
      () => ({ kind: "allow" }),
    ];
    const decision = await resolveHookPermissionDecision("tool.x", {}, hooks);
    expect(decision.kind).toBe("deny");
    expect(decision.reason).toBe("blocked");
  });

  test("all pass returns final pass", async () => {
    const hooks: PermissionDecisionHook[] = [
      () => ({ kind: "pass" }),
      () => undefined,
    ];
    const decision = await resolveHookPermissionDecision("tool.x", {}, hooks);
    expect(decision.kind).toBe("pass");
  });

  test("throwing hook is swallowed (treated as pass)", async () => {
    const errors: unknown[] = [];
    const hooks: PermissionDecisionHook[] = [
      () => {
        throw new Error("boom");
      },
      () => ({ kind: "allow" }),
    ];
    const decision = await resolveHookPermissionDecision(
      "tool.x",
      {},
      hooks,
      (err) => errors.push(err),
    );
    expect(decision.kind).toBe("allow");
    expect(errors).toHaveLength(1);
  });
});

describe("mergeHookPermissionDecision", () => {
  test("no hook result returns null", async () => {
    const merged = await mergeHookPermissionDecision({
      hookPermissionResult: undefined,
      args: { a: 1 },
    });
    expect(merged).toBeNull();
  });

  test("hook deny wins regardless of rules", async () => {
    const hook: HookPermissionResult = {
      behavior: "deny",
      message: "nope",
      hookName: "PreToolUse:x",
    };
    const merged = await mergeHookPermissionDecision({
      hookPermissionResult: hook,
      args: {},
    });
    expect(merged?.behavior).toBe("deny");
    expect(merged?.message).toBe("nope");
    expect(merged?.decisionReason?.type).toBe("hook");
    expect(merged?.decisionReason?.hookName).toBe("PreToolUse:x");
  });

  test("hook ask short-circuits to ask", async () => {
    const hook: HookPermissionResult = {
      behavior: "ask",
      message: "please confirm",
    };
    const merged = await mergeHookPermissionDecision({
      hookPermissionResult: hook,
      args: {},
    });
    expect(merged?.behavior).toBe("ask");
    expect(merged?.message).toBe("please confirm");
  });

  test("hook allow with no rule check passes through", async () => {
    const hook: HookPermissionResult = { behavior: "allow" };
    const merged = await mergeHookPermissionDecision({
      hookPermissionResult: hook,
      args: { original: true },
    });
    expect(merged?.behavior).toBe("allow");
    expect(merged?.args).toEqual({ original: true });
  });

  test("hook allow with updatedInput rewrites args", async () => {
    const hook: HookPermissionResult = {
      behavior: "allow",
      updatedInput: { redacted: true },
    };
    const merged = await mergeHookPermissionDecision({
      hookPermissionResult: hook,
      args: { original: true },
    });
    expect(merged?.behavior).toBe("allow");
    expect(merged?.args).toEqual({ redacted: true });
  });

  test("inc-4788: hook allow + rule deny → deny wins", async () => {
    const hook: HookPermissionResult = {
      behavior: "allow",
      hookName: "PreToolUse:x",
    };
    const merged = await mergeHookPermissionDecision({
      hookPermissionResult: hook,
      args: {},
      ruleBasedCheck: async () => ({
        behavior: "deny",
        message: "settings rule denies",
      }),
    });
    expect(merged?.behavior).toBe("deny");
    expect(merged?.message).toBe("settings rule denies");
    expect(merged?.decisionReason?.type).toBe("hook_plus_rule_deny");
    expect(merged?.decisionReason?.hookName).toBe("PreToolUse:x");
  });

  test("inc-4788: hook allow + rule ask → ask wins", async () => {
    const hook: HookPermissionResult = { behavior: "allow" };
    const merged = await mergeHookPermissionDecision({
      hookPermissionResult: hook,
      args: {},
      ruleBasedCheck: async () => ({
        behavior: "ask",
        message: "needs dialog",
      }),
    });
    expect(merged?.behavior).toBe("ask");
    expect(merged?.message).toBe("needs dialog");
    expect(merged?.decisionReason?.type).toBe("hook_plus_rule_ask");
  });

  test("hook allow + rule null → allow stays", async () => {
    const hook: HookPermissionResult = { behavior: "allow" };
    const merged = await mergeHookPermissionDecision({
      hookPermissionResult: hook,
      args: {},
      ruleBasedCheck: async () => null,
    });
    expect(merged?.behavior).toBe("allow");
  });
});

describe("HOOK_TIMING_DISPLAY_THRESHOLD_MS", () => {
  test("constant matches openclaude default", () => {
    expect(HOOK_TIMING_DISPLAY_THRESHOLD_MS).toBe(500);
  });

  test("overThreshold flag flips when a hook runs longer than the threshold", async () => {
    const timings: HookTimingRecord[] = [];
    const slow: PostToolUseFailureHook = async () => {
      await new Promise((r) => setTimeout(r, HOOK_TIMING_DISPLAY_THRESHOLD_MS + 30));
    };
    await runPostToolUseFailureHooks(
      [slow],
      { invocation: stubInvocation, tool: stubTool, args: {}, error: new Error("x") },
      undefined,
      (r) => timings.push(r),
    );
    expect(timings).toHaveLength(1);
    expect(timings[0]?.overThreshold).toBe(true);
  });
});
