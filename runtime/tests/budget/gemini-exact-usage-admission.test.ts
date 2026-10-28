import { describe, expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import type { AdmissionAcquireInput } from "../../src/budget/admission-client.js";
import { createAllowAdmissionHarness } from "./admission-test-harness.js";
import { GeminiProvider } from "../../src/llm/providers/gemini/index.js";
import { createGeminiEndpointPlan } from "../../src/llm/providers/gemini/endpoint-plan.js";
import type { Session } from "../../src/session/session.js";

function session(scope: Parameters<typeof createAllowAdmissionHarness>[0]["scope"]) {
  const harness = createAllowAdmissionHarness({ scope });
  return {
    ...harness,
    session: {
      conversationId: "gemini-exact-usage",
      services: {
        executionAdmission: harness.admission,
        admissionRequired: true,
        agentControl: { shutdownAgentTree: vi.fn() },
      },
      abortTerminal: vi.fn(),
    } as unknown as Session,
  };
}

const answer = {
  candidates: [{ content: { role: "model", parts: [{ text: "done" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 4_321, candidatesTokenCount: 7, totalTokenCount: 4_328 },
};

async function admittedGeminiCall(scope: Parameters<typeof createAllowAdmissionHarness>[0]["scope"], text: string) {
  const state = session(scope);
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (url) =>
    String(url).includes(":countTokens")
      ? Response.json({ totalTokens: 4_321 })
      : new Response(`data: ${JSON.stringify(answer)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
  const provider = new GeminiProvider({
    model: "gemini-4-argon",
    fetchImpl,
    contextWindowTokens: 1_048_576,
    endpointPlan: createGeminiEndpointPlan(),
    credentialPlan: { kind: "api-key", credential: "test-only", source: "factory" },
  });
  // Distinct text per test: native counts are cached by request.
  const messages = [{ role: "user" as const, content: text }];
  await runAdmittedModelCall({
    session: state.session, provider, messages,
    options: { maxOutputTokens: 65_536 }, stepId: "model:1", model: "gemini-4-argon", providerName: "gemini",
    invoke: (options) => provider.chatStream(messages, () => {}, options),
  });
  return { state, fetchImpl };
}

describe("Gemini admission without a countTokens round trip", () => {
  test("admits from the local estimate and settles at Google's reported usage", async () => {
    const { state, fetchImpl } = await admittedGeminiCall({}, "Fix the failing test in inventory.py.");
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes(":countTokens"))).toHaveLength(0);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const acquired = state.acquire.mock.calls[0]?.[0] as AdmissionAcquireInput;
    expect(acquired.maxInputTokens).toBeGreaterThan(0);
    expect(acquired.maxOutputTokens).toBe(65_536);
    expect(state.reconcile).toHaveBeenCalledWith("reservation-1", expect.objectContaining({ inputTokens: 4_321, outputTokens: 7 }));
  });

  test.each([
    ["a hard cost cap", { maxCostUsd: 5, hasHardCostCap: true }],
    ["a hard token cap", { maxTokens: 2_000_000, hasHardTokenCap: true }],
  ] as const)("keeps the native count under %s", async (label, scope) => {
    const { state, fetchImpl } = await admittedGeminiCall(scope, `Fix the failing test under ${label}.`);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).includes(":countTokens"))).toHaveLength(1);
    const acquired = state.acquire.mock.calls[0]?.[0] as AdmissionAcquireInput;
    // Google's count plus the margin admission keeps on a high-confidence count.
    expect(acquired.maxInputTokens).toBeGreaterThanOrEqual(4_321);
    expect(acquired.maxInputTokens).toBeLessThan(5_200);
  });
});
