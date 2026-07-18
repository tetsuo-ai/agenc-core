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

  test("reserved run methods are frozen", () => {
    expect(RESERVED_RUN_METHODS).toEqual([
      "run.status", "run.result", "run.replay", "run.evidence", "run.cancel",
    ]);
  });
});
