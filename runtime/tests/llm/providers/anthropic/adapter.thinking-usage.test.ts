import { describe, expect, test, vi } from "vitest";
import { AnthropicProvider } from "./adapter.js";

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

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

const EXAMPLE_USAGE = {
  input_tokens: 120,
  output_tokens: 348,
  output_tokens_details: { thinking_tokens: 312 },
} as const;

describe("AnthropicProvider thinking-token usage (#2112)", () => {
  test("chat and streaming paths normalize the same nested usage", async () => {
    const chatFetch = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "msg_chat",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4.5",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: EXAMPLE_USAGE,
      }),
    );
    const streamFetch = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_stream",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4.5",
            content: [],
            usage: {
              input_tokens: 120,
              output_tokens: 0,
            },
          },
        })}\n\n`,
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: {
            output_tokens: 348,
            output_tokens_details: { thinking_tokens: 312 },
          },
        })}\n\n`,
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );

    const chatProvider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-sonnet-4.5",
      fetchImpl: chatFetch,
    });
    const streamProvider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-sonnet-4.5",
      fetchImpl: streamFetch,
    });

    const chat = await chatProvider.chat([{ role: "user", content: "hello" }]);
    const stream = await streamProvider.chatStream(
      [{ role: "user", content: "hello" }],
      () => {},
    );

    expect(chat.usage).toEqual({
      promptTokens: 120,
      completionTokens: 348,
      totalTokens: 468,
      availability: "reported",
      provenance: "provider",
      reasoningOutputTokens: 312,
    });
    expect(stream.usage).toEqual(chat.usage);
  });

  test("streaming preserves thinking details reported on message_start", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: "msg_start_thinking",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-4.5",
            content: [],
            usage: {
              input_tokens: 120,
              output_tokens: 0,
              output_tokens_details: { thinking_tokens: 312 },
            },
          },
        })}\n\n`,
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
        'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":348}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ]),
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-sonnet-4.5",
      fetchImpl,
    });

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      () => {},
    );

    expect(response.usage.completionTokens).toBe(348);
    expect(response.usage.reasoningOutputTokens).toBe(312);
  });

  test("partial stream failure keeps nested thinking tokens", async () => {
    const encoder = new TextEncoder();
    let emitted = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!emitted) {
          controller.enqueue(encoder.encode(
            `event: message_start\ndata: ${JSON.stringify({
              type: "message_start",
              message: {
                id: "msg_partial",
                type: "message",
                role: "assistant",
                model: "claude-sonnet-4.5",
                content: [],
                usage: {
                  input_tokens: 120,
                  output_tokens: 348,
                  output_tokens_details: { thinking_tokens: 312 },
                },
              },
            })}\n\n`,
          ));
          controller.enqueue(encoder.encode(
            'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n',
          ));
          emitted = true;
          return;
        }
        controller.error(new Error("network blip"));
      },
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const provider = new AnthropicProvider({
      apiKey: "anthropic-test",
      model: "claude-sonnet-4.5",
      fetchImpl,
    });

    const response = await provider.chatStream(
      [{ role: "user", content: "hello" }],
      () => {},
    );

    expect(response.partial).toBe(true);
    expect(response.usage.completionTokens).toBe(348);
    expect(response.usage.reasoningOutputTokens).toBe(312);
  });
});
