import { describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import type { LLMChatOptions, LLMMessage, LLMResponse } from "../../../../src/llm/types.js";
import { runWithStartupProviderSelection } from "../../../../src/utils/model/providers.js";

const MODEL = "gpt-6-sol";
// Synthetic items in the shape OpenAI streams; never real ciphertext.
const REASONING = {
  type: "reasoning",
  id: "rs_0001",
  summary: [{ type: "summary_text", text: "Read the file before answering." }],
  encrypted_content: "gAAAAABsynthetic-adapter==",
};
const SERVER_CALL = {
  type: "function_call",
  id: "fc_server_side_id",
  call_id: "call_1",
  name: "read",
  arguments: '{"path":"a"}',
};

function sse(events: ReadonlyArray<Record<string, unknown>>): Response {
  const body = events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A tool turn streamed item by item, then a completion carrying `output`. */
function toolTurnStream(completedOutput: unknown[]): Response {
  return sse([
    { type: "response.output_item.done", item: REASONING },
    { type: "response.output_item.done", item: SERVER_CALL },
    {
      type: "response.completed",
      response: { id: "resp_1", status: "completed", model: MODEL, output: completedOutput },
    },
  ]);
}

function answerStream(): Response {
  return sse([
    { type: "response.output_text.delta", delta: "done" },
    {
      type: "response.completed",
      response: { id: "resp_2", status: "completed", model: MODEL, output: [] },
    },
  ]);
}

function withReplaySwitch<T>(
  value: string | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return runWithStartupProviderSelection(
    {
      provider: "openai",
      model: MODEL,
      environment: value === undefined ? {} : { AGENC_OPENAI_REASONING_REPLAY: value },
    },
    operation,
  );
}

type TurnResult = Pick<
  LLMResponse,
  "content" | "toolCalls" | "providerReasoningContent" | "providerReasoningProvenance"
>;

function historyAfter(first: TurnResult): LLMMessage[] {
  return [
    { role: "user", content: "read a" },
    {
      role: "assistant",
      content: first.content,
      toolCalls: first.toolCalls,
      ...(first.providerReasoningContent !== undefined
        ? {
          providerReasoningContent: first.providerReasoningContent,
          providerReasoningProvenance: first.providerReasoningProvenance,
        }
        : {}),
    },
    { role: "tool", toolCallId: "call_1", content: "A" },
  ];
}

function requestBody(
  fetchImpl: { readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> } },
  call: number,
): Record<string, unknown> {
  const init = fetchImpl.mock.calls[call]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

describe("OpenAIProvider encrypted reasoning replay (AGENC_OPENAI_REASONING_REPLAY)", () => {
  test.each([false, true])("keeps Luna max encrypted replay without forcing automatic summaries (stream=%s)", async (stream) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream
      ? toolTurnStream([REASONING, SERVER_CALL])
      : new Response(JSON.stringify({ status: "completed", output: [REASONING, SERVER_CALL] }),
        { headers: { "content-type": "application/json" } }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: "gpt-6-luna", fetchImpl });
    const messages: LLMMessage[] = [{ role: "user", content: "read a" }];
    const options = { reasoningEffort: "max" as const, maxOutputTokens: 8192 };
    const response = await withReplaySwitch(undefined, () => stream
      ? provider.chatStream(messages, () => {}, options)
      : provider.chat(messages, options));

    expect(requestBody(fetchImpl, 0).reasoning).toEqual({ effort: "max" });
    expect(requestBody(fetchImpl, 0).include).toEqual(["reasoning.encrypted_content"]);
    expect(requestBody(fetchImpl, 0).max_output_tokens).toBe(8192);
    expect(response.providerReasoningProvenance).toEqual({ provider: "openai", model: "gpt-6-luna" });
  });

  test.each([
    ["the completion lists its output", [REASONING, SERVER_CALL]],
    ["the completion has an empty output, as on the ChatGPT backend", []],
  ])("keeps streamed reasoning and replays it before the next request's function call when %s", async (_label, completedOutput) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(toolTurnStream(completedOutput))
      .mockResolvedValueOnce(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });

    const first = await withReplaySwitch(undefined, () =>
      provider.chatStream([{ role: "user", content: "read a" }], () => {}));
    await withReplaySwitch(undefined, () => provider.chatStream(historyAfter(first), () => {}));

    expect(first.providerReasoningProvenance).toEqual({ provider: "openai", model: MODEL });
    expect(requestBody(fetchImpl, 0).include).toEqual(["reasoning.encrypted_content"]);
    expect(requestBody(fetchImpl, 1).input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "read a" }] },
      REASONING,
      // The call goes back with the item id the server issued for it.
      { type: "function_call", id: "fc_server_side_id", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "A" },
    ]);
  });

  test("keeps reasoning from a non-streaming Responses call", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({ id: "resp_1", status: "completed", model: MODEL, output: [REASONING, SERVER_CALL] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });

    const response = await withReplaySwitch("true", () =>
      provider.chat([{ role: "user", content: "read a" }]));

    expect(response.providerReasoningContent).toBe(JSON.stringify([REASONING]));
    expect(requestBody(fetchImpl, 0).include).toEqual(["reasoning.encrypted_content"]);
  });

  test("drops the replay when the next request names another model", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(toolTurnStream([REASONING, SERVER_CALL]))
      .mockResolvedValueOnce(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });

    const first = await withReplaySwitch("1", () =>
      provider.chatStream([{ role: "user", content: "read a" }], () => {}));
    await withReplaySwitch("1", () =>
      provider.chatStream(historyAfter(first), () => {}, { model: "gpt-6-luna" }));

    expect(requestBody(fetchImpl, 1).input).not.toContainEqual(REASONING);
  });

  test.each(["0", "false", "no", "off", " FALSE "])("keeps replay disabled with explicit opt-out %s", async (value) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(toolTurnStream([REASONING, SERVER_CALL]))
      .mockResolvedValueOnce(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });

    const first = await withReplaySwitch(value, () =>
      provider.chatStream([{ role: "user", content: "read a" }], () => {}));
    await withReplaySwitch(value, () => provider.chatStream(
      historyAfter({ ...first, ...replayFrom(first) }),
      () => {},
    ));

    expect(first.providerReasoningContent).toBeUndefined();
    expect(requestBody(fetchImpl, 0).include).toBeUndefined();
    expect(requestBody(fetchImpl, 1).include).toBeUndefined();
    expect(requestBody(fetchImpl, 1).input).not.toContainEqual(REASONING);
  });

  test.each([
    { chatgptBackend: false, stream: false },
    { chatgptBackend: false, stream: true },
    { chatgptBackend: true, stream: false },
    { chatgptBackend: true, stream: true },
  ])("preserves default replay and explicit summary choices on both paths: %j", async ({ chatgptBackend, stream }) => {
    for (const summary of [undefined, "none", "concise", "detailed", "auto"] as const) {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(stream ? toolTurnStream([]) : new Response(JSON.stringify({
          status: "completed", output: [REASONING, SERVER_CALL],
        }), { headers: { "content-type": "application/json" } }))
        .mockResolvedValueOnce(stream ? answerStream() : new Response(JSON.stringify({
          status: "completed", output: [],
        }), { headers: { "content-type": "application/json" } }));
      const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, chatgptBackend, fetchImpl });
      // The task pipeline materializes metadata-default none; retain its provenance.
      const options: LLMChatOptions = {
        reasoningEffort: "max",
        reasoningSummary: summary ?? "none",
        ...(summary === undefined ? { reasoningSummaryIsDefault: true } : {}),
      };
      const invoke = (messages: LLMMessage[]) => withReplaySwitch(undefined, () => stream
        ? provider.chatStream(messages, () => {}, options) : provider.chat(messages, options));
      const first = await invoke([{ role: "user", content: "read a" }]);
      await invoke(historyAfter(first));

      expect(first.providerReasoningProvenance).toEqual({ provider: "openai", model: MODEL });
      const body = requestBody(fetchImpl, 1);
      expect(body.include).toEqual(["reasoning.encrypted_content"]);
      expect(body.reasoning).toEqual({ effort: "max", ...(summary === "none" ? {} : { summary: summary ?? "auto" }) });
      expect(body.input).toContainEqual(REASONING);
      expect(body.input).toContainEqual(SERVER_CALL);
    }
  });

  test("ChatGPT opt-out retains its encrypted-content request contract without retaining or replaying state", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(toolTurnStream([]))
      .mockResolvedValueOnce(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, chatgptBackend: true, fetchImpl });
    const options: LLMChatOptions = { reasoningEffort: "max" };
    const first = await withReplaySwitch("0", () => provider.chatStream([{ role: "user", content: "read a" }], () => {}, options));
    await withReplaySwitch("0", () => provider.chatStream(historyAfter({ ...first, ...replayFrom(first) }), () => {}, options));

    expect(first.providerReasoningContent).toBeUndefined();
    expect(requestBody(fetchImpl, 1).include).toEqual(["reasoning.encrypted_content"]);
    expect(requestBody(fetchImpl, 1).reasoning).toEqual({ effort: "max" });
    expect(requestBody(fetchImpl, 1).input).not.toContainEqual(REASONING);
  });

  test.each([
    ["gpt-6-luna", undefined, true],
    ["gpt-6.1-sol", undefined, true],
    ["gpt-6.1-terra", undefined, true],
    ["gpt-6.1-terra", "none", false],
    ["o3", undefined, true],
    ["gpt-5.4", undefined, false],
    ["gpt-5.4", "medium", true],
    ["gpt-6-luna", "none", false],
    ["gpt-4.1", undefined, false],
  ] as const)("defaults replay only for effective reasoning calls (%s, %s)", async (model, reasoningEffort, enabled) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(toolTurnStream([REASONING, SERVER_CALL]));
    const provider = new OpenAIProvider({ apiKey: "sk-test", model, fetchImpl });
    const history = historyAfter({ content: "", toolCalls: [{ id: "call_1", name: "read", arguments: '{"path":"a"}' }],
      providerReasoningContent: JSON.stringify([REASONING]), providerReasoningProvenance: { provider: "openai", model } });
    const response = await withReplaySwitch(undefined, () => provider.chatStream(history, () => {}, { reasoningEffort }));
    const body = requestBody(fetchImpl, 0);
    expect(body.include).toEqual(enabled ? ["reasoning.encrypted_content"] : undefined);
    if (enabled) {
      expect(body.input).toContainEqual(REASONING);
      // Luna and Terra on the platform API keep their own summary default;
      // other models request auto.
      const expected = { ...(reasoningEffort ? { effort: reasoningEffort } : {}),
        ...(model === "gpt-6-luna" || model === "gpt-6.1-terra" ? {} : { summary: "auto" }) };
      expect(body.reasoning).toEqual(Object.keys(expected).length > 0 ? expected : undefined);
      expect(response.providerReasoningProvenance).toEqual({ provider: "openai", model });
    } else {
      expect(body.input).not.toContainEqual(REASONING);
      expect(response.providerReasoningContent).toBeUndefined();
    }
  });

  test("keeps concurrent sessions' default and opt-out independent", async () => {
    const defaultFetch = vi.fn<typeof fetch>().mockResolvedValue(toolTurnStream([]));
    const disabledFetch = vi.fn<typeof fetch>().mockResolvedValue(toolTurnStream([]));
    const defaultProvider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl: defaultFetch });
    const disabledProvider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl: disabledFetch });
    const [on, off] = await Promise.all([
      withReplaySwitch(undefined, () => defaultProvider.chatStream([{ role: "user", content: "read a" }], () => {})),
      withReplaySwitch("0", () => disabledProvider.chatStream([{ role: "user", content: "read a" }], () => {})),
    ]);
    expect(on.providerReasoningContent).toBe(JSON.stringify([REASONING]));
    expect(off.providerReasoningContent).toBeUndefined();
    expect(requestBody(defaultFetch, 0).reasoning).toEqual({ summary: "auto" });
    expect(requestBody(disabledFetch, 0).reasoning).toBeUndefined();
  });

  test("does not retain stateless replay for stored Responses requests", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      status: "completed", output: [REASONING, SERVER_CALL],
    }), { headers: { "content-type": "application/json" } }));
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, store: true, fetchImpl });
    const response = await withReplaySwitch(undefined, () => provider.chat([{ role: "user", content: "read a" }], { reasoningEffort: "max" }));
    expect(requestBody(fetchImpl, 0).store).toBe(true);
    expect(requestBody(fetchImpl, 0).include).toBeUndefined();
    expect(requestBody(fetchImpl, 0).reasoning).toEqual({ effort: "max" });
    expect(response.providerReasoningContent).toBeUndefined();
  });

  test("leaves other providers on this adapter unchanged", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(answerStream());
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: MODEL,
      providerName: "openai-compatible",
      baseURL: "https://compatible.example.invalid/v1",
      useResponsesApi: true,
      fetchImpl,
    });
    const history = historyAfter({
      content: "",
      toolCalls: [{ id: "call_1", name: "read", arguments: '{"path":"a"}' }],
      providerReasoningContent: JSON.stringify([REASONING]),
      providerReasoningProvenance: { provider: "openai-compatible", model: MODEL },
    });

    await withReplaySwitch("1", () => provider.chatStream(history, () => {}));

    expect(requestBody(fetchImpl, 0).include).toBeUndefined();
    expect(requestBody(fetchImpl, 0).input).not.toContainEqual(REASONING);
  });
});

/**
 * With replay off the first response carries no reasoning. Give the next
 * request a matching replay anyway, so an unchanged wire is proven for a
 * history that would replay if the switch were on.
 */
function replayFrom(first: TurnResult): Partial<TurnResult> {
  return first.providerReasoningContent !== undefined
    ? {}
    : {
      providerReasoningContent: JSON.stringify([REASONING]),
      providerReasoningProvenance: { provider: "openai", model: MODEL },
    };
}
