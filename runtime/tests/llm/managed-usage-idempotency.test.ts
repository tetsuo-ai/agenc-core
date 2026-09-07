import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthBackend } from "../../src/auth/backend.js";
import { createProvider } from "../../src/llm/provider.js";
import type { LLMMessage } from "../../src/llm/types.js";

const baseURL = "https://id.agenc.ag/v1/auth/openrouter/v1";
const model = "openai/gpt-5";
const messages: LLMMessage[] = [{ role: "user", content: "Synthetic request" }];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const response = () => Response.json({ id: "synthetic-response", model, choices: [
  { index: 0, message: { role: "assistant", content: "Synthetic answer" }, finish_reason: "stop" },
], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
const stream = () => new Response([
  `data: ${JSON.stringify({ id: "synthetic-stream", model, choices: [{ index: 0, delta: { content: "Synthetic answer" } }] })}\n\n`,
  `data: ${JSON.stringify({ id: "synthetic-stream", model, choices: [{ index: 0, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\n`,
  "data: [DONE]\n\n",
].join(""), { headers: { "content-type": "text/event-stream" } });

function managed(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createProvider("openrouter", { apiKey: "synthetic-agenc-session", baseURL, model,
    extra: { managedGateway: true, maxTokens: 100, fetchImpl, ...extra } });
}
function requestId(init: RequestInit | undefined) { return new Headers(init?.headers).get("Idempotency-Key"); }
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("managed paid request identity", () => {
  test("keeps one UUID through lost responses and HTTP retries, then gives a new call its own identity", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(Response.json({ error: "synthetic-unavailable" }, { status: 503 }))
      .mockImplementation(async () => response());
    const provider = managed(fetchImpl, { defaultHeaders: { "idempotency-key": "unsafe-session-wide-static-value" } });
    const first = expect(provider.chat(messages)).resolves.toMatchObject({ content: "Synthetic answer" });
    await vi.runAllTimersAsync();
    await first;
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const identities = fetchImpl.mock.calls.map(([, init]) => requestId(init));
    expect(identities[0]).toMatch(uuid); expect(new Set(identities).size).toBe(1);
    expect(fetchImpl.mock.calls.map(([, init]) => init?.body)).toEqual(Array(3).fill(fetchImpl.mock.calls[0]![1]!.body));
    await provider.chat(messages);
    expect(requestId(fetchImpl.mock.calls[3]![1])).toMatch(uuid);
    expect(requestId(fetchImpl.mock.calls[3]![1])).not.toBe(identities[0]);
  });

  test("preserves the UUID when a streaming fallback recreates the HTTP session", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: "overloaded" } }, { status: 503 }))
      .mockImplementation(async () => stream());
    const provider = managed(fetchImpl, { providerFallback: { provider: "openrouter", model,
      statuses: [503], targets: [{ provider: "openrouter", model: "qwen/synthetic-fallback" }] } });
    const onChunk = vi.fn();
    const pending = expect(provider.chatStream(messages, onChunk)).resolves.toMatchObject({ content: "Synthetic answer" });
    await vi.runAllTimersAsync();
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requestId(fetchImpl.mock.calls[0]![1])).toMatch(uuid);
    expect(requestId(fetchImpl.mock.calls[1]![1])).toBe(requestId(fetchImpl.mock.calls[0]![1]));
    expect(fetchImpl.mock.calls[1]![1]!.body).toBe(fetchImpl.mock.calls[0]![1]!.body);
    expect(new Headers(fetchImpl.mock.calls[1]![1]!.headers).get("accept")).toBe("text/event-stream");
    expect(onChunk).toHaveBeenCalledWith(expect.objectContaining({ content: "Synthetic answer", done: false }));
  });

  test("assigns distinct IDs to concurrent calls and tool rounds even when inputs and options are reused", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => JSON.parse(String(init?.body)).stream ? stream() : response());
    const provider = managed(fetchImpl), options = { maxOutputTokens: 100 };
    await Promise.all([provider.chat(messages, options), provider.chat(messages, options),
      provider.chatStream(messages, () => {}, options), provider.chatStream(messages, () => {}, options)]);
    await provider.chat([...messages, { role: "assistant", content: "", toolCalls: [{ id: "synthetic-call", name: "read_file", arguments: "{}" }] },
      { role: "tool", content: "Synthetic tool result", toolCallId: "synthetic-call" }], options);
    const identities = fetchImpl.mock.calls.map(([, init]) => requestId(init));
    for (const identity of identities) expect(identity).toMatch(uuid);
    expect(new Set(identities).size).toBe(5);
  });

  test("sets the wire identity after lazy managed credential vending without exposing it as a body field", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    const backend: AuthBackend = { login: () => ({ authenticated: true, provider: "remote" }), logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true, provider: "remote" }), getSubscriptionTier: () => "pro",
      inferAgencModel: () => ({ provider: "openrouter", model }),
      vendKey: (provider, sessionId) => ({ kind: "api-key", provider, sessionId, apiKey: "synthetic-vended-session", baseUrl: baseURL }) };
    const provider = createProvider("openrouter", { model, extra: { authBackend: backend, managedCredential: true,
      sessionId: "synthetic-session", maxTokens: 100, fetchImpl } });
    await provider.chat(messages);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(`${baseURL}/chat/completions`);
    const init = fetchImpl.mock.calls[0]![1]!;
    expect(requestId(init)).toMatch(uuid);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer synthetic-vended-session");
    expect(JSON.parse(String(init.body))).toEqual({ model: "openrouter/openai/gpt-5", stream: false,
      messages: [{ role: "user", content: "Synthetic request" }], max_tokens: 100 });
    expect(String(init.body)).not.toContain("Idempotency"); expect(String(init.body)).not.toContain("synthetic-vended-session");
  });

  test("preserves direct BYOK headers and does not infer managed authority from a hostname", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => response());
    const options = { managedRequestId: "40c87426-0d3a-4b8e-9eb7-a06a882d52a3" };
    for (const target of ["https://openrouter.ai/api/v1", baseURL]) {
      const provider = createProvider("openrouter", { apiKey: "synthetic-byok", baseURL: target, model, extra: { fetchImpl } });
      await provider.chat(messages, options);
      expect(requestId(fetchImpl.mock.lastCall![1])).toBeNull();
    }
    const explicit = createProvider("openrouter", { apiKey: "synthetic-byok", model,
      extra: { fetchImpl, defaultHeaders: { "Idempotency-Key": "synthetic-custom-direct-header" } } });
    await explicit.chat(messages, options);
    expect(requestId(fetchImpl.mock.lastCall![1])).toBe("synthetic-custom-direct-header");
  });
});
