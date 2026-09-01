import { afterEach, describe, expect, test, vi } from "vitest";

import { ApprovalStore } from "../approval-cache.js";
import { APPROVED, APPROVED_FOR_SESSION } from "../review-decision.js";
import { createEmptyToolPermissionContext } from "../types.js";
import type { Event } from "../../session/event-log.js";
import type { ToolInvocation } from "../../tools/context.js";
import type { Tool } from "../../tools/types.js";
import {
  arbitratePermissionMode,
  requestApproval,
  requestToolUserApproval,
  type ApprovalCtx,
} from "./arbiter.js";
import type { GuardianApprovalReviewer } from "./reviewer.js";
import {
  registerNotificationHook,
  resetLifecycleHookRegistry,
} from "../../llm/hooks/registry.js";

afterEach(() => {
  resetLifecycleHookRegistry();
});

function invocation(
  opts: {
    readonly services?: Record<string, unknown>;
    readonly session?: ToolInvocation["session"];
    readonly approvalPolicy?: string;
    readonly approvalsReviewer?: string;
    readonly activeTurn?: {
      unsafePeek?: () => { readonly turnId?: unknown } | null | undefined;
    };
  } = {},
): ToolInvocation {
  return {
    session:
      opts.session ??
      ({
        services: opts.services ?? {},
        ...(opts.activeTurn !== undefined
          ? { activeTurn: opts.activeTurn }
          : {}),
      } as never),
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
  test("fsync-journals the request and linked answer around every shared resolver", async () => {
    const events: Event[] = [];
    let sequence = 0;
    const session = {
      conversationId: "run-approval",
      services: { admissionRequired: true },
      rolloutStore: {
        readAll: () =>
          events.map((event) => ({
            type: "event_msg" as const,
            payload: event,
          })),
      },
      emit: (event: Event): Event => {
        const nextSequence = ++sequence;
        const stamped = {
          ...event,
          eventId: `approval-event-${nextSequence}`,
          seq: nextSequence,
        };
        events.push(stamped);
        return stamped;
      },
    } as unknown as ToolInvocation["session"];
    const answer = Promise.withResolvers<typeof APPROVED>();
    const resolver = vi.fn(async () => {
      expect(events.map((event) => event.msg.type)).toEqual([
        "request_permissions",
      ]);
      return answer.promise;
    });
    const inv = invocation({ session });

    const pending = requestApproval({
      ctx: approvalCtx(inv),
      args: { command: "pwd" },
      resolver: { request: resolver },
    });
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledOnce());
    answer.resolve(APPROVED);
    await expect(pending).resolves.toMatchObject({
      decision: APPROVED,
      source: "resolver",
    });

    expect(events.map((event) => event.msg.type)).toEqual([
      "request_permissions",
      "permission_decision",
    ]);
    const request = events[0];
    const decision = events[1];
    expect(request?.eventId).toBe("approval-event-1");
    expect(request?.seq).toBe(1);
    expect(decision?.msg).toMatchObject({
      type: "permission_decision",
      payload: {
        requestEventId: "approval-event-1",
        requestEventSeq: 1,
        decision: "approved",
        source: "resolver",
      },
    });
  });

  test("does not ask a resolver when the canonical permission journal is detached", async () => {
    const resolver = vi.fn(async () => APPROVED);
    const session = {
      conversationId: "run-detached",
      services: { admissionRequired: true },
      rolloutStore: null,
      emit: vi.fn(),
    } as unknown as ToolInvocation["session"];

    await expect(
      requestApproval({
        ctx: approvalCtx(invocation({ session })),
        resolver: { request: resolver },
      }),
    ).rejects.toThrow(
      "permission request call-1 has no canonical rollout store",
    );
    expect(resolver).not.toHaveBeenCalled();
  });

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

  test("bare skips approval hooks and preserves the human resolver path", async () => {
    const rawHook = vi.fn(async () => ({ kind: "denied" as const }));
    const permissionHook = vi.fn(async () => ({
      kind: "deny" as const,
      reason: "hook denied",
    }));
    const resolver = vi.fn(async () => APPROVED);
    const inv = invocation({
      services: { runtimeOptions: { simpleMode: true } },
    });

    const result = await requestApproval({
      ctx: approvalCtx(inv),
      hooks: [rawHook],
      permissionDecisionHooks: [permissionHook],
      resolver: { request: resolver },
    });

    expect(result).toMatchObject({ source: "resolver", decision: APPROVED });
    expect(rawHook).not.toHaveBeenCalled();
    expect(permissionHook).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledOnce();
  });

  test("bare skips approval hooks and preserves guardian review", async () => {
    const rawHook = vi.fn(async () => ({ kind: "denied" as const }));
    const permissionHook = vi.fn(async () => ({ kind: "deny" as const }));
    const reviewer: GuardianApprovalReviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: APPROVED,
        reviewId: "review-bare",
        countedDenial: false,
      })),
    };
    const inv = invocation({
      services: { runtimeOptions: { simpleMode: true } },
    });

    const result = await requestApproval({
      ctx: approvalCtx(inv),
      hooks: [rawHook],
      permissionDecisionHooks: [permissionHook],
      guardianApprovalReviewer: reviewer,
    });

    expect(result).toMatchObject({ source: "guardian", decision: APPROVED });
    expect(rawHook).not.toHaveBeenCalled();
    expect(permissionHook).not.toHaveBeenCalled();
    expect(reviewer.reviewApprovalRequest).toHaveBeenCalledOnce();
  });

  test("bare skips approval hooks and preserves default-deny", async () => {
    const rawHook = vi.fn(async () => ({ kind: "approved" as const }));
    const permissionHook = vi.fn(async () => ({ kind: "allow" as const }));
    const inv = invocation({
      services: { runtimeOptions: { simpleMode: true } },
    });

    const result = await requestApproval({
      ctx: approvalCtx(inv),
      hooks: [rawHook],
      permissionDecisionHooks: [permissionHook],
    });

    expect(result).toMatchObject({
      source: "default_deny",
      decision: { kind: "denied" },
    });
    expect(rawHook).not.toHaveBeenCalled();
    expect(permissionHook).not.toHaveBeenCalled();
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
        unsafePeek: () => (activeTurn === null ? null : { turnId: activeTurn }),
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

  test("interactive approval always reaches the answer-bearing resolver", async () => {
    const store = new ApprovalStore<unknown>();
    const inv = invocation({ services: { toolApprovals: store } });
    const rawAllow = vi.fn(async () => APPROVED);
    const permissionAllow = vi.fn(async () => ({ kind: "allow" as const }));
    const reviewer: GuardianApprovalReviewer = {
      reviewApprovalRequest: vi.fn(async () => ({
        decision: APPROVED,
        reviewId: "interactive-review",
        countedDenial: false,
      })),
    };
    const resolver = vi.fn(async () => APPROVED_FOR_SESSION);
    const ctx = {
      ...approvalCtx(inv),
      requiresUserInteraction: true,
    };

    const first = await requestApproval({
      ctx,
      args: { questions: [{ question: "Continue?" }] },
      hooks: [rawAllow],
      permissionDecisionHooks: [permissionAllow],
      guardianApprovalReviewer: reviewer,
      resolver: { request: resolver },
    });
    const second = await requestApproval({
      ctx,
      args: { questions: [{ question: "Continue?" }] },
      hooks: [rawAllow],
      permissionDecisionHooks: [permissionAllow],
      guardianApprovalReviewer: reviewer,
      resolver: { request: resolver },
    });

    expect(first.source).toBe("resolver");
    expect(second.source).toBe("resolver");
    expect(rawAllow).toHaveBeenCalledTimes(2);
    expect(permissionAllow).toHaveBeenCalledTimes(2);
    expect(reviewer.reviewApprovalRequest).not.toHaveBeenCalled();
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  test("interactive approval still honors an automatic denial", async () => {
    const resolver = vi.fn(async () => APPROVED);
    const result = await requestApproval({
      ctx: { ...approvalCtx(), requiresUserInteraction: true },
      hooks: [async () => ({ kind: "denied" })],
      resolver: { request: resolver },
    });

    expect(result).toMatchObject({
      source: "hook",
      decision: { kind: "denied" },
    });
    expect(resolver).not.toHaveBeenCalled();
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

  test("interactive asks survive bypassPermissions arbitration", async () => {
    const canUseTool = vi.fn(async () => ({
      behavior: "ask" as const,
      message: "answer questions?",
      decisionReason: {
        type: "permissionPromptTool" as const,
        permissionPromptToolName: "AskUserQuestion",
        toolResult: null,
      },
    }));
    const permissionContext = {
      getAppState: () => ({
        toolPermissionContext: createEmptyToolPermissionContext({
          mode: "bypassPermissions",
        }),
      }),
    } as never;
    const tool = {
      name: "AskUserQuestion",
      requiresUserInteraction: () => true,
    } as Tool;

    const result = await arbitratePermissionMode({
      tool,
      args: { questions: [] },
      permissionContext,
      canUseTool: canUseTool as never,
    });

    expect(result.kind).toBe("ask");
    expect(result.reasonCode).toBe("evaluator_asked");
  });

  test("interactive asks survive a PreToolUse allow", async () => {
    const canUseTool = vi.fn(async () => ({
      behavior: "ask" as const,
      message: "answer questions?",
      decisionReason: {
        type: "permissionPromptTool" as const,
        permissionPromptToolName: "AskUserQuestion",
        toolResult: null,
      },
    }));
    const permissionContext = {
      getAppState: () => ({
        toolPermissionContext: createEmptyToolPermissionContext({
          mode: "bypassPermissions",
        }),
      }),
    } as never;
    const tool = {
      name: "AskUserQuestion",
      requiresUserInteraction: () => true,
    } as Tool;

    const result = await arbitratePermissionMode({
      tool,
      args: { questions: [] },
      hookPermissionResult: {
        behavior: "allow",
        hookName: "PreToolUse:auto-allow",
      },
      permissionContext,
      canUseTool: canUseTool as never,
    });

    expect(result.kind).toBe("ask");
    expect(result.reasonCode).toBe("interactive_tool");
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

  test("interactive user approval never replays the session approval cache", async () => {
    const store = new ApprovalStore<unknown>();
    const inv = invocation({ services: { toolApprovals: store } });
    const tool = {
      name: "AskUserQuestion",
      requiresUserInteraction: () => true,
    } as Tool;
    const prompt = vi.fn(async () => ({
      behavior: "allow" as const,
      decisionAtTurnId: "turn-1",
      reviewDecision: APPROVED_FOR_SESSION,
    }));

    await requestToolUserApproval({
      request: prompt,
      tool,
      args: { questions: [{ question: "Continue?" }] },
      invocation: inv,
      currentTurnId: "turn-1",
      signal: new AbortController().signal,
    });
    await requestToolUserApproval({
      request: prompt,
      tool,
      args: { questions: [{ question: "Continue?" }] },
      invocation: inv,
      currentTurnId: "turn-1",
      signal: new AbortController().signal,
    });

    expect(prompt).toHaveBeenCalledTimes(2);
  });

  test("notification dispatch keeps the prompting session's bare authority", async () => {
    const notificationHook = vi.fn(async () => ({
      succeeded: true,
      output: "must not run for bare",
    }));
    registerNotificationHook(notificationHook);
    const tool = { name: "exec_command" } as Tool;
    let eventSequence = 0;
    const eventLog = {
      emit: vi.fn((event: Event) => ({
        ...event,
        eventId: `approval-event-${eventSequence + 1}`,
        seq: ++eventSequence,
      })),
    };
    const prompt = vi.fn(async () => ({
      behavior: "allow" as const,
      decisionAtTurnId: "turn-1",
    }));
    const run = async (simpleMode: boolean) =>
      await requestToolUserApproval({
        request: prompt,
        tool,
        args: { command: "pwd" },
        invocation: invocation({
          services: { runtimeOptions: { simpleMode } },
        }),
        currentTurnId: "turn-1",
        signal: new AbortController().signal,
        eventLog: eventLog as never,
      });

    await run(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(notificationHook).not.toHaveBeenCalled();

    await run(false);
    await vi.waitFor(() => expect(notificationHook).toHaveBeenCalledOnce());
  });
});
