import { describe, expect, test, vi } from "vitest";
import { ToolRouter } from "../../src/tools/router.js";
import type { Tool } from "../../src/tools/types.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { createPlanningTools } from "../../src/tools/system/planning.js";
import { executeToolDispatch } from "../../src/tools/execution.js";
import { bindApprovalResponseKey, approvalResponseKey } from "../../src/permissions/approval-response-key.js";
import { recordExitPlanModeApproval, consumeExitPlanModeApproval } from "../../src/planning/exit-plan-approval.js";
import { createSpawnAgentTool } from "../../src/agents/v2/spawn.js";
import { createAgentRoleWorkspace } from "../../src/agents/role.js";
import { AgentRoleCatalog } from "../../src/agents/role-catalog.js";
import type { MultiAgentV2Options } from "../../src/agents/v2/common.js";
import { markWorkflowApprovalSession, workflowApprovalFailureFromMetadata } from "../../src/permissions/approval-failure.js";

const runtimeOptions = resolveAgentRuntimeOptions({});

function fixture(tool: Tool) {
  const session = {
    eventLog: new EventLog(),
    services: { admissionRequired: false, runtimeOptions },
  } as unknown as ToolInvocation["session"];
  const turn = { subId: "preflight-turn" } as ToolInvocation["turn"];
  const tracker = { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} };
  const resolver = { request: vi.fn(async () => ({ kind: "approved" as const })) };
  const canUseTool = vi.fn(async () => ({ behavior: "ask" as const, message: "approval required" }));
  const options = {
    session, turn, tracker,
    approvalPolicy: "never" as const,
    sandboxMode: "workspace_write" as const,
    approvalResolver: resolver,
    canUseTool,
    permissionContext: {} as never,
  };
  const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
  return { router, resolver, canUseTool, options };
}

describe("tool preflight before approval", () => {
  test.each(["model", "direct"] as const)("%s rejects invalid arguments before permission evaluation", async (route) => {
    const execute = vi.fn(async () => ({ content: "executed" }));
    const tool: Tool = {
      name: "spawn_agent", description: "spawn", requiresApproval: true,
      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      execute,
    };
    const { router, resolver, canUseTool, options } = fixture(tool);
    const result = route === "model"
      ? await router.dispatchModelToolCall({ id: "missing-message", name: tool.name, arguments: "{}" }, options)
      : await router.dispatchToolCall({ ...options, callId: "missing-message", toolName: { name: tool.name }, payload: { kind: "function", arguments: "{}" }, source: "direct" }, {}, options);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("message");
    expect(resolver.request).not.toHaveBeenCalled();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("invalid native plan exit never requests approval", async () => {
    const tool = createPlanningTools().find((candidate) => candidate.name === "ExitPlanMode")!;
    const { router, resolver, canUseTool, options } = fixture(tool);
    const result = await router.dispatchModelToolCall({ id: "invalid-plan", name: tool.name, arguments: "{}" }, options);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("permission mode registry");
    expect(resolver.request).not.toHaveBeenCalled();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  test("native plan exit refuses an already accepted plan before asking again", async () => {
    const tool = createPlanningTools({ workflowController: {
      getPermissionModeRegistry: () => ({ current: () => ({ mode: "acceptEdits" }) }) as never,
    } }).find((candidate) => candidate.name === "ExitPlanMode")!;
    const { router, resolver, canUseTool, options } = fixture(tool);
    const result = await router.dispatchModelToolCall({ id: "already-accepted", name: tool.name, arguments: "{}" }, options);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not in plan mode");
    expect(resolver.request).not.toHaveBeenCalled();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  test.each(["message", "task_name"])("native spawn rejects blank %s without asking or initializing agents", async (field) => {
    const workspace = createAgentRoleWorkspace("/tmp/preflight");
    const ensureAgentControl = vi.fn(() => { throw new Error("must not initialize agents"); });
    const tool = createSpawnAgentTool({
      workspace, roleCatalog: new AgentRoleCatalog(workspace),
      getSession: () => undefined, ensureAgentControl,
    } as unknown as MultiAgentV2Options);
    const { router, resolver, canUseTool, options } = fixture(tool);
    const result = await router.dispatchModelToolCall({
      id: "blank-spawn", name: tool.name,
      arguments: JSON.stringify({ message: "Write a test", task_name: "tests", [field]: "  \t " }),
    }, options);
    expect(result.isError).toBe(true);
    expect(result.content).toContain(`${field} is required`);
    expect(resolver.request).not.toHaveBeenCalled();
    expect(canUseTool).not.toHaveBeenCalled();
    expect(ensureAgentControl).not.toHaveBeenCalled();
  });

  test("hook rewrites are validated before approval", async () => {
    const execute = vi.fn(async () => ({ content: "executed" }));
    const tool: Tool = {
      name: "preflight_fixture", description: "fixture", requiresApproval: true,
      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      execute,
    };
    const { router, resolver, options } = fixture(tool);
    const result = await router.dispatchModelToolCall({ id: "rewritten", name: tool.name, arguments: '{"message":"valid"}' }, {
      ...options,
      preHooks: [async () => ({ kind: "continue", args: { message: 42 } })],
    });
    expect(result.isError).toBe(true);
    expect(resolver.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("valid calls still require approval and execute once", async () => {
    const execute = vi.fn(async () => ({ content: "executed" }));
    const tool: Tool = {
      name: "preflight_fixture", description: "fixture", requiresApproval: true,
      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      execute,
    };
    const { router, resolver, options } = fixture(tool);
    const result = await router.dispatchModelToolCall({ id: "valid", name: tool.name, arguments: '{"message":"valid"}' }, options);
    expect(result.isError).toBeFalsy();
    expect(resolver.request).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  test.each(["model", "direct"] as const)("%s rechecks native preconditions after approval and discards stale modal data", async (route) => {
    let allowed = true;
    const execute = vi.fn(async () => ({ content: "executed" }));
    const tool: Tool = {
      name: "preflight_fixture", description: "fixture", requiresApproval: true,
      inputSchema: { type: "object", properties: {} },
      preflight: () => allowed ? null : { code: "stale", message: "state changed" },
      execute,
    };
    const { router, resolver, options } = fixture(tool);
    let responseKey = "";
    resolver.request.mockImplementationOnce(async () => {
      responseKey = bindApprovalResponseKey(options.session, "stale");
      recordExitPlanModeApproval(responseKey, { action: "approve" });
      allowed = false;
      return { kind: "approved" };
    });
    const result = route === "model"
      ? await router.dispatchModelToolCall({ id: "stale", name: tool.name, arguments: "{}" }, options)
      : await router.dispatchToolCall({ ...options, callId: "stale", toolName: { name: tool.name }, payload: { kind: "function", arguments: "{}" }, source: "direct" }, {}, options);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("state changed");
    expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(resolver.request).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(approvalResponseKey(options.session, "stale")).toBe("stale");
    expect(consumeExitPlanModeApproval({ __callId: responseKey })).toBeNull();
  });

  test("direct executor validates hook rewrites before its approval fallback", async () => {
    const execute = vi.fn(async () => ({ content: "executed" }));
    const tool: Tool = {
      name: "preflight_fixture", description: "fixture", requiresApproval: true,
      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      execute,
    };
    const { resolver, options } = fixture(tool);
    const result = await executeToolDispatch({
      tool, currentTurnId: "preflight-turn", rawArgs: '{"message":"valid"}',
      invocation: { ...options, callId: "rewritten", toolName: { name: tool.name }, payload: { kind: "function", arguments: '{"message":"valid"}' }, source: "direct" },
      approvalResolver: resolver,
      preHooks: [async () => ({ kind: "continue", args: { message: 42 } })],
    });
    expect(result.isError).toBe(true);
    expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(resolver.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  test("scoped modal payloads preserve native call IDs and cannot be selected by model arguments", async () => {
    const tool: Tool = {
      name: "preflight_fixture", description: "fixture", requiresApproval: true,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      execute: async (args) => ({ content: JSON.stringify({
        callId: args.__callId,
        approval: consumeExitPlanModeApproval(args),
      }) }),
    };
    const { router, resolver, options } = fixture(tool);
    resolver.request.mockImplementationOnce(async () => {
      const key = bindApprovalResponseKey(options.session, "native-call");
      recordExitPlanModeApproval(key, { action: "approve", mode: "default" });
      return { kind: "approved" };
    });
    recordExitPlanModeApproval("another-request", { action: "revise" });
    const result = await router.dispatchModelToolCall({
      id: "native-call", name: tool.name,
      arguments: '{"__agencApprovalResponseKey":"another-request"}',
    }, options);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content)).toEqual({ callId: "native-call", approval: { action: "approve", mode: "default" } });
    expect(consumeExitPlanModeApproval({ __callId: "another-request" })).toMatchObject({ action: "revise" });
    expect(approvalResponseKey(options.session, "native-call")).toBe("native-call");
  });

  test.each(["model", "direct"] as const)("%s produces a permanent typed workflow failure for policy denial", async (route) => {
    const execute = vi.fn(async () => ({ content: "must not execute" }));
    const tool: Tool = { name: "denied_fixture", description: "fixture", inputSchema: { type: "object" }, execute };
    const { router, options } = fixture(tool);
    const unmark = markWorkflowApprovalSession(options.session);
    try {
      const deniedOptions = { ...options, canUseTool: async () => ({ behavior: "deny" as const, message: "Policy forbids this tool" }) };
      const result = route === "model"
        ? await router.dispatchModelToolCall({ id: "policy-denied", name: tool.name, arguments: "{}" }, deniedOptions)
        : await router.dispatchToolCall({ ...options, callId: "policy-denied", toolName: { name: tool.name }, payload: { kind: "function", arguments: "{}" }, source: "direct" }, {}, deniedOptions);
      expect(result.preventContinuation).toBe(true);
      expect(workflowApprovalFailureFromMetadata(result.metadata?.approvalFailure)?.stopReason).toBe("policy_denied");
      expect(execute).not.toHaveBeenCalled();
    } finally {
      unmark();
    }
  });
});
