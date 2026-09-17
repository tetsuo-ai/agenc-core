import { describe, expect, test, vi } from "vitest";
import { runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import type { AdmissionAcquireInput } from "../../src/budget/admission-client.js";
import type { LLMChatOptions } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

function exercise(kernel: boolean, leaseLimit?: number) {
  const warnings = vi.fn();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
    id: "offline-review", model: "glm-5.3",
    choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
  }), { status: 200, headers: { "content-type": "application/json" } }));
  const provider = new OpenAIProvider({
    apiKey: "offline", model: "glm-5.3", useResponsesApi: false,
    baseURL: "http://127.0.0.1:8000/v1", fetchImpl, emitWarning: warnings,
  });
  const admission = {
    scope: { runId: "review-run" },
    acquire: vi.fn(async (input: AdmissionAcquireInput) => {
      expect(input.denialReason).toBeUndefined();
      return {
        reservation: { reservationId: "review-reservation" },
        request: { estimate: { maxOutputTokens: Math.min(input.maxOutputTokens, leaseLimit ?? Infinity) } },
        signal: new AbortController().signal,
      };
    }),
    markDispatched: vi.fn(), recordFallback: vi.fn(), holdUnknown: vi.fn(),
    acknowledgeCompletion: vi.fn(), void: vi.fn(),
  };
  const session = {
    conversationId: "independent-review",
    services: { admissionRequired: kernel, ...(kernel ? { executionAdmission: admission } : {}) },
  } as unknown as Session;
  let seq = 0;
  const dispatch = async (inputTokens: number) => {
    seq++;
    Object.assign(provider, { tokenCountCapability: {
      capabilityVersion: "review-" + inputTokens + "-" + seq,
      adapterRevision: "1", configurationRevision: "1",
      countTokens: async () => ({
        inputTokens, complete: true, confidence: "exact",
        countedComponents: ["system", "messages", "tools", "provider_framing"],
      }),
    } });
    const messages = [{ role: "user" as const, content: "Offline fixture " + inputTokens + "-" + seq }];
    const invoke = vi.fn((options: LLMChatOptions) => provider.chat(messages, options));
    await runAdmittedModelCall({
      session, provider, messages, stepId: "review-" + seq,
      model: "glm-5.3", providerName: "openai", invoke,
      options: { model: "glm-5.3", contextWindowTokens: 950000, maxOutputTokens: 131072 },
    });
    const wire = JSON.parse(String(fetchImpl.mock.calls.at(-1)?.[1]?.body));
    expect(wire).not.toHaveProperty("requestedMaxOutputTokens");
    expect(wire).not.toHaveProperty("requested_max_output_tokens");
    return { wire, options: invoke.mock.calls[0]![0] };
  };
  return { dispatch, warnings, admission, provider, fetchImpl };
}

describe("independent output squeeze dispatch controls", () => {
  test.each([40774, 20000, 1256])("kernel lease minimum %i preserves original warning ceiling", async (limit) => {
    const x = exercise(true, limit);
    const { wire, options } = await x.dispatch(908202);
    expect(options.maxOutputTokens).toBe(limit);
    expect(options.requestedMaxOutputTokens).toBe(131072);
    expect(options.singleWireAttempt).toBe(true);
    expect(wire.max_tokens).toBe(limit);
    expect(x.warnings).toHaveBeenCalledWith(expect.objectContaining({
      cause: "output_reservation_squeezed",
      message: expect.stringContaining(limit + " of the requested 131072"),
    }));
    expect(x.admission.holdUnknown).toHaveBeenCalledOnce();
    expect(x.admission.acknowledgeCompletion).toHaveBeenCalledOnce();
  });

  test.each([false, true])("unsqueezed options stay unchanged, kernel=%s", async (kernel) => {
    const x = exercise(kernel);
    const { wire, options } = await x.dispatch(100);
    expect(options).not.toHaveProperty("requestedMaxOutputTokens");
    expect(wire.max_tokens).toBe(131072);
    expect(x.warnings).not.toHaveBeenCalled();
  });

  test("admitted warning halves, stays quiet between thresholds, and re-arms", async () => {
    const x = exercise(false);
    await x.dispatch(908202); // 40774
    await x.dispatch(910000); // 38976, no second warning
    expect(x.warnings).toHaveBeenCalledTimes(1);
    await x.dispatch(930000); // 18976, below half of last warning
    expect(x.warnings).toHaveBeenCalledTimes(2);
    await x.dispatch(100); // unsqueezed, re-arm
    await x.dispatch(908202);
    expect(x.warnings).toHaveBeenCalledTimes(3);
  });

  test("a further adapter fit retains the original ceiling for its warning", async () => {
    const x = exercise(false);
    await x.provider.chat([{ role: "user", content: "Offline further fit" }], {
      model: "glm-5.3", contextWindowTokens: 950000, accountedInputTokens: 910000,
      maxOutputTokens: 40774, requestedMaxOutputTokens: 131072,
    });
    const wire = JSON.parse(String(x.fetchImpl.mock.calls[0]?.[1]?.body));
    expect(wire.max_tokens).toBe(38976);
    expect(x.warnings).toHaveBeenCalledWith(expect.objectContaining({
      cause: "output_reservation_squeezed",
      message: expect.stringContaining("38976 of the requested 131072"),
    }));
  });
});
