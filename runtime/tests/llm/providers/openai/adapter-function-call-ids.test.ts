import { describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import type { LLMMessage, LLMToolCall } from "../../../../src/llm/types.js";
import { runWithStartupProviderSelection } from "../../../../src/utils/model/providers.js";

const MODEL = "gpt-6-luna";
// Item ids in the shape the OpenAI backend issues; not derivable from the call id.
const ISSUED_STREAM_ID = "fc_0e97423644f1c343016acabc7447308191b58ec08aee27d0ee";
const ISSUED_JSON_ID = "fc_09fa14739110db37016acabc7216cc87d2a390b127d70ae6c8";

function streamedCall(callId: string, id: string) {
  return { type: "function_call", id, call_id: callId, name: "read", arguments: '{"path":"a"}' };
}

function sse(events: ReadonlyArray<Record<string, unknown>>): Response {
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A tool turn as the ChatGPT backend streams it: the completion lists no output. */
function toolTurnStream(callId: string, id: string): Response {
  return sse([
    { type: "response.output_item.done", item: streamedCall(callId, id) },
    { type: "response.completed", response: { id: "resp_1", status: "completed", model: MODEL, output: [] } },
  ]);
}

function answerStream(): Response {
  return sse([
    { type: "response.output_text.delta", delta: "done" },
    { type: "response.completed", response: { id: "resp_2", status: "completed", model: MODEL, output: [] } },
  ]);
}

function json(data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });
}

function history(toolCalls: readonly LLMToolCall[]): LLMMessage[] {
  return [
    { role: "user", content: "read a" },
    { role: "assistant", content: "", toolCalls: [...toolCalls] },
    ...toolCalls.map((call): LLMMessage => ({ role: "tool", toolCallId: call.id, content: "A" })),
  ];
}

function requestText(
  fetchImpl: { readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  call: number,
): string {
  const init = fetchImpl.mock.calls[call]?.[1] as RequestInit | undefined;
  return String(init?.body);
}

function functionCallItems(text: string): Array<Record<string, unknown>> {
  const body = JSON.parse(text) as { input: Array<Record<string, unknown>> };
  return body.input.filter((item) => item.type === "function_call");
}

function inSession<T>(operation: () => Promise<T>): Promise<T> {
  return runWithStartupProviderSelection({ provider: "openai", model: MODEL, environment: {} }, operation);
}

describe("OpenAIProvider function_call item ids in Responses history", () => {
  test("echoes the item id the backend streamed for a call and invents none", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(toolTurnStream("call_1", ISSUED_STREAM_ID))
      .mockResolvedValueOnce(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });

    const first = await inSession(() => provider.chatStream([{ role: "user", content: "read a" }], () => {}));
    await inSession(() => provider.chatStream(history(first.toolCalls), () => {}));

    expect(first.toolCalls).toEqual([{ id: "call_1", name: "read", arguments: '{"path":"a"}' }]);
    const wire = requestText(fetchImpl, 1);
    expect(functionCallItems(wire)).toEqual([
      { type: "function_call", id: ISSUED_STREAM_ID, call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
    ]);
    expect(wire).not.toContain('"fc_1"');
  });

  test("echoes the item id from a non-streaming response", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({
        id: "resp_1", status: "completed", model: MODEL,
        output: [streamedCall("call_2", ISSUED_JSON_ID)],
      }))
      .mockResolvedValueOnce(json({
        id: "resp_2", status: "completed", model: MODEL,
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] }],
      }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });

    const first = await inSession(() => provider.chat([{ role: "user", content: "read a" }]));
    await inSession(() => provider.chat(history(first.toolCalls)));

    expect(functionCallItems(requestText(fetchImpl, 1))).toEqual([
      { type: "function_call", id: ISSUED_JSON_ID, call_id: "call_2", name: "read", arguments: '{"path":"a"}' },
    ]);
  });

  test("sends a call this process never received without an item id", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });

    // History restored from durable storage: the issued ids were never seen here.
    await inSession(() => provider.chatStream(
      history([{ id: "call_restored", name: "read", arguments: '{"path":"a"}' }]),
      () => {},
    ));

    const wire = requestText(fetchImpl, 0);
    expect(functionCallItems(wire)).toEqual([
      { type: "function_call", call_id: "call_restored", name: "read", arguments: '{"path":"a"}' },
    ]);
    expect(wire).not.toContain("fc_restored");
  });

  test("does not hand one provider's item ids to another provider on this adapter", async () => {
    const sourceFetch = vi.fn<typeof fetch>().mockResolvedValue(toolTurnStream("call_1", ISSUED_STREAM_ID));
    const source = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl: sourceFetch });
    await inSession(() => source.chatStream([{ role: "user", content: "read a" }], () => {}));
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answerStream());
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: MODEL,
      providerName: "openai-compatible",
      baseURL: "https://compatible.example.invalid/v1",
      useResponsesApi: true,
      fetchImpl,
    });

    await inSession(() => provider.chatStream(
      history([{ id: "call_1", name: "read", arguments: '{"path":"a"}' }]),
      () => {},
    ));

    expect(functionCallItems(requestText(fetchImpl, 0))).toEqual([
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
    ]);
  });
  test("keeps identical call ids from separate same-name adapters isolated", async () => {
    const fetchA = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(toolTurnStream("call_shared", ISSUED_STREAM_ID))
      .mockResolvedValueOnce(answerStream());
    const fetchB = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(toolTurnStream("call_shared", ISSUED_JSON_ID))
      .mockResolvedValueOnce(answerStream());
    const a = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl: fetchA });
    const b = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl: fetchB });
    const firstA = await inSession(() => a.chatStream([{ role: "user", content: "read a" }], () => {}));
    const firstB = await inSession(() => b.chatStream([{ role: "user", content: "read b" }], () => {}));
    await inSession(() => a.chatStream(history(firstA.toolCalls), () => {}));
    await inSession(() => b.chatStream(history(firstB.toolCalls), () => {}));
    expect(functionCallItems(requestText(fetchA, 1))[0]?.id).toBe(ISSUED_STREAM_ID);
    expect(functionCallItems(requestText(fetchB, 1))[0]?.id).toBe(ISSUED_JSON_ID);
  });

  test("does not infer an issued item id from restored fc-prefixed history", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });
    await inSession(() => provider.chatStream(history([
      { id: "fc_legacy_or_foreign", name: "read", arguments: '{"path":"a"}' },
    ]), () => {}));
    expect(functionCallItems(requestText(fetchImpl, 0))[0]).not.toHaveProperty("id");
  });

  test("echoes the issued id even when the opaque call id starts with fc_", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(toolTurnStream("fc_call_token", ISSUED_STREAM_ID))
      .mockResolvedValueOnce(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });
    const first = await inSession(() => provider.chatStream([{ role: "user", content: "read a" }], () => {}));
    await inSession(() => provider.chatStream(history(first.toolCalls), () => {}));
    expect(functionCallItems(requestText(fetchImpl, 1))[0]?.id).toBe(ISSUED_STREAM_ID);
  });

  test("remembers observed item ids when a backend omits call_id", async () => {
    const item = { type: "function_call", id: ISSUED_STREAM_ID, name: "read", arguments: '{"path":"a"}' };
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(sse([
        { type: "response.output_item.done", item },
        { type: "response.completed", response: { status: "completed", model: MODEL, output: [] } },
      ]))
      .mockResolvedValueOnce(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });
    const first = await inSession(() => provider.chatStream([{ role: "user", content: "read a" }], () => {}));
    await inSession(() => provider.chatStream(history(first.toolCalls), () => {}));
    expect(functionCallItems(requestText(fetchImpl, 1))[0]?.id).toBe(ISSUED_STREAM_ID);
  });

  test.each(["chat", "stream"] as const)("retains observed ids on the ChatGPT sign-in %s path", async (mode) => {
    const fetchImpl = vi.fn<typeof fetch>();
    if (mode === "stream") {
      fetchImpl.mockResolvedValueOnce(toolTurnStream("call_oauth", ISSUED_STREAM_ID))
        .mockResolvedValueOnce(answerStream());
    } else {
      fetchImpl.mockResolvedValueOnce(json({ status: "completed", model: MODEL, output: [streamedCall("call_oauth", ISSUED_STREAM_ID)] }))
        .mockResolvedValueOnce(json({ status: "completed", model: MODEL, output: [] }));
    }
    const provider = new OpenAIProvider({
      model: MODEL, authMode: "oauth", chatgptBackend: true, fetchImpl,
      oauth: { accessToken: "fixture-access", refreshToken: "fixture-refresh",
        refreshAccessToken: async () => ({ kind: "refreshed", accessToken: "fixture-next" }) },
    });
    const run = (messages: LLMMessage[]) => inSession(() => mode === "stream"
      ? provider.chatStream(messages, () => {}) : provider.chat(messages));
    const first = await run([{ role: "user", content: "read a" }]);
    await run(history(first.toolCalls));
    expect(functionCallItems(requestText(fetchImpl, 1))[0]?.id).toBe(ISSUED_STREAM_ID);
    const init = fetchImpl.mock.calls[1]?.[1] as RequestInit;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer fixture-access");
  });

});
