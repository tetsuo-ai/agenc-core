import { describe, expect, test, vi } from "vitest";
import {
  ApprovalRejectedError,
  SandboxDeniedError,
  attemptWithRetry,
  classifyToolApproval,
  defaultExecApprovalRequirement,
  defaultRetryPolicy,
  defaultToolRetryPolicy,
  escalateOnFailure,
  isApprovalAccepted,
  orchestrateToolCall,
  requestApproval,
  sandboxKindFromMode,
  wantsNoSandboxApproval,
  type ApprovalCtx,
  type ApprovalResolver,
  type GranularApprovalConfig,
  type PermissionRequestHook,
  type ReviewDecision,
} from "./orchestrator.js";
import type { Tool } from "./types.js";
import { ConfiguredHooksRuntime } from "../hooks/configured-hooks.js";
import { Policy } from "../sandbox/execpolicy/policy.js";
import { REJECT_RULES_APPROVAL_REASON } from "../sandbox/escalation/unix-escalation.js";

const readTool: Tool = {
  name: "FileRead",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
  isReadOnly: true,
};

const writeTool: Tool = {
  name: "Write",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
  isReadOnly: false,
};

describe("classifyToolApproval", () => {
  test("approvalPolicy=never → skip (bypass sandbox only on danger_full_access)", () => {
    const skipReadOnly = classifyToolApproval(writeTool, {
      approvalPolicy: "never",
      sandboxMode: "read_only",
    });
    expect(skipReadOnly.kind).toBe("skip");

    const skipYolo = classifyToolApproval(writeTool, {
      approvalPolicy: "never",
      sandboxMode: "danger_full_access",
    });
    expect(skipYolo.kind).toBe("skip");
    if (skipYolo.kind === "skip") expect(skipYolo.bypassSandbox).toBe(true);
  });

  test("granular policy → read-only skip, write needs approval", () => {
    expect(
      classifyToolApproval(readTool, {
        approvalPolicy: "granular",
        sandboxMode: "read_only",
      }).kind,
    ).toBe("skip");
    expect(
      classifyToolApproval(writeTool, {
        approvalPolicy: "granular",
        sandboxMode: "read_only",
      }).kind,
    ).toBe("needs_approval");
  });

  test("denylist wins", () => {
    const res = classifyToolApproval(readTool, {
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
      toolDenylist: new Set(["FileRead"]),
    });
    expect(res.kind).toBe("forbidden");
  });

  test("untrusted policy always needs approval", () => {
    expect(
      classifyToolApproval(readTool, {
        approvalPolicy: "untrusted",
        sandboxMode: "workspace_write",
      }).kind,
    ).toBe("needs_approval");
  });

  test("interactive tools need approval even when read-only", () => {
    const interactiveTool: Tool = {
      ...readTool,
      name: "AskUserQuestion",
      requiresApproval: true,
      requiresUserInteraction: () => true,
    };

    expect(
      classifyToolApproval(interactiveTool, {
        approvalPolicy: "never",
        sandboxMode: "danger_full_access",
      }).kind,
    ).toBe("needs_approval");
  });
});

describe("defaultRetryPolicy + attemptWithRetry", () => {
  test("default policy bubbles every error", () => {
    expect(defaultRetryPolicy().kind).toBe("bubble");
  });

  test("retry decision re-dispatches up to maxAttempts", async () => {
    let attempts = 0;
    const result = await attemptWithRetry({
      dispatch: async () => {
        attempts += 1;
        if (attempts < 2) throw new Error("transient");
        return "ok";
      },
      onFailure: () => ({ kind: "retry", reason: "transient" }),
      maxAttempts: 3,
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  test("maxAttempts cap bubbles last error", async () => {
    await expect(
      attemptWithRetry({
        dispatch: async () => {
          throw new Error("perm");
        },
        onFailure: () => ({ kind: "retry", reason: "x" }),
        maxAttempts: 2,
      }),
    ).rejects.toThrow("perm");
  });
});

// ─────────────────────────────────────────────────────────────────────
// donor runtime-parity port coverage (T7 orchestrator gap fill)
// ─────────────────────────────────────────────────────────────────────

describe("defaultExecApprovalRequirement (sandboxing behavior)", () => {
  test("never + restricted → skip", () => {
    const r = defaultExecApprovalRequirement("never", "restricted");
    expect(r.kind).toBe("skip");
  });

  test("on_failure + restricted → skip", () => {
    const r = defaultExecApprovalRequirement("on_failure", "restricted");
    expect(r.kind).toBe("skip");
  });

  test("on_request + restricted → needs_approval", () => {
    const r = defaultExecApprovalRequirement("on_request", "restricted");
    expect(r.kind).toBe("needs_approval");
  });

  test("on_request + unrestricted → skip", () => {
    const r = defaultExecApprovalRequirement("on_request", "unrestricted");
    expect(r.kind).toBe("skip");
  });

  test("granular + restricted → needs_approval", () => {
    const r = defaultExecApprovalRequirement("granular", "restricted");
    expect(r.kind).toBe("needs_approval");
  });

  test("granular + unrestricted → skip", () => {
    const r = defaultExecApprovalRequirement("granular", "unrestricted");
    expect(r.kind).toBe("skip");
  });

  test("untrusted + any kind → needs_approval", () => {
    expect(
      defaultExecApprovalRequirement("untrusted", "restricted").kind,
    ).toBe("needs_approval");
    expect(
      defaultExecApprovalRequirement("untrusted", "unrestricted").kind,
    ).toBe("needs_approval");
    expect(
      defaultExecApprovalRequirement("untrusted", "external_sandbox").kind,
    ).toBe("needs_approval");
  });

  test("sandboxKindFromMode maps every SandboxMode", () => {
    expect(sandboxKindFromMode("danger_full_access")).toBe("unrestricted");
    expect(sandboxKindFromMode("read_only")).toBe("restricted");
    expect(sandboxKindFromMode("workspace_write")).toBe("restricted");
    expect(sandboxKindFromMode("external_sandbox")).toBe("external_sandbox");
  });
});

describe("defaultToolRetryPolicy classifier", () => {
  test("sandbox-denied → escalate_sandbox", () => {
    const err = new SandboxDeniedError("blocked", {
      denial: "filesystem",
      target: "/tmp/block",
      policy: { kind: "workspace_write", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
    });
    expect(defaultToolRetryPolicy(err).kind).toBe("escalate_sandbox");
  });

  test("transient error → retry with delay", () => {
    const d = defaultToolRetryPolicy(new Error("connection timeout"));
    expect(d.kind).toBe("retry");
    if (d.kind === "retry") {
      expect(d.delayMs).toBeGreaterThan(0);
    }
  });

  test("hard error → bubble", () => {
    const d = defaultToolRetryPolicy(new Error("schema_validation_failed"));
    expect(d.kind).toBe("bubble");
  });

  test("attemptWithRetry + defaultToolRetryPolicy — transient retries once", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => {});
    const result = await attemptWithRetry({
      dispatch: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("timeout");
        return "ok";
      },
      onFailure: defaultToolRetryPolicy,
      maxAttempts: 2,
      sleep,
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  test("attemptWithRetry + defaultToolRetryPolicy — hard error does NOT retry", async () => {
    let attempts = 0;
    await expect(
      attemptWithRetry({
        dispatch: async () => {
          attempts += 1;
          throw new Error("schema_violation");
        },
        onFailure: defaultToolRetryPolicy,
        maxAttempts: 3,
      }),
    ).rejects.toThrow("schema_violation");
    expect(attempts).toBe(1);
  });

  test("attemptWithRetry + defaultToolRetryPolicy — sandbox-denied bubbles to caller", async () => {
    await expect(
      attemptWithRetry({
        dispatch: async () => {
          throw new SandboxDeniedError("sandbox blocked", {
            denial: "filesystem",
            target: "/tmp/block",
            policy: { kind: "workspace_write", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
          });
        },
        onFailure: defaultToolRetryPolicy,
        maxAttempts: 3,
      }),
    ).rejects.toBeInstanceOf(SandboxDeniedError);
  });
});

describe("requestApproval pipeline", () => {
  const mkCtx = (): ApprovalCtx => ({
    invocation: {} as ApprovalCtx["invocation"],
    callId: "c-1",
    toolName: "test.tool",
    turnId: "t-1",
  });

  const mkGuardianCtx = (
    reviewer = "auto_review",
    approvalPolicy: "never" | "on_failure" | "on_request" | "granular" | "untrusted" = "on_request",
  ): ApprovalCtx => ({
    invocation: {
      session: {} as ApprovalCtx["invocation"]["session"],
      turn: {
        subId: "t-1",
        approvalPolicy: { value: approvalPolicy },
        config: { approvalsReviewer: reviewer },
      } as ApprovalCtx["invocation"]["turn"],
      tracker: {
        appendFileDiff: () => {},
        snapshot: () => [],
        clear: () => {},
      },
      callId: "c-1",
      toolName: { name: "test.tool" },
      payload: { kind: "function", arguments: "{}" },
      source: "direct",
    },
    callId: "c-1",
    toolName: "test.tool",
    turnId: "t-1",
  });

  test("hook short-circuits before resolver", async () => {
    const hookSpy = vi
      .fn()
      .mockResolvedValue({ kind: "approved" } as ReviewDecision);
    const resolverSpy = vi
      .fn()
      .mockResolvedValue({ kind: "denied" } as ReviewDecision);
    const res = await requestApproval({
      ctx: mkCtx(),
      hooks: [hookSpy as PermissionRequestHook],
      resolver: { request: resolverSpy } as ApprovalResolver,
    });
    expect(res.decision.kind).toBe("approved");
    expect(res.source).toBe("hook");
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  test("hook passes (undefined) → resolver runs", async () => {
    const hookSpy = vi.fn().mockResolvedValue(undefined);
    const resolverSpy = vi
      .fn()
      .mockResolvedValue({ kind: "approved" } as ReviewDecision);
    const res = await requestApproval({
      ctx: mkCtx(),
      hooks: [hookSpy as PermissionRequestHook],
      resolver: { request: resolverSpy } as ApprovalResolver,
    });
    expect(res.decision.kind).toBe("approved");
    expect(res.source).toBe("resolver");
    expect(resolverSpy).toHaveBeenCalledOnce();
  });

  test("no hook + no resolver → default_deny (fires onNoResolver)", async () => {
    const noResolver = vi.fn();
    const res = await requestApproval({
      ctx: mkCtx(),
      onNoResolver: noResolver,
    });
    expect(res.decision.kind).toBe("denied");
    expect(res.source).toBe("default_deny");
    expect(noResolver).toHaveBeenCalledOnce();
  });

  test("auto_review routes through guardian before resolver", async () => {
    const guardian = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "denied" as const },
        reason: "guardian denied",
        reviewId: "review-1",
        countedDenial: true,
      })),
    };
    const resolverSpy = vi.fn(async () => ({ kind: "approved" as const }));
    const res = await requestApproval({
      ctx: mkGuardianCtx(),
      guardianApprovalReviewer: guardian,
      resolver: { request: resolverSpy } as ApprovalResolver,
    });
    expect(res.decision.kind).toBe("denied");
    expect(res.source).toBe("guardian");
    expect(res.reason).toBe("guardian denied");
    expect(guardian.reviewApprovalRequest).toHaveBeenCalledOnce();
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  test("auto_review routes actual approval requests even when original turn policy skipped", async () => {
    const guardian = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "approved" as const },
        reviewId: "review-effective-policy",
        countedDenial: false,
      })),
    };
    const resolverSpy = vi.fn(async () => ({ kind: "denied" as const }));
    const res = await requestApproval({
      ctx: mkGuardianCtx("auto_review", "never"),
      guardianApprovalReviewer: guardian,
      resolver: { request: resolverSpy } as ApprovalResolver,
    });
    expect(res.decision.kind).toBe("approved");
    expect(res.source).toBe("guardian");
    expect(guardian.reviewApprovalRequest).toHaveBeenCalledOnce();
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  test("manual approvals_reviewer falls through to resolver", async () => {
    const guardian = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "denied" as const },
        reviewId: "review-1",
        countedDenial: true,
      })),
    };
    const resolverSpy = vi.fn(async () => ({ kind: "approved" as const }));
    const res = await requestApproval({
      ctx: mkGuardianCtx("user"),
      guardianApprovalReviewer: guardian,
      resolver: { request: resolverSpy } as ApprovalResolver,
    });
    expect(res.decision.kind).toBe("approved");
    expect(res.source).toBe("resolver");
    expect(guardian.reviewApprovalRequest).not.toHaveBeenCalled();
    expect(resolverSpy).toHaveBeenCalledOnce();
  });

  test("abort signal preempts a slow resolver", async () => {
    const ctl = new AbortController();
    const resolverSpy = vi.fn(
      async () =>
        await new Promise<ReviewDecision>((resolve) => {
          setTimeout(() => resolve({ kind: "approved" }), 50);
        }),
    );
    setTimeout(() => ctl.abort("user_interrupt"), 10);

    const res = await requestApproval({
      ctx: { ...mkCtx(), signal: ctl.signal },
      resolver: { request: resolverSpy } as ApprovalResolver,
    });

    expect(res.decision.kind).toBe("abort");
    expect(res.source).toBe("aborted");
  });

  test("isApprovalAccepted covers all approve variants", () => {
    expect(isApprovalAccepted({ kind: "approved" })).toBe(true);
    expect(isApprovalAccepted({ kind: "approved_for_session" })).toBe(true);
    expect(
      isApprovalAccepted({
        kind: "approved_execpolicy_amendment",
        proposed_execpolicy_amendment: {},
      }),
    ).toBe(true);
    expect(isApprovalAccepted({ kind: "denied" })).toBe(false);
    expect(isApprovalAccepted({ kind: "abort" })).toBe(false);
    expect(isApprovalAccepted({ kind: "timed_out" })).toBe(false);
    expect(
      isApprovalAccepted({
        kind: "network_policy_amendment",
        amendment: { action: "deny", host: "x" },
      }),
    ).toBe(false);
  });
});

describe("classifyToolApproval — payload-variant routing", () => {
  const strictTool: Tool = {
    name: "variant.tool",
    description: "",
    inputSchema: {},
    execute: async () => ({ content: "ok" }),
    isReadOnly: false,
  };

  test("tool_search payload always skips approval", () => {
    const res = classifyToolApproval(strictTool, {
      approvalPolicy: "untrusted",
      sandboxMode: "read_only",
      payload: { kind: "tool_search", arguments: { query: "foo" } },
    });
    expect(res.kind).toBe("skip");
  });

  test("mcp payload: trusted server → skip", () => {
    const res = classifyToolApproval(strictTool, {
      approvalPolicy: "granular",
      sandboxMode: "read_only",
      payload: { kind: "mcp", server: "good", tool: "x", rawArguments: "{}" },
      mcpServerTrusted: (s) => s === "good",
    });
    expect(res.kind).toBe("skip");
  });

  test("mcp payload: untrusted server falls through to normal policy", () => {
    const res = classifyToolApproval(strictTool, {
      approvalPolicy: "granular",
      sandboxMode: "read_only",
      payload: { kind: "mcp", server: "untrusted", tool: "x", rawArguments: "{}" },
      mcpServerTrusted: () => false,
    });
    // granular + write tool → needs approval.
    expect(res.kind).toBe("needs_approval");
  });

  test("local_shell payload: restricted sandbox + on_request → needs approval", () => {
    const res = classifyToolApproval(strictTool, {
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
      payload: {
        kind: "local_shell",
        params: { command: ["ls"] },
      },
    });
    expect(res.kind).toBe("needs_approval");
  });

  test("local_shell payload: danger_full_access + never → skip with bypass", () => {
    const res = classifyToolApproval(strictTool, {
      approvalPolicy: "never",
      sandboxMode: "danger_full_access",
      payload: {
        kind: "local_shell",
        params: { command: ["ls"] },
      },
    });
    expect(res.kind).toBe("skip");
    if (res.kind === "skip") {
      expect(res.bypassSandbox).toBe(true);
    }
  });

  test("custom payload shares the function-branch logic", () => {
    const res = classifyToolApproval(strictTool, {
      approvalPolicy: "granular",
      sandboxMode: "workspace_write",
      payload: { kind: "custom", input: "x" },
    });
    // granular + mutation tool → needs approval (function-branch).
    expect(res.kind).toBe("needs_approval");
  });
});

describe("requestApproval — permissionDecisionHooks wiring", () => {
  const mkCtx = (): ApprovalCtx => ({
    invocation: {} as ApprovalCtx["invocation"],
    callId: "c-1",
    toolName: "test.tool",
    turnId: "t-1",
  });

  test("allow hook bypasses resolver", async () => {
    let resolverCalled = 0;
    const res = await requestApproval({
      ctx: mkCtx(),
      permissionDecisionHooks: [() => ({ kind: "allow" })],
      resolver: {
        request: async () => {
          resolverCalled += 1;
          return { kind: "denied" };
        },
      },
    });
    expect(res.decision.kind).toBe("approved");
    expect(res.source).toBe("permission_hook");
    expect(resolverCalled).toBe(0);
  });

  test("deny hook bypasses resolver", async () => {
    const res = await requestApproval({
      ctx: mkCtx(),
      permissionDecisionHooks: [() => ({ kind: "deny", reason: "blocked" })],
      resolver: { request: async () => ({ kind: "approved" }) },
    });
    expect(res.decision.kind).toBe("denied");
    expect(res.source).toBe("permission_hook");
    expect(res.reason).toBe("blocked");
  });

  test("configured permission hook receives live apply_patch matcher aliases", async () => {
    const runtime = new ConfiguredHooksRuntime({
      cwd: process.cwd(),
      env: process.env,
      agencHome: "/tmp/agenc-test",
      shellPath: process.env.SHELL ?? "/bin/sh",
    });
    const target = {
      preToolUseHooks: [],
      postToolUseHooks: [],
      failureToolUseHooks: [],
      permissionDecisionHooks: [],
      userPromptSubmitHooks: [],
      stopHooks: [],
      stopFailureHooks: [],
    };
    runtime.attachTarget(target);
    runtime.load({
      PermissionRequest: [
        {
          matcher: "Edit",
          hooks: [
            {
              type: "command",
              command:
                "node -e \"console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'deny',message:'alias reached'}}}))\"",
            },
          ],
        },
      ],
    });

    const res = await requestApproval({
      ctx: {
        invocation: {
          session: {},
          turn: {},
          tracker: {
            appendFileDiff: () => {},
            snapshot: () => [],
            clear: () => {},
          },
          callId: "c-apply",
          toolName: { name: "apply_patch" },
          payload: { kind: "function", arguments: "{}" },
          source: "direct",
        } as ApprovalCtx["invocation"],
        callId: "c-apply",
        toolName: "apply_patch",
        turnId: "turn-1",
      },
      permissionDecisionHooks: target.permissionDecisionHooks,
      resolver: { request: async () => ({ kind: "approved" }) },
    });

    expect(res.decision.kind).toBe("denied");
    expect(res.source).toBe("permission_hook");
    expect(res.reason).toBe("alias reached");
  });

  test("ask hook falls through to resolver", async () => {
    let resolverCalled = 0;
    const res = await requestApproval({
      ctx: mkCtx(),
      permissionDecisionHooks: [() => ({ kind: "ask" })],
      resolver: {
        request: async () => {
          resolverCalled += 1;
          return { kind: "approved" };
        },
      },
    });
    expect(res.decision.kind).toBe("approved");
    expect(res.source).toBe("resolver");
    expect(resolverCalled).toBe(1);
  });

  test("no resolver + no decision hook → default_deny", async () => {
    const res = await requestApproval({
      ctx: mkCtx(),
      permissionDecisionHooks: [() => ({ kind: "pass" })],
    });
    expect(res.source).toBe("default_deny");
    expect(res.decision.kind).toBe("denied");
  });
});

describe("orchestrateToolCall lifecycle (orchestrator behavior)", () => {
  const mkTool = (over: Partial<Tool> = {}): Tool => ({
    name: "test.cmd",
    description: "",
    inputSchema: {},
    execute: async () => ({ content: "ok" }),
    ...over,
  });

  const mkCtx = (): ApprovalCtx => ({
    invocation: {} as ApprovalCtx["invocation"],
    callId: "c-1",
    toolName: "test.cmd",
    turnId: "t-1",
  });

  const mkGuardianCtx = (
    approvalPolicy: "never" | "on_failure" | "on_request" | "granular" | "untrusted" = "on_request",
  ): ApprovalCtx => ({
    invocation: {
      session: {} as ApprovalCtx["invocation"]["session"],
      turn: {
        subId: "t-1",
        approvalPolicy: { value: approvalPolicy },
        config: { approvalsReviewer: "auto_review" },
      } as ApprovalCtx["invocation"]["turn"],
      tracker: {
        appendFileDiff: () => {},
        snapshot: () => [],
        clear: () => {},
      },
      callId: "c-1",
      toolName: { name: "test.cmd" },
      payload: { kind: "function", arguments: "{}" },
      source: "direct",
    },
    callId: "c-1",
    toolName: "test.cmd",
    turnId: "t-1",
  });

  test("sandbox escalation: first attempt sandbox-denied → approval → second attempt succeeds with sandbox=off (under on_failure which wants escalation)", async () => {
    // AgenC behavior (sandboxing.rs:290-298): `AskForApproval::OnFailure`
    // has `wants_no_sandbox_approval == true`. Under `never` /
    // `on_request`, the orchestrator bails with the original denial
    // (covered in separate tests below). This test exercises the
    // approval → retry-with-sandbox-off pathway via the policy that
    // opts into it.
    const calls: string[] = [];
    const resolver: ApprovalResolver = {
      request: async () => ({ kind: "approved" }),
    };
    const result = await orchestrateToolCall<string>({
      tool: mkTool(),
      approvalCtx: mkCtx(),
      approvalPolicy: "on_failure",
      sandboxMode: "workspace_write",
      dispatch: async (sandbox) => {
        calls.push(sandbox);
        if (calls.length === 1) {
          throw new SandboxDeniedError("fs blocked", {
            denial: "filesystem",
            target: "/tmp/block",
            policy: { kind: "workspace_write", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
          });
        }
        return "ok";
      },
      approvalResolver: resolver,
    });
    expect(result).toBe("ok");
    expect(calls).toEqual(["workspace_write", "danger_full_access"]);
  });

  test("sandbox escalation under on_failure routes auto_review through guardian", async () => {
    const calls: string[] = [];
    const guardian = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "approved" as const },
        reviewId: "review-sandbox-escalation",
        countedDenial: false,
      })),
    };
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "denied" })),
    };
    const result = await orchestrateToolCall<string>({
      tool: mkTool(),
      approvalCtx: mkGuardianCtx("on_failure"),
      approvalPolicy: "on_failure",
      sandboxMode: "workspace_write",
      dispatch: async (sandbox) => {
        calls.push(sandbox);
        if (calls.length === 1) {
          throw new SandboxDeniedError("fs blocked", {
            denial: "filesystem",
            target: "/tmp/block",
            policy: { kind: "workspace_write", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
          });
        }
        return "ok";
      },
      guardianApprovalReviewer: guardian,
      approvalResolver: resolver,
    });

    expect(result).toBe("ok");
    expect(calls).toEqual(["workspace_write", "danger_full_access"]);
    expect(guardian.reviewApprovalRequest).toHaveBeenCalledOnce();
    expect(resolver.request).not.toHaveBeenCalled();
  });

  test("sandbox escalation: approval denied → ApprovalRejectedError (under on_failure policy)", async () => {
    const resolver: ApprovalResolver = {
      request: async () => ({ kind: "denied" }),
    };
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool({ requiresApproval: true } as Partial<Tool>),
        approvalCtx: mkCtx(),
        approvalPolicy: "on_failure",
        sandboxMode: "workspace_write",
        dispatch: async () => {
          throw new SandboxDeniedError("fs blocked", {
            denial: "filesystem",
            target: "/tmp/block",
            policy: { kind: "workspace_write", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
          });
        },
        approvalResolver: resolver,
      }),
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
  });

  test("needs_approval path: approve → tool runs", async () => {
    const resolver: ApprovalResolver = {
      request: async () => ({ kind: "approved" }),
    };
    let ran = 0;
    const result = await orchestrateToolCall<string>({
      tool: mkTool(),
      approvalCtx: mkCtx(),
      approvalPolicy: "untrusted", // always needs approval
      sandboxMode: "workspace_write",
      dispatch: async () => {
        ran += 1;
        return "ok";
      },
      approvalResolver: resolver,
    });
    expect(result).toBe("ok");
    expect(ran).toBe(1);
  });

  test("sandbox_permissions=require_escalated: approval drives first attempt with sandbox off", async () => {
    const dispatches: string[] = [];
    const result = await orchestrateToolCall<string>({
      tool: mkTool(),
      approvalCtx: mkCtx(),
      approvalPolicy: "untrusted",
      sandboxMode: "workspace_write",
      approvalArgs: {
        sandbox_permissions: "require_escalated",
        justification: "needs full workspace access",
      },
      dispatch: async (sandbox) => {
        dispatches.push(sandbox);
        return "ok";
      },
      approvalResolver: {
        request: async () => ({ kind: "approved" }),
      },
    });

    expect(result).toBe("ok");
    expect(dispatches).toEqual(["danger_full_access"]);
  });

  test("sandbox_permissions=require_escalated: denied approval blocks dispatch", async () => {
    const dispatched = vi.fn(async () => "ok");
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "untrusted",
        sandboxMode: "workspace_write",
        approvalArgs: { sandbox_permissions: "require_escalated" },
        dispatch: dispatched,
        approvalResolver: {
          request: async () => ({ kind: "denied" }),
        },
      }),
    ).rejects.toBeInstanceOf(ApprovalRejectedError);

    expect(dispatched).not.toHaveBeenCalled();
  });

  test("sandbox_permissions=require_escalated: skip policies still require approval", async () => {
    const dispatched = vi.fn(async () => "ok");
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "on_failure",
        sandboxMode: "workspace_write",
        approvalArgs: { sandbox_permissions: "require_escalated" },
        dispatch: dispatched,
      }),
    ).rejects.toBeInstanceOf(ApprovalRejectedError);

    expect(dispatched).not.toHaveBeenCalled();
  });

  test("sandbox_permissions=require_escalated: approvalPolicy=never denies before sandbox bypass", async () => {
    const dispatched = vi.fn(async () => "ok");
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        approvalArgs: { sandbox_permissions: "require_escalated" },
        dispatch: dispatched,
      }),
    ).rejects.toMatchObject({
      message:
        "sandbox escalation requires approval, but approval policy is never",
    });

    expect(dispatched).not.toHaveBeenCalled();
  });

  test("sandbox_permissions=with_additional_permissions stays sandboxed after approval", async () => {
    const dispatches: string[] = [];
    const resolver = vi.fn(async (ctx: ApprovalCtx) => {
      expect(ctx.additionalPermissions).toEqual({
        network: { enabled: true },
      });
      expect(ctx.availableDecisions?.map((decision) => decision.kind)).toEqual([
        "approved",
        "abort",
      ]);
      return { kind: "approved" as const };
    });
    const result = await orchestrateToolCall<string>({
      tool: mkTool(),
      approvalCtx: mkCtx(),
      approvalPolicy: "untrusted",
      sandboxMode: "workspace_write",
      approvalArgs: {
        sandbox_permissions: "with_additional_permissions",
        additional_permissions: { network: { enabled: true } },
      },
      dispatch: async (sandbox, context) => {
        dispatches.push(sandbox);
        expect(context.additionalPermissions).toMatchObject({
          network: { enabled: true },
        });
        return "ok";
      },
      approvalResolver: {
        request: resolver,
      },
    });

    expect(result).toBe("ok");
    expect(dispatches).toEqual(["workspace_write"]);
    expect(resolver).toHaveBeenCalledOnce();
  });

  test("sandbox_permissions=with_additional_permissions: skipped tools do not receive free grants", async () => {
    const dispatched = vi.fn(async () => "ok");
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "on_failure",
        sandboxMode: "workspace_write",
        approvalArgs: {
          sandbox_permissions: "with_additional_permissions",
          additional_permissions: {
            network: { enabled: true },
            file_system: { write: ["/tmp/agenc-extra"] },
          },
        },
        dispatch: dispatched,
      }),
    ).rejects.toBeInstanceOf(ApprovalRejectedError);

    expect(dispatched).not.toHaveBeenCalled();
  });

  test("sandbox_permissions=with_additional_permissions: denied approval blocks dispatch", async () => {
    const dispatched = vi.fn(async () => "ok");
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "untrusted",
        sandboxMode: "workspace_write",
        approvalArgs: {
          sandbox_permissions: "with_additional_permissions",
          additional_permissions: { network: { enabled: true } },
        },
        dispatch: dispatched,
        approvalResolver: {
          request: async () => ({ kind: "denied" }),
        },
      }),
    ).rejects.toBeInstanceOf(ApprovalRejectedError);

    expect(dispatched).not.toHaveBeenCalled();
  });

  test("exec-policy prefix allow drives unsandboxed local-shell dispatch without resolver", async () => {
    const policy = Policy.empty();
    policy.addPrefixRule(["git", "status"], "allow");
    const dispatches: string[] = [];
    const result = await orchestrateToolCall<string>({
      tool: mkTool(),
      approvalCtx: mkCtx(),
      approvalPolicy: "on_request",
      sandboxMode: "workspace_write",
      execPolicy: policy,
      payload: {
        kind: "local_shell",
        params: { command: ["git", "status"] },
      },
      dispatch: async (sandbox) => {
        dispatches.push(sandbox);
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(dispatches).toEqual(["danger_full_access"]);
  });

  test("exec-policy prompt is rejected when granular rule approvals are disabled", async () => {
    const policy = Policy.empty();
    policy.addPrefixRule(["git"], "prompt");
    const dispatched = vi.fn(async () => "ok");
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "approved" })),
    };
    const granular: GranularApprovalConfig = {
      sandbox_approval: true,
      rules: false,
      skill_approval: true,
      request_permissions: true,
      mcp_elicitations: true,
    };

    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "granular",
        sandboxMode: "workspace_write",
        granular,
        execPolicy: policy,
        payload: {
          kind: "local_shell",
          params: { command: ["git", "status"] },
        },
        dispatch: dispatched,
        approvalResolver: resolver,
      }),
    ).rejects.toMatchObject({
      message: REJECT_RULES_APPROVAL_REASON,
    });

    expect(dispatched).not.toHaveBeenCalled();
    expect(resolver.request).not.toHaveBeenCalled();
  });

  test("needs_approval path records sanitized policy audit", async () => {
    const auditLogger = vi.fn(async () => {});
    const result = await orchestrateToolCall<string>({
      tool: mkTool(),
      approvalCtx: {
        invocation: {
          session: { conversationId: "session_1" },
        } as ApprovalCtx["invocation"],
        callId: "call_audit",
        toolName: "Write",
        turnId: "turn_audit",
      },
      approvalPolicy: "untrusted",
      sandboxMode: "workspace_write",
      approvalArgs: {
        command: "echo api_key=abcdefghijklmnopqrstuvwxyz123456",
      },
      dispatch: async () => "ok",
      approvalResolver: {
        request: async () => ({ kind: "approved" }),
      },
      permissionAuditLogger: auditLogger,
    });

    expect(result).toBe("ok");
    expect(auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "policy_outcome",
        decision: "approved",
        source: "approval-resolver",
        subjectType: "tool_execution",
        toolName: "Write",
        callId: "call_audit",
        sessionId: "session_1",
        reasonCode: "approved_resolver",
      }),
    );
    expect(JSON.stringify(auditLogger.mock.calls)).not.toContain(
      "abcdefghijklmnopqrstuvwxyz123456",
    );
  });

  test("per-tool default_permission_mode=never skips session approval prompts", async () => {
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "denied" })),
    };
    const dispatched = vi.fn(async () => "ok");
    const auditLogger = vi.fn(async () => {});
    const result = await orchestrateToolCall<string>({
      tool: mkTool({ defaultPermissionMode: "never" }),
      approvalCtx: mkCtx(),
      approvalPolicy: "untrusted",
      sandboxMode: "workspace_write",
      dispatch: dispatched,
      approvalResolver: resolver,
      permissionAuditLogger: auditLogger,
    });

    expect(result).toBe("ok");
    expect(dispatched).toHaveBeenCalledOnce();
    expect(resolver.request).not.toHaveBeenCalled();
    expect(auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "policy_outcome",
        decision: "approved",
        source: "approval-classifier",
        subjectType: "tool_execution",
        toolName: "test.cmd",
        callId: "c-1",
        reasonCode: "default_permission_never_skipped",
      }),
    );
  });

  test("per-tool default_permission_mode=untrusted prompts even when session skips", async () => {
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "approved" })),
    };
    const dispatched = vi.fn(async () => "ok");
    const result = await orchestrateToolCall<string>({
      tool: mkTool({ defaultPermissionMode: "untrusted" }),
      approvalCtx: mkCtx(),
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
      dispatch: dispatched,
      approvalResolver: resolver,
    });

    expect(result).toBe("ok");
    expect(dispatched).toHaveBeenCalledOnce();
    expect(resolver.request).toHaveBeenCalledOnce();
  });

  test("per-tool default_permission_mode=untrusted routes auto_review through guardian when session skips", async () => {
    const guardian = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "approved" as const },
        reviewId: "review-default-mode",
        countedDenial: false,
      })),
    };
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "denied" })),
    };
    const dispatched = vi.fn(async () => "ok");
    const result = await orchestrateToolCall<string>({
      tool: mkTool({ defaultPermissionMode: "untrusted" }),
      approvalCtx: mkGuardianCtx("never"),
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
      dispatch: dispatched,
      guardianApprovalReviewer: guardian,
      approvalResolver: resolver,
    });

    expect(result).toBe("ok");
    expect(dispatched).toHaveBeenCalledOnce();
    expect(guardian.reviewApprovalRequest).toHaveBeenCalledOnce();
    expect(resolver.request).not.toHaveBeenCalled();
  });

  test("needs_approval path: guardian denial blocks dispatch with guardian rationale", async () => {
    const dispatched = vi.fn(async () => "ok");
    const guardian = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: { kind: "denied" as const },
        reason: "guardian blocked unsafe write",
        reviewId: "review-1",
        countedDenial: true,
      })),
    };
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool({ requiresApproval: true }),
        approvalCtx: mkGuardianCtx(),
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        dispatch: dispatched,
        guardianApprovalReviewer: guardian,
      }),
    ).rejects.toMatchObject({
      decision: { kind: "denied" },
      message: "guardian blocked unsafe write",
      name: "ApprovalRejectedError",
    });
    expect(dispatched).not.toHaveBeenCalled();
    expect(guardian.reviewApprovalRequest).toHaveBeenCalledOnce();
  });

  test("needs_approval path: no resolver + no hook → default-deny (ApprovalRejectedError)", async () => {
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "untrusted",
        sandboxMode: "workspace_write",
        dispatch: async () => "ok",
      }),
    ).rejects.toMatchObject({
      decision: { kind: "denied" },
      name: "ApprovalRejectedError",
    });
  });

  test("needs_approval path: abort during approval rejects without dispatching", async () => {
    const ctl = new AbortController();
    const dispatched = vi.fn(async () => "ok");
    const resolver: ApprovalResolver = {
      request: async () =>
        await new Promise<ReviewDecision>((resolve) => {
          setTimeout(() => resolve({ kind: "approved" }), 50);
        }),
    };
    setTimeout(() => ctl.abort("ctrl_c"), 10);

    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: { ...mkCtx(), signal: ctl.signal },
        signal: ctl.signal,
        approvalPolicy: "untrusted",
        sandboxMode: "workspace_write",
        dispatch: dispatched,
        approvalResolver: resolver,
      }),
    ).rejects.toMatchObject({
      decision: { kind: "abort" },
      message: "approval aborted",
      name: "ApprovalRejectedError",
    });
    expect(dispatched).not.toHaveBeenCalled();
  });

  test("forbidden classification → ApprovalRejectedError, no dispatch", async () => {
    const dispatched = vi.fn();
    const auditLogger = vi.fn(async () => {});
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        dispatch: dispatched,
        toolDenylist: new Set(["test.cmd"]),
        permissionAuditLogger: auditLogger,
      }),
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(dispatched).not.toHaveBeenCalled();
    expect(auditLogger).toHaveBeenCalledWith(
      expect.objectContaining({
        eventKind: "policy_outcome",
        decision: "denied",
        source: "approval-classifier",
        subjectType: "tool_execution",
        toolName: "test.cmd",
        callId: "c-1",
        reasonCode: "tool_denylisted",
      }),
    );
  });

  test("sandbox-denied under on_request policy: bails with original error, no approval (orchestrator behavior + sandboxing.rs:290-298)", async () => {
    // AgenC behavior: `AskForApproval::OnRequest` has
    // `wants_no_sandbox_approval == false` (without network-approval
    // context). A SandboxDeniedError must propagate unchanged — the
    // orchestrator must not prompt for approval to retry unsandboxed.
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "approved" })),
    };
    const dispatches: string[] = [];
    const denial = new SandboxDeniedError("fs blocked", {
      denial: "filesystem",
      target: "/tmp/block",
      policy: { kind: "workspace_write", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
    });
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool({ isReadOnly: true }),
        approvalCtx: mkCtx(),
        approvalPolicy: "on_request",
        sandboxMode: "workspace_write",
        dispatch: async (sandbox) => {
          dispatches.push(sandbox);
          throw denial;
        },
        approvalResolver: resolver,
      }),
    ).rejects.toBe(denial);
    // First attempt ran; no retry, no approval prompt.
    expect(dispatches).toEqual(["workspace_write"]);
    expect(resolver.request).not.toHaveBeenCalled();
  });

  test("sandbox-denied under never policy: bails with original error, no approval", async () => {
    // `AskForApproval::Never` → `wants_no_sandbox_approval == false`.
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "approved" })),
    };
    const denial = new SandboxDeniedError("fs blocked", {
      denial: "filesystem",
      target: "/tmp/block",
      policy: { kind: "read_only", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
    });
    await expect(
      orchestrateToolCall<string>({
        // `isReadOnly: true` avoids the classifier upgrading this to
        // `needs_approval` before dispatch.
        tool: mkTool({ isReadOnly: true }),
        approvalCtx: mkCtx(),
        approvalPolicy: "never",
        sandboxMode: "read_only",
        dispatch: async () => {
          throw denial;
        },
        approvalResolver: resolver,
      }),
    ).rejects.toBe(denial);
    expect(resolver.request).not.toHaveBeenCalled();
  });

  test("sandbox-denied under untrusted policy: escalates via approval then retries sandbox=off (wants_no_sandbox_approval=true)", async () => {
    // `AskForApproval::UnlessTrusted` → wants_no_sandbox_approval = true.
    const dispatches: string[] = [];
    const resolver: ApprovalResolver = {
      request: async () => ({ kind: "approved" }),
    };
    const result = await orchestrateToolCall<string>({
      tool: mkTool(),
      approvalCtx: mkCtx(),
      approvalPolicy: "untrusted",
      sandboxMode: "workspace_write",
      dispatch: async (sandbox) => {
        dispatches.push(sandbox);
        if (dispatches.length === 1) {
          throw new SandboxDeniedError("fs blocked", {
            denial: "filesystem",
            target: "/tmp/block",
            policy: { kind: "workspace_write", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
          });
        }
        return "ok";
      },
      approvalResolver: resolver,
    });
    expect(result).toBe("ok");
    // Under `untrusted`, the initial approval-classification path
    // prompts; that approval also satisfies the post-denial retry, so
    // the escalation dispatches sandbox=off once without re-prompting.
    expect(dispatches).toEqual(["workspace_write", "danger_full_access"]);
  });

  test("escalateOnFailure=false: SandboxDeniedError bails without approval (sandboxing behavior)", async () => {
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "approved" })),
    };
    const denial = new SandboxDeniedError("fs blocked", {
      denial: "filesystem",
      target: "/tmp/block",
      policy: { kind: "workspace_write", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
    });
    // Using a tool that escalateOnFailure=false and untrusted policy
    // — the opt-out must win over wants_no_sandbox_approval=true.
    const tool = mkTool({
      // @ts-expect-error — structural extension on Tool.
      escalateOnFailure: false,
    });
    await expect(
      orchestrateToolCall<string>({
        tool,
        approvalCtx: mkCtx(),
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        dispatch: async () => {
          throw denial;
        },
        approvalResolver: resolver,
      }),
    ).rejects.toBe(denial);
    expect(resolver.request).not.toHaveBeenCalled();
  });

  test("granular policy with sandbox_approval=true: escalates via approval (sandboxing behavior)", async () => {
    const dispatches: string[] = [];
    const resolver: ApprovalResolver = {
      request: async () => ({ kind: "approved" }),
    };
    const granular: GranularApprovalConfig = {
      sandbox_approval: true,
      rules: true,
      skill_approval: true,
      request_permissions: true,
      mcp_elicitations: true,
    };
    const result = await orchestrateToolCall<string>({
      tool: mkTool({ isReadOnly: true }),
      approvalCtx: mkCtx(),
      approvalPolicy: "granular",
      sandboxMode: "read_only",
      granular,
      dispatch: async (sandbox) => {
        dispatches.push(sandbox);
        if (dispatches.length === 1) {
          throw new SandboxDeniedError("fs blocked", {
            denial: "filesystem",
            target: "/tmp/block",
            policy: { kind: "read_only", writable_roots: [], read_only_access: { kind: "full_access" }, network_access: { mode: "disabled" }, exclude_tmpdir_env_var: false, exclude_slash_tmp: false },
          });
        }
        return "ok";
      },
      approvalResolver: resolver,
    });
    expect(result).toBe("ok");
    expect(dispatches).toEqual(["read_only", "danger_full_access"]);
  });

  test("granular policy with sandbox_approval=false: restricted fs forbids, never prompts (sandboxing behavior)", async () => {
    const granular: GranularApprovalConfig = {
      sandbox_approval: false,
      rules: true,
      skill_approval: true,
      request_permissions: true,
      mcp_elicitations: true,
    };
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "approved" })),
    };
    // A local_shell payload under restricted fs + granular-no-sandbox
    // must be classified as `forbidden` and throw ApprovalRejectedError
    // without ever dispatching or prompting.
    const dispatched = vi.fn();
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "granular",
        sandboxMode: "workspace_write",
        granular,
        payload: { kind: "local_shell", params: { command: ["ls"] } },
        dispatch: dispatched,
        approvalResolver: resolver,
      }),
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(dispatched).not.toHaveBeenCalled();
    expect(resolver.request).not.toHaveBeenCalled();
  });

  test("double-classification removed: read-only skip is final under granular+restricted (orchestrator behavior)", async () => {
    // Regression for problem 6 (T6 audit). Previously: when the tool
    // classifier returned `skip` without sandbox bypass, the
    // orchestrator would re-run `defaultExecApprovalRequirement` and
    // upgrade to `needs_approval`. That behavior is removed — the
    // tool classifier's `skip` is now final.
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "approved" })),
    };
    const ran = vi.fn(async () => "ok");
    const result = await orchestrateToolCall<string>({
      tool: mkTool({ isReadOnly: true }),
      approvalCtx: mkCtx(),
      approvalPolicy: "granular",
      sandboxMode: "read_only", // fs_kind = restricted
      dispatch: ran,
      approvalResolver: resolver,
    });
    expect(result).toBe("ok");
    // Read-only skip is final — no resolver prompt.
    expect(resolver.request).not.toHaveBeenCalled();
    expect(ran).toHaveBeenCalledOnce();
  });

  test("array-shaped permission mode does not spoof bypassPermissions", async () => {
    const resolver: ApprovalResolver = {
      request: vi.fn(async () => ({ kind: "approved" })),
    };
    const ran = vi.fn(async () => "ok");
    const spoofedMode = Object.assign(["spoof"], {
      mode: "bypassPermissions",
    });

    const result = await orchestrateToolCall<string>({
      tool: mkTool({ isReadOnly: false }),
      approvalCtx: {
        ...mkCtx(),
        invocation: {
          session: {
            permissionModeRegistry: {
              current: () => spoofedMode,
            },
          },
        } as never,
      },
      approvalPolicy: "granular",
      sandboxMode: "read_only",
      dispatch: ran,
      approvalResolver: resolver,
    });

    expect(result).toBe("ok");
    expect(resolver.request).toHaveBeenCalledOnce();
    expect(ran).toHaveBeenCalledOnce();
  });
});

describe("escalateOnFailure + wantsNoSandboxApproval helpers", () => {
  const bareTool: Tool = {
    name: "x",
    description: "",
    inputSchema: {},
    execute: async () => ({ content: "ok" }),
  };

  test("escalateOnFailure: default true (sandboxing behavior)", () => {
    expect(escalateOnFailure(bareTool)).toBe(true);
  });

  test("escalateOnFailure: boolean override honored", () => {
    const optOut: Tool = {
      ...bareTool,
      // @ts-expect-error — structural extension on Tool.
      escalateOnFailure: false,
    };
    expect(escalateOnFailure(optOut)).toBe(false);
  });

  test("escalateOnFailure: function override honored", () => {
    const optOut: Tool = {
      ...bareTool,
      // @ts-expect-error — structural extension on Tool.
      escalateOnFailure: () => false,
    };
    expect(escalateOnFailure(optOut)).toBe(false);
  });

  test("wantsNoSandboxApproval defaults per policy (sandboxing behavior)", () => {
    expect(wantsNoSandboxApproval(bareTool, "never")).toBe(false);
    expect(wantsNoSandboxApproval(bareTool, "on_request")).toBe(false);
    expect(wantsNoSandboxApproval(bareTool, "on_failure")).toBe(true);
    expect(wantsNoSandboxApproval(bareTool, "untrusted")).toBe(true);
    expect(wantsNoSandboxApproval(bareTool, "granular")).toBe(false);
    const g: GranularApprovalConfig = {
      sandbox_approval: true,
      rules: true,
      skill_approval: true,
      request_permissions: true,
      mcp_elicitations: true,
    };
    expect(wantsNoSandboxApproval(bareTool, "granular", g)).toBe(true);
  });

  test("wantsNoSandboxApproval tool override honored", () => {
    const forced: Tool = {
      ...bareTool,
      // @ts-expect-error — structural extension on Tool.
      wantsNoSandboxApproval: true,
    };
    expect(wantsNoSandboxApproval(forced, "never")).toBe(true);
  });
});
