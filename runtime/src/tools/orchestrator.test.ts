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
    const err = new SandboxDeniedError("blocked", "stderr");
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
          throw new SandboxDeniedError("sandbox blocked");
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
    const hookSpy = vi.fn().mockResolvedValue("approved" as ReviewDecision);
    const resolverSpy = vi.fn().mockResolvedValue("denied" as ReviewDecision);
    const res = await requestApproval({
      ctx: mkCtx(),
      hooks: [hookSpy as PermissionRequestHook],
      resolver: { request: resolverSpy } as ApprovalResolver,
    });
    expect(res.decision).toBe("approved");
    expect(res.source).toBe("hook");
    expect(resolverSpy).not.toHaveBeenCalled();
  });

  test("hook passes (undefined) → resolver runs", async () => {
    const hookSpy = vi.fn().mockResolvedValue(undefined);
    const resolverSpy = vi.fn().mockResolvedValue("approved" as ReviewDecision);
    const res = await requestApproval({
      ctx: mkCtx(),
      hooks: [hookSpy as PermissionRequestHook],
      resolver: { request: resolverSpy } as ApprovalResolver,
    });
    expect(res.decision).toBe("approved");
    expect(res.source).toBe("resolver");
    expect(resolverSpy).toHaveBeenCalledOnce();
  });

  test("no hook + no resolver → default_deny (fires onNoResolver)", async () => {
    const noResolver = vi.fn();
    const res = await requestApproval({
      ctx: mkCtx(),
      onNoResolver: noResolver,
    });
    expect(res.decision).toBe("denied");
    expect(res.source).toBe("default_deny");
    expect(noResolver).toHaveBeenCalledOnce();
  });

  test("isApprovalAccepted covers all approve variants", () => {
    expect(isApprovalAccepted("approved")).toBe(true);
    expect(isApprovalAccepted("approved_for_session")).toBe(true);
    expect(isApprovalAccepted("approved_exec_policy_amendment")).toBe(true);
    expect(isApprovalAccepted("denied")).toBe(false);
    expect(isApprovalAccepted("abort")).toBe(false);
    expect(isApprovalAccepted("timed_out")).toBe(false);
    expect(isApprovalAccepted("network_policy_amendment")).toBe(false);
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
      request: async () => "approved",
    };
    const result = await orchestrateToolCall<string>({
      tool: mkTool(),
      approvalCtx: mkCtx(),
      approvalPolicy: "never",
      sandboxMode: "workspace_write",
      dispatch: async (sandbox) => {
        calls.push(sandbox);
        if (calls.length === 1) {
          throw new SandboxDeniedError("fs blocked");
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
      request: async () => "denied",
    };
    await expect(
      orchestrateToolCall<string>({
        tool: mkTool(),
        approvalCtx: mkCtx(),
        approvalPolicy: "never",
        sandboxMode: "workspace_write",
        dispatch: async () => {
          throw new SandboxDeniedError("fs blocked");
        },
        approvalResolver: resolver,
      }),
    ).rejects.toBeInstanceOf(ApprovalRejectedError);
  });

  test("needs_approval path: approve → tool runs", async () => {
    const resolver: ApprovalResolver = {
      request: async () => "approved",
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
    ).rejects.toMatchObject({ decision: "denied", name: "ApprovalRejectedError" });
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
