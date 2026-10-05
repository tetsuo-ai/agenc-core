import { expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { runTurn } from "../../src/session/run-turn.js";
import { MAX_OUTPUT_TOKENS_RECOVERY_LIMIT, RETRY_REASONING_ONLY_CONTENT } from "../../src/recovery/max-output-tokens.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";
import { bodyAt, sseResponse } from "../llm/providers/openai-compatible-test-helpers.js";

test.each([false, true])("DeepSeek reasoning-only cap retries a changed request at retry-only disabled thinking and the same ceiling (exhausted=%s)", async exhausted => {
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
    modelInfo: { ...ctx.modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true, supportedReasoningLevels: ["low", "high", "max"] },
  }, "Complete the requested task."));
  expect(fetchImpl).toHaveBeenCalledTimes(exhausted ? MAX_OUTPUT_TOKENS_RECOVERY_LIMIT + 1 : 2);
  const initial = bodyAt(fetchImpl, 0);
  for (let index = 0; index < fetchImpl.mock.calls.length; index++) {
    const body = bodyAt(fetchImpl, index);
    expect(body.max_tokens).toBe(8192);
    expect(body.reasoning_effort).toBe("high");
    expect(body.thinking).toEqual({ type: index === 0 ? "enabled" : "disabled" });
    if (index > 0) {
      expect(body.messages).not.toEqual(initial.messages);
      expect(JSON.stringify(body.messages)).toContain(RETRY_REASONING_ONLY_CONTENT);
    }
  }
  expect(events.filter(event => event.msg.type === "warning" && event.msg.payload.cause === "thinking_disabled_recovery")).toHaveLength(exhausted ? 3 : 1);
  const warning = events.find(event => event.msg.type === "warning" && event.msg.payload.cause === "thinking_disabled_recovery");
  expect(warning?.msg).toMatchObject({ payload: { message: JSON.stringify({ configuredEffort: "high", effectiveThinking: "disabled", maxOutputTokens: 8192, scope: "reasoning_only_output_recovery_sample" }) } });
  if (exhausted) {
    expect(events.some(event => event.msg.type === "turn_complete")).toBe(false);
    expect(events.find(event => event.msg.type === "turn_failed")?.msg).toMatchObject({ payload: {
      message: expect.stringContaining("Output recovery is exhausted"),
    } });
  } else {
    expect(events.some(event => event.msg.type === "turn_complete")).toBe(true);
  }
});

test("a successful recovery tool call restores configured effort for the next normal call", async () => {
  const execute = vi.fn(async () => ({ content: "fixture result" }));
  const tool = { name: "read_fixture", description: "Read fixture", inputSchema: { type: "object", properties: {} }, isReadOnly: true, recoveryCategory: "idempotent" as const, execute };
  const registry = { tools: [tool], toLLMTools: () => [{ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }], dispatch: execute };
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const i = index++;
    const delta = i === 0 ? { reasoning_content: "Think." } : i === 1 ? { tool_calls: [{ index: 0, id: "read1", type: "function", function: { name: "read_fixture", arguments: "{}" } }] } : { content: "Done." };
    return sseResponse([
      `data: ${JSON.stringify({ id: "sample", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "sample", choices: [{ index: 0, delta: {}, finish_reason: i === 0 ? "length" : i === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: i === 0 ? 8192 : 10, total_tokens: i === 0 ? 8202 : 20, completion_tokens_details: { reasoning_tokens: i === 0 ? 8192 : 0 } } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });
  const provider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-flash", fetchImpl });
  const { session } = mkSession({ provider, model: "deepseek-flash", registry });
  const ctx = mkCtx({ reasoningEffort: "high" });
  await drain(runTurn(session, { ...ctx, config: { ...ctx.config, model: "deepseek-flash", model_provider: "deepseek", max_output_tokens: 8192 }, modelInfo: { ...ctx.modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true, supportedReasoningLevels: ["low", "high", "max"] } }, "Read fixture and finish."));
  expect([0, 1, 2].map(i => bodyAt(fetchImpl, i).thinking)).toEqual([{ type: "enabled" }, { type: "disabled" }, { type: "enabled" }]);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect([0, 1, 2].map(i => bodyAt(fetchImpl, i).reasoning_effort)).toEqual(["high", "high", "high"]);
  expect([0, 1, 2].map(i => bodyAt(fetchImpl, i).max_tokens)).toEqual([8192, 8192, 8192]);
});

test("a visible-output cap after thinking-off restores normal thinking and keeps the cumulative retry budget", async () => {
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const i = index++;
    const capped = i < 3;
    const reasoning = i === 0 || i === 2;
    return sseResponse([
      `data: ${JSON.stringify({ id: "sample", model: "deepseek-flash", choices: [{ index: 0, delta: reasoning ? { reasoning_content: "Think." } : { content: "Answer." }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "sample", choices: [{ index: 0, delta: {}, finish_reason: capped ? "length" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: capped ? 8192 : 2, total_tokens: capped ? 8202 : 12, ...(reasoning ? { completion_tokens_details: { reasoning_tokens: 8192 } } : {}) } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });
  const provider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-flash", fetchImpl });
  const { session, events } = mkSession({ provider, model: "deepseek-flash" });
  const ctx = mkCtx({ reasoningEffort: "high" });
  await drain(runTurn(session, { ...ctx, config: { ...ctx.config, model: "deepseek-flash", model_provider: "deepseek", max_output_tokens: 8192 }, modelInfo: { ...ctx.modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true, supportedReasoningLevels: ["low", "high", "max"] } }, "Finish the task."));
  expect(fetchImpl).toHaveBeenCalledTimes(4);
  expect([0, 1, 2, 3].map(i => bodyAt(fetchImpl, i).thinking)).toEqual([{ type: "enabled" }, { type: "disabled" }, { type: "enabled" }, { type: "disabled" }]);
  expect([0, 1, 2, 3].map(i => bodyAt(fetchImpl, i).max_tokens)).toEqual([8192, 8192, 8192, 8192]);
  expect(events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === "thinking_disabled_recovery")).toHaveLength(2);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(true);
});
