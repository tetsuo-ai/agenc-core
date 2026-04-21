import { describe, expect, test } from "vitest";
import {
  capToolResult,
  classifyToolError,
  DEFAULT_MAX_TOOL_RESULT_BYTES,
  DEFAULT_TOOL_TIMEOUT_MS,
  defaultCheckModeStillAllowed,
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
    expect(out.content).toMatch(/aborted|plan/i);
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
