import { expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { runTurn } from "../../src/session/run-turn.js";
import {
  REASONING_CAP_ESCALATION_FACTOR,
  RETRY_REASONING_ONLY_CONTENT,
  resolveReasoningCapEscalation,
} from "../../src/recovery/max-output-tokens.js";
import { defaultConfig, validateAgenCConfigBlocks } from "../../src/config/schema.js";
import { drain, mkCtx, mkSession } from "../fixtures.js";
import { bodyAt, sseResponse } from "../llm/providers/openai-compatible-test-helpers.js";

type Sample = "reason-cap" | "visible-cap" | "tool" | "final";

/**
 * One native DeepSeek turn over scripted SSE samples. A `reason-cap` sample
 * spends its whole 8192-token limit on `reasoning_content`; `visible-cap`
 * is a truncated visible answer; `tool` calls the fixture tool; `final` ends.
 */
async function scenario(
  samples: Sample[],
  config: Record<string, unknown>,
  modelInfo: Record<string, unknown> = {},
) {
  const execute = vi.fn(async () => ({ content: "observed fixture" }));
  const tool = {
    name: "read_fixture", description: "Read fixture", inputSchema: { type: "object", properties: {} },
    isReadOnly: true, recoveryCategory: "idempotent" as const, execute,
  };
  const registry = {
    tools: [tool],
    toLLMTools: () => [{ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }],
    dispatch: execute,
  };
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const i = index++;
    const sample = samples[i] ?? "final";
    const capped = sample.endsWith("-cap");
    const delta = sample === "reason-cap" ? { reasoning_content: "Consider the next step." }
      : sample === "tool" ? { tool_calls: [{ index: 0, id: `read${i}`, type: "function", function: { name: tool.name, arguments: "{}" } }] }
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
  Object.assign(session.config!, config);
  const ctx = mkCtx({ reasoningEffort: "high" });
  await drain(runTurn(session, { ...ctx,
    config: { ...ctx.config, model: "deepseek-flash", model_provider: "deepseek", max_output_tokens: 8192 },
    modelInfo: { ...ctx.modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true,
      supportedReasoningLevels: ["low", "high", "max"], ...modelInfo },
  }, "Read the fixture and finish."));
  const bodies = fetchImpl.mock.calls.map((_, i) => bodyAt(fetchImpl, i));
  const warnings = (cause: string) =>
    events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === cause);
  return { bodies, events, execute, warnings };
}

const thinking = (bodies: Array<Record<string, unknown>>) => bodies.map(b => (b.thinking as { type: string }).type);
const maxTokens = (bodies: Array<Record<string, unknown>>) => bodies.map(b => b.max_tokens);

test("research switches are unset by default and validate at the top level", () => {
  const defaults = defaultConfig();
  expect(defaults.reasoning_cap_recovery).toBeUndefined();
  expect(defaults.reasoning_cap_escalate_max_output_tokens).toBeUndefined();
  expect(defaults.runtime_context_in_tool_results).toBeUndefined();
  expect(validateAgenCConfigBlocks({
    reasoning_cap_recovery: "escalate_thinking",
    reasoning_cap_escalate_max_output_tokens: 16_384,
    runtime_context_in_tool_results: true,
  })).toMatchObject({
    reasoning_cap_recovery: "escalate_thinking",
    reasoning_cap_escalate_max_output_tokens: 16_384,
    runtime_context_in_tool_results: true,
  });
  expect(validateAgenCConfigBlocks({ reasoning_cap_recovery: "thinking_off" }).reasoning_cap_recovery).toBe("thinking_off");
  for (const bad of [true, "on", "", null, 2]) {
    expect(() => validateAgenCConfigBlocks({ reasoning_cap_recovery: bad } as never)).toThrow();
  }
  for (const bad of [0, -1, 1.5, "8192", true, null]) {
    expect(() => validateAgenCConfigBlocks({ reasoning_cap_escalate_max_output_tokens: bad } as never)).toThrow();
  }
  for (const bad of ["true", 1, null]) {
    expect(() => validateAgenCConfigBlocks({ runtime_context_in_tool_results: bad } as never)).toThrow();
  }
});

test("resolveReasoningCapEscalation: off unless opted in, 3x bounded, explicit value honored, never at or below the limit", () => {
  const on = { reasoningCapRecovery: "escalate_thinking" as const };
  expect(resolveReasoningCapEscalation(undefined, { maxOutputTokens: 8192 })).toBeUndefined();
  expect(resolveReasoningCapEscalation({ reasoningCapRecovery: "thinking_off" }, { maxOutputTokens: 8192 })).toBeUndefined();
  expect(resolveReasoningCapEscalation(on, { maxOutputTokens: 8192, maxOutputTokensUpperLimit: 393_216 }))
    .toEqual({ maxOutputTokens: 8192 * REASONING_CAP_ESCALATION_FACTOR, fromMaxOutputTokens: 8192 });
  expect(resolveReasoningCapEscalation(on, { maxOutputTokens: 8192 }))
    .toEqual({ maxOutputTokens: 24_576, fromMaxOutputTokens: 8192 });
  expect(resolveReasoningCapEscalation(on, { maxOutputTokens: 8192, maxOutputTokensUpperLimit: 20_000 }))
    .toEqual({ maxOutputTokens: 20_000, fromMaxOutputTokens: 8192 });
  expect(resolveReasoningCapEscalation({ ...on, reasoningCapEscalateMaxOutputTokens: 16_000 }, { maxOutputTokens: 8192 }))
    .toEqual({ maxOutputTokens: 16_000, fromMaxOutputTokens: 8192 });
  // The 64k escalate ceiling bounds a large limit's 3x to the limit itself: no retry.
  expect(resolveReasoningCapEscalation(on, { maxOutputTokens: 64_000, maxOutputTokensUpperLimit: 393_216 })).toBeUndefined();
  expect(resolveReasoningCapEscalation(on, { maxOutputTokens: 32_000, maxOutputTokensUpperLimit: 393_216 }))
    .toEqual({ maxOutputTokens: 64_000, fromMaxOutputTokens: 32_000 });
  expect(resolveReasoningCapEscalation({ ...on, reasoningCapEscalateMaxOutputTokens: 4096 }, { maxOutputTokens: 8192 })).toBeUndefined();
  expect(resolveReasoningCapEscalation(on, {})).toBeUndefined();
  expect(resolveReasoningCapEscalation({ ...on, reasoningCapEscalateMaxOutputTokens: 30_000 }, {}))
    .toEqual({ maxOutputTokens: 30_000 });
});

test("escalate_thinking: a reasoning-only cap retries the same request with thinking on at 3x, then returns to the limit", async () => {
  const { bodies, warnings, execute, events } = await scenario(
    ["reason-cap", "tool", "final"], { reasoningCapRecovery: "escalate_thinking" },
  );
  expect(bodies).toHaveLength(3);
  expect(thinking(bodies)).toEqual(["enabled", "enabled", "enabled"]);
  expect(maxTokens(bodies)).toEqual([8192, 24_576, 8192]);
  expect(bodies.map(b => b.reasoning_effort)).toEqual(["high", "high", "high"]);
  // The retry is the capped request itself: nothing appended, nothing removed.
  expect(bodies[1]!.messages).toEqual(bodies[0]!.messages);
  expect(JSON.stringify(bodies[1]!.messages)).not.toContain(RETRY_REASONING_ONLY_CONTENT);
  expect(warnings("thinking_disabled_recovery")).toHaveLength(0);
  const escalations = warnings("reasoning_cap_escalation");
  expect(escalations).toHaveLength(1);
  expect(JSON.parse(escalations[0]!.msg.payload.message as string)).toEqual({
    fromMaxOutputTokens: 8192,
    toMaxOutputTokens: 24_576,
    reasoningOutputTokens: 8192,
    scope: "reasoning_only_output_cap_thinking_retry",
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(true);
});

test("escalate_thinking: a second cap in the thinking-on retry takes the thinking-off continuation at the configured limit", async () => {
  const { bodies, warnings, events } = await scenario(
    ["reason-cap", "reason-cap", "tool", "final"], { reasoningCapRecovery: "escalate_thinking" },
  );
  expect(thinking(bodies)).toEqual(["enabled", "enabled", "disabled", "enabled"]);
  expect(maxTokens(bodies)).toEqual([8192, 24_576, 8192, 8192]);
  expect(JSON.stringify(bodies[1]!.messages)).not.toContain(RETRY_REASONING_ONLY_CONTENT);
  expect(JSON.stringify(bodies[2]!.messages)).toContain(RETRY_REASONING_ONLY_CONTENT);
  expect(warnings("reasoning_cap_escalation")).toHaveLength(1);
  expect(warnings("thinking_disabled_recovery")).toHaveLength(1);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(true);
});

test("escalate_thinking: a later cap after a productive sample escalates again; the retry budget is not spent", async () => {
  const { bodies, warnings, events } = await scenario(
    ["reason-cap", "tool", "reason-cap", "tool", "reason-cap", "tool", "reason-cap", "tool", "final"],
    { reasoningCapRecovery: "escalate_thinking" },
  );
  expect(thinking(bodies)).toEqual(Array.from({ length: 9 }, () => "enabled"));
  expect(maxTokens(bodies)).toEqual([8192, 24_576, 8192, 24_576, 8192, 24_576, 8192, 24_576, 8192]);
  expect(warnings("reasoning_cap_escalation")).toHaveLength(4);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(true);
  expect(events.some(e => e.msg.type === "turn_failed")).toBe(false);
});

test("escalate_thinking: repeated caps still exhaust through the counted thinking-off retries", async () => {
  const { bodies, events } = await scenario(
    ["reason-cap", "reason-cap", "reason-cap", "reason-cap", "reason-cap", "reason-cap", "reason-cap"],
    { reasoningCapRecovery: "escalate_thinking" },
  );
  // cap, thinking-on retry, then three counted thinking-off retries that all cap.
  expect(thinking(bodies)).toEqual(["enabled", "enabled", "disabled", "disabled", "disabled"]);
  expect(maxTokens(bodies)).toEqual([8192, 24_576, 8192, 8192, 8192]);
  expect(events.some(e => e.msg.type === "turn_complete")).toBe(false);
  expect(events.find(e => e.msg.type === "turn_failed")?.msg).toMatchObject({
    payload: { message: expect.stringContaining("Output recovery is exhausted") },
  });
});

test.each([{}, { reasoningCapRecovery: "thinking_off" }])(
  "the default and explicit thinking_off keep today's thinking-off recovery: %j", async config => {
    const { bodies, warnings } = await scenario(["reason-cap", "tool", "final"], config);
    expect(thinking(bodies)).toEqual(["enabled", "disabled", "enabled"]);
    expect(maxTokens(bodies)).toEqual([8192, 8192, 8192]);
    expect(JSON.stringify(bodies[1]!.messages)).toContain(RETRY_REASONING_ONLY_CONTENT);
    expect(warnings("reasoning_cap_escalation")).toHaveLength(0);
    expect(warnings("thinking_disabled_recovery")).toHaveLength(1);
  },
);

test("escalate_thinking: honors reasoning_cap_escalate_max_output_tokens and the model upper limit", async () => {
  const explicit = await scenario(["reason-cap", "final"],
    { reasoningCapRecovery: "escalate_thinking", reasoningCapEscalateMaxOutputTokens: 16_000 });
  expect(maxTokens(explicit.bodies)).toEqual([8192, 16_000]);
  expect(thinking(explicit.bodies)).toEqual(["enabled", "enabled"]);
  const bounded = await scenario(["reason-cap", "final"],
    { reasoningCapRecovery: "escalate_thinking" }, { maxOutputTokensUpperLimit: 20_000 });
  expect(maxTokens(bounded.bodies)).toEqual([8192, 20_000]);
  // A ceiling that cannot exceed the limit disables the retry: thinking-off as today.
  const useless = await scenario(["reason-cap", "final"],
    { reasoningCapRecovery: "escalate_thinking", reasoningCapEscalateMaxOutputTokens: 8192 });
  expect(thinking(useless.bodies)).toEqual(["enabled", "disabled"]);
  expect(maxTokens(useless.bodies)).toEqual([8192, 8192]);
});

test("escalate_thinking: a visible-output cap keeps the ordinary continuation", async () => {
  const { bodies, warnings } = await scenario(["visible-cap", "final"], { reasoningCapRecovery: "escalate_thinking" });
  expect(thinking(bodies)).toEqual(["enabled", "enabled"]);
  expect(maxTokens(bodies)).toEqual([8192, 8192]);
  expect(JSON.stringify(bodies[1]!.messages)).toContain("Continue generating directly from where you left off");
  expect(warnings("reasoning_cap_escalation")).toHaveLength(0);
});
