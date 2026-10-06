import { describe, expect, it } from "vitest";

import {
  DEFAULT_WORKFLOW_DIAGNOSTIC_LIMIT,
  boundedWorkflowDiagnostic,
} from "../../src/workflow/diagnostics.js";

const XAI_SECRET = `xai-${"z".repeat(24)}`;

describe("boundedWorkflowDiagnostic", () => {
  it("keeps a short string whole after collapsing whitespace", () => {
    expect(boundedWorkflowDiagnostic("The change\n\nlooks   correct.")).toBe(
      "The change looks correct.",
    );
  });

  it("names an empty or whitespace-only answer rather than showing nothing", () => {
    expect(boundedWorkflowDiagnostic("   \n  ")).toBe("(empty response)");
    expect(boundedWorkflowDiagnostic("")).toBe("(empty response)");
  });

  it("reads an Error from its message and a string from itself", () => {
    expect(boundedWorkflowDiagnostic(new Error("verifier timed out"))).toBe(
      "verifier timed out",
    );
    expect(boundedWorkflowDiagnostic("plain failure")).toBe("plain failure");
  });

  it("serializes a plain object after redacting secret fields", () => {
    expect(
      boundedWorkflowDiagnostic({
        reason: "auth failed",
        token: XAI_SECRET,
      }),
    ).toBe('{"reason":"auth failed","token":"[REDACTED_SECRET]"}');
  });

  it("redacts secrets before bounding so a cut cannot expose a secret prefix", () => {
    const diagnostic = boundedWorkflowDiagnostic(
      `Review failed with token=${XAI_SECRET}. ${"x".repeat(500)}`,
      80,
    );

    expect(diagnostic).toContain("[REDACTED_SECRET]");
    expect(diagnostic).not.toContain(XAI_SECRET);
    expect(diagnostic).toHaveLength(80);
    expect(diagnostic.endsWith("…")).toBe(true);
  });

  it("bounds a long answer and marks the cut", () => {
    const diagnostic = boundedWorkflowDiagnostic("x".repeat(1000), 50);
    expect(diagnostic).toHaveLength(50);
    expect(diagnostic.endsWith("…")).toBe(true);
    expect(diagnostic.startsWith("x")).toBe(true);
  });

  it("falls back to the default limit when the caller passes a non-positive or non-integer", () => {
    const long = "y".repeat(DEFAULT_WORKFLOW_DIAGNOSTIC_LIMIT + 40);
    for (const limit of [0, -1, 1.5, Number.NaN]) {
      const diagnostic = boundedWorkflowDiagnostic(long, limit);
      expect(diagnostic).toHaveLength(DEFAULT_WORKFLOW_DIAGNOSTIC_LIMIT);
      expect(diagnostic.endsWith("…")).toBe(true);
    }
  });
});
