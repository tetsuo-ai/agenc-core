import { afterEach, describe, expect, test, vi } from "vitest";
import type { AuthBackend } from "../../src/auth/backend.js";
import { createProvider } from "../../src/llm/provider.js";
import type { LLMMessage } from "../../src/llm/types.js";
import { LLMManagedAdmissionError, LLMManagedUsagePendingError } from "../../src/llm/errors.js";
import { isTransientProviderError } from "../../src/recovery/api-errors.js";

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
  test.each([false, true])("keeps repeated provider tool IDs distinct across rounds and stable within an attempt (stream=%s)", async (streaming) => {
    const tools = [{type:"function" as const,function:{name:"write_marker",parameters:{type:"object",properties:{content:{type:"string"}}}}}];
    const argumentsText = JSON.stringify({content:"    marker\n"});
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const call={id:"call_0",type:"function",function:{name:"write_marker",arguments:argumentsText}};
      return JSON.parse(String(init?.body)).stream ? new Response([
        {model,choices:[{index:0,delta:{tool_calls:[{...call,index:0}]}}]},
        {model,choices:[{index:0,delta:{},finish_reason:"tool_calls"}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}},
      ].map(frame=>`data: ${JSON.stringify(frame)}\n\n`).join("")+"data: [DONE]\n\n",{headers:{"content-type":"text/event-stream"}}) :
        Response.json({model,choices:[{message:{role:"assistant",content:"",tool_calls:[call]},finish_reason:"tool_calls"}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}});
    });
    const provider = managed(fetchImpl), history: LLMMessage[] = [...messages], ids:string[]=[];
    for (let i=0;i<3;i++) {
      const options={tools,singleWireAttempt:true,managedRequestId:`40c87426-0d3a-4b8e-9eb7-a06a882d52a${i}`};
      const chunks:unknown[]=[];
      const result=streaming?await provider.chatStream(history,c=>chunks.push(c),options):await provider.chat(history,options);
      const call=result.toolCalls[0]!;ids.push(call.id);
      expect(call.arguments).toBe(argumentsText);
      if(streaming)expect(chunks.at(-1)).toMatchObject({done:true,toolCalls:result.toolCalls});
      const replay=streaming?await provider.chatStream(history,()=>{},options):await provider.chat(history,options);
      expect(replay.toolCalls[0]!.id).toBe(call.id);
      history.push({role:"assistant",content:"",toolCalls:result.toolCalls},{role:"tool",toolCallId:call.id,content:"written"});
    }
    expect(new Set(ids).size).toBe(3);
    const sent=JSON.parse(String(fetchImpl.mock.lastCall![1]?.body));
    expect(sent.messages.filter((m:LLMMessage)=>m.role==="tool").map((m:{tool_call_id:string})=>m.tool_call_id)).toEqual(ids.slice(0,2));
    expect(sent).not.toHaveProperty("toolCallIdNamespace");
  });

  test.each([false, true])("does not automatically retry a recorded failed attempt (stream=%s)", async (streaming) => {
    for (const [status, code, state] of [[502, "provider_unavailable", "pending"], [409, "request_already_recorded", "uncertain"]] as const) {
      const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => Response.json({error:{code}}, {
        status, headers:{"x-agenc-request-id":requestId(init)!,"x-agenc-usage-status":state},
      }));
      const provider = managed(fetchImpl);
      const error = await (streaming ? provider.chatStream(messages,()=>{},{singleWireAttempt:true}) : provider.chat(messages,{singleWireAttempt:true})).catch(error=>error);
      expect(error).toBeInstanceOf(LLMManagedUsagePendingError);
      expect(error).not.toBeInstanceOf(LLMManagedAdmissionError);
      expect(isTransientProviderError(error)).toBe(false);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });

  test("does not treat an unrelated gateway response as evidence of recorded usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({error:{code:"provider_unavailable"}}, {
      status:502, headers:{"x-agenc-request-id":"unrelated","x-agenc-usage-status":"pending"},
    }));
    const error = await managed(fetchImpl).chat(messages,{singleWireAttempt:true}).catch(error=>error);
    expect(error).not.toBeInstanceOf(LLMManagedUsagePendingError);
    expect(isTransientProviderError(error)).toBe(true);
  });

  test.each([false,true])("recognizes a matching no-dispatch receipt without automatic recovery (stream=%s)", async (streaming) => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => Response.json({error:{code:"too_many_requests"}}, {
      status:429, headers:{"x-agenc-request-id":requestId(init)!,"x-agenc-usage-status":"not_started"},
    }));
    const provider = managed(fetchImpl);
    const result = streaming ? provider.chatStream(messages,()=>{},{singleWireAttempt:true}) : provider.chat(messages,{singleWireAttempt:true});
    const error = await result.catch(error=>error);
    expect(error).toBeInstanceOf(LLMManagedAdmissionError);
    expect(isTransientProviderError(error)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  test.each(["different-request","pending"])("does not infer no usage from an unbound receipt (%s)", async (condition) => {
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => Response.json({error:{code:"too_many_requests"}}, {
      status:429, headers:{"x-agenc-request-id":condition==="different-request"?"unrelated":requestId(init)!,"x-agenc-usage-status":condition==="pending"?"pending":"not_started"},
    }));
    const error = await managed(fetchImpl).chat(messages,{singleWireAttempt:true}).catch(error=>error);
    expect(error).not.toBeInstanceOf(LLMManagedAdmissionError);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

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
