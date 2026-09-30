import { describe, expect, test } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import type { LLMStreamChunk } from "../../../../src/llm/types.js";

const tools = ["Write", "Read"].map(name => ({ type: "function" as const,
  function: { name, description: "Synthetic", parameters: { type: "object" } } }));
const item = { type: "function_call", id: "item-1", call_id: "call-1", name: "Write", arguments: '{"partial":' };
const frame = (event: Record<string, unknown>) => `data: ${JSON.stringify(event)}\n\n`;

async function probe(events: Record<string, unknown>[], responses: boolean) {
  const chunks: LLMStreamChunk[] = [];
  const provider = new OpenAIProvider({ apiKey: "synthetic-unused", model: "test-model", useResponsesApi: responses, maxRetries: 0,
    fetchImpl: async () => new Response(events.map(frame).join("") + (responses ? "" : "data: [DONE]\n\n"),
      { headers: { "content-type": "text/event-stream" } }) });
  const result = await provider.chatStream([{ role: "user", content: "Synthetic" }], chunk => chunks.push(chunk),
    { tools, singleWireAttempt: true });
  expect(result.toolCalls).toEqual([]);
  expect(chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
  expect(result.usage).toMatchObject({ promptTokens: 1, completionTokens: 1 });
  expect(JSON.stringify(result.incompleteToolCalls ?? [])).not.toContain("partial");
  return result;
}
const added = (value = item, index = 0) => ({ type: "response.output_item.added", output_index: index, item: value });
const end = (output: unknown[] = [], reason = "max_output_tokens") => ({ type: "response.incomplete",
  response: { status: "incomplete", output, incomplete_details: { reason }, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });

describe("streamed identity-only truncation diagnostics", () => {
  test("Responses keeps a valid started identity when terminal output omits it, not its arguments", async () => {
    const result = await probe([added(), end()], true);
    expect(result.incompleteToolCalls).toEqual([{ id: "call-1", name: "Write" }]);
    expect(JSON.stringify(result.incompleteToolCalls)).not.toContain("partial");
  });
  test("Responses terminal set is authoritative over an otherwise valid stale start", async () => {
    const result = await probe([added(), end([{ ...item, id: "item-2", call_id: "call-2", name: "Read" }])], true);
    expect(result.incompleteToolCalls).toEqual([{ id: "call-2", name: "Read" }]);
  });
  test.each([
    [added({ ...item, name: "Unknown" })],
    [added({ ...item, call_id: "" })],
    [added(), added({ ...item, name: "Read" })],
    [added(), added({ ...item, id: "item-2" }, 1)],
    [added(), added()],
    Array.from({ length: 33 }, (_, i) => added({ ...item, id: `item-${i}`, call_id: `call-${i}` }, i)),
  ].map(events => ({ events })))("omits ambiguous/invalid/excessive Responses starts %#", async ({ events }) => {
    expect((await probe([...events, end()], true)).incompleteToolCalls).toBeUndefined();
  });
  test("filter terminal does not convert a valid start into length recovery", async () => {
    expect((await probe([added(), end([], "content_filter")], true)).incompleteToolCalls).toBeUndefined();
  });
  test("consistent added/done identity remains diagnostic at length", async () => {
    expect((await probe([added(), { ...added(), type: "response.output_item.done" }, end()], true)).incompleteToolCalls)
      .toEqual([{ id: "call-1", name: "Write" }]);
  });

  const outputEvent = (value: Record<string, unknown>, index: unknown = 0, type = "response.output_item.done") =>
    ({ type, output_index: index, item: value });
  test.each([
    [added(), outputEvent({ ...item, call_id: "call-2" })],
    [added(), added({ ...item, id: "item-2", call_id: "call-2", name: "Read" })],
    [added(), added({ ...item, call_id: "call-2" }, 1)],
    [added(), outputEvent({ ...item, id: "item-2" })],
    [added(), outputEvent(item, 1)],
  ].map(events => ({ events })))("Responses rejects contradictory call/item/slot bindings %#", async ({ events }) => {
    expect((await probe([...events, end()], true)).incompleteToolCalls).toBeUndefined();
  });
  test.each([-1, "0", null, false, {}, [], 0.5, Number.MAX_SAFE_INTEGER + 1])(
    "Responses rejects malformed explicit slot %j", async index => {
      expect((await probe([outputEvent(item, index), end()], true)).incompleteToolCalls).toBeUndefined();
    },
  );
  test.each([null, false, 1, {}, [], "", "x".repeat(257), "bad\nitem"])(
    "Responses rejects malformed explicit item ID %#", async id => {
      expect((await probe([outputEvent({ ...item, id }), end()], true)).incompleteToolCalls).toBeUndefined();
    },
  );
  test.each([null, false, 1, {}, [], "", "x".repeat(257)])(
    "Responses rejects malformed explicit call ID %#", async call_id => {
      expect((await probe([outputEvent({ ...item, call_id }), end()], true)).incompleteToolCalls).toBeUndefined();
    },
  );
  test("omitted metadata preserves known item and slot, including across a later contradiction", async () => {
    const onlyCall = { type: "response.output_item.done", item: { type: "function_call", call_id: "call-1", name: "Write" } };
    expect((await probe([added(), onlyCall, end()], true)).incompleteToolCalls).toEqual([{ id: "call-1", name: "Write" }]);
    for (const conflicting of [outputEvent({ ...item, id: "changed" }), outputEvent(item, 1),
      outputEvent({ ...item, call_id: "changed" })]) {
      expect((await probe([added(), onlyCall, conflicting, end()], true)).incompleteToolCalls).toBeUndefined();
    }
  });
  test("initially absent metadata can be supplied consistently without inventing a new identity", async () => {
    const onlyCall = { type: "response.output_item.added", item: { type: "function_call", call_id: "call-1", name: "Write" } };
    expect((await probe([onlyCall, outputEvent(item), end()], true)).incompleteToolCalls).toEqual([{ id: "call-1", name: "Write" }]);
    expect((await probe([onlyCall, outputEvent(item), outputEvent({ ...item, call_id: "other" }), end()], true)).incompleteToolCalls).toBeUndefined();
  });
  test("omitted call_id may use only the actual supplied item ID compatibility identity", async () => {
    const { call_id: _call, ...withoutCall } = item;
    expect((await probe([outputEvent(withoutCall), end()], true)).incompleteToolCalls).toEqual([{ id: "item-1", name: "Write" }]);
    // A later different explicit call ID contradicts that established binding.
    expect((await probe([outputEvent(withoutCall), outputEvent(item), end()], true)).incompleteToolCalls).toBeUndefined();
  });
  test("distinct function identities retain independent slots", async () => {
    const second = { ...item, id: "item-2", call_id: "call-2", name: "Read" };
    expect((await probe([added(), added(second, 1), outputEvent(item), outputEvent(second, 1), end()], true)).incompleteToolCalls)
      .toEqual([{ id: "call-1", name: "Write" }, { id: "call-2", name: "Read" }]);
  });
  test.each(["message", "reasoning"])("%s item/slot reuse invalidates diagnostics in either order", async type => {
    for (const other of [outputEvent({ type, id: "item-1" }, 1), outputEvent({ type, id: "other" }, 0)]) {
      for (const events of [[added(), other], [other, added()]]) {
        expect((await probe([...events, end()], true)).incompleteToolCalls).toBeUndefined();
      }
    }
    expect((await probe([outputEvent({ type, id: "other" }, 1), added(), end()], true)).incompleteToolCalls)
      .toEqual([{ id: "call-1", name: "Write" }]);
  });
  test("non-function occupancy bookkeeping stays bounded", async () => {
    const others = Array.from({ length: 33 }, (_, i) => outputEvent({ type: "message", id: `other-${i}` }, i + 1));
    expect((await probe([...others, added(), end()], true)).incompleteToolCalls).toBeUndefined();
  });

  const delta = (value: Record<string, unknown>) => ({ choices: [{ index: 0, delta: { tool_calls: [value] }, finish_reason: null }] });
  const chatEnd = { choices: [{ index: 0, delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
  const first = { index: 0, id: "call-1", function: { name: "Write", arguments: '{"partial":' } };
  test("Chat identity survives argument-only continuation", async () => {
    const result = await probe([delta(first), delta({ index: 0, function: { arguments: "123" } }), chatEnd], false);
    expect(result.incompleteToolCalls).toEqual([{ id: "call-1", name: "Write" }]);
  });
  test.each(["custom", null, false, 1, {}, []])("Chat explicit non-function kind %j stays invalid after a later valid kind", async type => {
    const result = await probe([delta({ ...first, type }),
      delta({ index: 0, type: "function", function: { arguments: "123" } }), chatEnd], false);
    expect(result.incompleteToolCalls).toBeUndefined();
  });
  test("Chat explicit function kind permits later omitted kind compatibility", async () => {
    const result = await probe([delta({ ...first, type: "function" }),
      delta({ index: 0, function: { arguments: "123" } }), chatEnd], false);
    expect(result.incompleteToolCalls).toEqual([{ id: "call-1", name: "Write" }]);
  });
  test.each([
    { index: 0, id: "different" }, { index: 0, function: { name: "Read" } },
    { index: 0, id: false }, { index: 0, function: { name: null } },
    { function: { arguments: "123" } }, { index: -1, id: "call-2", function: { name: "Read" } },
    { index: 1, id: "call-1", function: { name: "Read" } },
  ])("Chat rejects ambiguous identity delta %#", async change => {
    expect((await probe([delta(first), delta(change), chatEnd], false)).incompleteToolCalls).toBeUndefined();
  });
});
