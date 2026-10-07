import { describe, expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { AnthropicProvider } from "../../src/llm/providers/anthropic/adapter.js";
import type { LLMMessage } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";
import { createAllowAdmissionHarness } from "./admission-test-harness.js";

const MODEL = "claude-sonnet-4.5";
const INPUT_TOKENS = 120;
const CACHE_READ_TOKENS = 2048;
const CACHE_WRITE_TOKENS = 1024;
const OUTPUT_TOKENS = 348;
const PROCESSED_INPUT_TOKENS =
  INPUT_TOKENS + CACHE_READ_TOKENS + CACHE_WRITE_TOKENS;
const PROCESSED_TOTAL_TOKENS = PROCESSED_INPUT_TOKENS + OUTPUT_TOKENS;

function sseFrame(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function sseResponse(frames: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(encoder.encode(frame));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function providerFor(transport: "chat" | "stream"): AnthropicProvider {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
    if (String(input).endsWith("/messages/count_tokens")) {
      return Response.json({ input_tokens: PROCESSED_INPUT_TOKENS });
    }
    if (transport === "chat") {
      return Response.json({
        id: "msg_cache_chat",
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: {
          input_tokens: INPUT_TOKENS,
          output_tokens: OUTPUT_TOKENS,
          cache_read_input_tokens: CACHE_READ_TOKENS,
          cache_creation_input_tokens: CACHE_WRITE_TOKENS,
        },
      });
    }
    return sseResponse([
      sseFrame("message_start", {
        type: "message_start",
        message: {
          id: "msg_cache_stream",
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          usage: {
            input_tokens: INPUT_TOKENS,
            output_tokens: 0,
            cache_read_input_tokens: CACHE_READ_TOKENS,
            cache_creation_input_tokens: CACHE_WRITE_TOKENS,
          },
        },
      }),
      sseFrame("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      }),
      sseFrame("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "ok" },
      }),
      sseFrame("content_block_stop", {
        type: "content_block_stop",
        index: 0,
      }),
      sseFrame("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: OUTPUT_TOKENS },
      }),
      sseFrame("message_stop", { type: "message_stop" }),
    ]);
  });
  return new AnthropicProvider({
    apiKey: "anthropic-test",
    model: MODEL,
    fetchImpl,
  });
}

describe("Anthropic cache tokens in admitted usage (#2772)", () => {
  test.each(["chat", "stream"] as const)(
    "%s charges ordinary input plus cache reads and writes",
    async (transport) => {
      const state = createAllowAdmissionHarness({
        scope: { maxTokens: 100_000, hasHardTokenCap: true },
      });
      const provider = providerFor(transport);
      const messages: LLMMessage[] = [{ role: "user", content: "hello" }];
      const session = {
        conversationId: "anthropic-cache-totals",
        services: {
          executionAdmission: state.admission,
          admissionRequired: true,
          agentControl: { shutdownAgentTree: vi.fn() },
        },
        abortTerminal: vi.fn(),
      } as unknown as Session;

      const response = await runAdmittedModelCall({
        session,
        provider,
        messages,
        options: { maxOutputTokens: 1024, contextWindowTokens: 200_000 },
        stepId: `anthropic-cache-${transport}`,
        model: MODEL,
        providerName: "anthropic",
        invoke: (options) =>
          transport === "chat"
            ? provider.chat(messages, options)
            : provider.chatStream(messages, () => {}, options),
      });

      expect(response.usage).toMatchObject({
        promptTokens: INPUT_TOKENS,
        completionTokens: OUTPUT_TOKENS,
        cachedInputTokens: CACHE_READ_TOKENS,
        cacheCreationInputTokens: CACHE_WRITE_TOKENS,
        totalTokens: PROCESSED_TOTAL_TOKENS,
        availability: "reported",
        provenance: "provider",
      });
      // Admission charges ordinary input plus cache: 120 + 2,048 + 1,024.
      expect(state.reconcile).toHaveBeenCalledWith("reservation-1", {
        inputTokens: PROCESSED_INPUT_TOKENS,
        outputTokens: OUTPUT_TOKENS,
        costUsd: expect.closeTo(0.0100344, 12),
      });
      expect(state.holdUnknown).not.toHaveBeenCalled();
    },
  );
});
