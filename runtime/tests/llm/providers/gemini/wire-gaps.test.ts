import type { Dispatcher } from "undici";
import { describe, expect, test, vi } from "vitest";
import { GeminiProvider } from "../../../../src/llm/providers/gemini/index.js";
import { geminiTransportFetch } from "../../../../src/llm/providers/gemini/transport.js";
import { createGeminiEndpointPlan } from "../../../../src/llm/providers/gemini/endpoint-plan.js";
import {
  TokenAccountingService,
  createTokenAccountingRequest,
} from "../../../../src/llm/token-accounting.js";
import type { LLMMessage } from "../../../../src/llm/types.js";

const answer = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
const PNG = "iVBORw0KGgoAAAANSUhEUg==";

function provider(model: string, fetchImpl: typeof fetch): GeminiProvider {
  return new GeminiProvider({
    model, fetchImpl,
    credentialPlan: { kind: "api-key", credential: "local-test-only", source: "factory" },
    endpointPlan: createGeminiEndpointPlan({ baseURL: "http://127.0.0.1:8080/v1beta" }),
  });
}

function sentBody(fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>, call = 0): Record<string, any> {
  return JSON.parse(String(fetchImpl.mock.calls[call]![1]!.body));
}

function imageResult(...urls: string[]): LLMMessage[] {
  return [
    { role: "user", content: "look at the picture" },
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "FileRead", arguments: '{"file_path":"pic.png"}' }] },
    { role: "tool", toolCallId: "call_1", toolName: "FileRead", content: [
      { type: "text", text: "Read image pic.png" },
      ...urls.map((url) => ({ type: "image_url" as const, image_url: { url } })),
    ] },
  ];
}

describe("Gemini function responses carry tool images", () => {
  test.each(["gemini-3.8-flash", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.1-pro-preview"])(
    "%s receives an inline image inside the function response", async (model) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(answer));
      await provider(model, fetchImpl).chat(imageResult(`data:image/png;base64,${PNG}`));
      const response = sentBody(fetchImpl).contents[2].parts[0].functionResponse;
      expect(response).toEqual({
        id: "call_1",
        name: "FileRead",
        response: { result: "Read image pic.png" },
        parts: [{ inlineData: { mimeType: "image/png", data: PNG } }],
      });
    });

  test("a stream and a token count send the same function response", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) => String(url).includes(":countTokens")
      ? Response.json({ totalTokens: 9 })
      : new Response(`data: ${JSON.stringify(answer)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const client = provider("gemini-3.8-flash", fetchImpl);
    const messages = imageResult(`data:image/jpeg;base64,${PNG}`);
    await client.chatStream(messages, () => {});
    await client.tokenCountCapability.countTokens(createTokenAccountingRequest({
      provider: "gemini", model: "gemini-3.8-flash", messages, options: {},
    }), new AbortController().signal);
    const streamed = sentBody(fetchImpl, 0).contents[2];
    expect(streamed.parts[0].functionResponse.parts).toEqual([{ inlineData: { mimeType: "image/jpeg", data: PNG } }]);
    expect(sentBody(fetchImpl, 1).generateContentRequest.contents[2]).toEqual(streamed);
  });

  test("an image that cannot travel inline keeps the omission note next to the one that can", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(answer));
    await provider("gemini-3.8-flash", fetchImpl).chat(imageResult(
      "https://example.invalid/remote.png", `data:image/webp;base64,${PNG}`, `data:image/gif;base64,${PNG}`,
    ));
    expect(sentBody(fetchImpl).contents[2].parts[0].functionResponse).toEqual({
      id: "call_1",
      name: "FileRead",
      response: { result: "Read image pic.png\n[image omitted: this provider cannot receive images in tool results]" },
      parts: [{ inlineData: { mimeType: "image/webp", data: PNG } }],
    });
  });

  test.each(["gemini-2.5-pro", "gemini-2.5-flash", "gemma-4-31b-it"])("%s keeps the text-only function response", async (model) => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(answer));
    await provider(model, fetchImpl).chat(imageResult(`data:image/png;base64,${PNG}`));
    const body = sentBody(fetchImpl);
    expect(JSON.stringify(body)).not.toContain(PNG);
    expect(body.contents[2].parts[0].functionResponse.response).toEqual({
      result: "Read image pic.png\n[image omitted: this provider cannot receive images in tool results]",
    });
    expect(body.contents[2].parts[0].functionResponse).not.toHaveProperty("parts");
  });
});

describe("Gemini token counting", () => {
  const signature = "S".repeat(4000);
  const signedHistory = (model: string): LLMMessage[] => [
    { role: "user", content: "run it" },
    {
      role: "assistant", content: "",
      toolCalls: [{ id: "call_1", name: "exec_command", arguments: '{"cmd":"true"}' }],
      providerReasoningContent: JSON.stringify([
        { functionCall: { id: "call_1", name: "exec_command", args: { cmd: "true" } }, thoughtSignature: signature },
        { text: "" },
      ]),
      providerReasoningProvenance: { provider: "gemini", model },
    },
    { role: "tool", toolCallId: "call_1", toolName: "exec_command", content: "done" },
  ];

  test("adds the thinking that returned thought signatures bill as input", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ totalTokens: 500 }));
    const client = provider("gemini-3.8-flash", fetchImpl);
    const count = await client.tokenCountCapability.countTokens(createTokenAccountingRequest({
      provider: "gemini", model: "gemini-3.8-flash", messages: signedHistory("gemini-3.8-flash"), options: {},
    }), new AbortController().signal);
    expect(sentBody(fetchImpl).generateContentRequest.contents[1].parts[0].thoughtSignature).toBe(signature);
    // countTokens leaves the replayed thinking out: 4,000 signature characters are at most 1,000 thought tokens.
    expect(count).toMatchObject({ inputTokens: 1500, complete: true, confidence: "high" });
  });

  test("the placeholder signature and an unsigned history add nothing", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ totalTokens: 500 }));
    const client = provider("gemini-3.8-flash", fetchImpl);
    // Another model produced this step, so the request carries the documented placeholder.
    const count = await client.tokenCountCapability.countTokens(createTokenAccountingRequest({
      provider: "gemini", model: "gemini-3.8-flash", messages: signedHistory("gemini-4-argon"), options: {},
    }), new AbortController().signal);
    expect(sentBody(fetchImpl).generateContentRequest.contents[1].parts[0].thoughtSignature)
      .toBe("skip_thought_signature_validator");
    expect(count.inputTokens).toBe(500);
  });

  test("a request far below the context window is estimated locally, with no countTokens request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ totalTokens: 7 }));
    const client = provider("gemini-3.8-flash", fetchImpl);
    const request = createTokenAccountingRequest({
      provider: "gemini", model: "gemini-3.8-flash", messages: [{ role: "user", content: "hello" }],
      options: {}, contextWindowTokens: 1_048_576,
    });
    const result = await new TokenAccountingService().count(request, { capability: client.tokenCountCapability });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.source).toBe("conservative_fallback");
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  test("a request that could fill half the window still asks Google", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ totalTokens: 300_000 }));
    const client = provider("gemini-3.8-flash", fetchImpl);
    const request = createTokenAccountingRequest({
      provider: "gemini", model: "gemini-3.8-flash", messages: [{ role: "user", content: "x ".repeat(300_000) }],
      options: {}, contextWindowTokens: 1_048_576,
    });
    const result = await new TokenAccountingService().count(request, { capability: client.tokenCountCapability });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0]![0])).toContain("gemini-3.8-flash:countTokens");
    expect(result.source).toBe("provider_native");
    expect(result.inputTokens).toBeGreaterThanOrEqual(300_000);
  });

  test("a request with no known window is counted as before", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ totalTokens: 7 }));
    const client = provider("gemini-3.8-flash", fetchImpl);
    const count = await client.tokenCountCapability.countTokens(createTokenAccountingRequest({
      provider: "gemini", model: "gemini-3.8-flash", messages: [{ role: "user", content: "hello" }], options: {},
    }), new AbortController().signal);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(count.inputTokens).toBe(7);
  });
});

describe("Gemini 4 Hydrogen transport", () => {
  type DispatchInit = RequestInit & { dispatcher: Pick<Dispatcher, "dispatch"> };

  test.each(["gemini-4-hydrogen", "models/gemini-4-hydrogen"])("%s waits 20 minutes for a silent response", async (model) => {
    const dispatch = vi.fn<Dispatcher["dispatch"]>().mockReturnValue(false);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
    const wrapped = geminiTransportFetch(model, fetchImpl);
    expect(wrapped).not.toBe(fetchImpl);
    await wrapped!("https://example.invalid/v1beta", { dispatcher: { dispatch } } as DispatchInit);
    const init = fetchImpl.mock.calls[0]![1] as DispatchInit;
    init.dispatcher.dispatch({ origin: "https://example.invalid", path: "/", method: "POST" } as Dispatcher.DispatchOptions, {} as Dispatcher.DispatchHandler);
    expect(dispatch.mock.calls[0]![0]).toMatchObject({ headersTimeout: 1_200_000, bodyTimeout: 1_200_000 });
  });

  test.each(["gemini-4-unknown", "gemini-4-hydrogen-preview", "gemini-3.8-flash"])("%s keeps the original fetch", (model) => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(geminiTransportFetch(model, fetchImpl)).toBe(fetchImpl);
  });
});
