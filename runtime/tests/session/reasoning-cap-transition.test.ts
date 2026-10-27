import { expect, test } from "vitest";
import {
  clearReasoningCapPolicyForTransition,
  reasoningCapPolicyEligible,
} from "../../src/session/reasoning-cap-policy.js";
import { buildInitialTurnState, toCheckpointSlice, type ContinueReason } from "../../src/session/turn-state.js";
import { mkCtx } from "../fixtures.js";

const native = { policy: "streak2", provider: "deepseek", model: "deepseek-flash" } as const;
const policy = { provider: native.provider, model: native.model, streak: 1 as const };
const fresh = () => buildInitialTurnState(mkCtx(), { role: "user", content: "task" });

const CLEAR_ON_TRANSITION = {
  model_fallback: true,
  streaming_fallback_retry: true,
  collapse_drain_retry: true,
  reactive_compact_retry: true,
  max_output_tokens_escalate: false,
  max_output_tokens_recovery: false,
  stop_hook_blocking: true,
  token_budget_continuation: true,
  plan_tool_required: true,
  text_tool_call_correction: true,
  continuation_nudge: true,
  completion_gate: true,
  goal_gate: true,
  image_rejection_retry: true,
} as const satisfies Record<ContinueReason, boolean>;

test.each([
  { ...native, eligible: true },
  { policy: "streak2", provider: "deepseek", model: "deepseek-v4-pro", eligible: true },
  { policy: "streak2", provider: "deepseek", model: "deepseek-v4-flash", eligible: true },
  { policy: "off", provider: "deepseek", model: "deepseek-flash", eligible: false },
  { policy: undefined, provider: "deepseek", model: "deepseek-flash", eligible: false },
  { policy: "streak2", provider: "openrouter", model: "deepseek-flash", eligible: false },
  { policy: "streak2", provider: "deepseek", model: "deepseek-chat", eligible: false },
  { policy: "streak2", provider: "anthropic", model: "claude-sonnet-5-5", eligible: false },
] as const)("reasoningCapPolicyEligible $policy $provider/$model → $eligible", target => {
  expect(reasoningCapPolicyEligible(target)).toBe(target.eligible);
});

test.each(Object.entries(CLEAR_ON_TRANSITION) as [ContinueReason, boolean][])(
  "clearReasoningCapPolicyForTransition %s clears=%s",
  (reason, clears) => {
    const state = fresh();
    state.reasoningCapPolicy = { ...policy };
    state.transition = { reason };
    clearReasoningCapPolicyForTransition(state);
    expect(state.reasoningCapPolicy).toEqual(clears ? undefined : policy);
    expect(toCheckpointSlice(state).reasoningCapPolicy).toEqual(clears ? undefined : policy);
  },
);

test("clearReasoningCapPolicyForTransition leaves policy when no transition is set", () => {
  const state = fresh();
  state.reasoningCapPolicy = { ...policy };
  clearReasoningCapPolicyForTransition(state);
  expect(state.reasoningCapPolicy).toEqual(policy);
});
