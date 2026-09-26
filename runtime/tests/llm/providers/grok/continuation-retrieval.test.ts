import { describe, expect, it } from "vitest";

import { isContinuationRetrievalFailure } from "../../../../src/llm/providers/grok/adapter-utils.js";

describe("isContinuationRetrievalFailure", () => {
  it("treats a 400 empty-content chain error as a retrieval failure", () => {
    expect(
      isContinuationRetrievalFailure({
        status: 400,
        message: "Each content element must have a type",
      }),
    ).toBe(true);
  });

  it("treats a 404 that names a response as a retrieval failure", () => {
    expect(
      isContinuationRetrievalFailure({
        status: 404,
        message: "Response not available",
      }),
    ).toBe(true);
    expect(
      isContinuationRetrievalFailure({
        statusCode: "404",
        message: "No such response id",
      }),
    ).toBe(true);
  });

  it("matches previous_response_id, previous-response, expired, and retrieve wording", () => {
    expect(
      isContinuationRetrievalFailure({
        message: "previous_response_id is no longer valid",
      }),
    ).toBe(true);
    expect(
      isContinuationRetrievalFailure({
        message: "The previous response has expired",
      }),
    ).toBe(true);
    expect(
      isContinuationRetrievalFailure({
        message: "Could not retrieve the previous response",
      }),
    ).toBe(true);
    expect(
      isContinuationRetrievalFailure({
        message: "Response not found",
      }),
    ).toBe(true);
  });

  it("leaves unrelated provider errors alone", () => {
    expect(
      isContinuationRetrievalFailure({
        status: 400,
        message: "Invalid request body",
      }),
    ).toBe(false);
    expect(
      isContinuationRetrievalFailure({
        status: 404,
        message: "Model not found",
      }),
    ).toBe(false);
    expect(
      isContinuationRetrievalFailure({
        status: 429,
        message: "Rate limited",
      }),
    ).toBe(false);
    expect(isContinuationRetrievalFailure({ message: "timeout" })).toBe(false);
    expect(isContinuationRetrievalFailure(null)).toBe(false);
    expect(isContinuationRetrievalFailure(undefined)).toBe(false);
    expect(isContinuationRetrievalFailure("previous_response_id missing")).toBe(
      false,
    );
  });

  it("does not treat a message that only says previous as a retrieval failure", () => {
    expect(
      isContinuationRetrievalFailure({
        message: "The previous turn is still running",
      }),
    ).toBe(false);
  });
});
