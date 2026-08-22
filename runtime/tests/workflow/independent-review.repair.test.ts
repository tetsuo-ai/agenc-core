/**
 * The reviewer gets one message and no tools, and its reply is taken as
 * final. A chat-shaped model opens with what it intends to do — "I'll review
 * this change and inspect the repo first" — and that preamble becomes the
 * whole review, failing the step and the run with it.
 *
 * So an unstructured reply earns one plain repair turn before the step is
 * failed. These use a scripted invoker: no model, no network.
 */

import { describe, expect, it } from "vitest";

import {
  REVIEW_REPAIR_INSTRUCTION,
  isUnstructuredReview,
  runIndependentReview,
} from "../../src/workflow/independent-review.js";

const VERDICT = JSON.stringify({
  findings: [],
  overallCorrectness: "correct",
  overallExplanation: "The change matches the goal.",
  overallConfidenceScore: 0.9,
});

const PREAMBLE =
  "I'll review this change using the review-agent skill and inspect the " +
  "surrounding repo so the verdict is based on the actual code.";

function scriptedInvoker(replies: readonly string[]): {
  readonly invoke: (input: { readonly userMessage: string }) => Promise<string>;
  readonly seen: string[];
} {
  const seen: string[] = [];
  let at = 0;
  return {
    seen,
    invoke: (input) => {
      seen.push(input.userMessage);
      const reply = replies[Math.min(at, replies.length - 1)];
      at += 1;
      return Promise.resolve(reply ?? "");
    },
  };
}

const SINK = {
  recordArtifact: () =>
    Promise.resolve({ digest: "sha256:test", bytes: 0, path: "review.json" }),
};

const BASE = {
  spec: { goal: "add a VERSION file", reviewerModel: "test-model" },
  patchText: "+2.0.0",
  changedFilesText: "VERSION",
  verification: [],
  verificationVerdict: "PASS",
  step: { runId: "wf-test", stepId: "workflow.review", attempt: 1 },
} as const;

describe("independent review", () => {
  it("asks again when the reviewer only narrated its intent", async () => {
    const invoker = scriptedInvoker([PREAMBLE, VERDICT]);
    const result = await runIndependentReview({
      ...BASE,
      invoker: invoker as never,
      sink: SINK as never,
    });
    expect(invoker.seen).toHaveLength(2);
    expect(invoker.seen[1]).toContain(REVIEW_REPAIR_INSTRUCTION);
    expect(result.review.overallCorrectness).toBe("correct");
  });

  it("does not ask twice when the first reply was already a verdict", async () => {
    const invoker = scriptedInvoker([VERDICT]);
    await runIndependentReview({
      ...BASE,
      invoker: invoker as never,
      sink: SINK as never,
    });
    expect(invoker.seen).toHaveLength(1);
  });

  it("fails with what came back when both replies are prose", async () => {
    const invoker = scriptedInvoker([PREAMBLE, PREAMBLE]);
    await expect(
      runIndependentReview({
        ...BASE,
        invoker: invoker as never,
        sink: SINK as never,
      }),
    ).rejects.toThrow(/I'll review this change/);
  });

  it("tells a verdict apart from an empty fallback", () => {
    expect(
      isUnstructuredReview({
        findings: [],
        overallCorrectness: "",
        overallExplanation: PREAMBLE,
        overallConfidenceScore: 0,
      }),
    ).toBe(true);
  });
});
