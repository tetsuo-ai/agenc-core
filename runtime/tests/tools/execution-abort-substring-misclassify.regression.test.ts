/**
 * Regression test for the abort-substring misclassification bug.
 *
 * Bug: `classifyToolError` / `isAbortLikeError` treated ANY error whose
 * message merely contained the substring "aborted" as a user interrupt.
 * A genuine tool failure (e.g. "transaction aborted by the database
 * engine") was therefore classified as `"aborted"`, its real text
 * discarded, and the model handed
 * `[Request interrupted by user for tool use]` instead. The failure hook
 * was also misinformed with `isInterrupt:true`.
 *
 * Fix: abort classification is gated on STRUCTURAL signals only
 * (`name === "AbortError"` / `code === "ABORT_ERR"`); the runtime's own
 * abort plumbing tags its rejections so genuine aborts still classify as
 * `"aborted"`. Each assertion below fails if the fix is reverted.
 */
import { describe, expect, test } from "vitest";
import {
  classifyToolError,
  formatError,
  runToolUse,
  withTimeoutAndAbort,
} from "../../src/tools/execution.js";
import type { Tool } from "../../src/tools/types.js";
import type { ToolInvocation } from "../../src/tools/context.js";

function makeInvocation(callId: string, toolName: string): ToolInvocation {
  return {
    session: { services: {} } as never,
    turn: {
      cwd: "/repo",
      sandboxPolicy: { value: "workspace_write" },
      approvalPolicy: { value: "on_request" },
    } as never,
    tracker: {
      appendFileDiff: () => {},
      snapshot: () => [],
      clear: () => {},
    },
    callId,
    toolName: { name: toolName },
    payload: { kind: "function", arguments: "" },
    source: "direct",
  };
}

const DB_ERROR = "transaction aborted by the database engine";

describe("abort-substring misclassification regression", () => {
  test("genuine tool error containing 'aborted' is tool_threw, not aborted", () => {
    // No AbortError name, no ABORT_ERR code — just a substring collision.
    expect(classifyToolError(new Error(DB_ERROR))).toBe("tool_threw");
  });

  test("plain Error('aborted') (no structural signal) is tool_threw", () => {
    expect(classifyToolError(new Error("aborted"))).toBe("tool_threw");
  });

  test("end-to-end: real DB error text is surfaced, not replaced by interrupt", async () => {
    const tool: Tool = {
      name: "db-writer",
      description: "",
      inputSchema: {},
      execute: async () => {
        throw new Error(DB_ERROR);
      },
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "db-writer"),
    });
    expect(out.isError).toBe(true);
    // The model must see the actual error, not the interrupt sentinel.
    expect(out.content).toContain(DB_ERROR);
    expect(out.content).not.toContain("interrupted by user");
  });

  test("end-to-end: failure hook is NOT told isInterrupt for a substring collision", async () => {
    let observedIsInterrupt: boolean | undefined;
    const tool: Tool = {
      name: "db-writer",
      description: "",
      inputSchema: {},
      execute: async () => {
        throw new Error(DB_ERROR);
      },
    };
    await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "db-writer"),
      failureHooks: [
        (input) => {
          observedIsInterrupt = input.isInterrupt;
          return undefined;
        },
      ],
    });
    expect(observedIsInterrupt).toBe(false);
  });

  // ── Genuine aborts must still be recognized (no regression). ──

  test("structurally-tagged AbortError still classifies as aborted", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(classifyToolError(err)).toBe("aborted");
  });

  test("ABORT_ERR code still classifies as aborted", () => {
    const err = new Error("whatever") as Error & { code?: string };
    err.code = "ABORT_ERR";
    expect(classifyToolError(err)).toBe("aborted");
  });

  test("a real signal abort is tagged so it still surfaces as an interrupt", async () => {
    // The runtime's own abort plumbing must produce a structurally
    // recognizable abort error even when the reason is an arbitrary
    // string carrying no AbortError name / ABORT_ERR code.
    const ctl = new AbortController();
    ctl.abort("aborted: permission mode changed to plan");
    const rejected = await withTimeoutAndAbort(
      () => new Promise<never>(() => {}),
      { timeoutMs: null, toolName: "hanger", signal: ctl.signal },
    ).then(
      () => undefined,
      (e) => e,
    );
    expect(classifyToolError(rejected)).toBe("aborted");
    expect(formatError(rejected)).not.toBe("");
  });
});
