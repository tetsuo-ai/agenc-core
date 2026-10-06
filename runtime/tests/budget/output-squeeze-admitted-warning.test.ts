import { describe, expect, test, vi } from "vitest";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import type { Session } from "../../src/session/session.js";

describe("independent admitted output squeeze warning", () => {
  test.each([
    { inputTokens: 908202, granted: 40774 },
    { inputTokens: 944618, granted: 4358 },
    { inputTokens: 947720, granted: 1256 },
  ])("reports the original ceiling after admission shrinks to $granted", async ({ inputTokens, granted }) => {
    const warnings = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(
      JSON.stringify({
        id: "offline-squeeze",
        model: "glm-5.3",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const provider = new OpenAIProvider({
      apiKey: "offline-fixture", model: "glm-5.3", useResponsesApi: false,
      baseURL: "http://127.0.0.1:8000/v1", fetchImpl, emitWarning: warnings,
    });
    Object.assign(provider, { tokenCountCapability: {
      capabilityVersion: `independent-squeeze-${inputTokens}`, adapterRevision: "1", configurationRevision: "1",
      countTokens: async () => ({ inputTokens, complete: true, confidence: "exact", countedComponents: ["system", "messages", "tools", "provider_framing"] }),
    } });
    const session = { conversationId: `squeeze-review-${inputTokens}`, services: { admissionRequired: false } } as unknown as Session;
    const messages = [{ role: "user" as const, content: "Synthetic offline squeeze fixture" }];
    const invoke = vi.fn((options) => provider.chat(messages, options));
    await runAdmittedModelCall({
      session, provider, messages, stepId: `review-${inputTokens}`, model: "glm-5.3", providerName: "openai", invoke,
      options: { model: "glm-5.3", contextWindowTokens: 950000, maxOutputTokens: 131072 },
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0].maxOutputTokens).toBe(granted);
    const wire = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(wire.max_tokens).toBe(granted);
    expect(warnings).toHaveBeenCalledWith(expect.objectContaining({
      cause: "output_reservation_squeezed",
      message: expect.stringContaining(`${granted} of the requested 131072`),
    }));
  });
});
