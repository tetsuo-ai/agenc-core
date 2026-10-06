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
