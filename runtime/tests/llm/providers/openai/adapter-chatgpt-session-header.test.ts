import { describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import type { LLMMessage } from "../../../../src/llm/types.js";

const MODEL = "gpt-6.1-sol";
const MESSAGES: LLMMessage[] = [{ role: "user", content: "hello" }];

function answerStream(): Response {
  const events = [
    { type: "response.output_text.delta", delta: "done" },
    {
      type: "response.completed",
      response: { id: "resp_1", status: "completed", model: MODEL, output: [] },
    },
  ];
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function answerJson(): Response {
  return new Response(
    JSON.stringify({
      id: "resp_1",
      status: "completed",
      model: MODEL,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      ],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function provider(options: {
  readonly chatgptBackend?: boolean;
  readonly fetchImpl: typeof fetch;
}): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: "sk-test",
    model: MODEL,
    ...(options.chatgptBackend === true ? { chatgptBackend: true } : {}),
    fetchImpl: options.fetchImpl,
  });
}

/** The one model request a mocked fetch saw: its headers and parsed body. */
function sentRequest(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>): {
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
} {
  const calls = fetchImpl.mock.calls.filter(([input]) => String(input).endsWith("/responses"));
  expect(calls).toHaveLength(1);
  const init = calls[0]![1]!;
  return {
    headers: new Headers(init.headers),
    body: JSON.parse(String(init.body)) as Record<string, unknown>,
  };
}

describe("ChatGPT backend session header", () => {
  test("a streamed request repeats the conversation's cache key as session_id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answerStream());
    await provider({ chatgptBackend: true, fetchImpl }).chatStream(MESSAGES, () => {}, {
      promptCacheKey: "conv-abc123",
    });

    const sent = sentRequest(fetchImpl);
    expect(sent.body.prompt_cache_key).toBe("conv-abc123");
    expect(sent.headers.get("session_id")).toBe(sent.body.prompt_cache_key);
    expect(sent.headers.has("conversation_id")).toBe(false);
  });

  test("a non-streamed request carries it too", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answerJson());
    await provider({ chatgptBackend: true, fetchImpl }).chat(MESSAGES, {
      promptCacheKey: "conv-abc123",
    });

    const sent = sentRequest(fetchImpl);
    expect(sent.headers.get("session_id")).toBe("conv-abc123");
  });

  test("the platform API route sends the key in the body only", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answerStream());
    await provider({ fetchImpl }).chatStream(MESSAGES, () => {}, {
      promptCacheKey: "conv-abc123",
    });

    const sent = sentRequest(fetchImpl);
    expect(sent.body.prompt_cache_key).toBe("conv-abc123");
    expect(sent.headers.has("session_id")).toBe(false);
  });

  test("a request without a cache key gets no session header", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => answerStream());
    await provider({ chatgptBackend: true, fetchImpl }).chatStream(MESSAGES, () => {});

    const sent = sentRequest(fetchImpl);
    expect(sent.body).not.toHaveProperty("prompt_cache_key");
    expect(sent.headers.has("session_id")).toBe(false);
  });
});
