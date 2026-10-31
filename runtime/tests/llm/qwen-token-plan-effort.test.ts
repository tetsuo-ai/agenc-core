import { describe, expect, it, vi } from "vitest";
import { QwenProvider, QwenTokenPlanProvider } from "../../src/llm/providers/qwen/index.js";
import { resolveReasoningEffort } from "../../src/llm/reasoning-effort.js";
import { resolveRegisteredModelCatalogEntry } from "../../src/llm/registry/model-catalog.js";
import { resolveSessionReasoningEffort } from "../../src/session/session-reasoning-effort.js";

// Qwen3.8 Max and Flash accept reasoning_effort none, which turns thinking off
// (alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions;
// live on the Token Plan 2026-10-31: no reasoning tokens, tools still work).
describe("Qwen3.8 thinking off through the none effort", () => {
  it.each([
    ["qwen-token-plan", "qwen3.8-max"], ["qwen-token-plan", "qwen3.8-flash"],
    ["qwen", "qwen3.8-max"], ["qwen", "qwen3.8-flash"],
  ] as const)("%s %s offers none before low, medium and xhigh", (provider, model) => {
    expect(resolveRegisteredModelCatalogEntry({ provider, model })?.supportedReasoningLevels)
      .toEqual(["none", "low", "medium", "xhigh"]);
    expect(resolveReasoningEffort({ provider, model })).toMatchObject({
      acceptsChatEffort: true, levels: ["none", "low", "medium", "xhigh"], defaultLevel: "xhigh",
    });
  });

  it("keeps the thinking-only and 27B deployments on three levels", () => {
    for (const model of ["qwen3.8-2.4t-a95b", "qwen3.8-27b"]) {
      expect(resolveRegisteredModelCatalogEntry({ provider: "qwen", model })?.supportedReasoningLevels)
        .toEqual(["low", "medium", "xhigh"]);
    }
  });

  it("sends reasoning_effort none on the Token Plan", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      id: "chatcmpl-plan", model: "qwen3.8-flash",
      choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new QwenTokenPlanProvider({
      apiKey: "placeholder", model: "qwen3.8-flash", baseURL: "http://127.0.0.1:1/compatible-mode/v1", fetchImpl,
    });
    await provider.chat([{ role: "user", content: "Reply OK" }], { reasoningEffort: "none" });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sent.reasoning_effort).toBe("none");
    expect(sent.enable_thinking).toBeUndefined();
  });

  // Omitting the field leaves Qwen3.8 thinking at its xhigh default, so a session set to none (the TUI's
  // "effort off", config reasoning_effort = "none", AGENC_EFFORT_LEVEL=none) has to send none literally.
  it.each([
    ["qwen-token-plan", "qwen3.8-max"], ["qwen-token-plan", "qwen3.8-flash"],
    ["qwen", "qwen3.8-max"], ["qwen", "qwen3.8-flash"],
  ] as const)("a %s %s session set to none sends none", (provider, model) => {
    const levels = resolveRegisteredModelCatalogEntry({ provider, model })?.supportedReasoningLevels;
    expect(resolveSessionReasoningEffort("none", levels, { provider, model })).toBe("none");
  });

  // GLM-5.2 on QwenCloud lists none too (live on the Token Plan, 2026-10-31: none = no reasoning tokens): a
  // session set to none reaches the wire as reasoning_effort none on either route.
  it.each([
    ["qwen-token-plan", "glm-5.2"], ["qwen", "glm-5.2"], ["qwen-token-plan", "qwen3.8-max"],
  ] as const)("a %s %s session set to none sends reasoning_effort none on the wire", async (provider, model) => {
    const levels = resolveRegisteredModelCatalogEntry({ provider, model })?.supportedReasoningLevels;
    const effort = resolveSessionReasoningEffort("none", levels, { provider, model });
    expect(effort).toBe("none");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      id: "chatcmpl-none", model,
      choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const Provider = provider === "qwen" ? QwenProvider : QwenTokenPlanProvider;
    const instance = new Provider({
      apiKey: "placeholder", model, baseURL: "http://127.0.0.1:1/compatible-mode/v1", fetchImpl,
    });
    await instance.chat([{ role: "user", content: "Reply OK" }], { reasoningEffort: effort });
    const sent = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(sent.reasoning_effort).toBe("none");
  });

  it("keeps none as no effort field where the Qwen deployment does not list it", () => {
    expect(resolveSessionReasoningEffort("none", ["low", "medium", "xhigh"],
      { provider: "qwen", model: "qwen3.8-27b" })).toBeUndefined();
    expect(resolveSessionReasoningEffort("none", ["low", "medium", "xhigh"],
      { provider: "qwen", model: "qwen3.8-max-0902" })).toBeUndefined();
    expect(resolveSessionReasoningEffort("none", undefined,
      { provider: "qwen-token-plan", model: "qwen3.7-max" })).toBeUndefined();
  });
});
