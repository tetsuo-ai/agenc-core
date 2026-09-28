import { describe, expect, test, vi } from "vitest";
import { AnthropicProvider } from "./adapter.js";
import { BudgetTracker } from "src/conversation/token-budget.js";
import { CostSidecar } from "src/session/cost.js";

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
  reasoningIncludedInCompletion: true,
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
  test.each([
    ["string", "312"],
    ["object", {}],
    ["array", []],
    ["null", null],
    ["negative", -1],
  ] as const)("chat and streams reject malformed nested thinking (%s)", async (_label, value) => {
    const usage = {
      ...EXAMPLE_USAGE,
      output_tokens_details: { thinking_tokens: value },
      reasoning_output_tokens: 99,
    };
    const chat = await providerFor(vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        model: MODEL,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage,
      }),
    )).chat([{ role: "user", content: "hello" }]);
    expect(chat.usage.reasoningOutputTokens).toBeUndefined();
    expect(chat.usage.reasoningIncludedInCompletion).toBeUndefined();

    for (const partial of [false, true]) {
      const frames = textAssistantFrames({
        id: "msg_malformed",
        startUsage: { input_tokens: 120, output_tokens: 0 },
        deltaUsage: usage,
      });
      const stream = await streamWith(vi.fn<typeof fetch>().mockResolvedValue(
        ssePayload(partial ? frames.slice(0, -1) : frames),
      ));
      expect(stream.partial ?? false).toBe(partial);
      expect(stream.usage.completionTokens).toBe(348);
      expect(stream.usage.reasoningOutputTokens).toBeUndefined();
      expect(stream.usage.reasoningIncludedInCompletion).toBeUndefined();
      if (!partial) expect(stream.usage).toEqual(chat.usage);
    }
  });

  test.each([
    { name: "invalid replaces valid", start: { thinking_tokens: 12 }, delta: { thinking_tokens: "312" }, expected: undefined },
    { name: "valid replaces invalid", start: { thinking_tokens: "312" }, delta: { thinking_tokens: 312 }, expected: 312 },
    { name: "invalid survives omitted details", start: { thinking_tokens: "312" }, delta: undefined, expected: undefined },
    { name: "invalid survives an omitted count", start: { thinking_tokens: "312" }, delta: {}, expected: undefined },
    { name: "valid replaces valid cumulatively", start: { thinking_tokens: 12 }, delta: { thinking_tokens: 312 }, expected: 312 },
    { name: "zero replaces invalid", start: { thinking_tokens: "312" }, delta: { thinking_tokens: 0 }, expected: 0 },
    { name: "absent count permits flat fallback", start: {}, delta: {}, expected: 99 },
  ])("stream updates: $name", async ({ start, delta, expected }) => {
    for (const partial of [false, true]) {
      const frames = textAssistantFrames({
        id: "msg_updates",
        startUsage: { input_tokens: 120, output_tokens: 12, output_tokens_details: start },
        deltaUsage: {
          output_tokens: 348,
          ...(delta !== undefined ? { output_tokens_details: delta } : {}),
          reasoning_output_tokens: 99,
        },
      });
      const response = await streamWith(vi.fn<typeof fetch>().mockResolvedValue(
        ssePayload(partial ? frames.slice(0, -1) : frames),
      ));
      expect(response.partial ?? false).toBe(partial);
      expect(response.usage.reasoningOutputTokens).toBe(expected);
      expect(response.usage.reasoningIncludedInCompletion).toBe(
        expected === undefined ? undefined : true,
      );
    }
  });

  test.each(["complete", "EOF", "transport error", "terminated", "ECONNRESET"] as const)(
    "thinking and cache accounting after final message_delta (%s)",
    async (ending) => {
      // Thinking precedes text; its usage arrives only on the final message_delta.
      const frames = [
        messageStart("msg_final_usage", {
          input_tokens: 120,
          output_tokens: 0,
          cache_read_input_tokens: 2048,
          cache_creation_input_tokens: 1024,
          cache_creation: { ephemeral_5m_input_tokens: 1024, ephemeral_1h_input_tokens: 0 },
        }),
        sseEvent("content_block_start", {
          type: "content_block_start", index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        }),
        sseEvent("content_block_delta", {
          type: "content_block_delta", index: 0,
          delta: { type: "thinking_delta", thinking: "A short summary." },
        }),
        sseEvent("content_block_delta", {
          type: "content_block_delta", index: 0,
          delta: { type: "signature_delta", signature: "test-signature" },
        }),
        sseEvent("content_block_stop", { type: "content_block_stop", index: 0 }),
        sseEvent("content_block_start", {
          type: "content_block_start", index: 1,
          content_block: { type: "text", text: "" },
        }),
        sseEvent("content_block_delta", {
          type: "content_block_delta", index: 1,
          delta: { type: "text_delta", text: "ok" },
        }),
        sseEvent("content_block_stop", { type: "content_block_stop", index: 1 }),
        sseEvent("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 348, output_tokens_details: { thinking_tokens: 312 } },
        }),
        sseEvent("message_stop", { type: "message_stop" }),
      ];
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ssePayload(
        ending === "complete" ? frames : frames.slice(0, -1),
        ending === "transport error" ? new Error("network cut after final usage")
          : ending === "terminated" ? new TypeError("terminated")
          : ending === "ECONNRESET"
            ? Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })
            : undefined,
      ));
      const response = await streamWith(fetchImpl);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(response.partial ?? false).toBe(ending !== "complete");
      expect(response.finishReason).toBe(ending === "complete" ? "stop" : "error");
      expect(response.content).toBe("ok");
      expect(response.usage).toMatchObject({
        promptTokens: 120,
        completionTokens: 348,
        cachedInputTokens: 2048,
        cacheCreationInputTokens: 1024,
        reasoningOutputTokens: 312,
        reasoningIncludedInCompletion: true,
      });
      const tracker = new BudgetTracker();
      const sidecar = new CostSidecar({
        defaultProvider: "anthropic", defaultModel: MODEL, budgetTracker: tracker,
      });
      sidecar.onEvent({
        id: "1", seq: 1,
        msg: { type: "token_count", payload: { ...response.usage, model: MODEL, provider: "anthropic" } },
      });
      expect(sidecar.getTotalReasoningOutputTokens()).toBe(312);
      expect(tracker.emitted).toBe(348);
      expect(sidecar.getTotalCostUsd()).toBeCloseTo(0.0100344, 12);
    },
  );

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
    expect(response.usage.reasoningIncludedInCompletion).toBe(true);
  });
});
