import { describe, expect, it, vi } from "vitest";
import { QwenTokenPlanProvider } from "../../../src/llm/providers/qwen/index.js";
import type { LLMMessage, LLMTool } from "../../../src/llm/types.js";
import { chatCompletionsCapabilityHintsForProvider } from "../../../src/llm/wire/capability-gating.js";
import { buildChatCompletionsRequest } from "../../../src/llm/wire/chat-completions.js";

// Qwen3.6 caches only with explicit cache_control markers (no implicit cache).
// On the Token Plan, qwen3.6-flash agent-loop calls cached 0% of their input
// without markers and 81% with a rolling system + newest-message marker
// (live probes p6b and p7, 2026-10-31).
const TOOLS: readonly LLMTool[] = [{ type: "function", function: {
  name: "FileRead", description: "Read", parameters: { type: "object", properties: { file_path: { type: "string" } } },
}}];
const HISTORY: LLMMessage[] = [
  { role: "user", content: "Read a.txt and summarize it." },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "FileRead", arguments: "{\"file_path\":\"a.txt\"}" }] },
  { role: "tool", toolCallId: "c1", toolName: "FileRead", content: "alpha beta gamma" },
];
const build = (provider: string, model: string) => buildChatCompletionsRequest({
  model, messages: HISTORY, tools: TOOLS, options: { systemPrompt: "SYSTEM_HEAD" },
  providerCapabilityHints: chatCompletionsCapabilityHintsForProvider(provider, model),
});
const markers = (body: Record<string, unknown>) => JSON.stringify(body).split("\"cache_control\"").length - 1;

describe("QwenCloud Token Plan explicit cache markers", () => {
  it("marks the system prompt and the newest message for qwen3.6-flash", () => {
    const body = build("qwen-token-plan", "qwen3.6-flash");
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(body.cache_control).toBeUndefined();
    expect(messages[0]).toEqual({ role: "system",
      content: [{ type: "text", text: "SYSTEM_HEAD", cache_control: { type: "ephemeral" } }] });
    expect(messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1",
      content: [{ type: "text", text: expect.stringContaining("alpha beta gamma"), cache_control: { type: "ephemeral" } }] });
    expect(markers(body)).toBe(2);
    expect(JSON.stringify(messages.slice(1, -1))).not.toContain("cache_control");
  });

  it("leaves implicitly cached models and other routes unmarked", () => {
    for (const [provider, model] of [
      ["qwen-token-plan", "qwen3.8-max"], ["qwen-token-plan", "qwen3.8-flash"], ["qwen-token-plan", "qwen3.7-max"],
      ["qwen-token-plan", "qwen3.7-plus"], ["qwen-token-plan", "deepseek-v4.1-flash"], ["qwen", "qwen3.6-flash"],
      ["deepseek", "deepseek-flash"],
    ] as const) {
      expect(markers(build(provider, model))).toBe(0);
    }
  });

  it("sends the markers through the Token Plan provider", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      id: "chatcmpl-plan", model: "qwen3.6-flash",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new QwenTokenPlanProvider({
      apiKey: "placeholder", model: "qwen3.6-flash", baseURL: "http://127.0.0.1:1/compatible-mode/v1", fetchImpl,
    });
    await provider.chat([{ role: "system", content: "SYSTEM_HEAD" }, ...HISTORY], { tools: [...TOOLS] });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(markers(sent)).toBe(2);
    const messages = sent.messages as Array<Record<string, unknown>>;
    expect(JSON.stringify(messages[0])).toContain("cache_control");
    expect(JSON.stringify(messages.at(-1))).toContain("cache_control");
  });
});
