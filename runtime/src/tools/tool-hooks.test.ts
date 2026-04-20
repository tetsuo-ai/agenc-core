import { describe, expect, test } from "vitest";
import {
  HOOK_TIMING_DISPLAY_THRESHOLD_MS,
  MAX_AUTO_FIX_RETRIES,
  resolveHookPermissionDecision,
  runPostToolUseFailureHooks,
  runPostToolUseHooks,
  runPreToolUseHooks,
  runWithAutoFixRetry,
  ToolHookRegistry,
  type HookTimingRecord,
  type PermissionDecisionHook,
  type PostToolUseFailureHook,
} from "./tool-hooks.js";
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
    if (decision.kind === "continue") {
      expect(decision.args).toEqual({ a: 1, b: 2 });
    } else {
      throw new Error("expected continue");
    }
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
});

describe("runPostToolUseHooks + auto-fix", () => {
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
  });

  test("runWithAutoFixRetry obeys MAX_AUTO_FIX_RETRIES cap", async () => {
    let dispatched = 0;
    const result = await runWithAutoFixRetry({
      invocation: stubInvocation,
      tool: stubTool,
      initialArgs: {},
      dispatch: async () => {
        dispatched += 1;
        return { content: `d${dispatched}`, isError: true };
      },
      postHooks: [
        async () => ({ kind: "retry", args: { i: dispatched } }),
      ],
    });
    expect(dispatched).toBe(MAX_AUTO_FIX_RETRIES + 1);
    expect(result.content).toBe(`d${MAX_AUTO_FIX_RETRIES + 1}`);
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
