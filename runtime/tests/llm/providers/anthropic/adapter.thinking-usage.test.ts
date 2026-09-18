import { describe, expect, test, vi } from "vitest";
import { AnthropicProvider } from "./adapter.js";

const MODEL = "claude-sonnet-4.5";
const EXAMPLE_USAGE = {
  input_tokens: 120,
  output_tokens: 348,
  output_tokens_details: { thinking_tokens: 312 },
} as const;
const EXPECTED_USAGE = {
  promptTokens: 120,
  completionTokens: 348,
  totalTokens: 468,
  availability: "reported" as const,
  provenance: "provider" as const,
  reasoningOutputTokens: 312,
};

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function ssePayload(frames: readonly string[], error?: Error): Response {
  const headers = { "content-type": "text/event-stream" };
  if (!error) {
    return new Response(frames.join(""), { status: 200, headers });
  }
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(frames.join("")));
          return;
        }
        controller.error(error);
      },
    }),
    { status: 200, headers },
  );
}

function providerFor(fetchImpl: typeof fetch): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: "anthropic-test",
    model: MODEL,
    fetchImpl,
  });
}

function sseEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(id: string, usage: Record<string, unknown>): string {
  return sseEvent("message_start", {
    type: "message_start",
    message: { id, type: "message", role: "assistant", model: MODEL, content: [], usage },
  });
}

function textAssistantFrames(args: {
  readonly id: string;
  readonly startUsage: Record<string, unknown>;
  readonly deltaUsage: Record<string, unknown>;
}): string[] {
  return [
    messageStart(args.id, args.startUsage),
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    sseEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: args.deltaUsage,
    }),
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
}

async function streamWith(
  fetchImpl: typeof fetch,
): Promise<Awaited<ReturnType<AnthropicProvider["chatStream"]>>> {
  return providerFor(fetchImpl).chatStream([{ role: "user", content: "hello" }], () => {});
}

describe("AnthropicProvider thinking-token usage (#2112)", () => {
  test("chat and streaming paths normalize the same nested usage", async () => {
    const chatFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "msg_chat",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: EXAMPLE_USAGE,
      }),
    );
    const streamFetch = vi.fn<typeof fetch>().mockResolvedValue(
      ssePayload(textAssistantFrames({
        id: "msg_stream",
        startUsage: { input_tokens: 120, output_tokens: 0 },
        deltaUsage: {
          output_tokens: 348,
          output_tokens_details: { thinking_tokens: 312 },
        },
      })),
    );

    const messages = [{ role: "user" as const, content: "hello" }];
    const chat = await providerFor(chatFetch).chat(messages);
    const stream = await providerFor(streamFetch).chatStream(messages, () => {});

    expect(chat.usage).toEqual(EXPECTED_USAGE);
    expect(stream.usage).toEqual(chat.usage);
  });

  test.each([
    {
      name: "streaming preserves thinking details reported on message_start",
      frames: textAssistantFrames({
        id: "msg_start_thinking",
        startUsage: {
          input_tokens: 120,
          output_tokens: 0,
          output_tokens_details: { thinking_tokens: 312 },
        },
        deltaUsage: { output_tokens: 348 },
      }),
      error: undefined,
      partial: false,
    },
    {
      name: "partial stream failure keeps nested thinking tokens",
      frames: [
        messageStart("msg_partial", EXAMPLE_USAGE),
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
      ],
      error: new Error("network blip"),
      partial: true,
    },
  ])("$name", async ({ frames, error, partial }) => {
    const response = await streamWith(
      vi.fn<typeof fetch>().mockResolvedValue(ssePayload(frames, error)),
    );
    expect(response.partial ?? false).toBe(partial);
    expect(response.usage.completionTokens).toBe(348);
    expect(response.usage.reasoningOutputTokens).toBe(312);
  });
});
