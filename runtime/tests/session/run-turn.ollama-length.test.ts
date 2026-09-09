import { describe, expect, test, vi } from "vitest";
import { classifyTurnTerminal } from "../../src/contracts/turn-terminal.js";
import { OllamaProvider } from "../../src/llm/providers/ollama/adapter.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

describe("native Ollama output truncation", () => {
  test.each([
    { persistent: false, withTool: false },
    { persistent: true, withTool: false },
    { persistent: false, withTool: true },
    { persistent: true, withTool: true },
  ])("uses bounded recovery rather than completing truncated commentary ($persistent persistent, $withTool tool)", async ({ persistent, withTool }) => {
    let samples = 0;
    const execute = vi.fn(async () => ({ content: "must not execute", isError: false }));
    const registry = {
      tools: [{
        name: "edit_file",
        description: "Edit a file",
        inputSchema: { type: "object" },
        requiresApproval: false,
        execute,
      }],
      toLLMTools: () => [],
      dispatch: execute,
    } as unknown as ToolRegistry;
    const provider = new OllamaProvider({ model: "test-model" });
    const chat = vi.fn(async function* () {
      samples += 1;
      const truncated = persistent || samples === 1;
      yield {
        model: "test-model",
        message: {
          role: "assistant",
          content: truncated ? "Now I need to modify the tests:" : "Finished after recovery.",
          ...(truncated && withTool ? {
            tool_calls: [{ function: { name: "edit_file", arguments: { path: "tests.ts" } } }],
          } : {}),
        },
        done: true,
        done_reason: truncated ? "length" : "stop",
        prompt_eval_count: 128,
        eval_count: truncated ? 4_096 : 10,
      };
    });
    Object.assign(provider, { client: { chat, list: async () => ({ models: [] }) } });
    const { session, events } = mkSession({ provider, registry });
    const ctx = mkCtx();

    await drain(runTurn(session, {
      ...ctx,
      config: { ...ctx.config, maxTurns: 10 },
      modelInfo: {
        ...ctx.modelInfo,
        maxOutputTokens: 4_096,
        maxOutputTokensExplicit: true,
      },
    }, "implement the tests"));

    expect(samples).toBe(persistent ? 4 : 2);
    expect(execute).not.toHaveBeenCalled();
    const terminals = events.flatMap((event) => {
      const terminal = classifyTurnTerminal(event.msg);
      return terminal === undefined ? [] : [terminal];
    });
    expect(terminals).toEqual([expect.objectContaining({
      outcome: persistent ? "errored" : "completed",
      code: persistent ? 1 : 0,
    })]);
    if (!persistent) expect(terminals[0]?.message).toBe("Finished after recovery.");
  });
});
