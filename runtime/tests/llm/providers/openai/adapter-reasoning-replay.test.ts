import { describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import type { LLMMessage, LLMResponse } from "../../../../src/llm/types.js";
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
  test.each([
    ["the completion lists its output", [REASONING, SERVER_CALL]],
    ["the completion has an empty output, as on the ChatGPT backend", []],
  ])("keeps streamed reasoning and replays it before the next request's function call when %s", async (_label, completedOutput) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(toolTurnStream(completedOutput))
      .mockResolvedValueOnce(answerStream());
    const provider = new OpenAIProvider({ apiKey: "sk-test", model: MODEL, fetchImpl });

    const first = await withReplaySwitch("1", () =>
      provider.chatStream([{ role: "user", content: "read a" }], () => {}));
    await withReplaySwitch("1", () => provider.chatStream(historyAfter(first), () => {}));

    expect(first.providerReasoningProvenance).toEqual({ provider: "openai", model: MODEL });
    expect(requestBody(fetchImpl, 0).include).toEqual(["reasoning.encrypted_content"]);
    expect(requestBody(fetchImpl, 1).input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "read a" }] },
      REASONING,
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
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

  test.each([
    ["switch unset", undefined],
    ["switch off", "0"],
  ])("keeps today's wire and response with the %s", async (_label, value) => {
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
