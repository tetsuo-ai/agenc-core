import { describe, expect, test } from "vitest";
import {
  HOOK_TIMING_DISPLAY_THRESHOLD_MS,
  mergeHookPermissionDecision,
  raceHookWithSignal,
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
  type PreToolUseHook,
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

  test("unknown runtime hook behavior defers to normal flow", async () => {
    const merged = await mergeHookPermissionDecision({
      hookPermissionResult: {
        behavior: "block",
      } as unknown as HookPermissionResult,
      args: { original: true },
    });
    expect(merged).toBeNull();
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

  test("hook ask + rule deny → deny wins", async () => {
    const hook: HookPermissionResult = {
      behavior: "ask",
      message: "please confirm",
      updatedInput: { redacted: true },
      hookName: "PreToolUse:x",
    };
    const merged = await mergeHookPermissionDecision({
      hookPermissionResult: hook,
      args: { original: true },
      ruleBasedCheck: async (args) => {
        expect(args).toEqual({ redacted: true });
        return {
          behavior: "deny",
          message: "settings rule denies",
        };
      },
    });
    expect(merged?.behavior).toBe("deny");
    expect(merged?.args).toEqual({ redacted: true });
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
  test("constant matches AgenC default", () => {
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

// ──────────────────────────────────────────────────────────────────────
// §4.3 — Signal-aware hook cancellation: invariant preservation.
//
// Each test BOUNDS its awaits so a regression (the loop never racing the
// signal) reddens as a clean per-test timeout rather than an ambient hang.
// A wedged uncooperative hook is `() => new Promise(()=>{})` — it ignores
// its signal entirely; only the runner racing the signal makes the loop
// return.
// ──────────────────────────────────────────────────────────────────────
describe("signal-aware hook cancellation (invariants)", () => {
  const wedged: PreToolUseHook = () => new Promise<never>(() => {});
  /** Reject if the promise does not settle within `ms`. */
  function bound<T>(p: Promise<T>, ms = 1500): Promise<T> {
    return Promise.race([
      p,
      new Promise<T>((_r, reject) => {
        const t = setTimeout(
          () => reject(new Error(`bound(${ms}ms) exceeded`)),
          ms,
        );
        (t as { unref?: () => void }).unref?.();
      }),
    ]);
  }
  function abortedSignal(reason = "drain"): AbortSignal {
    const ac = new AbortController();
    ac.abort(reason);
    return ac.signal;
  }

  // 1 — Ordering + atomic break: [completesA, wedged, neverReached]. Abort
  //     mid-#2 ⇒ #3 never ran, #1's accumulated state survives in the deny
  //     terminal, result is kind:"deny".
  test("pre: ordering + atomic break on cancel preserves earlier accumulation", async () => {
    const ac = new AbortController();
    let thirdRan = false;
    const completesA: PreToolUseHook = () => ({
      kind: "continue",
      args: { a: 1 },
      hookPermissionResult: { behavior: "allow", hookName: "A" },
      additionalContext: ["ctxA"],
    });
    const neverReached: PreToolUseHook = () => {
      thirdRan = true;
      return { kind: "continue" };
    };
    const run = runPreToolUseHooks(
      [completesA, wedged, neverReached],
      { invocation: stubInvocation, tool: stubTool, args: {} },
      undefined,
      undefined,
      ac.signal,
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort("drain");
    const decision = await bound(run);
    expect(decision.kind).toBe("deny");
    expect(thirdRan).toBe(false); // hook #3 never started (atomic break)
    // #1's accumulation survives in the deny terminal.
    expect(decision.args).toEqual({ a: 1 });
    expect(decision.hookPermissionResult?.hookName).toBe("A");
    expect(decision.additionalContexts).toEqual(["ctxA"]);
  });

  // 2 — First-wins preserved: #1 sets hookPermissionResult, #2 cancelled ⇒
  //     deny carries #1's permission result (never overwritten).
  test("pre: first-wins permission preserved through a cancel", async () => {
    const ac = new AbortController();
    const first: PreToolUseHook = () => ({
      kind: "continue",
      hookPermissionResult: { behavior: "deny", hookName: "first" },
    });
    const run = runPreToolUseHooks(
      [first, wedged],
      { invocation: stubInvocation, tool: stubTool, args: {} },
      undefined,
      undefined,
      ac.signal,
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort("drain");
    const decision = await bound(run);
    expect(decision.kind).toBe("deny");
    expect(decision.hookPermissionResult?.hookName).toBe("first");
    expect(decision.hookPermissionResult?.behavior).toBe("deny");
  });

  // 3 — Arg-mutation gating: #1 rewrites args, #2 cancelled ⇒ deny carries
  //     #1's rewritten args (and a deny never reaches execute).
  test("pre: arg-mutation from completed hook survives the cancel deny", async () => {
    const ac = new AbortController();
    const rewrite: PreToolUseHook = ({ args }) => ({
      kind: "continue",
      args: { ...args, rewritten: true },
    });
    const run = runPreToolUseHooks(
      [rewrite, wedged],
      { invocation: stubInvocation, tool: stubTool, args: { orig: 1 } },
      undefined,
      undefined,
      ac.signal,
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort("drain");
    const decision = await bound(run);
    expect(decision.kind).toBe("deny");
    expect(decision.args).toEqual({ orig: 1, rewritten: true });
  });

  // 4 — additionalContext fidelity + hook_cancelled emitted: #1 adds context,
  //     #2 cancelled ⇒ context present exactly once; onCancelled fired for #2.
  test("pre: additionalContext fidelity + onCancelled fires on cancel", async () => {
    const ac = new AbortController();
    const cancelledIdx: number[] = [];
    const ctxHook: PreToolUseHook = () => ({
      kind: "continue",
      additionalContext: ["once"],
    });
    const run = runPreToolUseHooks(
      [ctxHook, wedged],
      { invocation: stubInvocation, tool: stubTool, args: {} },
      undefined,
      undefined,
      ac.signal,
      (i) => cancelledIdx.push(i),
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort("drain");
    const decision = await bound(run);
    expect(decision.kind).toBe("deny");
    expect(decision.additionalContexts).toEqual(["once"]); // exactly once
    expect(cancelledIdx).toEqual([1]); // hook #1 (index 1) was cancelled
  });

  // 5 — Throw ≠ cancel: a pre-hook that THROWS takes the existing
  //     swallow-and-continue path, NOT the deny terminal.
  test("pre: a thrown hook is swallowed (continue), distinct from cancel (deny)", async () => {
    const ac = new AbortController(); // never aborted
    const errors: unknown[] = [];
    const throwing: PreToolUseHook = () => {
      throw new Error("boom");
    };
    const after: PreToolUseHook = () => ({ kind: "continue", args: { ok: 1 } });
    const decision = await bound(
      runPreToolUseHooks(
        [throwing, after],
        { invocation: stubInvocation, tool: stubTool, args: {} },
        (err) => errors.push(err),
        undefined,
        ac.signal,
      ),
    );
    expect(decision.kind).toBe("continue"); // NOT deny
    expect(decision.args).toEqual({ ok: 1 });
    expect(errors).toHaveLength(1);
  });

  // 6 — Post-hook cancel → continue: [rewriteHook, wedgedPost], abort ⇒
  //     kind:"continue" with the rewritten result, never stop/preventContinuation.
  test("post: cancel returns continue preserving the rewritten result", async () => {
    const ac = new AbortController();
    const rewriteHook: PostToolUseHook = () => ({
      kind: "rewrite",
      result: { content: "rewritten" },
    });
    const wedgedPost: PostToolUseHook = () => new Promise<never>(() => {});
    const run = runPostToolUseHooks(
      [rewriteHook, wedgedPost],
      {
        invocation: stubInvocation,
        tool: stubTool,
        args: {},
        result: { content: "original" },
        signal: ac.signal,
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort("drain");
    const decision = await bound(run);
    expect(decision.kind).toBe("continue"); // never stop/preventContinuation
    expect(decision.result.content).toBe("rewritten");
  });

  // 7 — Failure-hook cancel: [obsA, wedgedFailure, obsC], abort ⇒ partial
  //     records (A + cancelled marker), C dropped.
  test("failure: cancel drops remaining hooks + returns partial records", async () => {
    const ac = new AbortController();
    let cRan = false;
    const obsA: PostToolUseFailureHook = () => {};
    const wedgedFailure: PostToolUseFailureHook = () =>
      new Promise<void>(() => {});
    const obsC: PostToolUseFailureHook = () => {
      cRan = true;
    };
    const cancelledIdx: number[] = [];
    const run = runPostToolUseFailureHooks(
      [obsA, wedgedFailure, obsC],
      {
        invocation: stubInvocation,
        tool: stubTool,
        args: {},
        error: new Error("tool failed"),
      },
      undefined,
      undefined,
      ac.signal,
      (i) => cancelledIdx.push(i),
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort("drain");
    const records = await bound(run);
    expect(cRan).toBe(false); // hook C dropped
    expect(records).toHaveLength(2); // A + cancelled marker for the wedged hook
    expect(records[0]?.cancelled).toBeUndefined();
    expect(records[1]?.cancelled).toBe(true);
    expect(cancelledIdx).toEqual([1]);
  });

  // 8 — Permission-hook cancel → pass (bounded): a wedged permission hook
  //     with an aborting signal resolves {kind:"pass"} without hanging.
  test("permission: cancel falls through to pass (fail-open contract)", async () => {
    const ac = new AbortController();
    const wedgedPerm: PermissionDecisionHook = () =>
      new Promise<never>(() => {});
    const run = resolveHookPermissionDecision(
      "stub",
      {},
      [wedgedPerm],
      undefined,
      undefined,
      { signal: ac.signal },
    );
    await new Promise((r) => setTimeout(r, 20));
    ac.abort("drain");
    const decision = await bound(run);
    expect(decision.kind).toBe("pass"); // NOT deny — preserves fail-open
  });

  // 9 — Already-aborted fast path: runPreToolUseHooks([wedged], …,
  //     alreadyAbortedSignal) returns kind:"deny" immediately, never awaits.
  test("pre: already-aborted signal denies immediately without awaiting", async () => {
    let hookCalled = false;
    const neverResolves: PreToolUseHook = () => {
      hookCalled = true;
      return new Promise<never>(() => {});
    };
    const decision = await bound(
      runPreToolUseHooks(
        [neverResolves],
        { invocation: stubInvocation, tool: stubTool, args: {} },
        undefined,
        undefined,
        abortedSignal(),
      ),
      1000,
    );
    expect(decision.kind).toBe("deny");
    expect(hookCalled).toBe(false);
  });

  // raceHookWithSignal direct: no-signal value/throw passthrough + listener
  // hygiene (no abort-listener accumulation across a multi-hook loop).
  test("raceHookWithSignal: no-signal passthrough (value + throw)", async () => {
    const ok = await raceHookWithSignal(async () => 42, undefined);
    expect(ok).toEqual({ settled: "value", value: 42 });
    const err = await raceHookWithSignal(async () => {
      throw new Error("x");
    }, undefined);
    expect(err.settled).toBe("threw");
  });

  test("listener hygiene: no abort-listener accumulation across a multi-hook loop", async () => {
    const ac = new AbortController();
    let added = 0;
    let removed = 0;
    const realAdd = ac.signal.addEventListener.bind(ac.signal);
    const realRemove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "abort") added += 1;
      return (realAdd as never)(type, ...(rest as never[]));
    }) as never;
    ac.signal.removeEventListener = ((type: string, ...rest: unknown[]) => {
      if (type === "abort") removed += 1;
      return (realRemove as never)(type, ...(rest as never[]));
    }) as never;

    // Three fast hooks that all settle normally; the signal never aborts.
    const fast: PreToolUseHook = () => ({ kind: "continue" });
    const decision = await bound(
      runPreToolUseHooks(
        [fast, fast, fast],
        { invocation: stubInvocation, tool: stubTool, args: {} },
        undefined,
        undefined,
        ac.signal,
      ),
    );
    expect(decision.kind).toBe("continue");
    // Every added abort listener was removed (no accumulation on a long-
    // lived signal).
    expect(removed).toBeGreaterThanOrEqual(added);
    expect(added).toBe(3); // one per hook
  });
});
