import { describe, expect, it } from "vitest";
import { AdmissionDeniedError } from "../../src/budget/admission-client.js";
import type { AdmissionJournalEvent } from "../../src/budget/admission-types.js";
import { isWorkflowChildStopReason, workflowAdmissionStopReason } from "../../src/app-server/workflow/stop-reasons.js";

function event(details?: Record<string, unknown>): AdmissionJournalEvent {
  return { sequence: 1, eventId: "denied", timestamp: "2026-09-29T00:00:00.000Z", runId: "child",
    stepId: "model-10", kind: "model_turn", event: "denied", reason: "budget_exceeded",
    ...(details === undefined ? {} : { details }) };
}

describe("Goal admission stop reasons", () => {
  it.each([["tokens", "token_budget_exhausted"], ["cost", "cost_budget_exhausted"]] as const)(
    "uses durable %s authority instead of the subagent's generic cost message", (budgetDimension, reason) => {
      expect(workflowAdmissionStopReason(new Error("canonical session cost cap"), event({ budgetDimension }))).toBe(reason);
    },
  );
  it("keeps older budget denials generic instead of guessing cost", () => {
    expect(workflowAdmissionStopReason(undefined, event())).toBe("budget_exhausted");
    expect(workflowAdmissionStopReason(new AdmissionDeniedError("budget_exceeded"))).toBe("budget_exhausted");
  });
  it("does not reuse a denial dimension from a later successful admission", () => {
    expect(workflowAdmissionStopReason(undefined, { ...event(), event: "reconciled" })).toBeUndefined();
    expect(workflowAdmissionStopReason(new Error("canonical session cost cap"))).toBeUndefined();
  });
  it.each(["deadline_expired", "deadline_expired_during_recovery", "cancelled_before_dispatch:deadline_expired"])(
    "keeps deadline cause %s despite cancelled transport status", (reason) => {
      expect(workflowAdmissionStopReason(new Error("review failed", { cause: new AdmissionDeniedError(reason, "cancelled") }))).toBe("deadline_exceeded");
      expect(workflowAdmissionStopReason(undefined, { ...event(), event: "cancelled", reason })).toBe("deadline_exceeded");
    },
  );
  it("does not turn operator cancellation or unknown reasons into budget failures", () => {
    expect(workflowAdmissionStopReason(new AdmissionDeniedError("operator cancelled", "cancelled"))).toBeUndefined();
    expect(isWorkflowChildStopReason("toString")).toBe(false);
  });
});
