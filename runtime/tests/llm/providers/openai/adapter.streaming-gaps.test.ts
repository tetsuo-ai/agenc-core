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
};

describe("OpenAIProvider streaming gaps", () => {
  // GAP (a): the chat-completions streaming loop previously read only
  // `delta.content` and dropped `delta.reasoning_content`, so
  // DeepSeek-reasoner / openai-compat reasoning models lost their
  // chain-of-thought on the streamed path. The non-streaming path
  // (`parseChatCompletionsResponse`) already falls back to
  // `reasoning_content`; this pins the streamed path to mirror it.
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

    // Reasoning deltas are forwarded mid-stream instead of being dropped.
    expect(chunks).toEqual([
      { content: "Step 1. ", done: false },
      { content: "Step 2.", done: false },
      { content: "", done: true },
    ]);
    // With no visible `delta.content`, the final response falls back to
    // the accumulated reasoning_content (mirroring the non-streaming path).
    expect(response.content).toBe("Step 1. Step 2.");
    // Reasoning token usage is preserved for cost accounting.
    expect(response.usage.reasoningOutputTokens).toBe(6);
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
      { content: "thinking...", done: false },
      { content: "Answer.", done: false },
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
