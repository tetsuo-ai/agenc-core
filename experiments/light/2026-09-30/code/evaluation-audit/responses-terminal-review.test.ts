import { describe, expect, test, vi } from "/private/tmp/light-ultra/core/node_modules/vitest/dist/index.js";
import { OpenAIProvider } from "/private/tmp/light-takeover/startup-core/runtime/src/llm/providers/openai/adapter.ts";
import { parseOpenAIResponsesResponse } from "/private/tmp/light-takeover/startup-core/runtime/src/llm/wire/responses-openai.ts";

const item = { type: "function_call", call_id: "review-call", name: "Write", arguments: '{"content":"synthetic"}' };
const request = { model: "gpt-6-luna", messages: [{ role: "user" as const, content: "Synthetic only." }],
  tools: [{ type: "function" as const, function: { name: "Write", parameters: { type: "object" } } }] };
const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function stream(parts: string[]) {
  const chunks: Array<{ toolCalls?: unknown[] }> = [];
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({
    start(controller) { for (const part of parts) controller.enqueue(new TextEncoder().encode(part)); controller.close(); },
  }), { headers: { "content-type": "text/event-stream" } }));
  const provider = new OpenAIProvider({ apiKey: "synthetic-test-only", model: "gpt-6-luna", useResponsesApi: true, fetchImpl });
  let result, error;
  try { result = await provider.chatStream(request.messages, chunk => chunks.push(chunk), { tools: request.tools, singleWireAttempt: true }); }
  catch (caught) { error = caught; }
  expect(fetchImpl).toHaveBeenCalledOnce();
  return { result, error, chunks };
}

describe("independent Responses terminal safety review", () => {
  test.each([["completed"], { status: "completed" }, true, 1, null])("standalone non-string status is not success: %j", status => {
    const result = parseOpenAIResponsesResponse(request.model, { status, output: [item] }, request);
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("error");
  });

  test("streaming non-string completed status cannot regain success in the parser", async () => {
    const observed = await stream([
      frame("response.output_item.done", { type: "response.output_item.done", item }),
      frame("response.completed", { type: "response.completed", response: { status: ["completed"], output: [item], usage: { input_tokens: 5, output_tokens: 2 } } }),
    ]);
    expect(observed.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    expect(observed.result?.toolCalls ?? []).toEqual([]);
  });

  test("contradictory explicit SSE event and JSON type cannot authorize legacy missing-status success", async () => {
    const observed = await stream([
      frame("response.output_item.done", { type: "response.output_item.done", item }),
      frame("response.completed", { type: "response.incomplete", response: { output: [item], incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 5, output_tokens: 2 } } }),
    ]);
    expect(observed.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    expect(observed.result?.toolCalls ?? []).toEqual([]);
  });

  test("positive explicit completed event still emits a validated call", async () => {
    const observed = await stream([
      frame("response.output_item.done", { type: "response.output_item.done", item }),
      frame("response.completed", { type: "response.completed", response: { status: "completed", output: [item], usage: { input_tokens: 5, output_tokens: 2 } } }),
    ]);
    expect(observed.error).toBeUndefined();
    expect(observed.result?.toolCalls).toEqual([{ id: item.call_id, name: item.name, arguments: item.arguments }]);
    expect(observed.result?.usage).toMatchObject({ promptTokens: 5, completionTokens: 2 });
  });

  test("array terminal response is not a legacy completed object", async () => {
    const observed = await stream([
      frame("response.output_item.done", { type: "response.output_item.done", item }),
      frame("response.completed", { type: "response.completed", response: [] }),
    ]);
    expect(observed.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    expect(observed.result?.toolCalls ?? []).toEqual([]);
  });

  test.each([null, {}, "malformed"])("explicit malformed terminal output cannot become omitted-output fallback: %j", output => {
    return stream([
      frame("response.output_item.done", { type: "response.output_item.done", item }),
      frame("response.completed", { type: "response.completed", response: { status: "completed", output } }),
    ]).then(observed => {
      expect(observed.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
      expect(observed.result?.toolCalls ?? []).toEqual([]);
    });
  });

  test("explicit error event before a completed event cannot be forgotten", async () => {
    const observed = await stream([
      frame("response.output_item.done", { type: "response.output_item.done", item }),
      frame("error", { type: "error", code: "invalid_request_error", message: "Synthetic stream error", status: 400 }),
      frame("response.completed", { type: "response.completed", response: { status: "completed", output: [item] } }),
    ]);
    expect(observed.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
    expect(observed.result?.toolCalls ?? []).toEqual([]);
  });
});
