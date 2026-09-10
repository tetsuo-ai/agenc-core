import { describe, expect, test, vi } from "vitest";
import { projectProviderAccountingRequest } from "../../../../src/budget/admitted-model-call.js";
import { OllamaProvider } from "../../../../src/llm/providers/ollama/adapter.js";
import { validateToolTurnSequence } from "../../../../src/llm/tool-turn-validator.js";
import type { LLMMessage, LLMTool } from "../../../../src/llm/types.js";

const tool: LLMTool = { type: "function", function: {
  name: "mcp.qa-helper.lookup_marker",
  description: "Read the verification marker",
  parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
} };

describe("Ollama mixed assistant history projection", () => {
  test.each([
    { streaming: false, content: "I will read both markers." },
    { streaming: true, content: "I will read both markers." },
    { streaming: false, content: [] },
    { streaming: true, content: [] },
  ])("native accounting and wire preserve prose, calls and pairing (%j)", async ({ streaming, content }) => {
    const requests: Record<string, any>[] = [];
    const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", tools: [tool] });
    Object.assign(provider, { client: {
      show: vi.fn(async () => ({ capabilities: ["completion", "tools"] })),
      chat: vi.fn(async (request: Record<string, any>) => {
        requests.push(request);
        const response = { message: { content: "Done" }, done: true, done_reason: "stop" };
        return request.stream ? (async function* () { yield response; })() : response;
      }),
    } });
    const calls = [
      { id: "lookup-1", name: tool.function.name, arguments: '{"key":"first"}' },
      { id: "lookup-2", name: tool.function.name, arguments: '{"key":"second"}' },
    ];
    const messages: LLMMessage[] = [
      { role: "user", content: "Read the markers" },
      { role: "assistant", content, toolCalls: calls },
      ...calls.map(call => ({ role: "tool" as const, content: "untrusted marker", toolCallId: call.id, toolName: call.name })),
    ];
    const before = structuredClone(messages);
    const profile = await provider.getExecutionProfile({});
    const options = { providerExecutionHandle: profile.providerExecutionHandle };
    const projected = projectProviderAccountingRequest(provider, messages, options);
    expect(() => validateToolTurnSequence(projected.messages, { providerName: "ollama" })).not.toThrow();
    const callIndex = content.length > 0 ? 2 : 1;
    if (content.length > 0) expect(projected.messages[1]).toEqual({ role: "assistant", content });
    expect(projected.messages[callIndex]).toEqual({ role: "assistant", content: "", toolCalls: calls.map(call => ({
      ...call, name: "mcp__qa-helper__lookup_marker",
    })) });

    if (streaming) await provider.chatStream(messages, () => {}, options);
    else await provider.chat(messages, options);

    const wire = requests[0]?.messages;
    expect(wire).toHaveLength(projected.messages.length);
    expect(wire.slice(0, callIndex)).toEqual(projected.messages.slice(0, callIndex));
    expect(wire[callIndex]).toEqual({ role: "assistant", content: "", tool_calls: [
      { function: { name: "mcp__qa-helper__lookup_marker", arguments: { key: "first" } } },
      { function: { name: "mcp__qa-helper__lookup_marker", arguments: { key: "second" } } },
    ] });
    expect(wire.slice(callIndex + 1)).toEqual(calls.map(call => ({
      role: "tool", content: "untrusted marker", tool_call_id: call.id, tool_name: "mcp__qa-helper__lookup_marker",
    })));
    expect(requests[0]?.tools).toEqual(projected.options.tools);
    expect(messages).toEqual(before);
  });
});
