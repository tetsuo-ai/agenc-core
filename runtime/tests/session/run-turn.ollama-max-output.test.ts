import { describe, expect, test, vi } from "vitest";

import { OllamaProvider } from "../../src/llm/providers/ollama/adapter.js";
import type { LLMProviderTraceEvent } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { MAX_OUTPUT_TOKENS_ESCALATED } from "../../src/recovery/max-output-tokens.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { Terminal } from "../../src/session/turn-state.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { mkCtx, mkSession } from "../fixtures.js";

function numPredict(request: Record<string, unknown>): number | undefined {
  const options = request.options;
  if (typeof options !== "object" || options === null) return undefined;
  const value = (options as { num_predict?: unknown }).num_predict;
  return typeof value === "number" ? value : undefined;
}

describe("Ollama max-output recovery", () => {
  test("retries a truncated named tool choice instead of failing the catalog check", async () => {
    const requests: Record<string, unknown>[] = [];
    const traces: LLMProviderTraceEvent[] = [];
    const registry = {
      tools: [],
      toLLMTools: () => [{
        type: "function" as const,
        function: {
          name: "spawn_agent",
          description: "Spawn a worker",
          parameters: { type: "object", properties: {} },
        },
      }],
      dispatch: vi.fn(async () => ({ content: "unused" })),
    } as unknown as ToolRegistry;
    const provider = new OllamaProvider({ model: "test-model" });
    const chat = vi.fn(async function* (request: Record<string, unknown>) {
      requests.push(request);
      if (requests.length === 1) {
        yield {
          model: "test-model",
          message: {
            role: "assistant",
            content: "partial",
            tool_calls: [{
              function: { name: "spawn_agent", arguments: { task: "build" } },
            }],
          },
          done: true,
          done_reason: "length",
          prompt_eval_count: 8,
          eval_count: 4,
        };
        return;
      }
      yield {
        model: "test-model",
        message: { role: "assistant", content: "recovered" },
        done: true,
        done_reason: "stop",
        prompt_eval_count: 8,
        eval_count: 4,
      };
    });
    Object.assign(provider, { client: { chat, list: async () => ({ models: [] }) } });
    const chatStream = provider.chatStream.bind(provider);
    provider.chatStream = (messages, onChunk, options) => chatStream(messages, onChunk, {
      ...options,
      // The first request names spawn_agent; the retry keeps the turn's own options.
      toolChoice: requests.length === 0 ? { type: "function", name: "spawn_agent" } : options?.toolChoice,
      trace: {
        onProviderTraceEvent: (event) => {
          traces.push(event);
        },
      },
    });
    const base = mkCtx();
    const ctx = mkCtx({
      // Leave the provider id unset. Ollama's local profile hides spawn_agent,
      // and that tool is the session's only named function choice.
      modelInfo: {
        ...base.modelInfo,
        maxOutputTokens: 256,
        maxOutputTokensCappedDefault: true,
      },
    });
    const { session } = mkSession({ provider, registry });

    const yielded: PhaseEvent[] = [];
    const turn = runTurn(session, ctx, "do the parallel work");
    let step = await turn.next();
    while (!step.done) {
      yielded.push(step.value);
      step = await turn.next();
    }
    const terminal: Terminal = step.value;

    expect(requests).toHaveLength(2);
    expect(requests[0]?.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: "spawn_agent" }),
      }),
    ]);
    expect(requests[0]).not.toHaveProperty("tool_choice");
    expect(numPredict(requests[0]!)).toBe(256);
    expect(numPredict(requests[1]!)).toBe(MAX_OUTPUT_TOKENS_ESCALATED);
    expect(traces.filter((event) => event.kind === "request")[0]?.context).toMatchObject({
      requestedToolChoice: "function:spawn_agent",
      effectiveToolChoice: "function:spawn_agent",
    });
    expect(terminal).toMatchObject({ reason: "completed" });
    expect(terminal.error).toBeUndefined();
    expect(yielded.filter((event) => event.type === "turn_complete")).toEqual([
      expect.objectContaining({
        type: "turn_complete",
        stopReason: "completed",
        content: "recovered",
      }),
    ]);
  });
});
