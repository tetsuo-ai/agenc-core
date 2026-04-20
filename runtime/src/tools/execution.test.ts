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
  validateToolArgs,
  withTimeoutAndAbort,
} from "./execution.js";
import type { Tool } from "./types.js";
import type { ToolInvocation } from "./context.js";
import type {
  PostToolUseFailureHook,
  PostToolUseHook,
  PreToolUseHook,
} from "./tool-hooks.js";
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

  test("T6 gap #119: emits exec_approval_request + request_permissions when eventLog supplied", async () => {
    const ctl = new AbortController();
    const log = new EventLog();
    const recorded: Array<{ type: string; payload: unknown }> = [];
    log.subscribe((e) => {
      recorded.push({ type: e.msg.type, payload: e.msg.payload });
    });

    const tool = {
      name: "system.bash",
      description: "runs a shell command",
      inputSchema: {},
      execute: async () => ({ content: "" }),
    } as unknown as Tool;

    await requestApprovalWithAbortRace(
      async () => ({ behavior: "allow", decisionAtTurnId: "t1" }),
      {
        tool,
        args: { command: "ls -la" },
        currentTurnId: "t1",
        signal: ctl.signal,
        eventLog: log,
        subId: "sub-1",
        callId: "call-xyz",
      },
    );

    const approval = recorded.find((r) => r.type === "exec_approval_request");
    expect(approval).toBeDefined();
    const ap = approval!.payload as { callId: string; command: string };
    expect(ap.callId).toBe("call-xyz");
    expect(ap.command).toBe("ls -la");

    const perms = recorded.find((r) => r.type === "request_permissions");
    expect(perms).toBeDefined();
    const pp = perms!.payload as { toolName: string; permissions: string[] };
    expect(pp.toolName).toBe("system.bash");
    expect(pp.permissions.length).toBeGreaterThan(0);
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

// ─────────────────────────────────────────────────────────────────────
// Lightweight JSON Schema validation
// ─────────────────────────────────────────────────────────────────────

describe("validateToolArgs", () => {
  test("accepts args that satisfy required + types", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" }, b: { type: "number" } },
      required: ["a"],
    };
    const result = validateToolArgs(schema, { a: "hi", b: 3 });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("flags missing required field", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    };
    const result = validateToolArgs(schema, {});
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.path).toBe("a");
    expect(result.errors[0]?.message).toMatch(/missing/i);
  });

  test("flags wrong type", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    const result = validateToolArgs(schema, { a: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("expected string");
  });

  test("enum membership check", () => {
    const schema = {
      type: "object",
      properties: { color: { enum: ["red", "blue"] } },
    };
    expect(validateToolArgs(schema, { color: "red" }).valid).toBe(true);
    expect(validateToolArgs(schema, { color: "green" }).valid).toBe(false);
  });
});

describe("runToolUse — schema validation integration", () => {
  test("missing required field returns schema_validation_failed", async () => {
    const tool: Tool = {
      name: "strict",
      description: "",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      execute: async () => ({ content: "ok" }),
    };
    const log = new EventLog();
    const events: Array<{ type: string; payload: { cause?: string } }> = [];
    log.subscribe((e) => events.push({ type: e.msg.type, payload: e.msg.payload as { cause?: string } }));
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "strict"),
      eventLog: log,
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("schema validation failed");
    const err = events.find((e) => e.type === "error" && e.payload.cause === "schema_validation_failed");
    expect(err).toBeDefined();
  });

  test("skipArgValidation bypasses schema check", async () => {
    const tool: Tool = {
      name: "strict2",
      description: "",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      execute: async () => ({ content: "reached" }),
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "strict2"),
      skipArgValidation: true,
    });
    expect(out.content).toBe("reached");
  });
});

// ─────────────────────────────────────────────────────────────────────
// Hook invocation inside runToolUse (consistent boundary)
// ─────────────────────────────────────────────────────────────────────

describe("runToolUse — hook invocation", () => {
  test("pre-hook fires from runToolUse itself", async () => {
    let sawPre = false;
    const preHook: PreToolUseHook = async () => {
      sawPre = true;
      return { kind: "continue", args: { injected: true } };
    };
    const tool: Tool = {
      name: "h-pre",
      description: "",
      inputSchema: {},
      execute: async (args) => ({ content: JSON.stringify(args) }),
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "h-pre"),
      preHooks: [preHook],
    });
    expect(sawPre).toBe(true);
    expect(out.content).toContain('"injected":true');
  });

  test("post-hook fires from runToolUse itself + rewrite takes effect", async () => {
    let sawPost = false;
    const postHook: PostToolUseHook = async () => {
      sawPost = true;
      return { kind: "rewrite", result: { content: "rewritten" } };
    };
    const tool: Tool = {
      name: "h-post",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "original" }),
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "h-post"),
      postHooks: [postHook],
    });
    expect(sawPost).toBe(true);
    expect(out.content).toBe("rewritten");
  });

  test("failure-hook fires on tool throw", async () => {
    let sawFailure = 0;
    const failureHook: PostToolUseFailureHook = () => {
      sawFailure += 1;
    };
    const tool: Tool = {
      name: "thrower",
      description: "",
      inputSchema: {},
      execute: async () => {
        throw new Error("kaboom");
      },
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "thrower"),
      failureHooks: [failureHook],
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("kaboom");
    expect(sawFailure).toBe(1);
  });

  test("pre-hook deny short-circuits without executing tool", async () => {
    let executed = 0;
    const preHook: PreToolUseHook = () => ({ kind: "deny", reason: "nope" });
    const tool: Tool = {
      name: "h-deny",
      description: "",
      inputSchema: {},
      execute: async () => {
        executed += 1;
        return { content: "ran" };
      },
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "h-deny"),
      preHooks: [preHook],
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("nope");
    expect(executed).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Progress events
// ─────────────────────────────────────────────────────────────────────

describe("runToolUse — progress events", () => {
  test("tool that calls __onProgress emits tool_progress event on eventLog", async () => {
    const log = new EventLog();
    const progressEvents: Array<{ type: string; payload: { callId: string; chunk: string } }> = [];
    log.subscribe((e) => {
      if (e.msg.type === "tool_progress") {
        progressEvents.push({ type: e.msg.type, payload: e.msg.payload as { callId: string; chunk: string } });
      }
    });
    const tool: Tool = {
      name: "progressive",
      description: "",
      inputSchema: {},
      execute: async (args) => {
        const onProgress = (args as { __onProgress?: (e: { chunk: string }) => void })
          .__onProgress;
        onProgress?.({ chunk: "chunk-a" });
        onProgress?.({ chunk: "chunk-b" });
        return { content: "done" };
      },
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c-prog", "progressive"),
      eventLog: log,
    });
    expect(out.isError).toBe(false);
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0]!.payload.callId).toBe("c-prog");
    expect(progressEvents[0]!.payload.chunk).toBe("chunk-a");
    expect(progressEvents[1]!.payload.chunk).toBe("chunk-b");
  });
});
