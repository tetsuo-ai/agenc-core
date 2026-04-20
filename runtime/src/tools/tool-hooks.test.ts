import { describe, expect, test } from "vitest";
import {
  MAX_AUTO_FIX_RETRIES,
  runPostToolUseHooks,
  runPreToolUseHooks,
  runWithAutoFixRetry,
  ToolHookRegistry,
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
});
