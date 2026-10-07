import { describe, expect, test, vi } from "vitest";

import { isLLMPreGenerationRejection } from "../../../src/llm/errors.js";
import { ProviderHttpError } from "../../../src/llm/client-session.js";
import type { LLMProvider } from "../../../src/llm/types.js";
import { OpenAIProvider } from "../../../src/llm/providers/openai/adapter.js";
import { AnthropicProvider } from "../../../src/llm/providers/anthropic/adapter.js";
import { BedrockProvider } from "../../../src/llm/providers/bedrock/index.js";
import { GeminiProvider } from "../../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../../src/llm/providers/gemini/endpoint-plan.js";
import { GrokProvider } from "../../../src/llm/providers/grok/adapter.js";
import { OllamaProvider } from "../../../src/llm/providers/ollama/adapter.js";

const providers: { name: string; create: (fetchImpl: typeof fetch) => LLMProvider }[] = [
  { name: "openai-responses", create: (fetchImpl) => new OpenAIProvider({
    apiKey: "openai-test", model: "gpt-4.1", useResponsesApi: true, fetchImpl,
  }) },
  { name: "openai-chat", create: (fetchImpl) => new OpenAIProvider({
    apiKey: "openai-test", model: "gpt-4.1", useResponsesApi: false, fetchImpl,
  }) },
  { name: "grok", create: (fetchImpl) => new GrokProvider({
    apiKey: "xai-test", model: "grok-4-fast", fetchImpl,
  }) },
  { name: "anthropic", create: (fetchImpl) => new AnthropicProvider({
    apiKey: "anthropic-test", model: "claude-sonnet-4-5", fetchImpl,
  }) },
  { name: "gemini", create: (fetchImpl) => new GeminiProvider({
    credentialPlan: { kind: "api-key", credential: "gemini-test", source: "factory" },
    endpointPlan: createGeminiEndpointPlan(), model: "gemini-2.5-pro", fetchImpl,
  }) },
  { name: "bedrock", create: (fetchImpl) => new BedrockProvider({
    accessKeyId: "AKIDEXAMPLE", secretAccessKey: "secret", model: "amazon.nova-pro-v1:0", fetchImpl,
  }) },
  { name: "ollama", create: (fetchImpl) => new OllamaProvider({ model: "llama3.3", fetchImpl }) },
];

describe.each(providers)("$name HTTP rejection evidence", ({ create }) => {
  test.each([
    ["chat", "SDK"], ["chat", "shared client"],
    ["chatStream", "SDK"], ["chatStream", "shared client"],
  ] as const)("does not mark an error inside an accepted %s response (%s)", async (method, source) => {
    const streamError = source === "shared client" ? new ProviderHttpError({
      providerName: "test", status: 429, headers: new Headers(),
      url: "https://example.test", message: "stream failed after HTTP 200",
    }) : Object.assign(new Error("stream failed after HTTP 200"), {
      name: "ResponseError", status: 429, status_code: 429,
    });
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
      return new Response(new ReadableStream({
        pull(controller) { controller.error(streamError); },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    const provider = create(fetchImpl);
    const messages = [{ role: "user" as const, content: "hello" }];
    const call = method === "chat" ? provider.chat(messages, { singleWireAttempt: true })
      : provider.chatStream!(messages, () => {}, { singleWireAttempt: true });
    const error = await call.then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(isLLMPreGenerationRejection(error, provider.name)).toBe(false);
  });

  test.each(["chat", "chatStream"] as const)("%s marks only confirmed HTTP rejections", async (method) => {
    for (const status of [400, 401, 402, 403, 429, 500]) {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (input) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
        return Response.json({ error: { message: "Request rejected" }, message: "Request rejected" }, { status });
      });
      const provider = create(fetchImpl);
      const messages = [{ role: "user" as const, content: "hello" }];
      const options = { singleWireAttempt: true };
      const call = method === "chat"
        ? provider.chat(messages, options)
        : provider.chatStream!(messages, () => {}, options);
      const error = await call.then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(isLLMPreGenerationRejection(error, provider.name), `HTTP ${status}`).toBe(status !== 500);
      expect(isLLMPreGenerationRejection(error, "foreign-provider")).toBe(false);
      expect(error).not.toHaveProperty("preGenerationRejectionStatus");
    }
  });
  test.each(["chat", "chatStream"] as const)("%s does not certify a potentially multi-wire request", async method => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/api/show")) return Response.json({ capabilities: ["completion", "tools"] });
      return Response.json({ error: { message: "invalid request" }, message: "invalid request" }, { status: 400 });
    });
    const provider = create(fetchImpl);
    const messages = [{ role: "user" as const, content: "hello" }];
    const outcome = method === "chat" ? provider.chat(messages) : provider.chatStream!(messages, () => {});
    const error = await outcome.then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(isLLMPreGenerationRejection(error, provider.name)).toBe(false);
  });

});
