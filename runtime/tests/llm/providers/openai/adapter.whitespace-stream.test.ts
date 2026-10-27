import { describe, expect, test, vi } from "vitest";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import { LLMStreamTruncatedError } from "../../../../src/llm/errors.js";
import { isTransientProviderError } from "../../../../src/recovery/api-errors.js";

const frame = (args: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: {
  tool_calls: [{ index: 0, id: "call_1", function: { name: "Write", arguments: args } }],
} }] })}\n\n`;
function provider(fragments: string[], terminal: boolean) {
  const cancel = vi.fn();
  const bytes = new TextEncoder();
  const queue = [...fragments.map(frame), ...(terminal ? [
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    'data: [DONE]\n\n',
  ] : [])];
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) controller.enqueue(bytes.encode(next));
      else controller.close();
    }, cancel,
  }), { headers: { "content-type": "text/event-stream" } }));
  return { cancel, client: new OpenAIProvider({ apiKey: "fixture", providerName: "openrouter",
    model: "openai/gpt-6-luna", useResponsesApi: false, fetchImpl }) };
}

describe("tool argument whitespace stream guard", () => {
  test.each(["", '{"file_path":'])("rejects runaway padding after %j before any tool executes", async (prefix) => {
    const { client, cancel } = provider([prefix, ...Array(80).fill(" \n\t".repeat(256))], false);
    const chunks: unknown[] = [];
    const error = await client.chatStream([{ role: "user", content: "write" }], c => chunks.push(c)).catch(e => e);
    expect(error).toBeInstanceOf(LLMStreamTruncatedError);
    expect(error.message).toContain("whitespace");
    expect(isTransientProviderError(error)).toBe(true);
    expect(chunks.every(c => !(c as { toolCalls?: unknown }).toolCalls)).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  test("accepts whitespace inside a JSON string across chunks and escaped quotes", async () => {
    const args = { file_path: "space.txt", content: 'quote "\\' + " ".repeat(20000) };
    const encoded = JSON.stringify(args);
    const fragments = Array.from({ length: Math.ceil(encoded.length / 127) }, (_, i) => encoded.slice(i * 127, (i + 1) * 127));
    const { client } = provider(fragments, true);
    const result = await client.chatStream([{ role: "user", content: "write" }], () => {});
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toEqual(args);
  });

  test("resets padding count when JSON makes progress", async () => {
    const { client } = provider([" ".repeat(9000), '{"content":', " ".repeat(9000), '"ok"}'], true);
    const result = await client.chatStream([{ role: "user", content: "write" }], () => {});
    expect(JSON.parse(result.toolCalls[0]!.arguments)).toEqual({ content: "ok" });
  });
});
