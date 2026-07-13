import { describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";

// M-LLM-5 (core-todo.md): once the thinking block was closed on a reasoning->content
// (or reasoning->tool_call) transition, hasEmittedThinkingStart was never reset, so a
// later delta.reasoning_content skipped content_block_start and emitted a thinking_delta
// at a stale index (pointing at the open text block / an unstarted index). The consumer
// then threw a RangeError, killing the whole request. Providers that interleave
// reasoning_content around content/tool calls (Kimi/Moonshot, MiniMax, Z.AI) trigger it.

const MODEL = "kimi-thinking";

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function delta(obj: unknown): string {
  return `data: {"id":"c","model":"${MODEL}","choices":[{"index":0,"delta":${JSON.stringify(obj)}}]}\n\n`;
}

describe("OpenAIProvider — M-LLM-5 reasoning resumes after content", () => {
  test("interleaved reasoning -> content -> reasoning does not crash", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse([
        delta({ reasoning_content: "R1 " }),
        delta({ content: "Answer part. " }),
        // Reasoning resumes AFTER the thinking block was closed — the bug trigger.
        delta({ reasoning_content: "R2 more thinking" }),
        delta({ content: "final." }),
        `data: {"id":"c","model":"${MODEL}","choices":[{"index":0,"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":5,"total_tokens":8}}\n\n`,
        "data: [DONE]\n\n",
      ]),
    );
    const provider = new OpenAIProvider({
      apiKey: "sk-test",
      model: MODEL,
      useResponsesApi: false,
      fetchImpl,
    });

    const chunks: Array<{ content: string; done: boolean }> = [];
    // Must resolve without a RangeError from the block reducer.
    const response = await provider.chatStream(
      [{ role: "user", content: "think then answer" }],
      (chunk) => chunks.push(chunk),
    );

    // The visible content survives across the reasoning interruption.
    const joined = chunks.map((c) => c.content).join("");
    expect(joined).toContain("Answer part.");
    expect(joined).toContain("final.");
    expect(response.finishReason).toBe("stop");
  });
});
