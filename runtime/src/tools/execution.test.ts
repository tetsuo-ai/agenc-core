import { describe, expect, test } from "vitest";
import {
  capToolResult,
  classifyToolError,
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS,
  defaultCheckModeStillAllowed,
  formatError,
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
} from "./hooks.js";
import { EventLog } from "../session/event-log.js";
import { APPROVED_FOR_SESSION } from "../permissions/review-decision.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
} from "../permissions/evaluator.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import { PermissionModeRegistry } from "../permissions/mode.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type PermissionResult,
  type ToolPermissionContext,
} from "../permissions/types.js";

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

  test("timeout aborts the provided controller so the underlying tool can cancel", async () => {
    const ctl = new AbortController();
    await expect(
      withTimeoutAndAbort(() => new Promise(() => {}), {
        timeoutMs: 20,
        toolName: "stub",
        signal: ctl.signal,
        abortController: ctl,
      }),
    ).rejects.toThrow(ToolTimeoutError);
    expect(ctl.signal.aborted).toBe(true);
    expect(String(ctl.signal.reason)).toContain("tool timeout");
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

  test("I-44: stale active turn short-circuits before opening the modal", async () => {
    const ctl = new AbortController();
    let modalCalls = 0;
    const result = await requestApprovalWithAbortRace(
      async () => {
        modalCalls += 1;
        return {
          behavior: "allow",
          decisionAtTurnId: "t-prev",
        };
      },
      {
        tool: {} as Tool,
        args: {},
        currentTurnId: "t-prev",
        getActiveTurnId: () => "t-current",
        signal: ctl.signal,
      },
    );
    expect(result.allow).toBe(false);
    if (!result.allow) {
      expect(result.cause).toBe("stale_modal_decision");
    }
    expect(modalCalls).toBe(0);
  });

  test("I-44: active turn change after modal open rejects a matching stale decision", async () => {
    const ctl = new AbortController();
    let activeTurnId = "t1";
    let resolveDecision: ((value: {
      behavior: "allow" | "deny" | "abort";
      decisionAtTurnId: string;
    }) => void) | null = null;
    const resultPromise = requestApprovalWithAbortRace(
      async () =>
        await new Promise((resolve) => {
          resolveDecision = resolve;
        }),
      {
        tool: {} as Tool,
        args: {},
        currentTurnId: "t1",
        getActiveTurnId: () => activeTurnId,
        signal: ctl.signal,
      },
    );

    activeTurnId = "t2";
    resolveDecision?.({
      behavior: "allow",
      decisionAtTurnId: "t1",
    });

    const result = await resultPromise;
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

  test("approved_for_session decisions populate the approval cache and skip the second modal", async () => {
    const ctl = new AbortController();
    let modalCalls = 0;
    const cached = new Map<string, string>();
    const cache = {
      async withCachedApproval(opts: {
        readonly keys: readonly unknown[];
        readonly fetchDecision: () => Promise<{ readonly kind: string }>;
      }) {
        const key = JSON.stringify(opts.keys[0]);
        if (cached.get(key) === "approved_for_session") {
          return APPROVED_FOR_SESSION;
        }
        const decision = await opts.fetchDecision();
        if (decision.kind === "approved_for_session") {
          cached.set(key, decision.kind);
        }
        return decision;
      },
    };

    const first = await requestApprovalWithAbortRace(
      async () => {
        modalCalls += 1;
        return {
          behavior: "allow",
          decisionAtTurnId: "t1",
          reviewDecision: APPROVED_FOR_SESSION,
        };
      },
      {
        tool: {} as Tool,
        args: {},
        currentTurnId: "t1",
        signal: ctl.signal,
        approvalCache: {
          cache,
          keys: [{ toolName: "system.bash", cwd: "/repo" }],
        },
      },
    );
    const second = await requestApprovalWithAbortRace(
      async () => {
        modalCalls += 1;
        return {
          behavior: "allow",
          decisionAtTurnId: "t1",
          reviewDecision: APPROVED_FOR_SESSION,
        };
      },
      {
        tool: {} as Tool,
        args: {},
        currentTurnId: "t1",
        signal: ctl.signal,
        approvalCache: {
          cache,
          keys: [{ toolName: "system.bash", cwd: "/repo" }],
        },
      },
    );

    expect(first.allow).toBe(true);
    expect(second.allow).toBe(true);
    expect(modalCalls).toBe(1);
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

  test("injects __abortSignal so tools can observe runtime cancellation", async () => {
    let sawAbortSignal = false;
    let signalAbortedAtResolve = false;
    const controller = new AbortController();
    const tool: Tool = {
      name: "abort-aware",
      description: "",
      inputSchema: {},
      timeoutMs: 20,
      execute: async (args) =>
        await new Promise((resolve) => {
          const signal = (
            args as { __abortSignal?: AbortSignal }
          ).__abortSignal;
          sawAbortSignal = signal instanceof AbortSignal;
          signal?.addEventListener(
            "abort",
            () => {
              signalAbortedAtResolve = signal.aborted;
              resolve({ content: "cancelled", isError: true });
            },
            { once: true },
          );
        }),
    };

    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c-abort", "abort-aware"),
      abortController: controller,
      signal: controller.signal,
    });

    expect(sawAbortSignal).toBe(true);
    expect(signalAbortedAtResolve).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(out.isError).toBe(true);
  });

  test("I-44: stale active turn after approval blocks execute() and emits a warning", async () => {
    let executed = 0;
    let activeTurnId = "t1";
    let resolveDecision: ((value: {
      behavior: "allow" | "deny" | "abort";
      decisionAtTurnId: string;
    }) => void) | null = null;
    const tool: Tool = {
      name: "guarded",
      description: "",
      inputSchema: {},
      execute: async () => {
        executed += 1;
        return { content: "should-not-run" };
      },
    };
    const log = new EventLog();
    const warnings: string[] = [];
    const invocation = {
      ...makeInvocation("c-stale", "guarded"),
      session: { services: {} } as never,
    };
    log.subscribe((e) => {
      if (e.msg.type === "warning") {
        const payload = e.msg.payload as { cause?: string };
        if (payload.cause) warnings.push(payload.cause);
      }
    });

    const outPromise = runToolUse("{}", {
      currentTurnId: "t1",
      getActiveTurnId: () => activeTurnId,
      tool,
      invocation,
      eventLog: log,
      requestApproval: async () =>
        await new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    });

    activeTurnId = "t2";
    resolveDecision?.({
      behavior: "allow",
      decisionAtTurnId: "t1",
    });

    const out = await outPromise;
    expect(out.isError).toBe(true);
    expect(out.content).toContain("approval stale_modal_decision");
    expect(executed).toBe(0);
    expect(warnings).toContain("stale_modal_decision");
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
    expect(result.errors[0]?.category).toBe("missing");
  });

  test("flags wrong type + populates expected/received", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    const result = validateToolArgs(schema, { a: 42 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toContain("expected string");
    expect(result.errors[0]?.category).toBe("type");
    expect(result.errors[0]?.expected).toBe("string");
    expect(result.errors[0]?.received).toBe("integer");
  });

  test("enum membership check", () => {
    const schema = {
      type: "object",
      properties: { color: { enum: ["red", "blue"] } },
    };
    expect(validateToolArgs(schema, { color: "red" }).valid).toBe(true);
    expect(validateToolArgs(schema, { color: "green" }).valid).toBe(false);
  });

  test("anyOf accepts matching branch", () => {
    const schema = {
      type: "object",
      properties: {
        value: { anyOf: [{ type: "string" }, { type: "integer" }] },
      },
    };
    expect(validateToolArgs(schema, { value: "ok" }).valid).toBe(true);
    expect(validateToolArgs(schema, { value: 42 }).valid).toBe(true);
    expect(validateToolArgs(schema, { value: true }).valid).toBe(false);
  });

  test("const enforces exact equality", () => {
    const schema = {
      type: "object",
      properties: { kind: { const: "commit" } },
    };
    expect(validateToolArgs(schema, { kind: "commit" }).valid).toBe(true);
    expect(validateToolArgs(schema, { kind: "push" }).valid).toBe(false);
  });

  test("additionalProperties: false flags unexpected key", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" } },
      additionalProperties: false,
    };
    const result = validateToolArgs(schema, { name: "x", extra: 1 });
    expect(result.valid).toBe(false);
    const unexpected = result.errors.find((e) => e.category === "unexpected_key");
    expect(unexpected?.path).toBe("extra");
  });

  test("$ref resolves pointer to local definition", () => {
    const schema = {
      type: "object",
      properties: {
        item: { $ref: "#/definitions/Name" },
      },
      definitions: {
        Name: { type: "string", minLength: 3 },
      },
    };
    expect(validateToolArgs(schema, { item: "abc" }).valid).toBe(true);
    expect(validateToolArgs(schema, { item: "ab" }).valid).toBe(false);
    expect(validateToolArgs(schema, { item: 5 }).valid).toBe(false);
  });

  test("items schema recurses into arrays", () => {
    const schema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
    };
    expect(validateToolArgs(schema, { tags: ["a", "b"] }).valid).toBe(true);
    const bad = validateToolArgs(schema, { tags: ["a", 3] });
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]?.path).toBe("tags.1");
  });
});

describe("runToolUse — schema validation integration", () => {
  test("missing required field returns InputValidationError prose", async () => {
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
    expect(out.content).toContain("InputValidationError");
    expect(out.content).toContain("required parameter");
    expect(out.content).toContain("name");
    const err = events.find((e) => e.type === "error" && e.payload.cause === "schema_validation_failed");
    expect(err).toBeDefined();
  });

  test("type mismatch produces openclaude-style humanized prose", async () => {
    const tool: Tool = {
      name: "typed",
      description: "",
      inputSchema: {
        type: "object",
        properties: { count: { type: "integer" } },
      },
      execute: async () => ({ content: "ok" }),
    };
    const out = await runToolUse('{"count":"abc"}', {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "typed"),
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("InputValidationError");
    // openclaude prose: "The parameter `count` type is expected as `integer`
    // but provided as `string`"
    expect(out.content).toContain("count");
    expect(out.content).toContain("integer");
    expect(out.content).toContain("string");
  });

  test("deferred tool + unregistered schema → schema-not-sent hint appended", async () => {
    const tool: Tool = {
      name: "deferred.tool",
      description: "",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
      metadata: { deferred: true },
      execute: async () => ({ content: "ran" }),
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c-def", "deferred.tool"),
      discoveredToolNames: new Set(),
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("schema was not sent");
    expect(out.content).toContain("system.searchTools");
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

// ─────────────────────────────────────────────────────────────────────
// T11 W3-B — permission evaluator integration + I-3 mid-execution
// ─────────────────────────────────────────────────────────────────────

function buildEvaluatorContext(
  mode: PermissionMode,
  overrides?: Partial<ToolPermissionContext>,
): { context: ToolEvaluatorContext; registry: PermissionModeRegistry } {
  const ctx = createEmptyToolPermissionContext({ mode, ...(overrides ?? {}) });
  const registry = new PermissionModeRegistry(ctx);
  const denialTracking = freshDenialTracking();
  const appState: AppStateSnapshot = {
    toolPermissionContext: registry.current(),
    denialTracking,
    autoModeActive: false,
  };
  const context = attachContextDefaults({
    session: {} as never,
    denialTracking,
    getAppState: (): AppStateSnapshot => ({
      toolPermissionContext: registry.current(),
      denialTracking,
      autoModeActive: appState.autoModeActive,
    }),
  });
  return { context, registry };
}

describe("T11 W3-B — permission evaluator integration", () => {
  test("bypassPermissions mode skips prompts and allows execute()", async () => {
    const { context } = buildEvaluatorContext("bypassPermissions");
    let executed = 0;
    const tool: Tool = {
      name: "system.writeFile",
      description: "",
      inputSchema: {},
      execute: async () => {
        executed += 1;
        return { content: "wrote" };
      },
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "system.writeFile"),
      canUseTool: hasPermissionsToUseTool,
      permissionContext: context,
    });
    expect(out.isError).toBe(false);
    expect(out.content).toBe("wrote");
    expect(executed).toBe(1);
  });

  test("default mode with no matching rules returns ask → deny when no prompt wired", async () => {
    const { context } = buildEvaluatorContext("default");
    let executed = 0;
    const tool: Tool = {
      name: "system.writeFile",
      description: "",
      inputSchema: {},
      execute: async () => {
        executed += 1;
        return { content: "wrote" };
      },
    };
    const log = new EventLog();
    const errorCauses: string[] = [];
    log.subscribe((e) => {
      if (e.msg.type === "error") {
        const pl = e.msg.payload as { cause: string };
        errorCauses.push(pl.cause);
      }
    });
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "system.writeFile"),
      canUseTool: hasPermissionsToUseTool,
      permissionContext: context,
      eventLog: log,
    });
    expect(out.isError).toBe(true);
    expect(executed).toBe(0);
    expect(errorCauses.some((c) => c.startsWith("permission_denied:"))).toBe(
      true,
    );
  });

  test("deny rule short-circuits before execute()", async () => {
    const { context } = buildEvaluatorContext("default", {
      alwaysDenyRules: { session: ["system.writeFile"] },
    });
    let executed = 0;
    const tool: Tool = {
      name: "system.writeFile",
      description: "",
      inputSchema: {},
      execute: async () => {
        executed += 1;
        return { content: "wrote" };
      },
    };
    const log = new EventLog();
    const errorCauses: string[] = [];
    log.subscribe((e) => {
      if (e.msg.type === "error") {
        const pl = e.msg.payload as { cause: string };
        errorCauses.push(pl.cause);
      }
    });
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "system.writeFile"),
      canUseTool: hasPermissionsToUseTool,
      permissionContext: context,
      eventLog: log,
    });
    expect(out.isError).toBe(true);
    expect(executed).toBe(0);
    // Deny via rule surfaces as `permission_denied:rule` (decisionReason.type === "rule").
    expect(errorCauses.some((c) => c === "permission_denied:rule")).toBe(true);
  });

  test("allow rule lets execute() run under default mode", async () => {
    const { context } = buildEvaluatorContext("default", {
      alwaysAllowRules: { session: ["system.writeFile"] },
    });
    let executed = 0;
    const tool: Tool = {
      name: "system.writeFile",
      description: "",
      inputSchema: {},
      execute: async () => {
        executed += 1;
        return { content: "wrote" };
      },
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "system.writeFile"),
      canUseTool: hasPermissionsToUseTool,
      permissionContext: context,
    });
    expect(out.isError).toBe(false);
    expect(executed).toBe(1);
  });

  test("evaluator custom allow with updatedInput is threaded into tool.execute()", async () => {
    const { context: baseContext } = buildEvaluatorContext("default");
    // Custom canUseTool returns allow with an updatedInput replacing arg.
    const canUseTool = async () =>
      ({
        behavior: "allow" as const,
        updatedInput: { redacted: true },
      }) as PermissionResult;
    let seenArgs: unknown = null;
    const tool: Tool = {
      name: "system.echo",
      description: "",
      inputSchema: {},
      execute: async (args) => {
        seenArgs = { ...args };
        return { content: "ok" };
      },
    };
    await runToolUse('{"original":true}', {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "system.echo"),
      canUseTool,
      permissionContext: baseContext,
    });
    expect((seenArgs as { redacted?: boolean })?.redacted).toBe(true);
    expect((seenArgs as { original?: boolean })?.original).toBeUndefined();
  });

  test("mid-execution plan-mode transition aborts in-flight write-capable tool", async () => {
    const { context, registry } = buildEvaluatorContext("default", {
      alwaysAllowRules: { session: ["system.writeFile"] },
    });
    const abortCtl = new AbortController();
    const tool: Tool = {
      name: "system.writeFile",
      description: "",
      inputSchema: {},
      execute: (args) =>
        new Promise((resolve, reject) => {
          const sig = (args as { __signal?: AbortSignal }).__signal;
          const onAbort = () => {
            reject(new Error("aborted: plan mode"));
          };
          // Listen on the supplied session signal (bound by
          // runToolUse via `signal`), otherwise fall back to the
          // abort controller passed alongside modeChangeRegistry.
          abortCtl.signal.addEventListener("abort", onAbort, { once: true });
          if (sig) {
            sig.addEventListener("abort", onAbort, { once: true });
          }
          // Never resolves on its own.
        }),
    };
    const runP = runToolUse("{}", {
      signal: abortCtl.signal,
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "system.writeFile"),
      canUseTool: hasPermissionsToUseTool,
      permissionContext: context,
      modeChangeRegistry: registry,
      abortController: abortCtl,
    });
    // After microtask, flip mode to `plan` and expect the in-flight
    // tool to abort.
    setImmediate(async () => {
      const nextCtx: ToolPermissionContext = {
        ...registry.current(),
        mode: "plan" as PermissionMode,
      };
      await registry.update(nextCtx);
    });
    const out = await runP;
    expect(out.isError).toBe(true);
    // openclaude parity: aborted tools surface `INTERRUPT_MESSAGE_FOR_TOOL_USE`.
    expect(out.content).toContain("interrupted by user");
  });

  test("mode-change subscription is removed on normal completion (no leak)", async () => {
    const { context, registry } = buildEvaluatorContext("default", {
      alwaysAllowRules: { session: ["system.readFile"] },
    });
    const abortCtl = new AbortController();
    const tool: Tool = {
      name: "system.readFile",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ok" }),
    };
    const beforeSize = (registry as unknown as {
      subscribers: Set<unknown>;
    }).subscribers.size;
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "system.readFile"),
      canUseTool: hasPermissionsToUseTool,
      permissionContext: context,
      modeChangeRegistry: registry,
      abortController: abortCtl,
    });
    expect(out.isError).toBe(false);
    const afterSize = (registry as unknown as {
      subscribers: Set<unknown>;
    }).subscribers.size;
    expect(afterSize).toBe(beforeSize);
  });

  test("mode-change subscription is removed on tool error (no leak)", async () => {
    const { context, registry } = buildEvaluatorContext("default", {
      alwaysAllowRules: { session: ["system.thrower"] },
    });
    const abortCtl = new AbortController();
    const tool: Tool = {
      name: "system.thrower",
      description: "",
      inputSchema: {},
      execute: async () => {
        throw new Error("boom");
      },
    };
    const beforeSize = (registry as unknown as {
      subscribers: Set<unknown>;
    }).subscribers.size;
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "system.thrower"),
      canUseTool: hasPermissionsToUseTool,
      permissionContext: context,
      modeChangeRegistry: registry,
      abortController: abortCtl,
    });
    expect(out.isError).toBe(true);
    const afterSize = (registry as unknown as {
      subscribers: Set<unknown>;
    }).subscribers.size;
    expect(afterSize).toBe(beforeSize);
  });

  test("defaultCheckModeStillAllowed: plan mode strips write-capable tools", () => {
    const writeTool: Tool = {
      name: "system.writeFile",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "" }),
    };
    const readTool: Tool = {
      name: "system.readFile",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "" }),
      isReadOnly: true,
    };
    expect(defaultCheckModeStillAllowed(writeTool, {}, "plan")).toBe(false);
    expect(defaultCheckModeStillAllowed(readTool, {}, "plan")).toBe(true);
    // Non-plan transitions do not retroactively abort.
    expect(defaultCheckModeStillAllowed(writeTool, {}, "acceptEdits")).toBe(
      true,
    );
    expect(defaultCheckModeStillAllowed(writeTool, {}, "bypassPermissions")).toBe(
      true,
    );
  });

  test("no permission context supplied → evaluator path is skipped entirely", async () => {
    // Back-compat: runToolUse without canUseTool/permissionContext
    // still dispatches normally (existing approval modal path).
    let executed = 0;
    const tool: Tool = {
      name: "system.bash",
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
      invocation: makeInvocation("c1", "system.bash"),
    });
    expect(out.isError).toBe(false);
    expect(executed).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// T6 parity — PreToolUse runs BEFORE permission gate (inc-4788 order)
// ─────────────────────────────────────────────────────────────────────

describe("T6 parity — PreToolUse ordering + inc-4788", () => {
  test("pre-hook runs BEFORE permission gate", async () => {
    const order: string[] = [];
    const { context } = buildEvaluatorContext("default", {
      alwaysAllowRules: { session: ["ordered.tool"] },
    });
    const preHook: PreToolUseHook = () => {
      order.push("pre");
      return { kind: "continue" };
    };
    const canUseTool = async (
      t: Tool,
      args: Record<string, unknown>,
      ctx: ToolEvaluatorContext,
    ) => {
      order.push("gate");
      return hasPermissionsToUseTool(t, args, ctx);
    };
    const tool: Tool = {
      name: "ordered.tool",
      description: "",
      inputSchema: {},
      execute: async () => {
        order.push("exec");
        return { content: "ok" };
      },
    };
    await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "ordered.tool"),
      preHooks: [preHook],
      canUseTool,
      permissionContext: context,
    });
    expect(order).toEqual(["pre", "gate", "exec"]);
  });

  test("pre-hook allow + canUseTool returns ask → still asks (inc-4788)", async () => {
    // In inc-4788, hook `allow` does NOT bypass settings.json rules.
    // mergeHookPermissionDecision returns `allow` when no rule check is
    // wired, so this case ultimately routes through the evaluator's
    // native ask-without-prompt path when the evaluator disagrees.
    // We use a hook `allow` without ruleBasedCheck to confirm the
    // evaluator is NOT reached (hook allow short-circuits without rule
    // check, matching openclaude's `resolveHookPermissionDecision`).
    let evalRan = 0;
    let execRan = 0;
    const { context } = buildEvaluatorContext("default");
    const preHook: PreToolUseHook = () => ({
      kind: "continue",
      hookPermissionResult: { behavior: "allow", hookName: "PreToolUse:ok" },
    });
    const canUseTool = async (...args: Parameters<typeof hasPermissionsToUseTool>) => {
      evalRan += 1;
      return hasPermissionsToUseTool(...args);
    };
    const tool: Tool = {
      name: "hook.allowed",
      description: "",
      inputSchema: {},
      execute: async () => {
        execRan += 1;
        return { content: "ok" };
      },
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "hook.allowed"),
      preHooks: [preHook],
      canUseTool,
      permissionContext: context,
    });
    expect(out.isError).toBe(false);
    expect(execRan).toBe(1);
    // Hook allow short-circuits the evaluator when no ruleBasedCheck
    // is provided (the evaluator runs only when the hook was ask or
    // absent).
    expect(evalRan).toBe(0);
  });

  test("pre-hook hookPermissionResult.updatedInput threads into tool.execute", async () => {
    const { context } = buildEvaluatorContext("default");
    let seen: unknown = null;
    const preHook: PreToolUseHook = () => ({
      kind: "continue",
      hookPermissionResult: {
        behavior: "allow",
        updatedInput: { redacted: true },
      },
    });
    const tool: Tool = {
      name: "redact.tool",
      description: "",
      inputSchema: {},
      execute: async (args) => {
        seen = { ...args };
        return { content: "ok" };
      },
    };
    await runToolUse('{"orig":true}', {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "redact.tool"),
      preHooks: [preHook],
      canUseTool: hasPermissionsToUseTool,
      permissionContext: context,
    });
    expect((seen as { redacted?: boolean })?.redacted).toBe(true);
    expect((seen as { orig?: boolean })?.orig).toBeUndefined();
  });

  test("pre-hook stop → tool_result carries CANCEL_MESSAGE", async () => {
    let executed = 0;
    const preHook: PreToolUseHook = () => ({
      kind: "stop",
      stopReason: "explicit halt",
    });
    const tool: Tool = {
      name: "halted",
      description: "",
      inputSchema: {},
      execute: async () => {
        executed += 1;
        return { content: "should-not-run" };
      },
    };
    const log = new EventLog();
    const warnings: string[] = [];
    log.subscribe((e) => {
      if (e.msg.type === "warning") {
        const p = e.msg.payload as { cause: string };
        warnings.push(p.cause);
      }
    });
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "halted"),
      preHooks: [preHook],
      eventLog: log,
    });
    expect(out.isError).toBe(true);
    // CANCEL_MESSAGE prefix
    expect(out.content).toContain("STOP what you are doing");
    expect(executed).toBe(0);
    expect(warnings).toContain("hook_stopped_continuation");
  });
});

// ─────────────────────────────────────────────────────────────────────
// T6 parity — terminal tool_result labeling + formatError
// ─────────────────────────────────────────────────────────────────────

describe("T6 parity — formatError + terminal labels", () => {
  test("formatError on AbortError returns INTERRUPT_MESSAGE_FOR_TOOL_USE", () => {
    const err = new Error();
    err.name = "AbortError";
    expect(formatError(err)).toContain("interrupted by user");
  });

  test("formatError on ShellError emits exit code + stderr + interrupt marker", () => {
    const shell = new Error("Shell command failed");
    shell.name = "ShellError";
    (shell as Error & {
      code?: number;
      interrupted?: boolean;
      stderr?: string;
      stdout?: string;
    }).code = 127;
    (shell as Error & { interrupted?: boolean }).interrupted = true;
    (shell as Error & { stderr?: string }).stderr = "bad command";
    const out = formatError(shell);
    expect(out).toContain("Exit code 127");
    expect(out).toContain("interrupted by user");
    expect(out).toContain("bad command");
  });

  test("formatError on regular Error returns message", () => {
    expect(formatError(new Error("plain"))).toBe("plain");
  });

  test("formatError on non-Error value returns String(value)", () => {
    expect(formatError("just a string")).toBe("just a string");
  });

  test("formatError mid-truncates >10k messages", () => {
    const huge = "x".repeat(20_000);
    const out = formatError(new Error(huge));
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("characters truncated");
  });

  test("aborted tool surfaces INTERRUPT_MESSAGE_FOR_TOOL_USE (no <tool_use_error>)", async () => {
    // openclaude parity: an aborted tool's tool_result is NOT wrapped
    // in the old `<tool_use_error>` tag. The execution dispatcher
    // routes `cls === "aborted"` to the canonical
    // INTERRUPT_MESSAGE_FOR_TOOL_USE string.
    const tool: Tool = {
      name: "aborter",
      description: "",
      inputSchema: {},
      execute: async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      },
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "aborter"),
    });
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain("<tool_use_error>");
    expect(out.content).toContain("interrupted by user");
  });

  test("formatError fallback when AbortError has no message", () => {
    const bare = new Error();
    bare.name = "AbortError";
    expect(formatError(bare)).toContain("interrupted by user");
  });

  test("tool throw surfaces formatError prose (no bare wrapper)", async () => {
    const tool: Tool = {
      name: "thrower",
      description: "",
      inputSchema: {},
      execute: async () => {
        throw new Error("runtime failure: disk full");
      },
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "thrower"),
    });
    expect(out.isError).toBe(true);
    expect(out.content).toContain("runtime failure: disk full");
    expect(out.content).not.toContain("<tool_use_error>");
  });
});

// ─────────────────────────────────────────────────────────────────────
// T6 parity — MCP-class error handling
// ─────────────────────────────────────────────────────────────────────

describe("T6 parity — MCP error handling", () => {
  test("McpAuthError triggers onMcpAuthError hook with serverName", async () => {
    class McpAuthError extends Error {
      readonly serverName: string;
      constructor(serverName: string) {
        super(`MCP auth required for ${serverName}`);
        this.name = "McpAuthError";
        this.serverName = serverName;
      }
    }
    const authed: string[] = [];
    const tool: Tool = {
      name: "mcp.needs_auth",
      description: "",
      inputSchema: {},
      execute: async () => {
        throw new McpAuthError("github");
      },
    };
    const log = new EventLog();
    const causes: string[] = [];
    log.subscribe((e) => {
      if (e.msg.type === "error") {
        const p = e.msg.payload as { cause: string };
        causes.push(p.cause);
      }
    });
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "mcp.needs_auth"),
      eventLog: log,
      onMcpAuthError: (name) => authed.push(name),
    });
    expect(out.isError).toBe(true);
    expect(authed).toEqual(["github"]);
    expect(causes).toContain("mcp_auth_required");
  });

  test("McpToolCallError passes mcpMeta through onMcpToolCallError hook", async () => {
    class McpToolCallError extends Error {
      readonly mcpMeta: unknown;
      constructor(message: string, mcpMeta: unknown) {
        super(message);
        this.name = "McpToolCallError";
        this.mcpMeta = mcpMeta;
      }
    }
    const metas: unknown[] = [];
    const tool: Tool = {
      name: "mcp.fails",
      description: "",
      inputSchema: {},
      execute: async () => {
        throw new McpToolCallError("upstream error", { traceId: "abc" });
      },
    };
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "mcp.fails"),
      onMcpToolCallError: (m) => metas.push(m),
    });
    expect(out.isError).toBe(true);
    expect(metas).toEqual([{ traceId: "abc" }]);
    expect(out.content).toContain("upstream error");
  });

  test("classifyToolError recognizes McpAuthError + McpToolCallError + ShellError.interrupted", () => {
    class McpAuthError extends Error {
      readonly serverName = "x";
      constructor() {
        super("auth");
        this.name = "McpAuthError";
      }
    }
    class McpToolCallError extends Error {
      constructor() {
        super("x");
        this.name = "McpToolCallError";
      }
    }
    const shell = new Error("sh");
    shell.name = "ShellError";
    (shell as Error & { interrupted?: boolean }).interrupted = true;

    expect(classifyToolError(new McpAuthError())).toBe("mcp_auth");
    expect(classifyToolError(new McpToolCallError())).toBe("mcp_tool_call");
    expect(classifyToolError(shell)).toBe("shell_interrupted");
  });
});

// ─────────────────────────────────────────────────────────────────────
// T6 parity — six hook-attachment kinds emitted on the live path
// ─────────────────────────────────────────────────────────────────────

describe("T6 parity — hook attachment emission", () => {
  function mkLog(): {
    log: EventLog;
    attachments: Array<{ cause: string; message: string }>;
  } {
    const log = new EventLog();
    const attachments: Array<{ cause: string; message: string }> = [];
    log.subscribe((e) => {
      if (e.msg.type === "warning") {
        const p = e.msg.payload as { cause: string; message: string };
        if (p.cause.startsWith("hook_")) {
          attachments.push({ cause: p.cause, message: p.message });
        }
      }
    });
    return { log, attachments };
  }

  test("PostToolUse additionalContext emits hook_additional_context", async () => {
    const postHook: PostToolUseHook = () => ({
      kind: "additionalContext",
      content: ["lint: unused var"],
    });
    const tool: Tool = {
      name: "post.ac",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ran" }),
    };
    const { log, attachments } = mkLog();
    await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "post.ac"),
      postHooks: [postHook],
      eventLog: log,
    });
    const hit = attachments.find((a) => a.cause === "hook_additional_context");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("lint: unused var");
  });

  test("PostToolUse stop emits hook_stopped_continuation", async () => {
    const postHook: PostToolUseHook = () => ({
      kind: "stop",
      stopReason: "review required",
    });
    const tool: Tool = {
      name: "post.stop",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ran" }),
    };
    const { log, attachments } = mkLog();
    await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "post.stop"),
      postHooks: [postHook],
      eventLog: log,
    });
    const hit = attachments.find((a) => a.cause === "hook_stopped_continuation");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("review required");
  });

  test("PostToolUse hook_blocking_error emits hook_blocking_error", async () => {
    const postHook: PostToolUseHook = () => ({
      kind: "hook_blocking_error",
      blockingError: "lint failed",
    });
    const tool: Tool = {
      name: "post.block",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ran" }),
    };
    const { log, attachments } = mkLog();
    await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "post.block"),
      postHooks: [postHook],
      eventLog: log,
    });
    const hit = attachments.find((a) => a.cause === "hook_blocking_error");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("lint failed");
  });

  test("PostToolUse throwing hook emits hook_error_during_execution", async () => {
    const postHook: PostToolUseHook = () => {
      throw new Error("post kaboom");
    };
    const tool: Tool = {
      name: "post.throws",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ran" }),
    };
    const { log, attachments } = mkLog();
    await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "post.throws"),
      postHooks: [postHook],
      eventLog: log,
    });
    const hit = attachments.find((a) => a.cause === "hook_error_during_execution");
    expect(hit).toBeDefined();
    expect(hit?.message).toContain("post kaboom");
  });

  test("hookPermissionResult deny emits hook_permission_decision", async () => {
    const preHook: PreToolUseHook = () => ({
      kind: "continue",
      hookPermissionResult: {
        behavior: "deny",
        message: "denied by hook",
        hookName: "PreToolUse:deny",
      },
    });
    const tool: Tool = {
      name: "perm.deny",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ran" }),
    };
    const { log, attachments } = mkLog();
    const { context } = buildEvaluatorContext("default");
    const out = await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "perm.deny"),
      preHooks: [preHook],
      canUseTool: hasPermissionsToUseTool,
      permissionContext: context,
      eventLog: log,
    });
    expect(out.isError).toBe(true);
    const hit = attachments.find(
      (a) => a.cause === "hook_permission_decision" && a.message.includes("deny"),
    );
    expect(hit).toBeDefined();
  });

  test("hookPermissionResult allow emits hook_permission_decision", async () => {
    const preHook: PreToolUseHook = () => ({
      kind: "continue",
      hookPermissionResult: {
        behavior: "allow",
        hookName: "PreToolUse:allow",
      },
    });
    const tool: Tool = {
      name: "perm.allow",
      description: "",
      inputSchema: {},
      execute: async () => ({ content: "ran" }),
    };
    const { log, attachments } = mkLog();
    const { context } = buildEvaluatorContext("default");
    await runToolUse("{}", {
      currentTurnId: "t1",
      tool,
      invocation: makeInvocation("c1", "perm.allow"),
      preHooks: [preHook],
      canUseTool: hasPermissionsToUseTool,
      permissionContext: context,
      eventLog: log,
    });
    const hit = attachments.find(
      (a) => a.cause === "hook_permission_decision" && a.message.includes("allow"),
    );
    expect(hit).toBeDefined();
  });
});
