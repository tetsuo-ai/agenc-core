import { describe, expect, test } from "vitest";
import type { LLMTool, LLMToolCall } from "../llm/types.js";
import type { ToolDispatchResult, ToolRegistry } from "../tool-registry.js";
import type { ToolUseBlock } from "../session/turn-state.js";
import type { Tool } from "./types.js";
import {
  partitionToolCalls,
  resolveMaxToolUseConcurrency,
  runTools,
} from "./orchestration.js";

function testTool(overrides: Partial<Tool> & { name: string }): Tool {
  return {
    name: overrides.name,
    description: "test",
    inputSchema: { type: "object" },
    execute: async () => ({ content: "" }),
    ...overrides,
  };
}

function registry(
  tools: readonly Tool[],
  dispatch: (call: LLMToolCall) => Promise<ToolDispatchResult> = async (call) => ({
    content: call.id,
  }),
): ToolRegistry {
  return {
    tools,
    toLLMTools(): LLMTool[] {
      return tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));
    },
    dispatch,
  };
}

function block(id: string, name: string, input: unknown = {}): ToolUseBlock {
  return { type: "tool_use", id, name, input };
}

function call(id: string, name: string): LLMToolCall {
  return { id, name, arguments: "{}" };
}

describe("orchestration", () => {
  test("resolveMaxToolUseConcurrency default + env override", () => {
    delete process.env.AGENC_MAX_TOOL_USE_CONCURRENCY;
    expect(resolveMaxToolUseConcurrency()).toBe(10);
    process.env.AGENC_MAX_TOOL_USE_CONCURRENCY = "5";
    expect(resolveMaxToolUseConcurrency()).toBe(5);
    process.env.AGENC_MAX_TOOL_USE_CONCURRENCY = "bogus";
    expect(resolveMaxToolUseConcurrency()).toBe(10);
    process.env.AGENC_MAX_TOOL_USE_CONCURRENCY = "0";
    expect(resolveMaxToolUseConcurrency()).toBe(10);
    process.env.AGENC_MAX_TOOL_USE_CONCURRENCY = "-2";
    expect(resolveMaxToolUseConcurrency()).toBe(10);
    delete process.env.AGENC_MAX_TOOL_USE_CONCURRENCY;
  });

  test("partitionToolCalls batches consecutive safe calls and isolates unsafe calls", () => {
    const safe = testTool({
      name: "Read",
      isConcurrencySafe: (args) => args["safe"] === true,
    });
    const unsafe = testTool({ name: "Write" });
    const batches = partitionToolCalls(
      [
        block("a", "Read", { safe: true }),
        block("b", "Read", { safe: true }),
        block("c", "Write", {}),
        block("d", "Read", { safe: true }),
      ],
      registry([safe, unsafe]),
    );

    expect(batches.map((batch) => batch.isConcurrencySafe)).toEqual([
      true,
      false,
      true,
    ]);
    expect(batches.map((batch) => batch.blocks.map((item) => item.id))).toEqual([
      ["a", "b"],
      ["c"],
      ["d"],
    ]);
  });

  test("partitionToolCalls treats unknown, invalid input, and throwing safety hooks as unsafe", () => {
    const throwing = testTool({
      name: "MaybeRead",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      },
      isConcurrencySafe: () => {
        throw new Error("bad parse");
      },
    });
    const schemaInvalid = testTool({
      name: "SchemaRead",
      inputSchema: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      },
      isConcurrencySafe: () => true,
    });
    const batches = partitionToolCalls(
      [
        block("unknown", "Missing", {}),
        block("invalid", "MaybeRead", "not an object"),
        block("throws", "MaybeRead", {}),
        block("schema-invalid", "SchemaRead", {}),
      ],
      registry([throwing, schemaInvalid]),
    );

    expect(batches).toHaveLength(4);
    expect(batches.every((batch) => batch.isConcurrencySafe === false)).toBe(true);
  });

  test("runTools defers context modifiers for concurrent-safe batches", async () => {
    const safe = testTool({
      name: "Read",
      isConcurrencySafe: () => true,
    });
    const updates: Array<{ id?: string; context: string[] }> = [];
    let inProgress = new Set<string>();

    for await (const update of runTools(
      [block("a", "Read", {}), block("b", "Read", {})],
      [call("a", "Read"), call("b", "Read")],
      {
        registry: registry([safe], async (toolCall) => ({
          content: `ok-${toolCall.id}`,
        })),
        runToolUseFn: async (toolCall) => ({ content: `ok-${toolCall.id}` }),
        initialContext: [] as string[],
        setInProgressToolUseIds(updateIds) {
          inProgress = new Set(updateIds(inProgress));
        },
        contextModifierForUpdate(update) {
          if (update.kind !== "result") return null;
          return (context) => [...context, update.result.toolCall.id];
        },
      },
    )) {
      updates.push({
        id: update.update?.kind === "result"
          ? update.update.result.toolCall.id
          : undefined,
        context: update.newContext,
      });
    }

    expect(updates).toEqual([
      { id: "a", context: [] },
      { id: "b", context: [] },
      { id: undefined, context: ["a", "b"] },
    ]);
    expect(inProgress.size).toBe(0);
  });

  test("runTools applies context modifiers immediately for serial batches", async () => {
    const unsafe = testTool({ name: "Write" });
    const contexts: string[][] = [];

    for await (const update of runTools(
      [block("a", "Write", {}), block("b", "Write", {})],
      [call("a", "Write"), call("b", "Write")],
      {
        registry: registry([unsafe]),
        runToolUseFn: async (toolCall) => ({ content: `ok-${toolCall.id}` }),
        initialContext: [] as string[],
        contextModifierForUpdate(update) {
          if (update.kind !== "result") return null;
          return (context) => [...context, update.result.toolCall.id];
        },
      },
    )) {
      contexts.push(update.newContext);
    }

    expect(contexts).toEqual([["a"], ["a", "b"]]);
  });

  test("runTools maxConcurrency caps otherwise safe dispatch", async () => {
    const safe = testTool({
      name: "Read",
      isConcurrencySafe: () => true,
    });
    let active = 0;
    let peak = 0;

    const seen: string[] = [];
    for await (const update of runTools(
      [block("a", "Read", {}), block("b", "Read", {}), block("c", "Read", {})],
      [call("a", "Read"), call("b", "Read"), call("c", "Read")],
      {
        registry: registry([safe]),
        runToolUseFn: async (toolCall) => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return { content: `ok-${toolCall.id}` };
        },
        initialContext: null,
        maxConcurrency: 1,
      },
    )) {
      if (update.update?.kind === "result") {
        seen.push(update.update.result.toolCall.id);
      }
    }

    expect(seen).toEqual(["a", "b", "c"]);
    expect(peak).toBe(1);
  });
});
