import { describe, expect, test, vi } from "vitest";
import {
  ApprovalRejectedError,
  SandboxDeniedError,
  attemptWithRetry,
  classifyToolApproval,
  defaultExecApprovalRequirement,
  defaultRetryPolicy,
  defaultToolRetryPolicy,
  isApprovalAccepted,
  orchestrateToolCall,
  requestApproval,
  sandboxKindFromMode,
  type ApprovalCtx,
  type ApprovalResolver,
  type PermissionRequestHook,
  type ReviewDecision,
} from "./orchestrator.js";
import type { Tool } from "./types.js";

const readTool: Tool = {
  name: "system.readFile",
  description: "",
  inputSchema: {},
  execute: async () => ({ content: "ok" }),
  isReadOnly: true,
};

const writeTool: Tool = {
  name: "system.writeFile",
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
      toolDenylist: new Set(["system.readFile"]),
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
// Codex-parity port coverage (T7 orchestrator gap fill)
// ─────────────────────────────────────────────────────────────────────

describe("defaultExecApprovalRequirement (codex sandboxing.rs:185-221)", () => {
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
      permissionDecisionHooks: [() => ({ kind: "deny" })],
      resolver: { request: async () => ({ kind: "approved" }) },
    });
    expect(res.decision.kind).toBe("denied");
    expect(res.source).toBe("permission_hook");
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

describe("orchestrateToolCall lifecycle (codex orchestrator.rs:105-377)", () => {
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

  test("sandbox escalation: first attempt sandbox-denied → approval → second attempt succeeds with sandbox=off", async () => {
    const calls: string[] = [];
    const resolver: ApprovalResolver = {
      request: async () => ({ kind: "approved" }),
    };
    const result = await orchestrateToolCall<string>({
      tool: mkTool(),
      approvalCtx: mkCtx(),
      approvalPolicy: "never",
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

  test("sandbox escalation: approval denied → ApprovalRejectedError", async () => {
    const resolver: ApprovalResolver = {
      request: async () => ({ kind: "denied" }),
    };
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "never",
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

  test("forbidden classification → ApprovalRejectedError, no dispatch", async () => {
    const dispatched = vi.fn();
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        dispatch: dispatched,
        toolDenylist: new Set(["test.cmd"]),
      }),
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
    expect(dispatched).not.toHaveBeenCalled();
  });
});
