import { describe, expect, test } from "/private/tmp/light-ultra/core/node_modules/vitest/dist/index.js";
import { incompleteToolCallIdentities as identities } from "/private/tmp/light-takeover/startup-core/runtime/src/llm/wire/incomplete-tool-calls.ts";
import { OpenAIProvider } from "/private/tmp/light-takeover/startup-core/runtime/src/llm/providers/openai/adapter.ts";
const names = ["Write", "Read"];
const call = { type: "function_call", id: "item-1", call_id: "call-1", name: "Write" };

describe("independent final incomplete identity boundaries", () => {
  test("supplied null call ID does not mean absent", () => {
    expect(identities([{ ...call, call_id: null }], "responses", names)).toEqual([]);
  });
  test("absent call ID can use a real supplied item ID", () => {
    const { call_id: _unused, ...withoutCall } = call;
    expect(identities([withoutCall], "responses", names)).toEqual([{ id: "item-1", name: "Write" }]);
  });
  test.each([null, 1, ""])("invalid supplied item ID %j cannot be hidden by valid call ID", id => {
    expect(identities([{ ...call, id }], "responses", names)).toEqual([]);
  });
  test("two calls cannot share a supplied output item ID", () => {
    expect(identities([call, { ...call, call_id: "call-2", name: "Read" }], "responses", names)).toEqual([]);
  });
  test.each(["message", "reasoning"])("%s/function item ID collision is rejected in either order", type => {
    const other = { type, id: "item-1" };
    expect(identities([call, other], "responses", names)).toEqual([]);
    expect(identities([other, call], "responses", names)).toEqual([]);
    expect(identities([{ ...other, id: "other" }, call], "responses", names)).toEqual([{ id: "call-1", name: "Write" }]);
  });
  test.each([null, false, 1, "custom"])("explicit Chat type %j is not a function identity", type => {
    expect(identities([{ type, id: "call-1", function: { name: "Write" } }], "chat", names)).toEqual([]);
  });
  test("missing Chat type is the deliberate compatibility case", () => {
    expect(identities([{ id: "call-1", function: { name: "Write" } }], "chat", names))
      .toEqual([{ id: "call-1", name: "Write" }]);
  });
  test.each(["custom", undefined])("streamed Chat explicit type=%j obeys the same rule", async type => {
    const events = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", ...(type === undefined ? {} : { type }),
        function: { name: "Write", arguments: "{" } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ];
    const chunks: Array<{ toolCalls?: unknown[] }> = [];
    const provider = new OpenAIProvider({ apiKey: "synthetic-unused", model: "test-model", maxRetries: 0,
      useResponsesApi: false, fetchImpl: async () => new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } }) });
    const result = await provider.chatStream([{ role: "user", content: "Synthetic only" }], chunk => chunks.push(chunk),
      { tools: names.map(name => ({ type: "function", function: { name, parameters: { type: "object" } } })), singleWireAttempt: true });
    expect(result.toolCalls).toEqual([]);
    expect(chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    expect(result.incompleteToolCalls).toEqual(type === undefined ? [{ id: "call-1", name: "Write" }] : undefined);
  });
});
