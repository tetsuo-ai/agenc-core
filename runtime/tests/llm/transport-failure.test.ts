import { describe, expect, test } from "vitest";

import {
  LLMInvalidResponseError,
  LLMServerError,
  LLMStreamTruncatedError,
  LLMTimeoutError,
} from "../../src/llm/errors.js";
import { transportFailureOf } from "../../src/llm/transport-failure.js";

const CONNECTION_CODES = [
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
] as const;

describe("transportFailureOf", () => {
  test("classifies truncated streams, timeouts, 5xx, and socket loss", () => {
    expect(transportFailureOf(new LLMStreamTruncatedError("mock", "eof"))).toEqual({
      category: "stream_truncated",
    });
    expect(transportFailureOf(new LLMTimeoutError("mock", 1_000))).toEqual({
      category: "timeout",
    });
    expect(transportFailureOf(new LLMServerError("mock", 502, "upstream"))).toEqual({
      category: "http_5xx",
      status: 502,
    });
    expect(transportFailureOf({ statusCode: 503, status: 404 })).toEqual({
      category: "http_5xx",
      status: 503,
    });
    expect(transportFailureOf({ code: "ETIMEDOUT" })).toEqual({ category: "timeout" });
    for (const code of CONNECTION_CODES) {
      expect(transportFailureOf({ code }), code).toEqual({ category: "connection_lost" });
    }
  });

  test("does not retry a malformed body even when the adapter stamps 502", () => {
    const malformed = new LLMInvalidResponseError("mock", "truncated json");
    expect(malformed.statusCode).toBe(502);
    expect(transportFailureOf(malformed)).toBeUndefined();
    expect(transportFailureOf({ cause: malformed })).toBeUndefined();
    expect(transportFailureOf({ status: 499 })).toBeUndefined();
    expect(transportFailureOf({ status: 600 })).toBeUndefined();
    expect(transportFailureOf("ECONNRESET")).toBeUndefined();
    expect(transportFailureOf(null)).toBeUndefined();
  });

  test("walks nested causes and stops on a cycle", () => {
    expect(
      transportFailureOf({ cause: { cause: new LLMTimeoutError("mock", 250) } }),
    ).toEqual({ category: "timeout" });
    const cycle: { cause?: unknown } = {};
    cycle.cause = cycle;
    expect(transportFailureOf(cycle)).toBeUndefined();
  });
});
