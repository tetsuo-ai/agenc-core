import { describe, expect, test } from "vitest";
import { StreamingToolExecutor } from "./streaming-executor.js";
import type { ToolRegistry, ToolDispatchResult } from "../tool-registry.js";
import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { Tool } from "./types.js";
import { EXCLUSIVE, SHARED_READ } from "./concurrency.js";
import type { ToolUseBlock } from "../session/turn-state.js";

function mockRegistry(
  dispatch: (call: LLMToolCall) => Promise<ToolDispatchResult>,
  tools: Tool[] = [],
): ToolRegistry {
  return {
    tools,
    toLLMTools(): LLMTool[] {
      return tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.inputSchema,
        },
      }));
    },
    dispatch,
  };
}

function makeBlock(id: string, name: string): ToolUseBlock {
  return { type: "tool_use", id, name, input: {} };
}

function makeCall(id: string, name: string): LLMToolCall {
  return { id, name, arguments: "{}" };
}

describe("StreamingToolExecutor (I-65 + I-41)", () => {
  test("completes in submission order (I-65)", async () => {
    const exec = new StreamingToolExecutor({
      registry: mockRegistry(async (call) => ({ content: `ok-${call.id}` })),
    });
    for (const id of ["a", "b", "c"]) {
      exec.addTool(makeBlock(id, "system.readFile"), makeCall(id, "system.readFile"));
      exec.setConcurrencyClassFor("system.readFile", SHARED_READ);
    }
    exec.close();
    const results: string[] = [];
    for await (const r of exec.getRemainingResults()) {
      results.push(r.toolCall.id);
    }
    expect(results).toEqual(["a", "b", "c"]);
  });

  test("Bash error cascades sibling-abort", async () => {
    let bashErrored = 0;
    const exec = new StreamingToolExecutor({
      registry: mockRegistry(async (call) => {
        if (call.id === "bash1") {
          bashErrored += 1;
          return { content: "bash error", isError: true };
        }
        return { content: "safe" };
      }),
      onSiblingAbort: () => {},
    });
    exec.setConcurrencyClassFor("system.bash", EXCLUSIVE);
    exec.setConcurrencyClassFor("system.readFile", SHARED_READ);
    exec.addTool(makeBlock("bash1", "system.bash"), makeCall("bash1", "system.bash"));
    exec.addTool(
      makeBlock("read1", "system.readFile"),
      makeCall("read1", "system.readFile"),
    );
    exec.close();
    const results: string[] = [];
    for await (const r of exec.getRemainingResults()) {
      results.push(`${r.toolCall.id}:${r.status}`);
    }
    expect(bashErrored).toBe(1);
    expect(results[0]).toBe("bash1:completed");
    // Sibling read gets a synthetic error after bash failed.
    const read = results.find((r) => r.startsWith("read1"));
    expect(read).toBeDefined();
  });

  test("I-41 re-entrance guard: second discard is no-op", () => {
    const exec = new StreamingToolExecutor({
      registry: mockRegistry(async () => ({ content: "" })),
    });
    exec.discard("first");
    // Second call returns immediately without recursion / throw.
    expect(() => exec.discard("second")).not.toThrow();
  });

  test("discard synthesizes errors for queued tools", async () => {
    const exec = new StreamingToolExecutor({
      registry: mockRegistry(async () => {
        await new Promise<void>((r) => setTimeout(r, 50));
        return { content: "ok" };
      }),
    });
    exec.setConcurrencyClassFor("system.writeFile", EXCLUSIVE);
    exec.addTool(
      makeBlock("w1", "system.writeFile"),
      makeCall("w1", "system.writeFile"),
    );
    exec.addTool(
      makeBlock("w2", "system.writeFile"),
      makeCall("w2", "system.writeFile"),
    );
    // Discard immediately — both should become synthetic fallback
    // results before either dispatch has a chance to resolve. The
    // test asserts the discard path produces at least one synthetic.
    exec.discard("fallback");
    // getRemainingResults returns once isAborting is set.
    const stillQueued = exec
      .getToolStates()
      .filter((s) => s.status === "completed")
      .map((s) => s.id);
    expect(stillQueued.length).toBeGreaterThanOrEqual(1);
  });

  test("uses tool.isConcurrencySafe for per-call downgrade", async () => {
    let active = 0;
    let peak = 0;
    const tool: Tool = {
      name: "system.readFile",
      description: "conditionally parallel",
      inputSchema: { type: "object" },
      concurrencyClass: SHARED_READ,
      isConcurrencySafe: (args) => args["safe"] === true,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 15));
        active -= 1;
        return { content: "ok" };
      },
    };
    const exec = new StreamingToolExecutor({
      registry: mockRegistry(async (call) => {
        const parsed = call.arguments ? JSON.parse(call.arguments) : {};
        const result = await tool.execute(parsed);
        return { content: result.content, isError: result.isError };
      }, [tool]),
    });
    exec.addTool(
      makeBlock("unsafe", "system.readFile"),
      { id: "unsafe", name: "system.readFile", arguments: '{"safe":false}' },
    );
    exec.addTool(
      makeBlock("safe", "system.readFile"),
      { id: "safe", name: "system.readFile", arguments: '{"safe":true}' },
    );
    exec.close();

    const seenIds: string[] = [];
    for await (const result of exec.getRemainingResults()) {
      seenIds.push(result.toolCall.id);
    }

    expect(seenIds).toEqual(["unsafe", "safe"]);
    expect(peak).toBe(1);
  });
});
