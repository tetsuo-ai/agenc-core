import { describe, expect, it, vi } from "vitest";
import type { AuthBackend } from "../../../../src/auth/backend.js";
import { createProvider } from "../../../../src/llm/provider.js";
import { deriveFlatCatalog, resolveRegisteredModelCatalogEntry } from "../../../../src/llm/registry/model-catalog.js";
import { QWEN_CODER_30B_MODEL as model } from "../../../../src/llm/registry/qwen-coder-30b.js";

describe("AgenC Coder 30B relay wire", () => {
  it.each([false, true])("sends ordinary tool calls without thinking controls despite stale effort (stream=%s)", async (stream) => {
    const bodies: Record<string, any>[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("http://127.0.0.1:43187/v1/chat/completions");
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const message = bodies.length === 1
        ? { role: "assistant", content: null, tool_calls: [{ id: "call_test", type: "function", function: { name: body.tools[0].function.name, arguments: '{"value":"synthetic"}' } }] }
        : { role: "assistant", content: "done" };
      if (body.stream) {
        const delta = { ...message, ...(message.tool_calls ? { tool_calls: message.tool_calls.map((call, index) => ({ ...call, index })) } : {}) };
        const frames = [
          { model, choices: [{ index: 0, delta }] },
          { model, choices: [{ index: 0, delta: {}, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
        ];
        return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ model, choices: [{ message, finish_reason: bodies.length === 1 ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }), { headers: { "content-type": "application/json" } });
    });
    const authBackend: AuthBackend = {
      kind: "remote", login: () => ({ authenticated: true }), logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true }), getSubscriptionTier: () => "free",
      getLlmUsage: () => ({ managedModelsEnabled: true, subscriptionTier: "free", modelAllowance: { status: "active", duration: "pilot", allowedModelCount: 1 } }),
      inferAgencModel: () => ({ provider: "qwen", model }),
      vendKey: (provider, sessionId) => ({ kind: "api-key", provider, sessionId, apiKey: "synthetic-relay-capability", baseUrl: "http://127.0.0.1:43187/v1" }),
    };
    const provider = createProvider("agenc", { model, tools: [{ type: "function", function: {
      name: "echo_value", description: "Echo a synthetic value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    } }], extra: { authBackend, sessionId: "synthetic-session", subscriptionTier: "free", fetchImpl } });
    try {
      const run: typeof provider.chat = (messages, options) => stream
        ? provider.chatStream(messages, () => {}, options) : provider.chat(messages, options);
      const first = await run([{ role: "user", content: "Echo synthetic" }], { reasoningEffort: "medium", toolChoice: "required", maxOutputTokens: 192 });
      expect(first.toolCalls).toEqual([{ id: "call_test", name: "echo_value", arguments: '{"value":"synthetic"}' }]);
      const final = await run([
        { role: "user", content: "Echo synthetic" },
        { role: "assistant", content: "", toolCalls: first.toolCalls },
        { role: "tool", content: "synthetic", toolCallId: "call_test", toolName: "echo_value" },
      ], { reasoningEffort: "xhigh", maxOutputTokens: 192 });
      expect(final.content).toBe("done");
      expect(bodies[0]).toMatchObject({ model, max_completion_tokens: 192, tool_choice: "required" });
      expect(bodies[1].messages.find((message: any) => message.role === "tool").tool_call_id).toBe("call_test");
      for (const body of bodies) for (const field of ["reasoning_effort", "thinking", "enable_thinking", "preserve_thinking", "chat_template_kwargs"]) {
        expect(body[field]).toBeUndefined();
      }
    } finally { await provider.dispose?.(); }
  });

  it("keeps verified native metadata and pilot output policy out of public listings", () => {
    for (const provider of ["agenc", "qwen"]) {
      expect(resolveRegisteredModelCatalogEntry({ provider, model })).toMatchObject({
        displayName: "Qwen Coder 30B", contextWindow: 262_144, maxContextWindow: 262_144,
        maxOutputTokens: 16_384, maxOutputTokensUpperLimit: 32_768,
        inputModalities: ["text"], supportedReasoningLevels: [], visibility: "none",
      });
      expect(resolveRegisteredModelCatalogEntry({ provider, model })?.defaultReasoningLevel).toBeUndefined();
      expect(deriveFlatCatalog()[provider] ?? []).not.toContain(model);
    }
  });
});
