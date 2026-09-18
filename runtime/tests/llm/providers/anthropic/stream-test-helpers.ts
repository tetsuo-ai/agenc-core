import { vi } from "vitest";
import { AnthropicProvider } from "./adapter.js";

export { sseResponse } from "../openai-compatible-test-helpers.js";

export function createAnthropicFallbackProvider(
  fetchImpl: typeof fetch,
): AnthropicProvider {
  return new AnthropicProvider({
    apiKey: "anthropic-test",
    model: "claude-3-7-sonnet",
    fetchImpl,
    providerFallback: {
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      targets: [{ provider: "grok", model: "grok-4-fast" }],
      maxFailures: 5,
    },
  });
}

/**
 * Enqueue `frames` on the first pull, then fail on the next. Erroring in the
 * same tick as the enqueue discards the queued chunk under WHATWG
 * ReadableStream semantics and would skip the partial-content path.
 */
export function sseResponseThenError(
  frames: readonly string[],
  error: Error,
): Response {
  const encoded = frames.map((frame) => new TextEncoder().encode(frame));
  let phase: "frames" | "fail" = "frames";
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        switch (phase) {
          case "frames":
            for (const chunk of encoded) {
              controller.enqueue(chunk);
            }
            phase = "fail";
            return;
          case "fail":
            controller.error(error);
            return;
          default: {
            const _exhaustive: never = phase;
            return _exhaustive;
          }
        }
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    },
  );
}

export async function withDeterministicFallbackTimers(
  work: () => Promise<void>,
): Promise<void> {
  vi.useFakeTimers();
  const restoreRandom = vi.spyOn(Math, "random").mockReturnValue(0);
  try {
    await work();
  } finally {
    restoreRandom.mockRestore();
    vi.useRealTimers();
  }
}
