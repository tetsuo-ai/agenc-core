import { describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";

const PROVIDER_TEST_LABEL = "Open" + "AI";

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

type StreamChunk = {
  content: string;
  done: boolean;
  toolCalls?: Array<{ id: string; name: string; arguments: string }>;
  reasoningSummaryDelta?: { delta: string; summaryIndex: number };
};

describe("OpenAIProvider streaming gaps", () => {
  test("forwards recognized Responses progress and raw keepalives as content-free liveness", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        ": keep-alive\n\n",
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_live","status":"in_progress"}}\n\n',
        'event: response.in_progress\ndata: {"type":"response.in_progress","response":{"id":"resp_live","status":"in_progress"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","delta":"{\\"path\\":","item_id":"fc_1"}\n\n',
        // Future well-formed events still prove provider liveness.
        'event: response.future_event\ndata: {"type":"response.future_event"}\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"plan ","summary_index":0}\n\n',
        'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"detail","output_index":1}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_live","status":"completed","model":"gpt-5","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
    });
    const chunks: StreamChunk[] = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push(chunk),
    );

    expect(chunks).toEqual([
      { content: "", done: false },
      { content: "", done: false },
      { content: "", done: false },
      { content: "", done: false },
      { content: "", done: false },
      {
        content: "",
        done: false,
        reasoningSummaryDelta: { delta: "plan ", summaryIndex: 0 },
      },
      {
        content: "",
        done: false,
        reasoningSummaryDelta: { delta: "detail", summaryIndex: 1 },
      },
      { content: "Hello", done: false },
      { content: "", done: true },
    ]);
    expect(response.content).toBe("Hello");
    expect(response.thinking).toEqual([
      { text: "plan ", redacted: false, kind: "reasoning_summary" },
      { text: "detail", redacted: false, kind: "reasoning_summary" },
    ]);
  });

  test("keeps identical inner reasoning indexes separate across outputs", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"first ","output_index":0,"summary_index":0}\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"block","output_index":0,"summary_index":0}\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"second","output_index":1,"summary_index":0}\n\n',
        'event: response.reasoning_text.delta\ndata: {"type":"response.reasoning_text.delta","delta":"raw","output_index":1,"content_index":0}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_reasoning","status":"completed","model":"gpt-5","output":[],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
    });
    const chunks: StreamChunk[] = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "reason" }],
      (chunk) => chunks.push(chunk),
    );

    expect(
      chunks
        .map((chunk) => chunk.reasoningSummaryDelta)
        .filter((delta): delta is NonNullable<typeof delta> => delta !== undefined),
    ).toEqual([
      { delta: "first ", summaryIndex: 0 },
      { delta: "block", summaryIndex: 0 },
      { delta: "second", summaryIndex: 1 },
      { delta: "raw", summaryIndex: 2 },
    ]);
    expect(response.thinking).toEqual([
      { text: "first block", redacted: false, kind: "reasoning_summary" },
      { text: "second", redacted: false, kind: "reasoning_summary" },
      { text: "raw", redacted: false, kind: "reasoning_summary" },
    ]);
  });

  // GAP (a): the chat-completions streaming loop previously read only
  // `delta.content` and dropped `delta.reasoning_content`, so
  // DeepSeek-reasoner / openai-compat reasoning models lost their
  // chain-of-thought on the streamed path. It must remain available through
  // the explicit thinking channel without becoming visible assistant text.
  test("captures delta.reasoning_content on the chat-completions streaming path", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"id":"chatcmpl_r","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"Step 1. "}}]}\n\n',
        'data: {"id":"chatcmpl_r","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"Step 2."}}]}\n\n',
        'data: {"id":"chatcmpl_r","model":"deepseek-reasoner","choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10,"completion_tokens_details":{"reasoning_tokens":6}}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "deepseek-reasoner",
      useResponsesApi: false,
      fetchImpl,
    });
    const chunks: StreamChunk[] = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "think" }],
      (chunk) => chunks.push(chunk),
    );

    // Reasoning deltas remain explicit hidden-channel events instead of
    // masquerading as canonical assistant content.
    expect(chunks).toEqual([
      {
        content: "",
        done: false,
        reasoningSummaryDelta: { delta: "Step 1. ", summaryIndex: 0 },
      },
      {
        content: "",
        done: false,
        reasoningSummaryDelta: { delta: "Step 2.", summaryIndex: 0 },
      },
      { content: "", done: false },
      { content: "", done: true },
    ]);
    expect(response.content).toBe("");
    expect(response.thinking).toEqual([
      {
        text: "Step 1. Step 2.",
        redacted: false,
        kind: "reasoning_summary",
      },
    ]);
    // Reasoning token usage is preserved for cost accounting.
    expect(response.usage.reasoningOutputTokens).toBe(6);
  });

  test("forwards tool-argument-only chat-completions chunks as liveness", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"id":"chatcmpl_tool","model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":"}}]}}]}\n\n',
        'data: {"id":"chatcmpl_tool","model":"gpt-5","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"id":"chatcmpl_tool","model":"gpt-5","choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      useResponsesApi: false,
      fetchImpl,
    });
    const chunks: StreamChunk[] = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "write a file" }],
      (chunk) => chunks.push(chunk),
    );

    // Each parsed tool/usage-only event refreshes the semantic watchdog even
    // though none of it belongs in user-visible assistant content.
    expect(chunks).toEqual([
      { content: "", done: false },
      { content: "", done: false },
      { content: "", done: false },
      {
        content: "",
        done: true,
        toolCalls: [
          {
            id: "call_1",
            name: "write_file",
            arguments: '{"path":"README.md"}',
          },
        ],
      },
    ]);
    expect(response.toolCalls).toEqual([
      {
        id: "call_1",
        name: "write_file",
        arguments: '{"path":"README.md"}',
      },
    ]);
    expect(response.finishReason).toBe("tool_calls");
  });

  test("keeps visible content while still forwarding reasoning deltas", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'data: {"id":"chatcmpl_m","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"reasoning_content":"thinking..."}}]}\n\n',
        'data: {"id":"chatcmpl_m","model":"deepseek-reasoner","choices":[{"index":0,"delta":{"content":"Answer."}}]}\n\n',
        'data: {"id":"chatcmpl_m","model":"deepseek-reasoner","choices":[{"index":0,"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "deepseek-reasoner",
      useResponsesApi: false,
      fetchImpl,
    });
    const chunks: StreamChunk[] = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "think then answer" }],
      (chunk) => chunks.push(chunk),
    );

    expect(chunks).toEqual([
      {
        content: "",
        done: false,
        reasoningSummaryDelta: { delta: "thinking...", summaryIndex: 0 },
      },
      { content: "Answer.", done: false },
      { content: "", done: false },
      { content: "", done: true },
    ]);
    // When visible content is present it wins; reasoning_content does not
    // clobber the user-facing answer.
    expect(response.content).toBe("Answer.");
  });

  // GAP (b): the Responses streaming path threw out of the generator on a
  // single malformed function_call item even after good output_text had
  // been emitted, discarding the already-streamed content. It should now
  // recover the partial output (mirrors the Anthropic adapter's
  // partial-recovery and the in-stream `response.failed` branch).
  test("recovers already-streamed responses output when a function_call is malformed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Par"}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"tial"}\n\n',
        // Malformed: empty function-call name fails tool-call validation.
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_bad","call_id":"call_bad","name":"","arguments":"{}"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_bad","status":"completed","model":"gpt-5","output":[]}}\n\n',
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
    });
    const chunks: StreamChunk[] = [];

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      (chunk) => chunks.push(chunk),
    );

    // The good text already forwarded to the consumer is preserved, and a
    // terminal done chunk still arrives instead of an exception.
    expect(chunks).toEqual([
      { content: "Par", done: false },
      { content: "tial", done: false },
      { content: "", done: true },
    ]);
    expect(response.content).toBe("Partial");
    expect(response.partial).toBe(true);
    expect(response.finishReason).toBe("error");
    expect(response.error).toBeInstanceOf(Error);
  });

  test("still throws when a malformed function_call arrives before any output", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        // No prior output_text/tool calls: nothing was emitted, so the
        // original throw behavior is preserved for the outer fallback path.
        'event: response.output_item.done\ndata: {"type":"response.output_item.done","item":{"type":"function_call","id":"fc_bad","call_id":"call_bad","name":"","arguments":"{}"}}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_bad","status":"completed","model":"gpt-5","output":[]}}\n\n',
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: "gpt-5",
      fetchImpl,
    });

    await expect(
      provider.chatStream([{ role: "user", content: "hello" }], () => {}),
    ).rejects.toThrow(
      `${PROVIDER_TEST_LABEL} Responses stream emitted invalid function_call`,
    );
  });
});
