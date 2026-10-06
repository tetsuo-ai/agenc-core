/**
 * A reviewer one-shot that settled without text is a known failure.
 *
 * #2248 typed that path as `ReviewInvocationError` so the controller
 * retries instead of recording `unknown_outcome` (soak F76). The
 * controller tests inject that class directly; this file locks the
 * adapter mapping that actually produces it.
 */

import { describe, expect, it } from "vitest";

import { reviewOneShotTextOrThrow } from "../../src/app-server/workflow/session-adapters.js";
import {
  ReviewInvocationError,
  ReviewParseError,
} from "../../src/workflow/independent-review.js";

describe("reviewOneShotTextOrThrow", () => {
  it("returns the assistant text when the one-shot answered", () => {
    expect(
      reviewOneShotTextOrThrow({
        rawText: '{"overallCorrectness":"correct"}',
        error: null,
        verdict: "pass",
      }),
    ).toBe('{"overallCorrectness":"correct"}');
  });

  it("throws ReviewInvocationError with the provider error when there is no text", () => {
    const cause = new Error("grok authentication failed (HTTP 403)");
    expect(() =>
      reviewOneShotTextOrThrow({
        rawText: null,
        error: cause,
        verdict: "fail",
      }),
    ).toThrow(ReviewInvocationError);
    try {
      reviewOneShotTextOrThrow({
        rawText: null,
        error: cause,
        verdict: "fail",
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ReviewInvocationError);
      expect(error).not.toBeInstanceOf(ReviewParseError);
      expect((error as Error).message).toContain(
        "grok authentication failed (HTTP 403)",
      );
      expect((error as Error).cause).toBe(cause);
    }
  });

  it("names the verdict when the one-shot left no error object", () => {
    expect(() =>
      reviewOneShotTextOrThrow({
        rawText: null,
        verdict: "timeout",
      }),
    ).toThrow(ReviewInvocationError);
    try {
      reviewOneShotTextOrThrow({ rawText: null, verdict: "timeout" });
    } catch (error) {
      expect((error as Error).message).toContain("verdict timeout");
      expect((error as Error).cause).toBeUndefined();
    }
  });
});
