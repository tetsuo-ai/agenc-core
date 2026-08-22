/**
 * A workflow child that fails has to say why.
 *
 * `RunAgentResult` carries the child's `error`, but only its `finalMessage`
 * was passed on, and a child that dies before it speaks has none. The run
 * then recorded a terminal failure with an empty message, so a run that died
 * at `plan` reported `step_retries_exhausted` and nothing else — not in the
 * journal, not in the effects, not in the daemon log.
 */

import { describe, expect, it } from "vitest";

import { workflowChildFailureMessage } from "../../src/app-server/workflow/session-adapters.js";

describe("workflowChildFailureMessage", () => {
  it("says nothing for a child that completed", () => {
    expect(workflowChildFailureMessage("plan", { outcome: "completed" })).toBeNull();
  });

  it("carries the child's own error", () => {
    expect(
      workflowChildFailureMessage("plan", {
        outcome: "errored",
        error: new Error("recovery ladder exceeded MAX_RECOVERY_REENTRIES=5"),
      }),
    ).toBe(
      "workflow plan child errored: recovery ladder exceeded MAX_RECOVERY_REENTRIES=5",
    );
  });

  it("still names the outcome when the child left no error", () => {
    expect(workflowChildFailureMessage("implement", { outcome: "errored" })).toBe(
      "workflow implement child errored",
    );
    expect(workflowChildFailureMessage("verify_agent", { outcome: "aborted" })).toBe(
      "workflow verify_agent child aborted",
    );
    expect(
      workflowChildFailureMessage("review", { outcome: "interrupted" }),
    ).toBe("workflow review child interrupted");
  });

  it("reads a thrown non-Error as text rather than [object Object]", () => {
    const message = workflowChildFailureMessage("plan", {
      outcome: "errored",
      error: { code: "PROVIDER_UNAVAILABLE" },
    });
    expect(message).toContain("workflow plan child errored");
    expect(message).not.toContain("[object Object]");
  });
});
