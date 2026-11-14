import type { Dispatcher } from "undici";
import { describe, expect, test, vi } from "vitest";
import { GEMINI_4_SILENCE_LIMIT_MS, geminiTransportFetch } from "../../../../src/llm/providers/gemini/transport.js";
import { GeminiProvider } from "../../../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../../../src/llm/providers/gemini/endpoint-plan.js";
import { createTokenAccountingRequest } from "../../../../src/llm/token-accounting.js";

type DispatchInit = RequestInit & { dispatcher: Pick<Dispatcher, "dispatch"> };
const messages = [{ role: "user" as const, content: "hello" }];
const answer = { candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] };
const body = '{"contents":[{"role":"user","parts":[{"text":"hello"}]}],"generationConfig":{"maxOutputTokens":4096},"store":false}';

describe("Gemini transport options", () => {
  test("passes a dispatcher through Node's default fetch options", async () => {
    const nativeFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(answer));
    try {
      await geminiTransportFetch("gemini-4-carbon")!("https://example.invalid/v1beta");
      expect((nativeFetch.mock.calls[0]![1] as DispatchInit).dispatcher.dispatch).toBeTypeOf("function");
    } finally { nativeFetch.mockRestore(); }
  });

  test.each(["gemini-4-argon", "gemini-4-carbon"])("uses %s transport for token counting but keeps health checks unchanged", async model => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ totalTokens: 1 }));
    const client = new GeminiProvider({
      model, fetchImpl,
      credentialPlan: { kind: "api-key", credential: "local-test-only", source: "factory" },
      endpointPlan: createGeminiEndpointPlan({ baseURL: "http://127.0.0.1:8080/v1beta" }),
    });
    const count = (effectiveModel: string) => client.tokenCountCapability.countTokens(createTokenAccountingRequest({
      provider: "gemini", model, messages, options: { model: effectiveModel },
    }), new AbortController().signal);
    await count(model);
    expect((fetchImpl.mock.calls[0]![1] as DispatchInit).dispatcher.dispatch).toBeTypeOf("function");
    await count("gemini-3.8-flash");
    expect(fetchImpl.mock.calls[1]![1]).not.toHaveProperty("dispatcher");
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("gemini-3.8-flash:countTokens");
    await expect(client.healthCheck()).resolves.toBe(true);
    expect(fetchImpl.mock.calls[2]![1]).not.toHaveProperty("dispatcher");
  });

  test.each([
    "gemini-3.8-flash", "gemini-3.1-pro-preview", "gemini-2.5-pro",
    "gemma-4-31b-it", "gemini-4-unknown", "gemini-4-carbon-preview",
  ])("keeps the exact original fetch for %s", model => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(geminiTransportFetch(model, fetchImpl)).toBe(fetchImpl);
    expect(geminiTransportFetch(model)).toBeUndefined();
  });

  test.each([
    "gemini-4-argon", "gemini-4-carbon", "models/gemini-4-carbon",
    "publishers/google/models/gemini-4-argon", "gemini:gemini-4-carbon", "google/gemini-4-argon",
  ])("changes only the dispatch silence timers for registered %s", async model => {
    const dispatch = vi.fn<Dispatcher["dispatch"]>().mockReturnValue(false);
    const base = { dispatch, get isMockActive() { return this.dispatch === dispatch; } };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
    const signal = new AbortController().signal;
    const init: DispatchInit = {
      method: "POST", headers: new Headers({ "x-test": "unchanged" }), body,
      signal, redirect: "manual", dispatcher: base,
    };
    const fetchWithWait = geminiTransportFetch(model, fetchImpl)!;
    await fetchWithWait("https://example.invalid/v1beta", init);
    const actual = fetchImpl.mock.calls[0]![1] as DispatchInit;
    const { dispatcher, ...rest } = actual;
    const { dispatcher: _base, ...original } = init;
    expect(rest).toEqual(original);
    expect(actual.headers).toBe(init.headers);
    expect(actual.signal).toBe(signal);
    expect(init.dispatcher).toBe(base);
    expect(dispatcher).not.toBe(base);
    expect((dispatcher as typeof base).isMockActive).toBe(true);
    const options = {
      origin: "https://example.invalid", path: "/v1beta", method: "POST" as const,
      body, headers: ["x-test", "unchanged"], headersTimeout: 1_800_000, bodyTimeout: 0,
    };
    const handler = {};
    expect(dispatcher.dispatch(options, handler)).toBe(false);
    // A longer limit of the request is kept, and no limit stays no limit.
    expect(dispatch).toHaveBeenCalledExactlyOnceWith({ ...options, headersTimeout: 1_800_000, bodyTimeout: 0 }, handler);
    expect(dispatch.mock.contexts[0]).toBe(base);
    expect(dispatch.mock.calls[0]![0].headers).toBe(options.headers);
    expect(dispatch.mock.calls[0]![1]).toBe(handler);
    expect(options.headersTimeout).toBe(1_800_000);
    await fetchWithWait("https://example.invalid/v1beta", init);
    expect((fetchImpl.mock.calls[1]![1] as DispatchInit).dispatcher).toBe(dispatcher);
  });

  test("waits 20 minutes where the request set no limit or a shorter one", async () => {
    expect(GEMINI_4_SILENCE_LIMIT_MS).toBe(1_200_000);
    const dispatch = vi.fn<Dispatcher["dispatch"]>().mockReturnValue(false);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer));
    await geminiTransportFetch("gemini-4-argon", fetchImpl)!("https://example.invalid/v1beta", { dispatcher: { dispatch } } as DispatchInit);
    const { dispatcher } = fetchImpl.mock.calls[0]![1] as DispatchInit;
    const request = { origin: "https://example.invalid", path: "/v1beta", method: "POST" as const };
    dispatcher.dispatch(request, {});
    dispatcher.dispatch({ ...request, headersTimeout: 300_000, bodyTimeout: 30 }, {});
    for (const [options] of dispatch.mock.calls) {
      expect(options).toMatchObject({ headersTimeout: 1_200_000, bodyTimeout: 1_200_000 });
    }
  });

  test.each(["chat", "stream", "count"] as const)("preserves every older-model %s request byte and option", async operation => {
    const fetchImpl = vi.fn<typeof fetch>(async () => operation === "count"
      ? Response.json({ totalTokens: 1 })
      : operation === "chat" ? Response.json(answer)
        : new Response(`data: ${JSON.stringify(answer)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
    const client = new GeminiProvider({
      model: "gemini-3.8-flash", fetchImpl,
      credentialPlan: { kind: "api-key", credential: "local-test-only", source: "factory" },
      endpointPlan: createGeminiEndpointPlan({ baseURL: "http://127.0.0.1:8080/v1beta" }),
    });
    const signal = new AbortController().signal;
    if (operation === "chat") await client.chat(messages, { signal });
    else if (operation === "stream") await client.chatStream(messages, () => {}, { signal });
    else await client.tokenCountCapability.countTokens(createTokenAccountingRequest({
      provider: "gemini", model: "gemini-3.8-flash", messages, options: {},
    }), signal);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0]!;
    const suffix = operation === "chat" ? "generateContent"
      : operation === "stream" ? "streamGenerateContent?alt=sse" : "countTokens";
    expect(String(url)).toBe(`http://127.0.0.1:8080/v1beta/models/gemini-3.8-flash:${suffix}`);
    expect(Object.keys(init!).sort()).toEqual(["body", "headers", "method", "redirect", "signal"]);
    expect(init!.method).toBe("POST");
    expect(init!.redirect).toBe("manual");
    expect(init!.body).toBe(operation === "count"
      ? `{"generateContentRequest":{"model":"models/gemini-3.8-flash",${body.slice(1)}}` : body);
    expect([...(init!.headers as Headers).entries()]).toEqual([
      ...(operation === "stream" ? [["accept", "text/event-stream"]] : []),
      ["content-type", "application/json"], ["x-goog-api-key", "local-test-only"],
    ]);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(init!.signal!.aborted).toBe(false);
  });
});
