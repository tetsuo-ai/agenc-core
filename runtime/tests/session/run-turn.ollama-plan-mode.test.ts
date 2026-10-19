import { describe, expect, test, vi } from "vitest";

import { OllamaProvider } from "../../src/llm/providers/ollama/adapter.js";
import type { LLMProviderTraceEvent } from "../../src/llm/types.js";
import type { PhaseEvent } from "../../src/phases/events.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { Terminal } from "../../src/session/turn-state.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { mkCtx, mkSession } from "../fixtures.js";

describe("Ollama plan mode", () => {
  test("allows an answer with the catalog without forcing tool_choice", async () => {
    const requests: Record<string, unknown>[] = [];
    const traces: LLMProviderTraceEvent[] = [];
    const registry = {
      tools: [],
      toLLMTools: () => [{
        type: "function" as const,
        function: {
          name: "FileRead",
          description: "Read a file",
          parameters: { type: "object", properties: {} },
        },
      }],
      dispatch: vi.fn(async () => ({ content: "unused" })),
    } as unknown as ToolRegistry;
    const provider = new OllamaProvider({ model: "test-model" });
    const chat = vi.fn(async function* (request: Record<string, unknown>) {
      requests.push(request);
      yield {
        model: "test-model",
        message: { role: "assistant", content: "No changes are needed." },
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
      trace: {
        onProviderTraceEvent: (event) => {
          traces.push(event);
        },
      },
    });
    const { session } = mkSession({ provider, registry });
    await session.permissionModeRegistry.update({
      ...session.permissionModeRegistry.current(),
      mode: "plan",
    });
    const ctx = mkCtx({ permissionMode: "plan", modelProviderId: "ollama" });

    const yielded: PhaseEvent[] = [];
    const turn = runTurn(session, {
      ...ctx,
      config: { ...ctx.config, maxTurns: 6 },
    }, "plan the change");
    let step = await turn.next();
    while (!step.done) {
      yielded.push(step.value);
      step = await turn.next();
    }
    const terminal: Terminal = step.value;

    const catalog = [
      expect.objectContaining({
        function: expect.objectContaining({ name: "FileRead" }),
      }),
    ];
    expect(requests).toHaveLength(1);
    for (const request of requests) {
      expect(request.tools).toEqual(catalog);
      expect(request).not.toHaveProperty("tool_choice");
    }
    const requestTraces = traces.filter((event) => event.kind === "request");
    expect(requestTraces).toHaveLength(requests.length);
    for (const event of requestTraces) {
      expect(event.context).toMatchObject({
        requestedToolChoice: "auto",
        effectiveToolChoice: "auto",
      });
    }
    expect(terminal).toMatchObject({ reason: "completed" });
    expect(terminal.error).toBeUndefined();
    expect(yielded.filter((event) => event.type === "turn_complete")).toEqual([
      expect.objectContaining({ type: "turn_complete", stopReason: "completed", content: "No changes are needed." }),
    ]);
  });
});
