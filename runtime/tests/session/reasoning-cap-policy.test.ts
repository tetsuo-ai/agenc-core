import { expect, test } from "vitest";
import { admitReasoningCapSample, completeReasoningCapSample, qualifyReasoningCapRecovery,
  readReasoningCapPolicy } from "../../src/session/reasoning-cap-policy.js";
import { buildInitialTurnState, restoreFromCheckpoint, toCheckpointSlice, advanceModelSampleOrdinal } from "../../src/session/turn-state.js";
import { readTurnCheckpoint } from "../../src/session/durable-checkpoint-reader.js";
import { defaultConfig, validateAgenCConfigBlocks } from "../../src/config/schema.js";
import { resolveProfile } from "../../src/config/profiles.js";
import { mkCtx } from "../fixtures.js";

const target = { policy: "streak2", provider: "deepseek", model: "deepseek-flash" } as const;
const fresh = () => buildInitialTurnState(mkCtx(), { role: "user", content: "task" });
function checkpoint(state: ReturnType<typeof fresh>) {
  const event = { turnId: "turn", iterationIndex: 0, boundary: "iteration", checkpointSeq: 1,
    persistedMessageCount: 0, prefixHash: "a".repeat(64), checkpointVersion: 4,
    prefixHashVersion: 3, toolResultIntegrityVersion: 1, resumableState: toCheckpointSlice(state) };
  const parsed = readTurnCheckpoint(JSON.parse(JSON.stringify(event)));
  const restored = fresh();
  restoreFromCheckpoint(restored, parsed.checkpoint.resumableState);
  // The real restart path advances physical identity, independently of policy identity.
  advanceModelSampleOrdinal(restored);
  return restored;
}
function cap(state: ReturnType<typeof fresh>) {
  state.reasoningOnlyRecoveryPending = undefined;
  const sample = admitReasoningCapSample(state, target)!;
  expect(sample.kind).toBe("enabled");
  completeReasoningCapSample(state, sample, false, true);
  qualifyReasoningCapRecovery(state, true);
  state.reasoningOnlyRecoveryPending = true;
}
function recover(state: ReturnType<typeof fresh>, productive = true) {
  const sample = admitReasoningCapSample(state, target)!;
  expect(sample.kind).toBe("recovery");
  completeReasoningCapSample(state, sample, productive, false);
  state.reasoningOnlyRecoveryPending = undefined;
  return sample;
}

test("canonical flag defaults off, validates top-level/profile, and projects profile overrides", () => {
  expect(defaultConfig().reasoning_cap_policy).toBe("off");
  expect(validateAgenCConfigBlocks({ reasoning_cap_policy: "streak2" }).reasoning_cap_policy).toBe("streak2");
  for (const bad of [true, "6k", "", null, 2]) {
    expect(() => validateAgenCConfigBlocks({ reasoning_cap_policy: bad } as never)).toThrow();
    expect(() => validateAgenCConfigBlocks({ profiles: { a: { reasoning_cap_policy: bad } } } as never)).toThrow();
  }
  expect(resolveProfile({ profiles: { a: { reasoning_cap_policy: "streak2" } } }, "a").reasoning_cap_policy).toBe("streak2");
});

test("actual checkpoint reader preserves cap, matching recovery, armed intent and consumed sample once", () => {
  let state = fresh();
  for (let pair = 0; pair < 2; pair++) {
    cap(state); state = checkpoint(state);
    const recovery = admitReasoningCapSample(state, target)!;
    state = checkpoint(state);
    expect(admitReasoningCapSample(state, target)).toEqual(recovery);
    completeReasoningCapSample(state, recovery, true, false);
    state.reasoningOnlyRecoveryPending = undefined;
    state = checkpoint(state);
    // Replaying an already completed recovery cannot add another count.
    const before = toCheckpointSlice(state);
    completeReasoningCapSample(state, recovery, true, false);
    expect(toCheckpointSlice(state)).toEqual(before);
  }
  expect(state.reasoningCapPolicy?.extraPending).toBe(true);
  state = checkpoint(state);
  const extra = admitReasoningCapSample(state, target)!;
  expect(extra.kind).toBe("extra");
  state = checkpoint(state);
  expect(admitReasoningCapSample(state, target)).toEqual(extra);
  completeReasoningCapSample(state, extra, true, false);
  state = checkpoint(state);
  expect(admitReasoningCapSample(state, target)?.kind).toBe("enabled");
  expect(state.reasoningCapPolicy?.streak).toBe(0);
});

test.each(["success", "unproductive", "unmatched", "visible-cap", "unsupported", "model-switch", "off"])("%s breaks adjacency", boundary => {
  const state = fresh(); cap(state); recover(state);
  expect(state.reasoningCapPolicy?.streak).toBe(1);
  if (boundary === "success") {
    const sample = admitReasoningCapSample(state, target); completeReasoningCapSample(state, sample, true, false);
  } else if (boundary === "unproductive") { cap(state); recover(state, false); }
  else if (boundary === "unmatched") { state.reasoningOnlyRecoveryPending = true; recover(state); }
  else if (boundary === "visible-cap") {
    const sample = admitReasoningCapSample(state, target); completeReasoningCapSample(state, sample, false, true);
    qualifyReasoningCapRecovery(state, false);
  } else admitReasoningCapSample(state, { ...target, ...(boundary === "off" ? { policy: "off" } :
    boundary === "unsupported" ? { provider: "openrouter" } : { model: "deepseek-v4-pro" }) });
  expect(state.reasoningCapPolicy?.extraPending).toBeUndefined();
  expect(state.reasoningCapPolicy?.streak ?? 0).toBe(0);
});

test("policy samples cannot rearm or forgive any native recovery budget", () => {
  let state = fresh(); cap(state); recover(state); cap(state); recover(state);
  state.reasoningOnlyRecoveryCount = 2; state.maxOutputTokensRecoveryCount = 1;
  const extra = admitReasoningCapSample(state, target);
  completeReasoningCapSample(state, extra, false, true);
  qualifyReasoningCapRecovery(state, true);
  state.reasoningOnlyRecoveryPending = true;
  recover(state);
  expect(state.reasoningCapPolicy?.streak).toBe(0);
  expect(state.reasoningCapPolicy?.extraPending).toBeUndefined();
  state = checkpoint(state);
  expect(state.reasoningOnlyRecoveryCount).toBe(2);
  expect(state.maxOutputTokensRecoveryCount).toBe(1);
});

test("strict bounded checkpoint parser rejects malformed provenance and legacy stays empty", () => {
  const state = fresh(); cap(state);
  const good = toCheckpointSlice(state).reasoningCapPolicy!;
  for (const value of [null, {}, { ...good, extra: 1 }, { ...good, streak: 2 },
    { ...good, streak: -1 }, { ...good, streak: 0.5 }, { ...good, provider: "openai" },
    { ...good, pendingCap: "bad" }, { ...good, extraPending: true },
    { ...good, sample: { ...good.sample, completed: false } },
    { ...good, sample: { ...good.sample, unexpected: true } },
    { ...good, sample: { ...good.sample, kind: "extra" } }]) {
    expect(() => readReasoningCapPolicy(value)).toThrow(/reasoningCapPolicy/);
  }
  expect(checkpoint(fresh()).reasoningCapPolicy).toBeUndefined();
  const cloned = readReasoningCapPolicy(good)!; cloned.streak = 1;
  expect(good.streak).toBe(0);
});

test.each(["reactive_compact_retry", "model_fallback", "continuation_nudge", "token_budget_continuation"] as const)("checkpointed semantic reentry %s clears a pending policy extension", reason => {
  const state = fresh(); cap(state); recover(state); cap(state); recover(state);
  expect(state.reasoningCapPolicy?.extraPending).toBe(true);
  state.transition = { reason } as typeof state.transition;
  expect(admitReasoningCapSample(state, target)?.kind).toBe("enabled");
  expect(state.reasoningCapPolicy?.extraPending).toBeUndefined();
});

test("policy request override stays immutable across retries and cannot cross target or flag boundaries", async () => {
  const { buildProviderOptions } = await import("../../src/phases/stream-model.js");
  const { buildSamplingRequestContract, snapshotSamplingRequestContract } = await import("../../src/session/run-turn-sampling-request.js");
  const { mkSession, mkProvider } = await import("../fixtures.js");
  const state = fresh(); cap(state); recover(state); cap(state); recover(state);
  const extra = admitReasoningCapSample(state, target)!;
  const ctx = mkCtx({ reasoningEffort: "high" });
  const { session } = mkSession({ model: "deepseek-flash", provider: { ...mkProvider(), name: "deepseek" } });
  Object.assign(session.config!, { reasoningCapPolicy: "streak2" });
  const request = snapshotSamplingRequestContract({ ...buildSamplingRequestContract(state, session, ctx),
    reasoningCapSample: extra, reasoningCapTarget: target, maxOutputTokens: 8192 });
  completeReasoningCapSample(state, extra, true, false);
  admitReasoningCapSample(state, target);
  const options = () => buildProviderOptions(request, ctx, new AbortController().signal, session);
  expect(options()).toMatchObject({ disableThinkingForRecovery: true, maxOutputTokens: 8192, reasoningEffort: "high" });
  expect(options().disableThinkingForRecovery).toBe(true);
  Object.assign(session.config!, { model: "deepseek-v4-pro" });
  expect(options().disableThinkingForRecovery).toBeUndefined();
  Object.assign(session.config!, { model: "deepseek-flash", reasoningCapPolicy: "off" });
  expect(options().disableThinkingForRecovery).toBeUndefined();
});
