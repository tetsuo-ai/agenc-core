import { describe, expect, test } from "vitest";
import {
  ADMISSION_DECISIONS,
  ADMISSION_KINDS,
  EFFECT_INTENT_EVENT,
  EFFECT_OUTCOMES,
  EFFECT_RESULT_EVENT,
  EFFECT_UNKNOWN_OUTCOME_EVENT,
  EVENT_GAP_EVENT,
  RESERVATION_RESOLUTIONS,
  RESERVED_RUN_METHODS,
  RUN_TERMINAL_STATUSES,
  WORKFLOW_STEP_IDS,
  WORKFLOW_STEP_PREREQUISITES,
  WORKFLOW_STEP_STATUSES,
  WORKFLOW_STOP_REASONS,
} from "../../src/contracts/run-contracts.js";

/**
 * The Wave-B contract freeze: these vocabularies are what M3/M4/M5
 * implementations and the SDK build against. Changing a frozen member is a
 * contract-change PR by definition — this test makes such a change loud.
 */
describe("shared run contracts (frozen v1)", () => {
  test("admission vocabulary is frozen", () => {
    expect(ADMISSION_KINDS).toEqual(["model_turn", "tool_exec", "spawn"]);
    expect(ADMISSION_DECISIONS).toEqual([
      "allow", "queue", "deny", "approval_required",
    ]);
    expect(RESERVATION_RESOLUTIONS).toEqual([
      "reconciled", "voided", "held_unknown",
    ]);
  });

  test("effect outcome vocabulary is frozen and eval-aligned", () => {
    expect(EFFECT_OUTCOMES).toEqual([
      "committed", "failed", "cancelled", "unknown_outcome",
    ]);
    expect(EFFECT_INTENT_EVENT).toBe("effect_intent");
    expect(EFFECT_RESULT_EVENT).toBe("effect_result");
    // Name-aligned with the eval contract's `effect.unknown_outcome`.
    expect(EFFECT_UNKNOWN_OUTCOME_EVENT).toBe("effect_unknown_outcome");
    expect(EVENT_GAP_EVENT).toBe("event_gap");
  });

  test("run terminal statuses include the honest unknown_outcome", () => {
    expect(RUN_TERMINAL_STATUSES).toEqual([
      "completed", "failed", "cancelled", "unknown_outcome",
    ]);
  });

  test("reserved run methods are frozen (run.start added by the M5 contract change)", () => {
    expect(RESERVED_RUN_METHODS).toEqual([
      "run.status", "run.result", "run.replay", "run.evidence", "run.cancel",
      "run.start",
    ]);
  });

  test("workflow step vocabulary is frozen (M5)", () => {
    expect(WORKFLOW_STEP_IDS).toEqual([
      "workflow.intake",
      "workflow.worktree",
      "workflow.plan",
      "workflow.implement",
      "workflow.verify",
      "workflow.review",
      "workflow.finalize",
    ]);
    expect(WORKFLOW_STEP_STATUSES).toEqual([
      "pending", "running", "committed", "failed", "cancelled",
      "unknown_outcome", "blocked",
    ]);
  });

  test("workflow prerequisites form the fixed linear pipeline", () => {
    expect(WORKFLOW_STEP_PREREQUISITES).toEqual({
      "workflow.intake": [],
      "workflow.worktree": ["workflow.intake"],
      "workflow.plan": ["workflow.worktree"],
      "workflow.implement": ["workflow.plan"],
      "workflow.verify": ["workflow.implement"],
      "workflow.review": ["workflow.verify"],
      "workflow.finalize": ["workflow.review"],
    });
    expect(Object.isFrozen(WORKFLOW_STEP_PREREQUISITES)).toBe(true);
    // Every stage except intake has exactly one prerequisite and every
    // prerequisite is itself a frozen stage — the chain has no cycles by
    // construction, and this pins that shape.
    for (const [step, prerequisites] of Object.entries(WORKFLOW_STEP_PREREQUISITES)) {
      for (const prerequisite of prerequisites) {
        expect(WORKFLOW_STEP_IDS).toContain(prerequisite);
        expect(prerequisite).not.toBe(step);
      }
    }
  });

  test("workflow stop reasons are frozen and machine-readable", () => {
    expect(WORKFLOW_STOP_REASONS).toEqual([
      "verification_failed",
      "review_rejected",
      "base_moved_conflict",
      "budget_exhausted",
      "policy_denied",
      "approval_required",
      "unknown_outcome_effect",
      "evidence_invalid",
      "step_retries_exhausted",
    ]);
  });
});
