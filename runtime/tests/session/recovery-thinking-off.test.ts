import { expect, test } from "vitest";
import { supportsThinkingOffRecovery } from "../../src/session/session-reasoning-effort.js";
import { buildInitialTurnState, restoreFromCheckpoint, toCheckpointSlice, resetIterationFields } from "../../src/session/turn-state.js";
import { buildSamplingRequestContract, snapshotSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { buildProviderOptions } from "../../src/phases/stream-model.js";
import { mkCtx, mkSession, mkProvider } from "../fixtures.js";

test.each([
  ["deepseek", "deepseek-flash", true],
  ["deepseek", "deepseek-v4-pro", true],
  ["deepseek", "unknown", false],
  ["openai", "deepseek-flash", false],
  ["openrouter", "deepseek/deepseek-flash", false],
] as const)("native retry switch %s/%s", (provider, model, expected) => {
  expect(supportsThinkingOffRecovery(provider, model)).toBe(expected);
});

test("durable retry intent survives iteration reset, request snapshot and reconnect", () => {
  const ctx = mkCtx({ reasoningEffort: "high" });
  const state = buildInitialTurnState(ctx, { role: "user", content: "task" });
  expect(toCheckpointSlice(state)).not.toHaveProperty("reasoningOnlyRecoveryPending");
  state.reasoningOnlyRecoveryPending = true;
  state.maxOutputTokensRecoveryCount = 1;
  const resumed = buildInitialTurnState(ctx, { role: "user", content: "task" });
  restoreFromCheckpoint(resumed, JSON.parse(JSON.stringify(toCheckpointSlice(state))));
  resetIterationFields(resumed);
  const { session } = mkSession({ model: "deepseek-flash", provider: { ...mkProvider(), name: "deepseek" } });
  const request = snapshotSamplingRequestContract(buildSamplingRequestContract(resumed, session, ctx));
  resumed.reasoningOnlyRecoveryPending = undefined;
  const options = () => buildProviderOptions(request, ctx, new AbortController().signal, session);
  expect(options().disableThinkingForRecovery).toBe(true);
  expect(options().disableThinkingForRecovery).toBe(true);
  expect(buildProviderOptions(buildSamplingRequestContract(resumed, session, ctx), ctx, new AbortController().signal, session).reasoningEffort).toBe("high");
  expect(buildProviderOptions(buildSamplingRequestContract(resumed, session, ctx), ctx, new AbortController().signal, session).disableThinkingForRecovery).toBeUndefined();
  expect(options().reasoningEffort).toBe("high");
  expect(resumed.maxOutputTokensRecoveryCount).toBe(1);
});

test("provider wire permits thinking-off only on the native supported route and restores it next call", async () => {
  const { OpenAIProvider } = await import("../../src/llm/providers/openai/adapter.js");
  const { bodyAt, createSuccessfulChatResponse } = await import("../llm/providers/openai-compatible-test-helpers.js");
  const { vi } = await import("vitest");
  for (const providerName of ["deepseek", "openai"]) {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => createSuccessfulChatResponse("ok")("deepseek-flash"));
    const provider = new OpenAIProvider({ apiKey: "test", model: "deepseek-flash", providerName, useResponsesApi: false, fetchImpl });
    await provider.chat([{ role: "user", content: "task" }], { reasoningEffort: "high", maxOutputTokens: 8192, disableThinkingForRecovery: true });
    await provider.chat([{ role: "user", content: "task" }], { reasoningEffort: "high", maxOutputTokens: 8192 });
    if (providerName === "deepseek") {
      expect(bodyAt(fetchImpl, 0)).toMatchObject({ thinking: { type: "disabled" }, reasoning_effort: "high", max_tokens: 8192 });
      expect(bodyAt(fetchImpl, 1)).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "high", max_tokens: 8192 });
    } else {
      expect(bodyAt(fetchImpl, 0).thinking).toBeUndefined();
      expect(bodyAt(fetchImpl, 1).thinking).toBeUndefined();
    }
  }
});


test.each([false, true])("native equal-limit recovery keeps the paid sample (fast=%s)", async fast => {
  const { runTurn } = await import("../../src/session/run-turn.js");
  const { resolveAgentRuntimeOptions } = await import("../../src/session/runtime-options.js");
  const { oneShotFastModeActive } = await import("../../src/one-shot-fast-mode.js");
  const requests: { messages: unknown; maxOutputTokens?: number }[] = [];
  const provider = { ...mkProvider(), name: "deepseek" };
  let fastCalls = 0;
  provider.chatStream = async (messages, _chunk, options) => {
    if (oneShotFastModeActive()) fastCalls++;
    requests.push({ messages: structuredClone(messages), maxOutputTokens: options?.maxOutputTokens });
    return {
      content: requests.length === 1 ? "Paid partial draft." : "Finished draft.",
      toolCalls: [], finishReason: requests.length === 1 ? "length" : "stop",
      model: "deepseek-flash", usage: { promptTokens: 10, completionTokens: 64_000, totalTokens: 64_010 },
    };
  };
  const { session } = mkSession({ model: "deepseek-flash", provider, services: {
    runtimeOptions: resolveAgentRuntimeOptions({}, {
      nonInteractive: true, dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true,
    }),
  } });
  await session.permissionModeRegistry.update({ ...session.permissionModeRegistry.current(),
    mode: "bypassPermissions", isBypassPermissionsModeAvailable: true });
  const base = mkCtx();
  const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
    modelProviderId: "deepseek", reasoningEffort: "max",
    modelInfo: { ...base.modelInfo, slug: "deepseek-flash", contextWindow: 1_048_576, supportedReasoningLevels: ["low", "high", "max"],
      maxOutputTokens: 64_000, maxOutputTokensUpperLimit: 393_216, maxOutputTokensCappedDefault: true },
    config: { ...base.config, bypassFastMode: fast },
  });
  const phases = [];
  for await (const phase of runTurn(session, ctx, "Finish the draft.", { exactOutput: true })) phases.push(phase);
  expect(requests).toHaveLength(2);
  expect(requests.map(request => request.maxOutputTokens)).toEqual([64_000, 64_000]);
  expect(fastCalls).toBe(fast ? 1 : 0);
  expect(JSON.stringify(requests[1]?.messages)).toContain("Paid partial draft.");
  expect(phases.at(-1)).toMatchObject({ type: "turn_complete", content: "Finished draft." });
});
