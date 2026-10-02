import { describe, expect, test, vi } from "vitest";

import { OllamaProvider } from "../../src/llm/providers/ollama/adapter.js";
import type { LLMProviderTraceEvent } from "../../src/llm/types.js";
import { runTurn } from "../../src/session/run-turn.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";

describe("Ollama plan mode", () => {
  test("sends the turn when plan mode sets toolChoice required", async () => {
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
        message: { role: "assistant", content: "Need a file first." },
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

    let failure: unknown;
    try {
      await drain(runTurn(session, {
        ...ctx,
        config: { ...ctx.config, maxTurns: 6 },
      }, "plan the change"));
    } catch (error) {
      failure = error;
    }

    expect(requests.length).toBeGreaterThan(0);
    expect(requests[0]?.tools).toEqual([
      expect.objectContaining({
        function: expect.objectContaining({ name: "FileRead" }),
      }),
    ]);
    expect(requests[0]).not.toHaveProperty("tool_choice");
    expect(traces.find((event) => event.kind === "request")?.context).toMatchObject({
      requestedToolChoice: "required",
      effectiveToolChoice: "auto",
    });
    const message = failure instanceof Error ? failure.message : "";
    expect(message).not.toMatch(/unsupported provider capability/u);
  });
});
