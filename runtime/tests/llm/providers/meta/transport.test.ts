import type { Dispatcher } from "undici";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ProviderHttpClient } from "../../../../src/llm/client.js";
import { MetaProvider } from "../../../../src/llm/providers/meta/index.js";
import { DeepSeekProvider } from "../../../../src/llm/providers/deepseek/index.js";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import { geminiTransportFetch } from "../../../../src/llm/providers/gemini/transport.js";
import { isRegisteredMetaChatModel } from "../../../../src/llm/registry/meta-models.js";
import { BUILT_IN_PROVIDER_MODEL_CATALOG } from "../../../../src/llm/registry/provider-info.js";

type DispatchInit = RequestInit & { dispatcher: Pick<Dispatcher, "dispatch"> };
const messages = [{ role: "user" as const, content: "hello" }];
const registered = BUILT_IN_PROVIDER_MODEL_CATALOG.meta.filter(isRegisteredMetaChatModel);
const answer = { choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };
function response(stream: boolean, responses: boolean) {
  if (responses) {
    const completed = { id: "resp_test", status: "completed", output: [
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
    ] };
    return stream ? new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`,
      { headers: { "content-type": "text/event-stream" } }) : Response.json(completed);
  }
  return stream ? new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } }) : Response.json(answer);
}

afterEach(() => { vi.restoreAllMocks(); });

describe("Meta transport options", () => {
  for (const model of [...registered, "meta:muse-spark-1.3", "meta/muse-spark-1.3"]) {
    test.each([false, true])(`${model} stream=%s changes only the dispatch silence timers`, async stream => {
      const fetchImpl = vi.fn<typeof fetch>(async () => response(stream, model.includes("wonder")));
      const provider = new MetaProvider({ model, apiKey: "local-test-only", fetchImpl });
      if (stream) await provider.chatStream(messages, () => {});
      else await provider.chat(messages);
      const init = fetchImpl.mock.calls[0]![1] as DispatchInit;
      const { dispatcher, ...rest } = init;
      expect(dispatcher.dispatch).toBeTypeOf("function");
      expect(Object.keys(rest).sort()).toEqual(["body", "headers", "method", "redirect", "signal"]);
      expect(rest.method).toBe("POST");
      expect(rest.redirect).toBe("manual");
      expect(rest.signal).toBeInstanceOf(AbortSignal);
      expect((rest.headers as Headers).get("authorization")).toBe("Bearer local-test-only");
      expect(JSON.parse(String(rest.body))).toMatchObject({ model, stream });
    });
  }

  test("uses the native fetch when no custom fetch is supplied", async () => {
    const nativeFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(answer));
    await new MetaProvider({ model: "muse-spark-1.3", apiKey: "local-test-only" }).chat(messages);
    expect((nativeFetch.mock.calls[0]![1] as DispatchInit).dispatcher.dispatch).toBeTypeOf("function");
  });

  test("keeps health checks on the original transport", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ data: [] }));
    await expect(new MetaProvider({ model: "muse-spark-1.3", apiKey: "local-test-only", fetchImpl }).healthCheck())
      .resolves.toBe(true);
    expect(fetchImpl.mock.calls[0]![1]).not.toHaveProperty("dispatcher");
  });

  test.each(["muse-spark-unknown", "muse-wonder-1.1", "muse-image-1.0", "muse-voice-transcribe-1.0"])(
    "keeps the original transport for unregistered %s", async model => {
      const fetchImpl = vi.fn<typeof fetch>(async () => response(false, model.includes("wonder")));
      const sessions = vi.spyOn(ProviderHttpClient.prototype, "createTurnSession");
      await new MetaProvider({ model, apiKey: "local-test-only", fetchImpl }).chat(messages);
      const session = sessions.mock.results[0]!.value as { config: { fetchImpl: typeof fetch } };
      expect(session.config.fetchImpl).toBe(fetchImpl);
      expect(fetchImpl.mock.calls[0]![1]).not.toHaveProperty("dispatcher");
    },
  );

  test("shares Gemini's cached dispatcher and preserves explicit pool options and ownership", async () => {
    const dispatch = vi.fn<Dispatcher["dispatch"]>().mockReturnValue(false);
    const close = vi.fn();
    const destroy = vi.fn();
    const base = { dispatch, close, destroy, get isMockActive() { return this.dispatch === dispatch; } };
    // Supply a dispatcher at the session boundary, as a custom transport can.
    const createSession = ProviderHttpClient.prototype.createTurnSession;
    let selectedFetch!: typeof fetch;
    vi.spyOn(ProviderHttpClient.prototype, "createTurnSession").mockImplementation(function (overrides) {
      selectedFetch = overrides!.fetchImpl!;
      return createSession.call(this, overrides);
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(answer));
    await new MetaProvider({ model: "muse-spark-1.3", apiKey: "local-test-only", fetchImpl }).chat(messages);
    fetchImpl.mockClear();
    const init: DispatchInit = { method: "POST", body: "unchanged", headers: new Headers({ "x-test": "unchanged" }),
      signal: new AbortController().signal, redirect: "manual", dispatcher: base };
    await selectedFetch("https://example.invalid", init);
    const { dispatcher, ...rest } = fetchImpl.mock.calls[0]![1] as DispatchInit;
    const { dispatcher: _base, ...original } = init;
    expect(rest).toEqual(original);
    expect(rest.headers).toBe(init.headers);
    expect(rest.signal).toBe(init.signal);
    expect(init.dispatcher).toBe(base);
    expect(dispatcher).not.toBe(base);
    expect((dispatcher as typeof base).isMockActive).toBe(true);
    const options = { origin: "https://example.invalid", path: "/", method: "POST" as const, headers: ["x-test", "unchanged"] };
    const handler = {};
    dispatcher.dispatch(options, handler);
    dispatcher.dispatch({ ...options, headersTimeout: 30, bodyTimeout: 300_000 }, handler);
    dispatcher.dispatch({ ...options, headersTimeout: 1_800_000, bodyTimeout: 0 }, handler);
    expect(dispatch.mock.calls.map(([request]) => [request.headersTimeout, request.bodyTimeout])).toEqual([
      [1_200_000, 1_200_000], [1_200_000, 1_200_000], [1_800_000, 0],
    ]);
    for (let i = 0; i < 3; i++) {
      expect(dispatch.mock.contexts[i]).toBe(base);
      expect(dispatch.mock.calls[i]![0].headers).toBe(options.headers);
      expect(dispatch.mock.calls[i]![1]).toBe(handler);
    }
    await selectedFetch("https://example.invalid", init);
    await geminiTransportFetch("gemini-4-carbon", fetchImpl)!("https://example.invalid", init);
    expect((fetchImpl.mock.calls[1]![1] as DispatchInit).dispatcher).toBe(dispatcher);
    expect((fetchImpl.mock.calls[2]![1] as DispatchInit).dispatcher).toBe(dispatcher);
    expect(close).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });
});

for (const kind of ["deepseek", "openai-chat", "openai-responses"] as const) {
  test.each([false, true])(`${kind} stream=%s keeps the exact original fetch and request init`, async stream => {
    const responses = kind === "openai-responses";
    const fetchImpl = vi.fn<typeof fetch>(async () => response(stream, responses));
    const config = { model: kind === "deepseek" ? "deepseek-v4-pro" : "gpt-4.1", apiKey: "local-test-only",
      baseURL: "https://example.invalid/v1", fetchImpl, useResponsesApi: responses, maxTokens: 100 };
    const sessions = vi.spyOn(ProviderHttpClient.prototype, "createTurnSession");
    const provider = kind === "deepseek" ? new DeepSeekProvider(config) : new OpenAIProvider(config);
    if (stream) await provider.chatStream(messages, () => {});
    else await provider.chat(messages);
    const session = sessions.mock.results[0]!.value as { config: { fetchImpl: typeof fetch } };
    expect(session.config.fetchImpl).toBe(fetchImpl);
    expect(sessions.mock.calls[0]![0]).toEqual({ wireApi: responses ? "responses" : "chat_completions" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`https://example.invalid/v1/${responses ? "responses" : "chat/completions"}`);
    expect(Object.keys(init!).sort()).toEqual(["body", "headers", "method", "redirect", "signal"]);
    expect(init!.signal).toBeInstanceOf(AbortSignal);
    expect(init!.signal!.aborted).toBe(false);
    expect({ ...init, signal: "AbortSignal", headers: [...(init!.headers as Headers).entries()] }).toMatchSnapshot();
  });
}
