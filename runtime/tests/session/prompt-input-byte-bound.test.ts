import { expect, test } from "vitest";
import { createTokenAccountingRequest } from "../../src/llm/token-accounting.js";
import { promptInputTokenByteBound } from "../../src/session/prompt-input-byte-bound.js";

function request(text: string) {
  return createTokenAccountingRequest({
    provider: "deepseek", model: "deepseek-flash",
    messages: [{ role: "user", content: text }],
    options: { systemPrompt: "Follow the instructions.", tools: [{ type: "function", function: {
      name: "read", description: "Read a file", parameters: { type: "object", properties: {} },
    } }] },
  });
}

test("bounds complete text envelopes on either side of an input budget", () => {
  const small = promptInputTokenByteBound(request("hello"))!;
  const large = promptInputTokenByteBound(request("x".repeat(10000)))!;
  expect(small).toBeLessThan(4096);
  expect(large).toBeGreaterThan(4096);
  expect(large).toBeGreaterThanOrEqual(10000);
  expect(promptInputTokenByteBound({ ...request("hello"), options: {
    systemPrompt: "y".repeat(10000),
  } })).toBeGreaterThan(4096);
});

test("counts UTF-8 bytes and complete tool schemas", () => {
  const input = request("€😀");
  const original = promptInputTokenByteBound(input)!;
  expect(original - promptInputTokenByteBound(request(""))!).toBeGreaterThanOrEqual(7);
  expect(promptInputTokenByteBound({ ...input, options: { ...input.options, tools: [{
    type: "function", function: { name: "read", description: "z".repeat(10000), parameters: {} },
  }] } })).toBeGreaterThan(original + 9000);
});

test("leaves native media, native tools and unsupported vocabularies to accounting", () => {
  const base = request("hello");
  expect(promptInputTokenByteBound({ ...base, messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url: "https://example.invalid/image.png" } },
  ] }] })).toBeUndefined();
  expect(promptInputTokenByteBound({ ...base, providerNativeTools: [{ type: "web_search" }] })).toBeUndefined();
  expect(promptInputTokenByteBound({ ...base, provider: "anthropic" })).toBeUndefined();
});
