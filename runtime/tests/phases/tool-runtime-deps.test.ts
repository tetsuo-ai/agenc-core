import { describe, expect, test } from "vitest";
import { StreamingToolExecutor } from "./_deps/tool-runtime.js";
import type { LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import type { PreToolUseHook } from "../tools/hooks.js";
import type { Tool } from "../tools/types.js";

describe("phase tool-runtime dependency executor", () => {
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
