import { expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { runTurn } from "../../src/session/run-turn.js";
import { MAX_OUTPUT_TOKENS_RECOVERY_LIMIT, RETRY_REASONING_ONLY_CONTENT } from "../../src/recovery/max-output-tokens.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";
import { bodyAt, sseResponse } from "../llm/providers/openai-compatible-test-helpers.js";

test.each([false, true])("DeepSeek reasoning-only cap retries a changed request at the same effort/ceiling (exhausted=%s)", async exhausted => {
  let count = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const capped = exhausted || count++ === 0;
    const usage = { prompt_tokens: 10, completion_tokens: capped ? 8192 : 2,
      total_tokens: capped ? 8202 : 12, completion_tokens_details: { reasoning_tokens: capped ? 8192 : 0 } };
    return sseResponse([
      `data: ${JSON.stringify({ id: "sample", model: "deepseek-flash", choices: [{ index: 0,
        delta: capped ? { reasoning_content: "Consider the next step." } : { content: "Finished." }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "sample", model: "deepseek-flash", choices: [{ index: 0, delta: {}, finish_reason: capped ? "length" : "stop" }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });
  const provider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-flash", fetchImpl });
  const { session, events } = mkSession({ provider, model: "deepseek-flash" });
  const ctx = mkCtx({ reasoningEffort: "high" });
  await drain(runTurn(session, { ...ctx,
    config: { ...ctx.config, model: "deepseek-flash", model_provider: "deepseek", max_output_tokens: 8192 },
    modelInfo: { ...ctx.modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true, supportedReasoningLevels: ["high"] },
  }, "Complete the requested task."));
  expect(fetchImpl).toHaveBeenCalledTimes(exhausted ? MAX_OUTPUT_TOKENS_RECOVERY_LIMIT + 1 : 2);
  const initial = bodyAt(fetchImpl, 0);
  for (let index = 0; index < fetchImpl.mock.calls.length; index++) {
    const body = bodyAt(fetchImpl, index);
    expect(body.max_tokens).toBe(8192);
    expect(body.reasoning_effort).toBe("high");
    if (index > 0) {
      expect(body.messages).not.toEqual(initial.messages);
      expect(JSON.stringify(body.messages)).toContain(RETRY_REASONING_ONLY_CONTENT);
    }
  }
  if (exhausted) {
    expect(events.some(event => event.msg.type === "turn_complete")).toBe(false);
    expect(events.find(event => event.msg.type === "turn_failed")?.msg).toMatchObject({ payload: {
      message: expect.stringContaining("Output recovery is exhausted"),
    } });
  } else {
    expect(events.some(event => event.msg.type === "turn_complete")).toBe(true);
  }
});
