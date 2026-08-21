/**
 * An unparseable review has to say what came back.
 *
 * "no structured ReviewOutput in reviewer response (189 chars)" cannot be
 * told apart from prose, a refusal, or a stream that was cut off, and the
 * response is kept nowhere else — so a run that died in review left the
 * next reader with nothing to work from.
 */

import { describe, expect, it } from "vitest";

import { reviewerResponseExcerpt } from "../../src/workflow/independent-review.js";

describe("reviewerResponseExcerpt", () => {
  it("flattens the answer onto one line", () => {
    expect(reviewerResponseExcerpt("The change\n\nlooks   correct.")).toBe(
      "The change looks correct.",
    );
  });

  it("bounds a long answer and marks the cut", () => {
    const excerpt = reviewerResponseExcerpt("x".repeat(1000), 50);
    expect(excerpt).toHaveLength(50);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("names an empty answer rather than showing nothing", () => {
    expect(reviewerResponseExcerpt("   \n  ")).toBe("(empty response)");
  });

  it("keeps a short answer whole", () => {
    expect(reviewerResponseExcerpt("I cannot review this.")).toBe(
      "I cannot review this.",
    );
  });
});
