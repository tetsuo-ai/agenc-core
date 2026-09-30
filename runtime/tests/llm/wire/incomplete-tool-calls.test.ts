import { describe, expect, test } from "vitest";
import { incompleteToolCallIdentities, MAX_INCOMPLETE_TOOL_CALLS } from "../../../src/llm/wire/incomplete-tool-calls.js";
import { encodeMcpToolNameForWire } from "../../../src/llm/wire/mcp-tool-naming.js";
import { parseChatCompletionsResponse } from "../../../src/llm/wire/chat-completions.js";
import { parseOpenAIResponsesResponse } from "../../../src/llm/wire/responses-openai.js";

const tools = ["Write", "mcp.server.search"].map(name => ({ type: "function" as const,
  function: { name, description: "Synthetic tool", parameters: { type: "object" } } }));
const names = tools.map(tool => tool.function.name);
const request = { model: "test-model", messages: [], tools };
const identity = { id: "call-one", name: "Write" };

describe("bounded non-executable incomplete tool identities", () => {
  test("retains only id/name without reading argument bytes", () => {
    const raw = { ...identity, get arguments(): never { throw new Error("arguments accessed"); } };
    expect(incompleteToolCallIdentities([raw], "identity", names)).toEqual([identity]);
  });

  test("decodes only an advertised MCP name and preserves namespace identity", () => {
    const raw = { id: "call-one", function: { name: encodeMcpToolNameForWire("mcp.server.search") } };
    const result = incompleteToolCallIdentities([raw], "chat", names, "attempt-one");
    expect(result).toEqual([{ id: expect.stringMatching(/^call_[a-f0-9]{32}$/u), name: "mcp.server.search" }]);
    expect(result).toEqual(incompleteToolCallIdentities([raw], "chat", names, "attempt-one"));
    expect(result).not.toEqual(incompleteToolCallIdentities([raw], "chat", names, "attempt-two"));
  });

  test.each([
    null, {}, [null], [false], [{ name: "Write" }], [{ id: "", name: "Write" }],
    [{ id: "x".repeat(257), name: "Write" }], [{ id: "control\n", name: "Write" }],
    [{ id: "call-one", name: "Unknown" }], [{ id: "call-one", name: "x".repeat(257) }],
    [identity, identity], [identity, { id: identity.id, name: "mcp.server.search" }],
    Array.from({ length: MAX_INCOMPLETE_TOOL_CALLS + 1 }, (_, index) => ({ id: `call-${index}`, name: "Write" })),
  ])("omits malformed or ambiguous batch %#", raw => {
    expect(incompleteToolCallIdentities(raw, "identity", names)).toEqual([]);
  });

  test("allows distinct calls of the same advertised tool at the exact count bound", () => {
    const raw = Array.from({ length: MAX_INCOMPLETE_TOOL_CALLS }, (_, index) => ({ id: `call-${index}`, name: "Write" }));
    expect(incompleteToolCallIdentities(raw, "identity", names)).toEqual(raw);
  });

  test.each(["length", "content_filter", "error", "stop"])("Chat %s retains identities only at length", finish => {
    const result = parseChatCompletionsResponse("test-model", { choices: [{ finish_reason: finish, message: {
      role: "assistant", content: "", tool_calls: [{ id: identity.id, type: "function",
        function: { name: "Write", arguments: finish === "stop" ? "{}" : '{"unfinished":' } }],
    } }] }, request);
    expect(result.incompleteToolCalls).toEqual(finish === "length" ? [identity] : undefined);
    if (finish !== "stop") expect(result.toolCalls).toEqual([]);
  });

  test.each(["max_output_tokens", "content_filter", "error", "unknown"])("Responses incomplete %s retains identities only at length", reason => {
    const result = parseOpenAIResponsesResponse("test-model", { status: "incomplete", incomplete_details: { reason },
      output: [{ type: "function_call", call_id: identity.id, name: "Write", arguments: '{"unfinished":' }] }, request);
    expect(result.incompleteToolCalls).toEqual(reason === "max_output_tokens" ? [identity] : undefined);
    expect(result.toolCalls).toEqual([]);
    expect(JSON.stringify(result.incompleteToolCalls ?? [])).not.toContain("unfinished");
  });

  const responseItem = { type: "function_call", id: "item-one", call_id: "call-one", name: "Write" };
  const lengthResponse = (output: unknown[]) => parseOpenAIResponsesResponse("test-model", {
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output,
    usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
  }, request);
  const assertLength = (output: unknown[], expected: typeof identity[] | undefined) => {
    expect(incompleteToolCallIdentities(output, "responses", names)).toEqual(expected ?? []);
    const result = lengthResponse(output);
    expect(result.incompleteToolCalls).toEqual(expected);
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("length");
    expect(result.usage).toMatchObject({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
  };
  test.each([undefined, null, false, 1, {}, [], "", "x".repeat(257), "bad\nid"])(
    "Responses explicitly malformed call_id %# cannot fall back to valid item.id", call_id => {
      assertLength([{ ...responseItem, call_id }], undefined);
    },
  );
  test.each([undefined, null, false, 1, {}, [], "", "x".repeat(257), "bad\nid"])(
    "Responses explicitly malformed item.id %# cannot accompany a valid call_id", id => {
      assertLength([{ ...responseItem, id }], undefined);
    },
  );
  test("Responses absent call_id uses the supplied valid item ID without accessing arguments", () => {
    const { call_id: _call, ...withoutCall } = responseItem;
    assertLength([{ ...withoutCall, get arguments(): never { throw new Error("argument bytes inspected"); } }],
      [{ id: "item-one", name: "Write" }]);
  });
  test("Responses absent item.id leaves a valid explicit call identity unchanged", () => {
    const { id: _item, ...withoutItem } = responseItem;
    assertLength([withoutItem], [identity]);
  });
  test.each(["call-one", "call-two"])("Responses duplicate item ID with call_id %s omits the whole batch", call_id => {
    assertLength([responseItem, { ...responseItem, call_id }], undefined);
  });
  test("Responses duplicate logical ID across explicit/omitted call_id is ambiguous", () => {
    assertLength([responseItem, { type: "function_call", id: "call-one", name: "Write" }], undefined);
  });
  test("Responses distinct supplied item/call IDs remain a bounded diagnostic batch", () => {
    assertLength([responseItem, { ...responseItem, id: "item-two", call_id: "call-two" }],
      [identity, { id: "call-two", name: "Write" }]);
  });
  test.each(["message", "reasoning"])("Responses %s item ID cannot also identify a function, in either order", type => {
    const other = { type, id: "item-one", get content(): never { throw new Error("other payload inspected"); } };
    // Helper occupancy checks never need message/reasoning payload content.
    expect(incompleteToolCallIdentities([other, responseItem], "responses", names)).toEqual([]);
    expect(incompleteToolCallIdentities([responseItem, other], "responses", names)).toEqual([]);
    assertLength([{ type, id: "item-one" }, responseItem], undefined);
    assertLength([responseItem, { type, id: "item-one" }], undefined);
    assertLength([{ type, id: "unrelated" }, responseItem], [identity]);
  });
  test.each([undefined, null, false, 1, {}, [], "", "message", "custom"])(
    "Chat supplied non-function type %# omits diagnostics without changing terminal usage", type => {
      const toolCall = { ...identity, type, function: { name: "Write", arguments: '{"unfinished":' } };
      expect(incompleteToolCallIdentities([toolCall], "chat", names)).toEqual([]);
      const result = parseChatCompletionsResponse("test-model", { choices: [{ finish_reason: "length", message: {
        content: "", tool_calls: [toolCall],
      } }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, request);
      expect(result.incompleteToolCalls).toBeUndefined();
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).toBe("length");
      expect(result.usage).toMatchObject({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
    },
  );
  test("Chat absent type remains explicit legacy compatibility", () => {
    const toolCall = { id: "call-one", function: { name: "Write" } };
    expect(incompleteToolCallIdentities([toolCall], "chat", names)).toEqual([identity]);
    expect(incompleteToolCallIdentities([{ ...toolCall, type: "function" }], "chat", names)).toEqual([identity]);
  });
});
