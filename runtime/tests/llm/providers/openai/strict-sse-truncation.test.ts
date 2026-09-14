// Offline regression probes for the 2026-09-14 proxy interruption. All stream content is synthetic.
import { describe, expect, test, vi } from "vitest";
import { ZaiProvider } from "../../../../src/llm/providers/zai/index.js";
import { KimiProvider } from "../../../../src/llm/providers/kimi/index.js";
import { DeepSeekProvider } from "../../../../src/llm/providers/deepseek/index.js";
import { LLMInvalidResponseError, LLMStreamTruncatedError } from "../../../../src/llm/errors.js";
import { StreamModelError } from "../../../../src/phases/stream-model.js";
import { isRetryableStreamError } from "../../../../src/session/run-turn-stream-retry.js";
import type { StreamProgressCallback } from "../../../../src/llm/types.js";

function response(parts: string[]): Response {
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}

const progress = 'data: {"choices":[{"index":0,"delta":{"content":"synthetic progress"}}]}\n\n';
const terminal = 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n';
const done = 'data: [DONE]\n\n';

const strictProviders = {
  zai: (config: { apiKey: string; fetchImpl: typeof fetch }) => new ZaiProvider({ ...config, model: "glm-5.3" }),
  kimi: (config: { apiKey: string; fetchImpl: typeof fetch }) => new KimiProvider({ ...config, model: "kimi-k3" }),
  deepseek: (config: { apiKey: string; fetchImpl: typeof fetch }) => new DeepSeekProvider({ ...config, model: "deepseek-v4-pro" }),
};
const strictLabels = { zai: "Z.AI", kimi: "Kimi", deepseek: "DeepSeek" } as const;

for (const name of ["zai", "kimi", "deepseek"] as const) {
  function setup(parts: string[]) {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(parts));
    const config = { apiKey: "dummy-test", fetchImpl };
    const provider = strictProviders[name](config);
    const chunks: Parameters<StreamProgressCallback>[0][] = [];
    const invoke = () => provider.chatStream([{ role: "user", content: "synthetic probe" }], chunk => chunks.push(chunk), { singleWireAttempt: true });
    return { fetchImpl, chunks, invoke };
  }

  describe(`${name} strict-SSE interruption`, () => {
    test.each([
      ["unterminated data frame", [progress, 'data: {"choices":']],
      ["plain proxy error trailer", [progress, "upstream error: read ETIMEDOUT\n"]],
      ["clean EOF between frames before any terminal signal", [progress]],
    ])("classifies %s as typed truncation", async (_label, parts) => {
      const probe = setup(parts as string[]);
      const error = await probe.invoke().catch(error => error);
      expect(error).toBeInstanceOf(LLMStreamTruncatedError);
      expect(isRetryableStreamError(new StreamModelError(error))).toBe(true);
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
      expect(probe.chunks.some(chunk => chunk.done)).toBe(false);
    });

    test("keeps complete malformed JSON non-retryable", async () => {
      const probe = setup([progress, "data: {not-json}\n\n", done]);
      const error = await probe.invoke().catch(error => error);
      expect(error).toBeInstanceOf(LLMInvalidResponseError);
      expect((error as Error).message).toContain(`Malformed JSON in ${strictLabels[name]} SSE event`);
      expect(isRetryableStreamError(new StreamModelError(error))).toBe(false);
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });

    // A [DONE] without any finish_reason is refused only where core declares the provider's finish reasons
    // (capability-gating allowedFinishReasons: Z.AI and Kimi). DeepSeek declares none, and strict SSE leaves that alone.
    if (name !== "deepseek") {
      test("keeps explicit DONE without required finish_reason non-retryable", async () => {
        const probe = setup([progress, done]);
        const error = await probe.invoke().catch(error => error);
        expect(error).toBeInstanceOf(LLMInvalidResponseError);
        expect(isRetryableStreamError(new StreamModelError(error))).toBe(false);
        expect(probe.fetchImpl).toHaveBeenCalledOnce();
      });
    }

    test("accepts an explicit valid finish_reason with clean EOF", async () => {
      const probe = setup([progress, terminal]);
      await expect(probe.invoke()).resolves.toMatchObject({ content: "synthetic progress", finishReason: "stop" });
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });

    test("never publishes a fragmented tool call as executable after interruption", async () => {
      const frame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_probe", type: "function", function: { name: "exec_command", arguments: "{" } }] } }] })}\n\n`;
      const probe = setup([frame, 'data: {"choices":']);
      const error = await probe.invoke().catch(error => error);
      expect(error).toBeInstanceOf(Error);
      expect(probe.chunks.some(chunk => (chunk.toolCalls?.length ?? 0) > 0)).toBe(false);
      expect(probe.chunks.some(chunk => chunk.done)).toBe(false);
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });
  });
}

// Terminal-Bench 4.0, 2026-09-14 (vf2-speedup-networkx): DeepSeek reset two long reasoning streams, and the benchmark
// key proxy of the time closed each response cleanly after a plain-text error line. With no terminal signal required,
// the runtime took each cut as a finished empty answer, and the turn failed as empty_response after one retry.
describe("deepseek reasoning stream cut by an upstream reset", () => {
  test("a reasoning-only stream ended by a plain-text proxy trailer is typed truncation, not an empty answer", async () => {
    const reasoning = 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"synthetic reasoning"}}]}\n\n';
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response([reasoning, reasoning, "upstream error: read ECONNRESET\n"]));
    const provider = new DeepSeekProvider({ apiKey: "dummy-test", fetchImpl, model: "deepseek-v4-pro" });
    const error = await provider
      .chatStream([{ role: "user", content: "synthetic probe" }], () => undefined, { singleWireAttempt: true })
      .catch(error => error);
    expect(error).toBeInstanceOf(LLMStreamTruncatedError);
    expect((error as Error).message).toMatch(/DeepSeek SSE stream/);
    expect(isRetryableStreamError(new StreamModelError(error))).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
