import { describe, expect, test } from "vitest";
import {
  capToolResult,
  classifyToolError,
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS,
  parseToolArgsWithBigInt,
  requestApprovalWithAbortRace,
  resolveTimeoutMs,
  runToolUse,
  ToolTimeoutError,
  withTimeoutAndAbort,
} from "./execution.js";
import type { Tool } from "./types.js";
import type { ToolInvocation } from "./context.js";
import { EventLog } from "../session/event-log.js";

function makeInvocation(callId: string, toolName: string): ToolInvocation {
  return {
    session: {} as never,
    turn: {} as never,
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

describe("I-79 parseToolArgsWithBigInt", () => {
  test("preserves BigInt for literals >= 16 digits", () => {
    const parsed = parseToolArgsWithBigInt('{"lamports":9007199254740993}');
    expect(parsed).not.toBeNull();
    expect(typeof parsed!.lamports).toBe("bigint");
    expect(parsed!.lamports).toBe(9007199254740993n);
  });

  test("small numbers stay as Number", () => {
    const parsed = parseToolArgsWithBigInt('{"n":12345}');
    expect(parsed!.n).toBe(12345);
  });

  test("malformed JSON returns null", () => {
    expect(parseToolArgsWithBigInt("{not json")).toBeNull();
  });

  test("empty string returns empty object", () => {
    expect(parseToolArgsWithBigInt("")).toEqual({});
    expect(parseToolArgsWithBigInt("  ")).toEqual({});
  });
});

describe("I-15 capToolResult", () => {
  test("small result passes through unchanged", () => {
    const out = capToolResult("hello", 1000);
    expect(out.capped).toBe("hello");
    expect(out.truncated).toBe(false);
  });

  test("oversized result truncated with marker", () => {
    const big = "a".repeat(1000);
    const out = capToolResult(big, 500);
    expect(out.truncated).toBe(true);
    expect(out.originalBytes).toBe(1000);
    expect(out.capped.length).toBeLessThanOrEqual(500);
    expect(out.capped).toContain("[truncated:");
  });

  test("default cap constant is 400KB", () => {
    expect(DEFAULT_MAX_TOOL_RESULT_BYTES).toBe(400_000);
  });
});

describe("I-9 resolveTimeoutMs + withTimeoutAndAbort", () => {
  test("per-call timeoutMs wins over per-tool and default", () => {
    const tool = { timeoutMs: 15_000 } as unknown as Tool;
    expect(resolveTimeoutMs(tool, { timeoutMs: 5_000 })).toBe(5_000);
    expect(resolveTimeoutMs(tool, {})).toBe(15_000);
    expect(resolveTimeoutMs({} as Tool, {})).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });

  test("timer fires → ToolTimeoutError thrown", async () => {
    await expect(
      withTimeoutAndAbort(() => new Promise(() => {}), {
        timeoutMs: 50,
        toolName: "stub",
      }),
    ).rejects.toThrow(ToolTimeoutError);
  });

  test("signal abort preempts timer", async () => {
    const ctl = new AbortController();
    const p = withTimeoutAndAbort(() => new Promise(() => {}), {
      timeoutMs: 5_000,
      toolName: "stub",
      signal: ctl.signal,
    });
    setTimeout(() => ctl.abort("user"), 20);
    await expect(p).rejects.toThrow(/user|aborted/);
  });
});

describe("classifyToolError", () => {
  test("ToolTimeoutError → 'timeout'", () => {
    expect(classifyToolError(new ToolTimeoutError("x", 30))).toBe("timeout");
  });
  test("Error with 'aborted' → 'aborted'", () => {
    expect(classifyToolError(new Error("aborted"))).toBe("aborted");
  });
  test("EACCES → permission_denied", () => {
    expect(classifyToolError(new Error("EACCES: permission denied"))).toBe(
      "permission_denied",
    );
  });
  test("ENOENT → not_found", () => {
    expect(classifyToolError(new Error("ENOENT"))).toBe("not_found");
  });
});

describe("I-21 + I-44 requestApprovalWithAbortRace", () => {
  test("abort signal wins over slow modal", async () => {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 20);
    const result = await requestApprovalWithAbortRace(
      () =>
        new Promise((r) =>
          setTimeout(
            () =>
              r({
                behavior: "allow",
                decisionAtTurnId: "t1",
              }),
            100,
          ),
        ),
      {
        tool: {} as Tool,
        args: {},
        currentTurnId: "t1",
        signal: ctl.signal,
      },
    );
    expect(result.allow).toBe(false);
  });

  test("I-44: decision for wrong turn id → stale_modal_decision", async () => {
    const ctl = new AbortController();
    const result = await requestApprovalWithAbortRace(
      async () => ({
        behavior: "allow",
        decisionAtTurnId: "t-prev",
      }),
      {
        tool: {} as Tool,
        args: {},
        currentTurnId: "t-current",
        signal: ctl.signal,
      },
    );
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.cause).toBe("stale_modal_decision");
    }
  });

  test("valid allow decision passes", async () => {
    const ctl = new AbortController();
    const result = await requestApprovalWithAbortRace(
      async () => ({
        behavior: "allow",
        decisionAtTurnId: "t1",
      }),
      {
        tool: {} as Tool,
        args: {},
        currentTurnId: "t1",
        signal: ctl.signal,
      },
    );
    expect(result.allow).toBe(true);
  });
});

describe("runToolUse end-to-end", () => {
  test("I-9 timeout on stalled tool", async () => {
    const tool: Tool = {
      name: "stuck",
      description: "",
      inputSchema: {},
      execute: () => new Promise(() => {}),
      timeoutMs: 50,
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "stuck"),
    });
    expect(out.isError).toBe(true);
    // per-tool timeoutMs:50 → message mentions 50ms (not the 30s default)
    expect(out.content).toContain("50ms");
  });

  test("I-15 oversized result truncated + warning emitted", async () => {
    const big = "x".repeat(2000);
    const tool: Tool = {
      name: "big",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: big }),
      maxResultBytes: 500,
    };
    const log = new EventLog();
    const warnings: string[] = [];
    log.subscribe((e) => {
      const pl = e.msg.payload as { cause?: string };
      if (e.msg.type === "warning" && pl.cause === "tool_result_truncated") {
        warnings.push(pl.cause);
      }
    });
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "big"),
      eventLog: log,
    });
    expect(out.content).toContain("[truncated:");
    expect(warnings).toContain("tool_result_truncated");
  });

  test("I-79 BigInt args passed through to tool", async () => {
    let seen: unknown = null;
    const tool: Tool = {
      name: "echo",
      description: "",
      inputSchema: {},
      execute: async (args) => {
        seen = args["lamports"];
        return { content: "ok" };
      },
    };
    await runToolUse('{"lamports":9007199254740993}', {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "echo"),
    });
    expect(typeof seen).toBe("bigint");
    expect(seen).toBe(9007199254740993n);
  });
});
