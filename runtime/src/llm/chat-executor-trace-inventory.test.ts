import { describe, expect, it } from "vitest";

import { CHAT_EXECUTION_TRACE_EVENT_TYPES } from "./chat-executor-types.js";

/**
 * Plan §8 Done criterion: "Trace payload for a coding turn contains
 * session id, tool calls with args + results, model requests +
 * responses, hook fires, but does not reference deleted verifier /
 * probe event types. Field inventory captured in a snapshot test."
 *
 * This file owns the inventory assertion. Any change to the runtime's
 * trace event surface must be reflected in the lists below — the
 * snapshot intentionally fails on drift so the public trace contract
 * cannot silently mutate.
 */

const REQUIRED_EVENT_TYPES = new Set([
  // Tool dispatch lifecycle — every tool call emits both sides.
  "tool_dispatch_started",
  "tool_dispatch_finished",
  "tool_rejected",
  "tool_arguments_invalid",
  // Tool protocol (xAI assistant-tool_calls -> tool_result ordering).
  "tool_protocol_opened",
  "tool_protocol_repaired",
  "tool_protocol_result_recorded",
  "tool_protocol_violation",
  // Model call preparation (one per provider call, captures phase,
  // session id, routed tools, structured-output requirements).
  "model_call_prepared",
  // Stop-hook chain events — user-facing "Stop" hooks fire here.
  "stop_hook_execution_finished",
  "stop_hook_blocked",
  "stop_hook_exhausted",
  "stop_hook_retry_requested",
  // Completion validator envelope + stop-gate intervention — the
  // once-per-turn gate.
  "completion_validation_started",
  "completion_validation_finished",
  "completion_validator_started",
  "completion_validator_finished",
  "stop_gate_intervention",
  // Continuation controller — token-budget + stop-hook recovery.
  "continuation_started",
  "continuation_stopped",
  "continuation_evaluated",
  // Compaction + recovery hints + routing expansion + runtime-contract
  // snapshot observability.
  "compaction_triggered",
  "context_injected",
  "recovery_hints_injected",
  "route_expanded",
  "runtime_contract_snapshot",
]);

const FORBIDDEN_LEGACY_EVENT_TYPES = new Set([
  // Deleted verifier stack — referencing any of these would mean the
  // verifier runtime crept back in.
  "verifier_stage_started",
  "verifier_stage_finished",
  "verifier_probe_started",
  "verifier_probe_finished",
  "verifier_spawn",
  "verifier_verdict",
  "top_level_verifier_started",
  "top_level_verifier_finished",
  "top_level_verifier_invoked",
  // Deleted probe stack.
  "acceptance_probe_started",
  "acceptance_probe_finished",
  "workspace_probe_started",
  "workspace_probe_finished",
  "deterministic_probe_dispatched",
  "deterministic_probe_evaluated",
  // Deleted autonomous stack.
  "autonomous_goal_evaluated",
  "autonomous_task_scanned",
  "autonomous_desktop_dispatched",
]);

describe("chat execution trace inventory", () => {
  it("contains every required event type a coding turn emits", () => {
    const inventory = new Set(CHAT_EXECUTION_TRACE_EVENT_TYPES);
    for (const required of REQUIRED_EVENT_TYPES) {
      expect(inventory.has(required as (typeof CHAT_EXECUTION_TRACE_EVENT_TYPES)[number])).toBe(true);
    }
  });

  it("does not reference any deleted verifier / probe / autonomous event type", () => {
    const inventory = new Set(CHAT_EXECUTION_TRACE_EVENT_TYPES);
    for (const forbidden of FORBIDDEN_LEGACY_EVENT_TYPES) {
      expect(inventory.has(forbidden as (typeof CHAT_EXECUTION_TRACE_EVENT_TYPES)[number])).toBe(false);
    }
  });

  it("exposes exactly the expected set — field inventory snapshot", () => {
    // Lock the full list so any future addition is deliberate.
    expect([...CHAT_EXECUTION_TRACE_EVENT_TYPES].sort()).toEqual([
      "compaction_triggered",
      "completion_validation_finished",
      "completion_validation_started",
      "completion_validator_finished",
      "completion_validator_started",
      "context_injected",
      "continuation_evaluated",
      "continuation_started",
      "continuation_stopped",
      "model_call_prepared",
      "recovery_hints_injected",
      "route_expanded",
      "runtime_contract_snapshot",
      "stop_gate_intervention",
      "stop_hook_blocked",
      "stop_hook_execution_finished",
      "stop_hook_exhausted",
      "stop_hook_retry_requested",
      "tool_arguments_invalid",
      "tool_dispatch_finished",
      "tool_dispatch_started",
      "tool_protocol_opened",
      "tool_protocol_repaired",
      "tool_protocol_result_recorded",
      "tool_protocol_violation",
      "tool_rejected",
    ]);
  });

  it("has no duplicate entries", () => {
    const deduped = new Set(CHAT_EXECUTION_TRACE_EVENT_TYPES);
    expect(deduped.size).toBe(CHAT_EXECUTION_TRACE_EVENT_TYPES.length);
  });
});
