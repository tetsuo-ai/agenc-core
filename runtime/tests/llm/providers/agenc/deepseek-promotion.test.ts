import { describe, expect, it, vi } from "vitest";
import type { AuthBackend } from "../../../../src/auth/backend.js";
import { createProvider } from "../../../../src/llm/provider.js";
import { AGENC_DEEPSEEK_MODEL as model } from "../../../../src/llm/registry/agenc-deepseek.js";
import { deriveFlatCatalog, resolveRegisteredModelCatalogEntry } from "../../../../src/llm/registry/model-catalog.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../../src/llm/wire/capability-gating.js";

describe("AgenC DeepSeek promotion wire", () => {
  it.each([false, true])("completes a tool round trip within the reviewed gateway contract (stream=%s)", async stream => {
    const bodies: Record<string, any>[] = [];
    const allowed = new Set(["model", "messages", "stream", "stream_options", "max_tokens", "temperature",
      "top_p", "stop", "frequency_penalty", "presence_penalty", "top_k", "seed", "response_format",
      "tools", "tool_choice", "reasoning", "reasoning_effort"]);
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe("https://identity.example.test/v1/chat/completions");
      expect(new Headers(init?.headers).get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      expect(Object.keys(body).filter(key => !allowed.has(key))).toEqual([]);
      if (body.reasoning_effort !== undefined) expect(body.reasoning_effort).toBe("medium");
      const first = bodies.length === 1;
      const message = first
        ? { role: "assistant", content: null, reasoning: "Read the synthetic marker.", tool_calls: [
          { id: "call_marker", type: "function", function: { name: body.tools[0].function.name, arguments: "{}" } },
        ] }
        : { role: "assistant", content: "marker" };
      const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
      const finish_reason = first ? "tool_calls" : "stop";
      if (!body.stream) return Response.json({ model, choices: [{ message, finish_reason }], usage });
      const delta = { ...message, ...(first ? { tool_calls: message.tool_calls!.map(call => ({ ...call, index: 0 })) } : {}) };
      return new Response([
        { model, choices: [{ index: 0, delta }] },
        { model, choices: [{ index: 0, delta: {}, finish_reason }], usage },
      ].map(frame => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } });
    });
    const authBackend: AuthBackend = {
      kind: "remote", login: () => ({ authenticated: true }), logout: () => ({ authenticated: false }),
      whoami: () => ({ authenticated: true }), getSubscriptionTier: () => "free",
      getLlmUsage: () => ({ managedModelsEnabled: true, subscriptionTier: "free",
        modelAllowance: { status: "active", duration: "promotion", allowedModelCount: 1 } }),
      inferAgencModel: () => ({ provider: "openrouter", model }),
      vendKey: (provider, sessionId) => ({ kind: "api-key", provider, sessionId,
        apiKey: "synthetic-capability", baseUrl: "https://identity.example.test/v1" }),
    };
    const provider = createProvider("agenc", { model, tools: [{ type: "function", function: {
      name: "read_marker", parameters: { type: "object", properties: {} },
    } }], extra: { authBackend, sessionId: "synthetic", subscriptionTier: "free", fetchImpl } });
    try {
      const run: typeof provider.chat = (messages, options) => stream
        ? provider.chatStream(messages, () => {}, options) : provider.chat(messages, options);
      const first = await run([{ role: "user", content: "Read marker" }], {
        reasoningEffort: "medium", parallelToolCalls: true, toolChoice: "required", maxOutputTokens: 256,
      });
      expect(first.toolCalls).toEqual([{ id: "call_marker", name: "read_marker", arguments: "{}" }]);
      const final = await run([
        { role: "user", content: "Read marker" },
        { role: "assistant", content: "", toolCalls: first.toolCalls,
          providerReasoningContent: first.providerReasoningContent,
          providerReasoningProvenance: first.providerReasoningProvenance },
        { role: "tool", content: "marker", toolCallId: "call_marker", toolName: "read_marker" },
      ], { reasoningEffort: "xhigh", parallelToolCalls: true, maxOutputTokens: 256 });
      expect(final.content).toBe("marker");
      expect(bodies[0]).toMatchObject({ model, max_tokens: 256, reasoning_effort: "medium" });
      expect(bodies[1].reasoning_effort).toBeUndefined();
      expect(bodies[1].messages.find((row: any) => row.role === "assistant").reasoning).toBe("Read the synthetic marker.");
      expect(bodies[1].messages.find((row: any) => row.role === "tool").tool_call_id).toBe("call_marker");
      expect(bodies).toHaveLength(2);
    } finally { await provider.dispose?.(); }
  });

  it("keeps route metadata hidden and does not change direct OpenRouter capabilities", () => {
    expect(resolveRegisteredModelCatalogEntry({ provider: "agenc", model })).toMatchObject({
      contextWindow: 1_048_576, maxOutputTokens: 8_192, maxOutputTokensUpperLimit: 384_000,
      supportedReasoningLevels: ["medium"], defaultReasoningLevel: "medium", visibility: "none",
    });
    expect(deriveFlatCatalog().agenc ?? []).not.toContain(model);
    expect(chatCompletionsCapabilityHintsForProvider("openrouter", model).acceptsParallelToolCalls).toBeUndefined();
  });
});
