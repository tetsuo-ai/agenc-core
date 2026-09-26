import { describe, expect, test, vi } from "vitest";

import { isConfirmedProviderRejection } from "../../../src/llm/errors.js";
import { ProviderHttpError } from "../../../src/llm/client-session.js";
import type { LLMProvider } from "../../../src/llm/types.js";
import { AnthropicProvider } from "../../../src/llm/providers/anthropic/adapter.js";
import { BedrockProvider } from "../../../src/llm/providers/bedrock/index.js";
import { GeminiProvider } from "../../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../../src/llm/providers/gemini/endpoint-plan.js";
import { GrokProvider } from "../../../src/llm/providers/grok/adapter.js";
import { OllamaProvider } from "../../../src/llm/providers/ollama/adapter.js";

const providers: { name: string; create: (fetchImpl: typeof fetch) => LLMProvider }[] = [
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
  test.each(["SDK", "shared client"])("does not mark a %s error inside an accepted stream", async (source) => {
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
    const error = await provider.chatStream!(
      [{ role: "user", content: "hello" }], () => {}, { singleWireAttempt: true },
    ).then(() => undefined, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(isConfirmedProviderRejection(error)).toBe(false);
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
      expect(isConfirmedProviderRejection(error), `HTTP ${status}`).toBe(status !== 500);
      if (status !== 500) expect(error).toMatchObject({ preGenerationRejectionStatus: status });
    }
  });
});
