import { describe, expect, test, vi } from "vitest";

import { ApprovalStore } from "../approval-cache.js";
import { APPROVED, APPROVED_FOR_SESSION } from "../review-decision.js";
import { createEmptyToolPermissionContext } from "../types.js";
import type { ToolInvocation } from "../../tools/context.js";
import type { Tool } from "../../tools/types.js";
import {
  arbitratePermissionMode,
  requestApproval,
  requestToolUserApproval,
  type ApprovalCtx,
} from "./arbiter.js";
import type { GuardianApprovalReviewer } from "./reviewer.js";

function invocation(opts: {
  readonly services?: Record<string, unknown>;
  readonly approvalPolicy?: string;
  readonly approvalsReviewer?: string;
  readonly activeTurn?: {
    unsafePeek?: () => { readonly turnId?: unknown } | null | undefined;
  };
} = {}): ToolInvocation {
  return {
    session: {
      services: opts.services ?? {},
      ...(opts.activeTurn !== undefined ? { activeTurn: opts.activeTurn } : {}),
    } as never,
    turn: {
      subId: "turn-1",
      cwd: "/repo",
      approvalPolicy: { value: opts.approvalPolicy ?? "on_request" },
      sandboxPolicy: { value: "workspace_write" },
      config: {
        approvalsReviewer: opts.approvalsReviewer ?? "auto_review",
      },
    } as never,
    tracker: {
      appendFileDiff() {},
      snapshot: () => [],
      clear() {},
    },
    callId: "call-1",
    toolName: { name: "exec_command" },
    payload: { kind: "function", arguments: "{}" },
    source: "direct",
  };
}

function approvalCtx(inv = invocation()): ApprovalCtx {
  return {
    invocation: inv,
    callId: inv.callId,
    toolName: inv.toolName.name,
    turnId: "turn-1",
  };
}

describe("guardian arbiter", () => {
  test("raw approval hook wins before resolver", async () => {
    const resolver = vi.fn(async () => APPROVED);
    const result = await requestApproval({
      ctx: approvalCtx(),
      hooks: [async () => ({ kind: "denied" })],
      resolver: { request: resolver },
    });

    expect(result.source).toBe("hook");
    expect(result.decision.kind).toBe("denied");
    expect(resolver).not.toHaveBeenCalled();
  });

  test("routes configured approval requests through guardian before resolver", async () => {
    const resolver = vi.fn(async () => ({ kind: "denied" as const }));
    const reviewer: GuardianApprovalReviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: APPROVED,
        reviewId: "review-1",
        countedDenial: false,
      })),
    };

    const result = await requestApproval({
      ctx: approvalCtx(),
      guardianApprovalReviewer: reviewer,
      resolver: { request: resolver },
    });

    expect(result.source).toBe("guardian");
    expect(result.decision).toBe(APPROVED);
    expect(resolver).not.toHaveBeenCalled();
  });

  test("untrusted approval requests route through configured guardian review", async () => {
    const reviewer: GuardianApprovalReviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: APPROVED,
        reviewId: "review-1",
        countedDenial: false,
      })),
    };

    const result = await requestApproval({
      ctx: approvalCtx(invocation({ approvalPolicy: "untrusted" })),
      guardianApprovalReviewer: reviewer,
    });

    expect(result.source).toBe("guardian");
    expect(reviewer.reviewApprovalRequest).toHaveBeenCalledOnce();
  });

  test("guardian decisions are one-shot and never populate the session cache", async () => {
    const store = new ApprovalStore<unknown>();
    const inv = invocation({ services: { toolApprovals: store } });
    const reviewer: GuardianApprovalReviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: APPROVED_FOR_SESSION,
        reviewId: "review-1",
        countedDenial: false,
      })),
    };

    const first = await requestApproval({
      ctx: approvalCtx(inv),
      args: { command: "pwd" },
      guardianApprovalReviewer: reviewer,
    });
    const second = await requestApproval({
      ctx: approvalCtx(inv),
      args: { command: "pwd" },
      guardianApprovalReviewer: reviewer,
    });

    expect(first.source).toBe("guardian");
    expect(second.source).toBe("guardian");
    expect(first.decision).toEqual({ kind: "denied" });
    expect(second.decision).toEqual({ kind: "denied" });
    expect(first.reason).toContain("only the current call");
    expect(reviewer.reviewApprovalRequest).toHaveBeenCalledTimes(2);
  });

  test.each([
    {
      kind: "approved_execpolicy_amendment" as const,
      proposed_execpolicy_amendment: { command: "*" },
    },
    {
      kind: "network_policy_amendment" as const,
      amendment: { action: "allow" as const, host: "example.test" },
    },
  ])("guardian cannot persist $kind", async (decision) => {
    const reviewer: GuardianApprovalReviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision,
        reviewId: "review-1",
        countedDenial: false,
      })),
    };

    const result = await requestApproval({
      ctx: approvalCtx(),
      guardianApprovalReviewer: reviewer,
    });

    expect(result.source).toBe("guardian");
    expect(result.decision).toEqual({ kind: "denied" });
    expect(result.reason).toContain("authoritative human decision");
  });

  test("canonical resolver path persists approved_for_session decisions", async () => {
    const store = new ApprovalStore<unknown>();
    const inv = invocation({ services: { toolApprovals: store } });
    const resolver = vi.fn(async () => APPROVED_FOR_SESSION);

    const first = await requestApproval({
      ctx: approvalCtx(inv),
      args: { command: "pwd" },
      resolver: { request: resolver },
    });
    const second = await requestApproval({
      ctx: approvalCtx(inv),
      args: { command: "pwd" },
      resolver: { request: resolver },
    });

    expect(first.decision).toBe(APPROVED_FOR_SESSION);
    expect(second.decision).toEqual(APPROVED_FOR_SESSION);
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  test("approval cache ignores array-shaped session services", async () => {
    const store = new ApprovalStore<unknown>();
    const services = Object.assign(["spoof"], {
      toolApprovals: store,
    });
    const inv = invocation({ services: services as never });
    const resolver = vi.fn(async () => APPROVED_FOR_SESSION);

    const first = await requestApproval({
      ctx: approvalCtx(inv),
      args: { command: "pwd" },
      resolver: { request: resolver },
    });
    const second = await requestApproval({
      ctx: approvalCtx(inv),
      args: { command: "pwd" },
      resolver: { request: resolver },
    });

    expect(first.decision).toBe(APPROVED_FOR_SESSION);
    expect(second.decision).toBe(APPROVED_FOR_SESSION);
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  test("approval cache tolerates non-json tool args", async () => {
    const store = new ApprovalStore<unknown>();
    const inv = {
      ...invocation({ services: { toolApprovals: store } }),
      toolName: { name: "CustomTool" },
    } as ToolInvocation;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const args = {
      bigint: 10n,
      circular,
      fn: () => undefined,
      symbol: Symbol("approval"),
    };
    const resolver = vi.fn(async () => APPROVED_FOR_SESSION);

    const first = await requestApproval({
      ctx: approvalCtx(inv),
      args,
      resolver: { request: resolver },
    });
    const second = await requestApproval({
      ctx: approvalCtx(inv),
      args,
      resolver: { request: resolver },
    });

    expect(first.decision).toBe(APPROVED_FOR_SESSION);
    expect(second.decision).toEqual(APPROVED_FOR_SESSION);
    expect(resolver).toHaveBeenCalledTimes(1);

    const shellStore = new ApprovalStore<unknown>();
    const shellInv = invocation({ services: { toolApprovals: shellStore } });
    const shellResolver = vi.fn(async () => APPROVED_FOR_SESSION);
    const shellArgs = {
      command: "pwd",
      sandbox_permissions: { write: 10n },
      additional_permissions: [Symbol("network"), () => undefined],
    };

    await requestApproval({
      ctx: approvalCtx(shellInv),
      args: shellArgs,
      resolver: { request: shellResolver },
    });
    await requestApproval({
      ctx: approvalCtx(shellInv),
      args: shellArgs,
      resolver: { request: shellResolver },
    });

    expect(shellResolver).toHaveBeenCalledTimes(1);
  });

  test("canonical resolver path rejects stale active-turn decisions", async () => {
    let activeTurn = "turn-1";
    const resolver = vi.fn(async () => {
      activeTurn = "turn-2";
      return APPROVED;
    });

    const result = await requestApproval({
      ctx: approvalCtx(),
      resolver: { request: resolver },
      getActiveTurnId: () => activeTurn,
    });

    expect(result.source).toBe("aborted");
    expect(result.reason).toBe("stale_modal_decision");
    expect(result.decision.kind).toBe("abort");
  });

  test("guardian path rejects stale active-turn decisions", async () => {
    let activeTurn = "turn-1";
    const reviewer: GuardianApprovalReviewer = {
      reviewApprovalRequest: vi.fn(async () => {
        activeTurn = "turn-2";
        return {
          decision: APPROVED,
          reviewId: "review-1",
          countedDenial: false,
        };
      }),
    };

    const result = await requestApproval({
      ctx: approvalCtx(),
      guardianApprovalReviewer: reviewer,
      getActiveTurnId: () => activeTurn,
    });

    expect(result.source).toBe("aborted");
    expect(result.reason).toBe("stale_modal_decision");
    expect(result.decision.kind).toBe("abort");
  });

  test("canonical resolver path rejects decisions after the session turn clears", async () => {
    let activeTurn: string | null = "turn-1";
    const inv = invocation({
      activeTurn: {
        unsafePeek: () =>
          activeTurn === null ? null : { turnId: activeTurn },
      },
    });
    const resolver = vi.fn(async () => {
      activeTurn = null;
      return APPROVED;
    });

    const result = await requestApproval({
      ctx: approvalCtx(inv),
      resolver: { request: resolver },
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(result.source).toBe("aborted");
    expect(result.reason).toBe("stale_modal_decision");
  });

  test("permission-mode arbitration merges hook and rule decisions", async () => {
    const toolPermissionContext = createEmptyToolPermissionContext({
      alwaysAskRules: {
        session: ["exec_command"],
      },
    });
    const permissionContext = {
      getAppState: () => ({
        toolPermissionContext,
      }),
    } as never;

    const result = await arbitratePermissionMode({
      tool: { name: "exec_command" } as Tool,
      args: { command: "pwd" },
      hookPermissionResult: { behavior: "allow", hookName: "PreToolUse:ok" },
      permissionContext,
      includeEvaluator: false,
    });

    expect(result.kind).toBe("ask");
    expect(result.source).toBe("pre-tool-use-hook");
    expect(result.reasonCode).toBe("rule_asked");
    expect(result.mergedDecision?.decisionReason?.type).toBe(
      "hook_plus_rule_ask",
    );
  });

  test("SEC-02: hook allow still applies evaluator deny floors", async () => {
    const canUseTool = vi.fn(async () => ({
      behavior: "deny" as const,
      message: "unattended denylist: exec_command",
      decisionReason: { type: "other" as const, reason: "unattended_denylist" },
    }));
    const permissionContext = {
      getAppState: () => ({
        toolPermissionContext: createEmptyToolPermissionContext(),
      }),
    } as never;

    const result = await arbitratePermissionMode({
      tool: { name: "exec_command" } as Tool,
      args: { command: "rm -rf /" },
      hookPermissionResult: { behavior: "allow", hookName: "PreToolUse:ok" },
      permissionContext,
      canUseTool: canUseTool as never,
      includeEvaluator: true,
    });

    expect(canUseTool).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("deny");
    expect(result.source).toBe("permission-evaluator");
    expect(result.message).toMatch(/unattended denylist/i);
  });

  test("SEC-02: hook allow still surfaces safetyCheck asks", async () => {
    const canUseTool = vi.fn(async () => ({
      behavior: "ask" as const,
      message: "path outside workspace",
      decisionReason: {
        type: "safetyCheck" as const,
        title: "path",
        description: "outside",
      },
    }));
    const permissionContext = {
      getAppState: () => ({
        toolPermissionContext: createEmptyToolPermissionContext(),
      }),
    } as never;

    const result = await arbitratePermissionMode({
      tool: { name: "Write" } as Tool,
      args: { path: "/etc/passwd" },
      hookPermissionResult: { behavior: "allow", hookName: "PreToolUse:ok" },
      permissionContext,
      canUseTool: canUseTool as never,
    });

    expect(result.kind).toBe("ask");
    expect(result.source).toBe("permission-evaluator");
    expect(result.reasonCode).toBe("safety_check");
  });

  test("permission-mode arbitration ignores array-shaped tool permission context", async () => {
    const spoofedToolPermissionContext = Object.assign(["spoof"], {
      alwaysAskRules: {
        session: ["exec_command"],
      },
    });
    const permissionContext = {
      getAppState: () => ({
        toolPermissionContext: spoofedToolPermissionContext,
      }),
    } as never;

    const result = await arbitratePermissionMode({
      tool: { name: "exec_command" } as Tool,
      args: { command: "pwd" },
      hookPermissionResult: { behavior: "allow", hookName: "PreToolUse:ok" },
      permissionContext,
      includeEvaluator: false,
    });

    expect(result.kind).toBe("allow");
    expect(result.reasonCode).toBe("hook_allowed");
  });

  test("user approval prompt uses the session approval cache", async () => {
    const store = new ApprovalStore<unknown>();
    const inv = invocation({ services: { toolApprovals: store } });
    const tool = { name: "exec_command" } as Tool;
    const prompt = vi.fn(async () => ({
      behavior: "allow" as const,
      decisionAtTurnId: "turn-1",
      reviewDecision: APPROVED_FOR_SESSION,
    }));

    const first = await requestToolUserApproval({
      request: prompt,
      tool,
      args: { command: "pwd" },
      invocation: inv,
      currentTurnId: "turn-1",
      signal: new AbortController().signal,
    });
    const second = await requestToolUserApproval({
      request: prompt,
      tool,
      args: { command: "pwd" },
      invocation: inv,
      currentTurnId: "turn-1",
      signal: new AbortController().signal,
    });

    expect(first.allow).toBe(true);
    expect(second.allow).toBe(true);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});
