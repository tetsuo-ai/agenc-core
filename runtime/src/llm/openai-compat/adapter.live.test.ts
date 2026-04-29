import { describe, it, expect } from "vitest";
import { OpenAICompatProvider } from "./adapter.js";

/**
 * Live server tests for OpenAICompatProvider.
 *
 * Kept in a separate file from adapter.test.ts so that the vi.mock("openai")
 * hoisted in adapter.test.ts does not replace the real OpenAI SDK here.
 * The mock would cause all chat completion calls to hit mockCreate instead
 * of the real HTTP client, producing a 500 from the mock rather than a
 * real response from the server.
 *
 * Run with:
 *   OPENAI_COMPAT_BASE_URL=http://127.0.0.1:1234/v1 \
 *   OPENAI_COMPAT_MODEL=google_gemma-4-26b-a4b-it \
 *   npm run test --workspace=@tetsuo-ai/runtime -- \
 *     src/llm/openai-compat/adapter.live.test.ts
 */

const hasLiveServer =
  !!process.env.OPENAI_COMPAT_BASE_URL && !!process.env.OPENAI_COMPAT_MODEL;

describe.skipIf(!hasLiveServer)("OpenAICompatProvider — live server", () => {
  function makeProvider() {
    return new OpenAICompatProvider({
      model: process.env.OPENAI_COMPAT_MODEL!,
      baseUrl: process.env.OPENAI_COMPAT_BASE_URL!,
      apiKey: "local",
      contextWindowTokens: 32768,
    } as any);
  }

  it("basic round-trip returns a non-empty content string", async () => {
    const provider = makeProvider();
    const result = await provider.chat([
      { role: "user", content: "Say 'pong' and nothing else." },
    ]);
    expect(typeof result.content).toBe("string");
    expect(result.content.length).toBeGreaterThan(0);
  });

  it("chatStream: streams chunks and assembles full content", async () => {
    const provider = makeProvider();
    const chunks: string[] = [];
    const result = await provider.chatStream(
      [{ role: "user", content: "Count to three." }],
      (chunk) => {
        if (chunk.content) chunks.push(chunk.content);
      },
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(result.content).toBe(chunks.join(""));
  });
});
