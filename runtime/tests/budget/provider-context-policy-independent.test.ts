import { describe, expect, test, vi } from "vitest";
import { fitOutputReservationToContext, runAdmittedModelCall } from "../../src/budget/admitted-model-call.js";
import { AgenCProvider } from "../../src/llm/providers/agenc/index.js";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { OpenAIProvider } from "../../src/llm/providers/openai/adapter.js";
import { OllamaProvider } from "../../src/llm/providers/ollama/adapter.js";
import type { AuthBackend } from "../../src/auth/backend.js";
import type { LLMProvider } from "../../src/llm/types.js";
import type { Session } from "../../src/session/session.js";

const windowTokens = 950_000;
const messages = [{ role: "user" as const, content: "Synthetic request" }];
const boundaries = [
  { input: 948_879, requested: 131_072, expected: undefined },
  { input: 948_914, requested: 131_072, expected: undefined },
  { input: 947_952, requested: 131_072, expected: 1_024 },
  { input: 947_953, requested: 131_072, expected: undefined },
  { input: 948_464, requested: 512, expected: 512 },
  { input: 948_465, requested: 512, expected: undefined },
  { input: 948_720, requested: 256, expected: 256 },
  { input: 948_721, requested: 256, expected: undefined },
  { input: 948_975, requested: 1, expected: 1 },
  { input: 948_976, requested: 1, expected: undefined },
];

describe("independent provider-declared context reserve", () => {
  test.each(boundaries)("fits input $input and explicit output $requested without double buffering", ({ input, requested, expected }) => {
    expect(fitOutputReservationToContext({ admissible: true, inputTokens: input, totalTokens: input + requested }, windowTokens, requested, 1024)).toBe(expected);
  });

  test("no declaration retains the original explicit-small-output contract", () => {
    expect(fitOutputReservationToContext({ admissible: true, inputTokens: 30_617, totalTokens: 31_129 }, 31_129, 512)).toBe(512);
    expect(fitOutputReservationToContext({ admissible: true, inputTokens: 948_879, totalTokens: 948_879 + 131_072 }, windowTokens, 131_072)).toBe(1121);
    expect(fitOutputReservationToContext({ admissible: false, inputTokens: 100, totalTokens: 101 }, windowTokens, 1, 1024)).toBeUndefined();
  });

  test.each([true, false, undefined])("OpenAI profile matches the configured wire path: Responses=$use", async use => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new OpenAIProvider({ apiKey: "offline", model: "gpt-4.1", fetchImpl, ...(use === undefined ? {} : { useResponsesApi: use }) });
    expect((await provider.getExecutionProfile()).contextSafetyBufferTokens).toBe(use === false ? 1024 : undefined);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("native Ollama does not inherit the compatible-wire buffer", async () => {
    const provider = new OllamaProvider({ model: "local", numCtx: 31_129 });
    Object.assign(provider, { client: { ps: async () => ({ models: [] }), list: async () => ({ models: [] }), show: async () => ({}) } });
    expect(await provider.getExecutionProfile()).not.toHaveProperty("contextSafetyBufferTokens");
  });

  for (const managed of [false, true]) {
    test.each(boundaries)(`real admission preserves the declared reserve (managed=${managed}, input=$input, output=$requested)`, async ({ input, requested, expected }) => {
      const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
        model: "deepseek-flash", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: input, completion_tokens: 1, total_tokens: input + 1 },
      }), { headers: { "content-type": "application/json" } }));
      const delegate = new DeepSeekProvider({ apiKey: "offline", model: "deepseek-flash", fetchImpl });
      const factory = vi.fn(() => delegate);
      const provider: LLMProvider = managed ? new AgenCProvider({
        model: "agenc:deepseek-flash", sessionId: `managed-${input}-${requested}`,
        authBackend: {
          inferAgencModel: () => ({ provider: "deepseek", model: "deepseek-flash" }),
          vendKey: () => ({ kind: "api-key", apiKey: "offline" }),
        } as unknown as AuthBackend,
        providerFactory: factory,
      }) : delegate;
      Object.assign(provider, { tokenCountCapability: {
        capabilityVersion: "independent-exact-input", adapterRevision: "1",
        configurationRevision: `${managed}-${input}-${requested}`,
        countTokens: async () => ({ inputTokens: input, complete: true, confidence: "exact", countedComponents: ["system", "messages", "tools", "provider_framing"] }),
      } });
      const profile = await provider.getExecutionProfile!();
      expect(profile.contextSafetyBufferTokens).toBe(1024);
      const session = { conversationId: `review-${managed}-${input}-${requested}`, services: { admissionRequired: false } } as unknown as Session;
      const invoke = vi.fn(options => provider.chat(messages, options));
      const call = runAdmittedModelCall({ session, provider, messages, options: {
        model: managed ? "agenc:deepseek-flash" : "deepseek-flash", contextWindowTokens: windowTokens, maxOutputTokens: requested,
      }, stepId: "review-step", model: managed ? "agenc:deepseek-flash" : "deepseek-flash", providerName: managed ? "agenc" : "deepseek", invoke });
      if (expected === undefined) {
        await expect(call).rejects.toMatchObject({ reason: "context_window_exceeded" });
        expect(invoke).not.toHaveBeenCalled();
        expect(fetchImpl).not.toHaveBeenCalled();
      } else {
        await expect(call).resolves.toMatchObject({ content: "ok" });
        expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: expected, accountedInputTokens: input }));
        expect(fetchImpl).toHaveBeenCalledOnce();
        const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
        expect(body.max_tokens).toBe(expected);
        expect(input + expected + 1024).toBeLessThanOrEqual(windowTokens);
      }
      if (managed) expect(factory).toHaveBeenCalledOnce();
    });
  }
});
