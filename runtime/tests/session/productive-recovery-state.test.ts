import { expect, test } from "vitest";
import { streamModel } from "../../src/phases/stream-model.js";
import { buildInitialTurnState, resetIterationFields, restoreFromCheckpoint, toCheckpointSlice } from "../../src/session/turn-state.js";
import { buildSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";
import type { LLMResponse } from "../../src/llm/types.js";

test.each([
  ["final answer", { content: "Done.", finishReason: "stop" }, true],
  ["empty stop", { content: "", finishReason: "stop" }, false],
  ["whitespace stop", { content: "  ", finishReason: "stop" }, false],
  ["visible cap", { content: "partial", finishReason: "length" }, false],
  ["refusal", { content: "", finishReason: "content_filter" }, false],
  ["provider failure", { content: "", finishReason: "error" }, false],
] as const)("only productive recovery resets reasoning spending: %s", async (_label, response, productive) => {
  const ctx = mkCtx({ reasoningEffort: "high" });
  const provider = { ...mkProvider(response as Partial<LLMResponse>), name: "deepseek" };
  const { session } = mkSession({ provider, model: "deepseek-flash" });
  const state = buildInitialTurnState(ctx, { role: "user", content: "task" });
  state.maxOutputTokensRecoveryCount = 1;
  state.reasoningOnlyRecoveryCount = 2;
  state.reasoningOnlyRecoveryPending = true;
  const restored = buildInitialTurnState(ctx, { role: "user", content: "task" });
  restoreFromCheckpoint(restored, JSON.parse(JSON.stringify(toCheckpointSlice(state))));
  resetIterationFields(restored);
  await streamModel(restored, ctx, session, buildSamplingRequestContract(restored, session, ctx));
  expect(restored.reasoningOnlyRecoveryCount).toBe(productive ? 0 : 2);
  expect(restored.maxOutputTokensRecoveryCount).toBe(1);
  expect(toCheckpointSlice(restored).reasoningOnlyRecoveryCount).toBe(productive ? 0 : 2);
});

test.each(["transport", "cancel", "response-error"])("%s cannot refund checkpointed recovery spending", async failure => {
  const ctx = mkCtx({ reasoningEffort: "high" });
  const provider = { ...mkProvider(failure === "response-error" ? { error: new Error("provider failed") } : {}), name: "deepseek" };
  if (failure === "transport") provider.chatStream = async () => { throw new Error("connection failed"); };
  const { session } = mkSession({ provider, model: "deepseek-flash" });
  const state = buildInitialTurnState(ctx, { role: "user", content: "task" });
  state.reasoningOnlyRecoveryPending = true;
  state.reasoningOnlyRecoveryCount = 2;
  const controller = new AbortController();
  if (failure === "cancel") controller.abort();
  await expect(streamModel(state, ctx, session, buildSamplingRequestContract(state, session, ctx), controller.signal)).rejects.toThrow();
  expect(state.reasoningOnlyRecoveryCount).toBe(2);
  expect(toCheckpointSlice(state).reasoningOnlyRecoveryCount).toBe(2);
});
