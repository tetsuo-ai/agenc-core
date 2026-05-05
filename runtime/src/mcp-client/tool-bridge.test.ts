/**
 * T6 gap #119 — MCP tool-bridge `mcp_tool_call_begin` / `_end` smoke.
 *
 * Verifies that the bridge factory threads an `MCPCallObserver` into
 * each per-tool `execute()` wrapper so the session layer can emit
 * the canonical EventMsg variants without the bridge itself needing
 * a Session reference.
 */

import { describe, expect, test, vi } from "vitest";
import type { ToolEvaluatorContext } from "../permissions/evaluator.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import { RequestPermissionsRpc } from "../permissions/rpc/request-permissions.js";
import { buildGuardianApprovalRequest } from "../permissions/guardian/approval-request.js";
import type { GuardianApprovalReviewOptions } from "../permissions/guardian/reviewer.js";
import { APPROVED, DENIED } from "../permissions/review-decision.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { createToolBridge, type MCPCallObserver } from "./tool-bridge.js";

function permissionContext(): ToolEvaluatorContext {
  const toolPermissionContext = createEmptyToolPermissionContext();
  return {
    session: { services: {} } as never,
    getAppState() {
      return {
        toolPermissionContext,
        denialTracking: freshDenialTracking(),
        autoModeActive: false,
      };
    },
  };
}

describe("createToolBridge — T6 gap #119 observer wiring", () => {
  test("observer.onBegin + onEnd fire around a successful call", async () => {
    const begins: Array<{ server: string; toolName: string; args: string }> = [];
    const ends: Array<{ server: string; toolName: string; isError: boolean }> = [];
    const observer: MCPCallObserver = {
      onBegin: (b) => {
        begins.push({ server: b.server, toolName: b.toolName, args: b.args });
      },
      onEnd: (e) => {
        ends.push({ server: e.server, toolName: e.toolName, isError: e.isError });
      },
    };

    const fakeClient = {
      listTools: async () => ({
        tools: [
          {
            name: "echo",
            description: "echoes input",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool: async () => ({
        content: [{ type: "text", text: "hello" }],
        isError: false,
      }),
      close: async () => {},
    };

    const bridge = await createToolBridge(fakeClient, "srv", undefined, {
      callObserver: observer,
    });
    const tool = bridge.tools[0]!;
    const result = await tool.execute({ msg: "hi" });

    expect(result.isError).toBeFalsy();
    expect(begins).toHaveLength(1);
    expect(begins[0]!.server).toBe("srv");
    expect(begins[0]!.toolName).toBe("echo");
    expect(JSON.parse(begins[0]!.args)).toEqual({ msg: "hi" });

    expect(ends).toHaveLength(1);
    expect(ends[0]!.server).toBe("srv");
    expect(ends[0]!.toolName).toBe("echo");
    expect(ends[0]!.isError).toBe(false);
  });

  test("observer.onEnd still fires with isError when client throws", async () => {
    const ends: Array<{ isError: boolean }> = [];
    const observer: MCPCallObserver = {
      onEnd: (e) => {
        ends.push({ isError: e.isError });
      },
    };

    const fakeClient = {
      listTools: async () => ({
        tools: [
          {
            name: "boom",
            description: "throws",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
      callTool: async () => {
        throw new Error("server exploded");
      },
      close: async () => {},
    };

    const bridge = await createToolBridge(fakeClient, "srv", undefined, {
      callObserver: observer,
    });
    const result = await bridge.tools[0]!.execute({});
    expect(result.isError).toBe(true);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.isError).toBe(true);
  });

  test("permission deny blocks MCP client dispatch", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "should-not-run" }],
      isError: false,
    }));
    const bridge = await createToolBridge(
      {
        listTools: async () => ({
          tools: [{ name: "write", description: "writes remotely" }],
        }),
        callTool,
        close: async () => {},
      },
      "srv",
      undefined,
      {
        permissions: {
          canUseTool: async () => ({
            behavior: "deny",
            message: "blocked by policy",
            decisionReason: { type: "other", reason: "blocked" },
          }),
          permissionContext: permissionContext(),
        },
      },
    );

    await expect(bridge.tools[0]!.execute({ value: 1 })).resolves.toEqual({
      content: "blocked by policy",
      isError: true,
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  test("permission approval dispatches MCP client tools with updated args", async () => {
    const callTool = vi.fn(async () => ({
      content: [{ type: "text", text: "approved" }],
      isError: false,
    }));
    const bridge = await createToolBridge(
      {
        listTools: async () => ({
          tools: [{ name: "write", description: "writes remotely" }],
        }),
        callTool,
        close: async () => {},
      },
      "srv",
      undefined,
      {
        permissions: {
          canUseTool: async () => ({
            behavior: "ask",
            message: "needs approval",
            updatedInput: { value: 2 },
          }),
          permissionContext: permissionContext(),
          approvalResolver: { request: async () => APPROVED },
        },
      },
    );

    await expect(bridge.tools[0]!.execute({ value: 1 })).resolves.toMatchObject({
      content: "approved",
    });
    expect(callTool).toHaveBeenCalledWith({
      name: "write",
      arguments: { value: 2 },
    });
  });

  test("MCP approval templates feed guardian prompts with updated args", async () => {
    const reviewer = vi.fn(async () => ({
      decision: DENIED,
      reviewId: "review-1",
      countedDenial: false,
    }));
    const bridge = await createToolBridge(
      {
        listTools: async () => ({
          tools: [{ name: "create_event", description: "creates event" }],
        }),
        callTool: async () => ({
          content: [{ type: "text", text: "should-not-run" }],
        }),
        close: async () => {},
      },
      "calendar",
      undefined,
      {
        permissions: {
          canUseTool: async () => ({
            behavior: "ask",
            message: "fallback",
            updatedInput: { title: "Updated" },
          }),
          permissionContext: permissionContext(),
          guardianApprovalReviewer: {
            reviewApprovalRequest: reviewer,
          },
          getActiveTurnId: () => "turn-active",
          approvalTemplates: {
            schemaVersion: 4,
            templates: [
              {
                serverName: "calendar",
                connectorId: "calendar",
                toolTitle: "create_event",
                template: "Allow {connector_name} to create an event?",
                templateParams: [],
              },
            ],
          },
        },
      },
    );

    await expect(bridge.tools[0]!.execute({ title: "Original" })).resolves
      .toMatchObject({ isError: true });
    expect(reviewer.mock.calls[0]![0].ctx.retryReason).toBe(
      "Allow calendar to create an event?",
    );
    expect(reviewer.mock.calls[0]![0].ctx.turnId).toBe("turn-active");
    expect(reviewer.mock.calls[0]![0].args).toEqual({ title: "Updated" });
  });

  test("request_permissions tool uses local guardian request shape", async () => {
    const callTool = vi.fn();
    const reviewer = vi.fn(async (opts: GuardianApprovalReviewOptions) => {
      const request = buildGuardianApprovalRequest(opts.ctx, opts.args ?? {});
      expect(request).toMatchObject({
        kind: "request_permissions",
        permissions: ["network"],
        toolName: "request_permissions",
      });
      return {
        decision: APPROVED,
        reviewId: "review-2",
        countedDenial: false,
      };
    });
    const bridge = await createToolBridge(
      {
        listTools: async () => ({
          tools: [{ name: "request_permissions", description: "requests perms" }],
        }),
        callTool,
        close: async () => {},
      },
      "srv",
      undefined,
      {
        permissions: {
          requestPermissionsRpc: new RequestPermissionsRpc(),
          guardianApprovalReviewer: {
            reviewApprovalRequest: reviewer,
          },
          getActiveTurnId: () => "turn-rpc",
          cwd: "/repo",
        },
      },
    );

    const result = await bridge.tools[0]!.execute({
      reason: "Need network",
      permissions: { network: { enabled: true } },
    });
    expect(JSON.parse(result.content)).toEqual({
      permissions: { network: { enabled: true } },
      scope: "turn",
      strictAutoReview: false,
    });
    expect(result.isError).toBeFalsy();
    expect(reviewer).toHaveBeenCalledOnce();
    expect(reviewer.mock.calls[0]![0].ctx.turnId).toBe("turn-rpc");
    expect(callTool).not.toHaveBeenCalled();
  });

  test("request_permissions handles invalid args and denied approvals locally", async () => {
    const callTool = vi.fn();
    const rpc = new RequestPermissionsRpc();
    const bridge = await createToolBridge(
      {
        listTools: async () => ({
          tools: [{ name: "request_permissions", description: "requests perms" }],
        }),
        callTool,
        close: async () => {},
      },
      "srv",
      undefined,
      {
        permissions: {
          requestPermissionsRpc: rpc,
          approvalResolver: { request: async () => DENIED },
          cwd: "/repo",
        },
      },
    );

    await expect(bridge.tools[0]!.execute({})).resolves.toEqual({
      content: "request_permissions requires at least one permission",
      isError: true,
    });
    const denied = await bridge.tools[0]!.execute({
      permissions: { network: { enabled: true } },
    });
    expect(JSON.parse(denied.content)).toEqual({
      permissions: {},
      scope: "turn",
      strictAutoReview: false,
    });
    expect(denied.isError).toBeFalsy();
    expect(rpc.pendingCount).toBe(0);
    expect(callTool).not.toHaveBeenCalled();
  });
});
