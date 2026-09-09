import { describe, expect, test } from "vitest";
import { StreamingToolExecutor } from "./_deps/tool-runtime.js";
import type { LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import type { PreToolUseHook } from "../tools/hooks.js";
import type { Tool } from "../tools/types.js";
import { mkCtx, mkSession } from "../fixtures.js";

describe("phase tool-runtime dependency executor", () => {
  test.each([false, true])("preserves resolver denial status and metadata when audit logging throws=%s", async (throwAudit) => {
    let executed = 0;
    const tool: Tool = {
      name: "legacy_approval",
      description: "approval-gated legacy tool",
      inputSchema: { type: "object" },
      requiresApproval: true,
      execute: async () => {
        executed += 1;
        return { content: "must not execute" };
      },
    };
    const registry: ToolRegistry = { tools: [tool], toLLMTools: () => [], dispatch: async () => tool.execute({}) };
    const { session } = mkSession({ registry });
    const executor = new StreamingToolExecutor({
      registry,
      liveToolDispatch: {
        router: { registry },
        options: {
          session: { services: session.services },
          turn: mkCtx(),
          approvalPolicy: "on_request",
          approvalResolver: { request: async () => ({ kind: "denied" }) },
          permissionAuditLogger: async () => { if (throwAudit) throw new Error("audit failed"); },
          onPermissionAuditError: () => {},
        },
      },
    });
    executor.addTool({}, { id: "denied-legacy", name: tool.name, arguments: "{}" });
    executor.close();
    const results: ToolDispatchResult[] = [];

    for await (const completed of executor.getRemainingResults()) results.push(completed.result);

    expect(executed).toBe(0);
    expect(results).toEqual([expect.objectContaining({ isError: true, preventContinuation: true, metadata: { approvalDenied: true } })]);
  });

  test("normalizes array-shaped parsed arguments before pre-hooks", async () => {
    let observedArgs: Record<string, unknown> | undefined;
    const preHook: PreToolUseHook = ({ args }) => {
      observedArgs = args;
      return { kind: "continue" };
    };
    const tool: Tool = {
      name: "legacy_read",
      description: "legacy test tool",
      inputSchema: { type: "object" },
      execute: async () => ({ content: "ok" }),
    };
    const registry: ToolRegistry = {
      tools: [tool],
      toLLMTools: () => [],
      dispatch: async (call: LLMToolCall): Promise<ToolDispatchResult> =>
        tool.execute(JSON.parse(call.arguments || "{}")),
    };
    const executor = new StreamingToolExecutor({
      registry,
      liveToolDispatch: {
        router: { registry },
        options: { preHooks: [preHook] },
      },
    });

    executor.addTool(
      { id: "array-args", name: "legacy_read", input: {} },
      { id: "array-args", name: "legacy_read", arguments: "[\"spoof\"]" },
    );
    executor.close();

    const seenIds: string[] = [];
    for await (const result of executor.getRemainingResults()) {
      seenIds.push(result.toolCall.id);
    }

    expect(seenIds).toEqual(["array-args"]);
    expect(observedArgs).toEqual({});
    expect(Array.isArray(observedArgs)).toBe(false);
  });
});
