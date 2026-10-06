import { expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { runTurn } from "../../src/session/run-turn.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";
import { bodyAt, sseResponse } from "../llm/providers/openai-compatible-test-helpers.js";

type Sample = "reason-cap" | "visible-cap" | "tool-cap" | "tool" | "final";
async function scenario(samples: Sample[]) {
  const execute = vi.fn(async () => ({ content: "observed fixture" }));
  const tool = { name: "read_fixture", description: "Read fixture", inputSchema: { type: "object", properties: {} },
    isReadOnly: true, recoveryCategory: "idempotent" as const, execute };
  const registry = { tools: [tool], toLLMTools: () => [{ type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }], dispatch: execute };
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const i = index++;
    const sample = samples[i] ?? "final";
    const capped = sample.endsWith("-cap");
    const delta = sample === "reason-cap" ? { reasoning_content: "Consider next step." }
      : sample === "tool" || sample === "tool-cap" ? { tool_calls: [{ index: 0, id: `read${i}`, type: "function",
        function: { name: tool.name, arguments: sample === "tool" ? "{}" : '{"partial":' } }] }
      : { content: sample === "final" ? "Finished." : "Partial answer." };
    return sseResponse([
      `data: ${JSON.stringify({ model: "deepseek-flash", choices: [{ index: 0, delta }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: capped ? "length" : sample === "tool" ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: capped ? 8192 : 10, total_tokens: capped ? 8202 : 20,
          ...(sample === "reason-cap" ? { completion_tokens_details: { reasoning_tokens: 8192 } } : {}) } })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });
  const provider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-flash", fetchImpl });
  const { session, events } = mkSession({ provider, model: "deepseek-flash", registry });
  const ctx = mkCtx({ reasoningEffort: "high" });
  await drain(runTurn(session, { ...ctx,
    config: { ...ctx.config, model: "deepseek-flash", model_provider: "deepseek", max_output_tokens: 8192 },
    modelInfo: { ...ctx.modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true, supportedReasoningLevels: ["low", "high", "max"] },
  }, "Read fixtures and finish."));
  for (let i = 0; i < fetchImpl.mock.calls.length; i++) {
    expect(bodyAt(fetchImpl, i)).toMatchObject({ max_tokens: 8192, reasoning_effort: "high" });
  }
  return { fetchImpl, execute, events };
}

test("five productive reasoning-only recoveries continue and normal calls restore thinking", async () => {
  const samples: Sample[] = [...Array.from({ length: 5 }, (): Sample[] => ["reason-cap", "tool"]).flat(), "final"];
  const { fetchImpl, execute, events } = await scenario(samples);
  expect(fetchImpl).toHaveBeenCalledTimes(11);
  expect(execute).toHaveBeenCalledTimes(5);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(true);
  expect(events.some(e => e.msg.type === "turn_failed")).toBe(false);
  for (let i = 0; i < 11; i++) {
    expect(bodyAt(fetchImpl, i).thinking).toEqual({ type: i % 2 === 1 ? "disabled" : "enabled" });
  }
});

test("after productive recoveries, three unproductive retries still exhaust", async () => {
  const { fetchImpl, execute, events } = await scenario(["reason-cap", "tool", "reason-cap", "tool",
    "reason-cap", "reason-cap", "reason-cap", "reason-cap", "final"]);
  expect(fetchImpl).toHaveBeenCalledTimes(8);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(false);
  expect(events.find(e => e.msg.type === "turn_failed")?.msg).toMatchObject({ payload: {
    message: expect.stringContaining("Output recovery is exhausted"),
  } });
});

test.each(["visible-cap", "tool-cap"] as const)("%s keeps its cumulative three-retry limit despite tools between caps", async cap => {
  const { fetchImpl, execute, events } = await scenario([cap, "tool", cap, "tool", cap, "tool", cap, "final"]);
  expect(fetchImpl).toHaveBeenCalledTimes(7);
  expect(execute).toHaveBeenCalledTimes(3);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(false);
  for (let i = 0; i < 7; i++) expect(bodyAt(fetchImpl, i).thinking).toEqual({ type: "enabled" });
});

test.each(["visible-cap", "tool-cap"] as const)("productive reasoning recovery does not forgive earlier %s spending", async cap => {
  const { fetchImpl, events } = await scenario([cap, "reason-cap", "tool", cap, "reason-cap", "tool", cap, "reason-cap", "final"]);
  expect(fetchImpl).toHaveBeenCalledTimes(8);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(false);
  expect(events.find(e => e.msg.type === "turn_failed")?.msg).toMatchObject({ payload: {
    message: expect.stringContaining("Output recovery is exhausted"),
  } });
});
