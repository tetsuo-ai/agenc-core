import { expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { runTurn } from "../../src/session/run-turn.js";
import { buildSamplingRequestContract, snapshotSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import {
  INITIAL_THINKING_OFF_HOLD,
  MAX_THINKING_OFF_HOLD,
  THINKING_OFF_HOLD_ENV,
  completeThinkingOffHoldSample,
  startThinkingOffHold,
  thinkingOffHoldActive,
  thinkingOffHoldEnabled,
} from "../../src/session/thinking-off-hold.js";
import { buildInitialTurnState, restoreFromCheckpoint, toCheckpointSlice } from "../../src/session/turn-state.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { bodyAt, sseResponse } from "../llm/providers/openai-compatible-test-helpers.js";

const lightOptions = (environment: Record<string, string>) => ({
  runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }),
  providerEnvironment: environment,
});

test.each([
  ["Light session with the switch", { lightMode: true, env: { [THINKING_OFF_HOLD_ENV]: "1" } }, true],
  ["Light session, switch spelled true", { lightMode: true, env: { [THINKING_OFF_HOLD_ENV]: "true" } }, true],
  ["Light session without the switch", { lightMode: true, env: {} }, false],
  ["Light session with the switch off", { lightMode: true, env: { [THINKING_OFF_HOLD_ENV]: "0" } }, false],
  ["standard session with the switch", { lightMode: false, env: { [THINKING_OFF_HOLD_ENV]: "1" } }, false],
] as const)("the hold runs only in a Light session that sets the switch: %s", (_label, input, expected) => {
  const session = {
    services: {
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: input.lightMode }),
      providerEnvironment: input.env,
    },
  };
  expect(thinkingOffHoldEnabled(session as never)).toBe(expected);
});

test("the switch is read from the shell's child environment first, like the prompt", () => {
  const session = {
    services: {
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true }),
      userShell: { childEnvironment: { [THINKING_OFF_HOLD_ENV]: "1" } },
      providerEnvironment: {},
    },
  };
  expect(thinkingOffHoldEnabled(session as never)).toBe(true);
  expect(thinkingOffHoldEnabled(undefined)).toBe(false);
});

test("a hold starts short, spends one sample per thinking-off request, and a completed probe ends it", () => {
  const ctx = mkCtx({ reasoningEffort: "high" });
  const state = buildInitialTurnState(ctx, { role: "user", content: "task" });
  expect(state.thinkingOffHold).toBeUndefined();
  expect(thinkingOffHoldActive(state)).toBe(false);
  // Nothing to account for without a hold.
  completeThinkingOffHoldSample(state, {}, { capped: false });
  expect(state.thinkingOffHold).toBeUndefined();

  expect(startThinkingOffHold(state)).toEqual({ remaining: INITIAL_THINKING_OFF_HOLD, length: INITIAL_THINKING_OFF_HOLD });
  expect(thinkingOffHoldActive(state)).toBe(true);
  // A recovery sample is accounted by startThinkingOffHold, never here.
  completeThinkingOffHoldSample(state, { reasoningOnlyRecovery: true }, { capped: false });
  expect(state.thinkingOffHold).toEqual({ remaining: 2, length: 2 });
  completeThinkingOffHoldSample(state, { thinkingOffHold: true }, { capped: false });
  expect(state.thinkingOffHold).toEqual({ remaining: 1, length: 2 });
  completeThinkingOffHoldSample(state, { thinkingOffHold: true }, { capped: true });
  expect(state.thinkingOffHold).toEqual({ remaining: 0, length: 2 });
  expect(thinkingOffHoldActive(state)).toBe(false);
  // The probe completed without a cap: the turn is back to configured thinking.
  completeThinkingOffHoldSample(state, {}, { capped: false });
  expect(state.thinkingOffHold).toBeUndefined();
  // A later cap starts over at the short hold.
  expect(startThinkingOffHold(state)).toEqual({ remaining: 2, length: 2 });
});

test("a probe that caps keeps the hold, and the recovery after it doubles the length up to the ceiling", () => {
  const ctx = mkCtx({ reasoningEffort: "high" });
  const state = buildInitialTurnState(ctx, { role: "user", content: "task" });
  startThinkingOffHold(state);
  completeThinkingOffHoldSample(state, { thinkingOffHold: true }, { capped: false });
  completeThinkingOffHoldSample(state, { thinkingOffHold: true }, { capped: false });
  completeThinkingOffHoldSample(state, {}, { capped: true });
  expect(state.thinkingOffHold).toEqual({ remaining: 0, length: 2 });
  const lengths = [startThinkingOffHold(state).length];
  for (let round = 0; round < 4; round++) {
    while (thinkingOffHoldActive(state)) completeThinkingOffHoldSample(state, { thinkingOffHold: true }, { capped: false });
    completeThinkingOffHoldSample(state, {}, { capped: true });
    lengths.push(startThinkingOffHold(state).length);
  }
  expect(lengths).toEqual([4, 8, 16, 16, 16]);
  expect(MAX_THINKING_OFF_HOLD).toBe(16);
  // A hold never counts below zero.
  state.thinkingOffHold = { remaining: 0, length: 16 };
  completeThinkingOffHoldSample(state, { thinkingOffHold: true }, { capped: false });
  expect(state.thinkingOffHold).toEqual({ remaining: 0, length: 16 });
});

test("the hold is turn state only: it is not checkpointed and a resumed turn starts without one", () => {
  const ctx = mkCtx({ reasoningEffort: "high" });
  const state = buildInitialTurnState(ctx, { role: "user", content: "task" });
  startThinkingOffHold(state);
  const slice = JSON.parse(JSON.stringify(toCheckpointSlice(state)));
  expect(slice).not.toHaveProperty("thinkingOffHold");
  const resumed = buildInitialTurnState(ctx, { role: "user", content: "task" });
  restoreFromCheckpoint(resumed, slice);
  expect(resumed.thinkingOffHold).toBeUndefined();
});

test("an active hold disables thinking on the native DeepSeek route only, and only with the switch on", () => {
  const ctx = mkCtx({ reasoningEffort: "high" });
  const deepseek = { ...mkProvider(), name: "deepseek" };
  const cases = [
    { label: "on", services: lightOptions({ [THINKING_OFF_HOLD_ENV]: "1" }), provider: deepseek, model: "deepseek-flash", flagged: true, disabled: true },
    { label: "switch unset", services: lightOptions({}), provider: deepseek, model: "deepseek-flash", flagged: false, disabled: false },
    { label: "standard session", services: { runtimeOptions: resolveAgentRuntimeOptions({}), providerEnvironment: { [THINKING_OFF_HOLD_ENV]: "1" } }, provider: deepseek, model: "deepseek-flash", flagged: false, disabled: false },
    { label: "unsupported route", services: lightOptions({ [THINKING_OFF_HOLD_ENV]: "1" }), provider: { ...mkProvider(), name: "openai" }, model: "gpt-6-luna", flagged: true, disabled: false },
  ];
  for (const testCase of cases) {
    const { session } = mkSession({ model: testCase.model, provider: testCase.provider, services: testCase.services as never });
    const state = buildInitialTurnState(ctx, { role: "user", content: "task" });
    state.thinkingOffHold = { remaining: 2, length: 2 };
    const request = snapshotSamplingRequestContract(buildSamplingRequestContract(state, session, ctx));
    expect(request.thinkingOffHold, testCase.label).toBe(testCase.flagged ? true : undefined);
    expect(request.reasoningOnlyRecovery, testCase.label).toBeUndefined();
    const options = buildProviderOptions(request, ctx, new AbortController().signal, session);
    expect(options.disableThinkingForRecovery, testCase.label).toBe(testCase.disabled ? true : undefined);
    expect(options.reasoningEffort, testCase.label).toBe("high");
  }
});

test("a pending reasoning-only recovery keeps its own request flag while a hold is active", () => {
  const ctx = mkCtx({ reasoningEffort: "high" });
  const { session } = mkSession({ model: "deepseek-flash", provider: { ...mkProvider(), name: "deepseek" },
    services: lightOptions({ [THINKING_OFF_HOLD_ENV]: "1" }) as never });
  const state = buildInitialTurnState(ctx, { role: "user", content: "task" });
  state.thinkingOffHold = { remaining: 1, length: 2 };
  state.reasoningOnlyRecoveryPending = true;
  const request = buildSamplingRequestContract(state, session, ctx);
  expect(request.reasoningOnlyRecovery).toBe(true);
  expect(request.thinkingOffHold).toBeUndefined();
});

/**
 * One scripted DeepSeek conversation: a reasoning-only cap, its thinking-off
 * recovery (a tool call), then tool calls until the model answers. The script
 * answers every request the same way whatever the thinking switch says, so the
 * only difference between the two runs is which requests carry it.
 */
function scriptedDeepSeek(plan: ReadonlyArray<"cap" | "tool" | "final">) {
  let index = 0;
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => {
    const step = plan[index] ?? "final";
    const callId = `call-${index}`;
    index += 1;
    const delta = step === "cap"
      ? { reasoning_content: "Consider the next step." }
      : step === "tool"
        // Distinct arguments per call: the no-progress backstop ends a turn
        // that repeats one identical action, which is not what is measured here.
        ? { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "read_fixture", arguments: JSON.stringify({ step: index }) } }] }
        : { content: "Done." };
    const finish = step === "cap" ? "length" : step === "tool" ? "tool_calls" : "stop";
    const usage = step === "cap"
      ? { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202, completion_tokens_details: { reasoning_tokens: 8192 } }
      : { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20, completion_tokens_details: { reasoning_tokens: 0 } };
    return sseResponse([
      `data: ${JSON.stringify({ id: "sample", model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "sample", choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`,
      "data: [DONE]\n\n",
    ]);
  });
  return fetchImpl;
}

function fixtureRegistry() {
  const execute = vi.fn(async (args: { step?: number }) => ({ content: `fixture result ${args?.step ?? 0}` }));
  const tool = { name: "read_fixture", description: "Read fixture", inputSchema: { type: "object", properties: { step: { type: "number" } } }, isReadOnly: true, recoveryCategory: "idempotent" as const, execute };
  return {
    execute,
    registry: {
      tools: [tool],
      toLLMTools: () => [{ type: "function" as const, function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }],
      dispatch: execute,
    },
  };
}

async function runLightDeepSeekTurn(plan: ReadonlyArray<"cap" | "tool" | "final">, environment: Record<string, string>) {
  const fetchImpl = scriptedDeepSeek(plan);
  const provider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-flash", fetchImpl });
  const { registry, execute } = fixtureRegistry();
  const { session, events } = mkSession({ provider, model: "deepseek-flash", registry: registry as never, services: lightOptions(environment) as never });
  const ctx = mkCtx({ reasoningEffort: "high" });
  await drain(runTurn(session, {
    ...ctx,
    config: { ...ctx.config, model: "deepseek-flash", model_provider: "deepseek", max_output_tokens: 8192 },
    modelInfo: { ...ctx.modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true, supportedReasoningLevels: ["low", "high", "max"] },
  }, "Read the fixture until the task is done."));
  const thinking = fetchImpl.mock.calls.map((_call, i) => (bodyAt(fetchImpl, i).thinking as { type: string }).type);
  const warnings = (cause: string) => events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === cause);
  return { fetchImpl, events, execute, thinking, warnings };
}

test("with the switch, the samples after a productive thinking-off recovery stay thinking-off, then a probe restores thinking", async () => {
  const plan = ["cap", "tool", "tool", "tool", "final"] as const;
  const on = await runLightDeepSeekTurn(plan, { [THINKING_OFF_HOLD_ENV]: "1" });
  expect(on.thinking).toEqual(["enabled", "disabled", "disabled", "disabled", "enabled"]);
  expect(on.fetchImpl).toHaveBeenCalledTimes(5);
  expect(on.execute).toHaveBeenCalledTimes(3);
  expect(on.warnings("thinking_disabled_recovery")).toHaveLength(1);
  const holdWarnings = on.warnings("thinking_off_hold");
  expect(holdWarnings).toHaveLength(2);
  expect(holdWarnings.map(w => (w.msg.payload as { details?: Record<string, unknown> }).details)).toEqual([
    { remaining: 2, length: 2 },
    { remaining: 1, length: 2 },
  ]);
  expect(JSON.parse(String(holdWarnings[0]!.msg.payload.message))).toMatchObject({
    configuredEffort: "high", effectiveThinking: "disabled", maxOutputTokens: 8192, scope: "light_thinking_off_hold_sample",
  });
  for (let i = 0; i < 5; i++) {
    expect(bodyAt(on.fetchImpl, i).reasoning_effort).toBe("high");
    expect(bodyAt(on.fetchImpl, i).max_tokens).toBe(8192);
  }
  expect(on.events.some(e => e.msg.type === "turn_complete")).toBe(true);

  // Switch unset: the shipped behavior, thinking back on right after the recovery.
  const off = await runLightDeepSeekTurn(plan, {});
  expect(off.thinking).toEqual(["enabled", "disabled", "enabled", "enabled", "enabled"]);
  expect(off.fetchImpl).toHaveBeenCalledTimes(5);
  expect(off.execute).toHaveBeenCalledTimes(3);
  expect(off.warnings("thinking_disabled_recovery")).toHaveLength(1);
  expect(off.warnings("thinking_off_hold")).toHaveLength(0);
  expect(off.events.some(e => e.msg.type === "turn_complete")).toBe(true);
});

test("a probe that caps on reasoning again is recovered as before and the next hold is twice as long", async () => {
  const plan = ["cap", "tool", "tool", "tool", "cap", "tool", "tool", "tool", "tool", "tool", "final"] as const;
  const on = await runLightDeepSeekTurn(plan, { [THINKING_OFF_HOLD_ENV]: "1" });
  expect(on.thinking).toEqual([
    "enabled", "disabled", "disabled", "disabled",
    "enabled", "disabled", "disabled", "disabled", "disabled", "disabled",
    "enabled",
  ]);
  expect(on.warnings("thinking_disabled_recovery")).toHaveLength(2);
  expect(on.warnings("thinking_off_hold").map(w => (w.msg.payload as { details?: Record<string, unknown> }).details))
    .toEqual([
      { remaining: 2, length: 2 }, { remaining: 1, length: 2 },
      { remaining: 4, length: 4 }, { remaining: 3, length: 4 }, { remaining: 2, length: 4 }, { remaining: 1, length: 4 },
    ]);
  expect(on.events.some(e => e.msg.type === "turn_complete")).toBe(true);
  expect(on.events.some(e => e.msg.type === "turn_failed")).toBe(false);

  const off = await runLightDeepSeekTurn(plan, {});
  expect(off.thinking).toEqual([
    "enabled", "disabled", "enabled", "enabled",
    "enabled", "disabled", "enabled", "enabled", "enabled", "enabled",
    "enabled",
  ]);
  expect(off.warnings("thinking_off_hold")).toHaveLength(0);
});

test("a standard session with the switch set behaves exactly as without it", async () => {
  const plan = ["cap", "tool", "tool", "final"] as const;
  const fetchImpl = scriptedDeepSeek(plan);
  const provider = new DeepSeekProvider({ apiKey: "test", model: "deepseek-flash", fetchImpl });
  const { registry } = fixtureRegistry();
  const { session, events } = mkSession({ provider, model: "deepseek-flash", registry: registry as never,
    services: { runtimeOptions: resolveAgentRuntimeOptions({}), providerEnvironment: { [THINKING_OFF_HOLD_ENV]: "1" } } as never });
  const ctx = mkCtx({ reasoningEffort: "high" });
  await drain(runTurn(session, {
    ...ctx,
    config: { ...ctx.config, model: "deepseek-flash", model_provider: "deepseek", max_output_tokens: 8192 },
    modelInfo: { ...ctx.modelInfo, maxOutputTokens: 8192, maxOutputTokensExplicit: true, supportedReasoningLevels: ["low", "high", "max"] },
  }, "Read the fixture until the task is done."));
  expect(fetchImpl.mock.calls.map((_c, i) => (bodyAt(fetchImpl, i).thinking as { type: string }).type))
    .toEqual(["enabled", "disabled", "enabled", "enabled"]);
  expect(events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === "thinking_off_hold")).toHaveLength(0);
});
