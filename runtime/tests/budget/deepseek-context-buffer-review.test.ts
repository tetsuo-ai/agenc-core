import { describe, expect, test, vi } from "vitest";
import { fitOutputReservationToContext } from "../../src/budget/admitted-model-call.js";
import { LLMContextWindowExceededError } from "../../src/llm/errors.js";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";

const windowTokens = 950_000;
const requestedOutput = 131_072;
const observedBoundaries = [
  { trial: "Vigenere VyVpg2j", inputTokens: 948_879, fittedOutput: 1_121 },
  { trial: "HOF topology AS9FRa5", inputTokens: 948_914, fittedOutput: 1_086 },
];

describe("independent observed context-buffer boundary review", () => {
  test.each(observedBoundaries)("the real adapter refuses $trial before calling fetch", async ({ inputTokens, fittedOutput }) => {
    const fetchImpl = vi.fn<typeof fetch>();
    const provider = new DeepSeekProvider({ apiKey: "offline-fixture", model: "deepseek-flash", fetchImpl });
    await expect(provider.chat([{ role: "user", content: "Synthetic boundary probe" }], {
      maxOutputTokens: fittedOutput, contextWindowTokens: windowTokens, accountedInputTokens: inputTokens,
    })).rejects.toThrow(LLMContextWindowExceededError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(observedBoundaries)("shared preflight must not approve $trial if the adapter rejects it locally", async ({ inputTokens }) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Synthetic response" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { headers: { "content-type": "application/json" } }));
    const provider = new DeepSeekProvider({ apiKey: "offline-fixture", model: "deepseek-flash", fetchImpl });
    const profile = await provider.getExecutionProfile();
    const fitted = fitOutputReservationToContext({ admissible: true, inputTokens, totalTokens: inputTokens + requestedOutput }, windowTokens, requestedOutput, profile.contextSafetyBufferTokens);
    if (fitted === undefined) {
      expect(fetchImpl).not.toHaveBeenCalled();
      return;
    }
    const result = await provider.chat([{ role: "user", content: "Synthetic boundary probe" }], {
      maxOutputTokens: fitted, contextWindowTokens: windowTokens, accountedInputTokens: inputTokens,
    }).then(() => ({ kind: "accepted" }), error => ({ kind: "rejected", localContextGuard: error instanceof LLMContextWindowExceededError }));
    // A fix must retain provider safety and align the upstream decision, not
    // remove the 1024-token safety buffer or enlarge the context window.
    expect(result).not.toMatchObject({ kind: "rejected", localContextGuard: true });
  });
});
