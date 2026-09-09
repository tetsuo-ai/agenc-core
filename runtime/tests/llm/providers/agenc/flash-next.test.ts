import { describe, expect, it, vi } from "vitest";
import type { AuthBackend } from "../../../../src/auth/backend.js";
import { createProvider } from "../../../../src/llm/provider.js";
import { resolveModelCatalogMetadata, deriveFlatCatalog } from "../../../../src/llm/registry/model-catalog.js";
import { QWEN_FLASH_NEXT_MODEL as model } from "../../../../src/llm/registry/qwen-flash-next.js";
import type { LLMMessage, LLMTool } from "../../../../src/llm/types.js";

const tools: LLMTool[] = [{ type: "function", function: {
  name: "lookup_ticket", description: "Look up a synthetic ticket", parameters: {
    type: "object", properties: { ticket_id: { type: "string" } }, required: ["ticket_id"],
  },
} }];

function sse(frames: unknown[]): Response {
  return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function authBackend(): AuthBackend {
  return {
    kind: "remote", login: () => ({ authenticated: true }), logout: () => ({ authenticated: false }),
    whoami: () => ({ authenticated: true }), getSubscriptionTier: () => "free",
    getLlmUsage: () => ({ managedModelsEnabled: true, subscriptionTier: "free", modelAllowance: { status: "active", duration: "pilot", allowedModelCount: 1 } }),
    inferAgencModel: () => ({ provider: "qwen", model }),
    vendKey: (provider, sessionId) => ({ kind: "api-key", provider, sessionId, apiKey: "synthetic-loopback-capability", baseUrl: "http://127.0.0.1:43187/v1", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  };
}

describe("AgenC Flash Next relay wire", () => {
  it.each(["reasoning", "reasoning_content"])("preserves %s and fragmented tools across a two-turn stream", async (field) => {
    const requests: Record<string, any>[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:43187/v1/chat/completions");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer synthetic-loopback-capability");
      const body = JSON.parse(String(init?.body));
      requests.push(body);
      if (requests.length === 1) return sse([
        { model, choices: [{ index: 0, delta: { [field]: "synthetic replay state" } }] },
        { model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_lookup", type: "function", function: { name: body.tools[0].function.name, arguments: '{"ticket_id":' } }] } }] },
        { model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"SYN-42"}' } }] } }] },
        { model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        { model, choices: [], usage: { prompt_tokens: 24, completion_tokens: 12, total_tokens: 36 } },
      ]);
      return sse([
        { model, choices: [{ index: 0, delta: { content: "resolved" } }] },
        { model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 45, completion_tokens: 2, total_tokens: 47 } },
      ]);
    });
    const provider = createProvider("agenc", { model, tools, extra: { authBackend: authBackend(), sessionId: "synthetic-session", subscriptionTier: "free", fetchImpl } });
    const messages: LLMMessage[] = [{ role: "user", content: "Look up SYN-42" }];
    const first = await provider.chatStream(messages, () => {}, { reasoningEffort: "medium", maxTokens: 192 });
    expect(first.content).toBe("");
    expect(first.providerReasoningContent).toBe("synthetic replay state");
    expect(first.toolCalls).toEqual([{ id: "call_lookup", name: "lookup_ticket", arguments: '{"ticket_id":"SYN-42"}' }]);
    expect(first.usage.totalTokens).toBe(36);
    const final = await provider.chatStream([...messages,
      { role: "assistant", content: "", toolCalls: first.toolCalls, providerReasoningContent: first.providerReasoningContent, providerReasoningProvenance: first.providerReasoningProvenance },
      { role: "tool", content: '{"status":"resolved"}', toolCallId: "call_lookup", toolName: "lookup_ticket" },
    ], () => {}, { reasoningEffort: "low", maxTokens: 192 });
    expect(final.content).toBe("resolved");
    expect(requests[0]).toMatchObject({ model, reasoning_effort: "medium", chat_template_kwargs: { preserve_thinking: true }, stream_options: { include_usage: true } });
    expect(requests[1].messages.find((message: any) => message.role === "assistant")).toMatchObject({ reasoning: "synthetic replay state" });
    expect(requests[1].messages.find((message: any) => message.role === "tool").tool_call_id).toBe("call_lookup");
    await provider.dispose?.();
  });

  it("uses nested vLLM thinking controls and parses canonical reasoning without streaming", async () => {
    let body: Record<string, any> = {};
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ model, choices: [{ message: { role: "assistant", content: "ok", reasoning: "synthetic state" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } }), { headers: { "content-type": "application/json" } });
    });
    const provider = createProvider("agenc", { model, tools, extra: { authBackend: authBackend(), sessionId: "synthetic-session", fetchImpl } });
    const result = await provider.chat([{ role: "user", content: "use the tool" }], { toolChoice: "required", reasoningEffort: "xhigh" });
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false, preserve_thinking: true });
    expect(body.enable_thinking).toBeUndefined();
    expect(result.providerReasoningContent).toBe("synthetic state");
  });

  it("records native metadata without advertising a globally available route", () => {
    for (const provider of ["agenc", "qwen"]) {
      expect(resolveModelCatalogMetadata({ provider, model })).toMatchObject({
        contextWindow: 262_144, maxOutputTokens: 16_384, maxOutputTokensUpperLimit: 32_768,
      });
      expect(deriveFlatCatalog()[provider] ?? []).not.toContain(model);
    }
  });
});
