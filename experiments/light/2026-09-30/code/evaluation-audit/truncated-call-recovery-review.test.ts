import { describe, expect, test } from "/private/tmp/light-ultra/core/node_modules/vitest/dist/index.js";
import { OpenAIProvider } from "/private/tmp/light-takeover/startup-core/runtime/src/llm/providers/openai/adapter.ts";
import { incompleteToolCallIdentities } from "/private/tmp/light-takeover/startup-core/runtime/src/llm/wire/incomplete-tool-calls.ts";

const tools = ["Write", "Read"].map(name => ({ type: "function" as const,
  function: { name, parameters: { type: "object" } } }));
const item = { type: "function_call", id: "item-1", call_id: "call-1", name: "Write", arguments: '{"PRIVATE_PARTIAL":' };
const event = (type: string, value = item, index: unknown = 0) => ({ type, output_index: index, item: value });
const added = "response.output_item.added", done = "response.output_item.done";
async function probe(events: object[]) {
  const chunks: Array<{ toolCalls?: unknown[] }> = [];
  let calls = 0;
  const terminal = { type: "response.incomplete", response: { status: "incomplete", output: [],
    incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } } };
  const provider = new OpenAIProvider({ apiKey: "synthetic-unused", model: "test-model", maxRetries: 0,
    useResponsesApi: true, fetchImpl: async () => {
      calls++;
      return new Response([...events, terminal].map(value => `data: ${JSON.stringify(value)}\n\n`).join(""),
        { headers: { "content-type": "text/event-stream" } });
    } });
  const result = await provider.chatStream([{ role: "user", content: "Synthetic only" }], chunk => chunks.push(chunk),
    { tools, singleWireAttempt: true });
  expect(calls).toBe(1);
  expect(result.toolCalls).toEqual([]);
  expect(chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
  expect(result.usage).toMatchObject({ promptTokens: 2, completionTokens: 3 });
  expect(JSON.stringify(result.incompleteToolCalls)).not.toContain("PRIVATE_PARTIAL");
  return result;
}

describe("independent bounded recovery diagnostic review", () => {
  test("valid matching added/done keeps only identity", async () => {
    expect((await probe([event(added), event(done)])).incompleteToolCalls)
      .toEqual([{ id: "call-1", name: "Write" }]);
  });
  test("same output item changing call_id must omit the ambiguous batch", async () => {
    expect((await probe([event(added), event(done, { ...item, call_id: "call-2" })])).incompleteToolCalls).toBeUndefined();
  });
  test("same output index assigned two distinct items must omit the ambiguous batch", async () => {
    expect((await probe([event(added), event(added, { ...item, id: "item-2", call_id: "call-2", name: "Read" })])).incompleteToolCalls).toBeUndefined();
  });
  test("same item id assigned two distinct output slots must omit the ambiguous batch", async () => {
    expect((await probe([event(added), event(added, { ...item, call_id: "call-2" }, 1)])).incompleteToolCalls).toBeUndefined();
  });
  test.each([-1, "0", null])("malformed explicit output_index=%j must not supply a fallback identity", async index => {
    expect((await probe([event(added, item, index)])).incompleteToolCalls).toBeUndefined();
  });
  test("32 identity-only records omit arguments without invoking getters", () => {
    const rows = Array.from({ length: 32 }, (_, i) => ({ id: `call-${i}`, name: "Write",
      get arguments(): never { throw new Error("arguments inspected"); } }));
    expect(incompleteToolCallIdentities(rows, "identity", ["Write"]))
      .toEqual(rows.map(({ id, name }) => ({ id, name })));
  });
});
