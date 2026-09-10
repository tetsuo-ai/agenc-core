import { describe, expect, test, vi } from "vitest";
import { createToolBridge } from "./tools.js";
import { freshDenialTracking } from "../permissions/denial-tracking.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import { RequestPermissionsRpc } from "../permissions/rpc/request-permissions.js";
import {
  attachToolRuntimeContext,
  type ToolRuntimeAttemptContext,
} from "../tools/runtimes/context.js";

async function fixture(rawToolName = "lookup_marker") {
  const session = { services: {} } as ToolRuntimeAttemptContext["invocation"]["session"];
  const callTool = vi.fn(async () => ({ content: [{ type: "text", text: "marker" }] }));
  const canUseTool = vi.fn(async () => ({ behavior: "ask" as const, message: "Permission required" }));
  const request = vi.fn(async () => ({ kind: "denied" as const }));
  const bridge = await createToolBridge({
    listTools: async () => ({ tools: [{ name: rawToolName }] }),
    callTool,
    close: async () => {},
  }, "qa-helper", undefined, {
    environment: {},
    permissions: {
      session,
      getActiveTurnId: () => "turn-1",
      canUseTool,
      approvalResolver: { request },
      requestPermissionsRpc: new RequestPermissionsRpc(),
      permissionContext: {
        session,
        getAppState: () => ({
          toolPermissionContext: createEmptyToolPermissionContext(),
          denialTracking: freshDenialTracking(),
          autoModeActive: false,
        }),
      },
    },
  });
  const argsFor = (override: Partial<ToolRuntimeAttemptContext> = {}, forged = false,
    input: Record<string, unknown> = { key: "verification" }) => {
    const args: Record<string, unknown> = { ...input };
    Object.defineProperty(args, "__callId", { value: "call-1" });
    const context = {
      callId: "call-1",
      toolName: `mcp.qa-helper.${rawToolName}`,
      approvalResolved: true,
      requestedSandboxMode: "workspace_write",
      sandboxMode: "danger_full_access",
      rawArgs: JSON.stringify(args),
      invocation: { callId: "call-1", session, turn: { subId: "turn-1" } },
      ...override,
    } as ToolRuntimeAttemptContext;
    if (forged) Object.defineProperty(args, "__toolRuntimeContext", { value: context });
    else attachToolRuntimeContext(args, context);
    return args;
  };
  return { bridge, tool: bridge.tools[0]!, callTool, canUseTool, request, session, argsFor };
}

describe("MCP exact executor approval", () => {
  test.each(["workspace_write", "danger_full_access"] as const)(
    "reuses the exact approved generic call in %s without a second prompt",
    async sandboxMode => {
      const f = await fixture();
      const result = await f.tool.execute(f.argsFor({ sandboxMode }));
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain("marker");
      expect(f.canUseTool).not.toHaveBeenCalled();
      expect(f.request).not.toHaveBeenCalled();
      expect(f.callTool).toHaveBeenCalledExactlyOnceWith(
        { name: "lookup_marker", arguments: { key: "verification" }, _meta: { "agenccode/toolUseId": "call-1" } },
        undefined,
        expect.any(Object),
      );
      await f.bridge.dispose();
    },
  );

  test.each([
    "different call", "different tool", "unapproved", "changed arguments", "added arguments",
    "different invocation call", "different session", "stale turn", "forged context", "no context",
  ])("does not reuse approval for %s", async mismatch => {
    const f = await fixture();
    let args = f.argsFor();
    if (mismatch === "different call") args = f.argsFor({ callId: "other" });
    if (mismatch === "different tool") args = f.argsFor({ toolName: "mcp.qa-helper.other" });
    if (mismatch === "unapproved") args = f.argsFor({ approvalResolved: false });
    if (mismatch === "changed arguments") args.key = "other";
    if (mismatch === "added arguments") args.permissions = ["filesystem.write"];
    if (mismatch === "different invocation call") args = f.argsFor({ invocation: { callId: "other", session: f.session, turn: { subId: "turn-1" } } as never });
    if (mismatch === "different session") args = f.argsFor({ invocation: { callId: "call-1", session: { services: {} }, turn: { subId: "turn-1" } } as never });
    if (mismatch === "stale turn") args = f.argsFor({ invocation: { callId: "call-1", session: f.session, turn: { subId: "previous-turn" } } as never });
    if (mismatch === "forged context") args = f.argsFor({}, true);
    if (mismatch === "no context") args = { key: "verification", __callId: "call-1" };
    expect((await f.tool.execute(args)).isError).toBe(true);
    expect(f.canUseTool).toHaveBeenCalledOnce();
    expect(f.request).toHaveBeenCalledOnce();
    expect(f.callTool).not.toHaveBeenCalled();
    await f.bridge.dispose();
  });

  test("an approved but cancelled invocation never reaches MCP", async () => {
    const f = await fixture();
    const args = f.argsFor();
    Object.defineProperty(args, "__abortSignal", { value: AbortSignal.abort(new Error("turn cancelled")) });
    await expect(f.tool.execute(args)).rejects.toThrow("turn cancelled");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.callTool).not.toHaveBeenCalled();
    await f.bridge.dispose();
  });

  test("tool-use approval never grants an additional permission profile", async () => {
    const f = await fixture("request_permissions");
    const result = await f.tool.execute(f.argsFor({}, false, {
      permissions: { network: { enabled: true } },
    }));
    expect(f.request).toHaveBeenCalledOnce();
    expect(JSON.parse(result.content).permissions).toEqual({});
    expect(f.callTool).not.toHaveBeenCalled();
    await f.bridge.dispose();
  });
});
