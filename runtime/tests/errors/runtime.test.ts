import { describe, expect, test } from "vitest";
import {
  AbortError,
  AgenCError,
  SDKAuthenticationError,
  SDKRateLimitError,
  classifyAxiosError,
  errorMessage,
  getErrnoCode,
  getErrnoPath,
  hasExactErrorMessage,
  isAbortError,
  isFsInaccessible,
  sdkErrorFromType,
  shortErrorStack,
  toError,
} from "./runtime.js";

describe("runtime error primitives", () => {
  test("normalizes unknown errors and exact messages", () => {
    expect(toError("boom")).toBeInstanceOf(Error);
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(hasExactErrorMessage(new Error("boom"), "boom")).toBe(true);
  });

  test("detects abort and filesystem error shapes", () => {
    expect(isAbortError(new AbortError("cancelled"))).toBe(true);
    expect(isAbortError(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(true);

    const fsError = Object.assign(new Error("missing"), {
      code: "ENOENT",
      path: "/tmp/missing",
    });
    expect(getErrnoCode(fsError)).toBe("ENOENT");
    expect(getErrnoPath(fsError)).toBe("/tmp/missing");
    expect(isFsInaccessible(fsError)).toBe(true);
  });

  test("maps SDK assistant-message error types to typed errors", () => {
    expect(sdkErrorFromType("authentication_failed")).toBeInstanceOf(
      SDKAuthenticationError,
    );
    expect(sdkErrorFromType("rate_limit")).toBeInstanceOf(SDKRateLimitError);
    expect(sdkErrorFromType("unknown")).toBeInstanceOf(AgenCError);
  });

  test("classifies axios-shaped errors without importing axios", () => {
    expect(
      classifyAxiosError({
        isAxiosError: true,
        response: { status: 403 },
        message: "forbidden",
      }),
    ).toEqual({ kind: "auth", status: 403, message: "forbidden" });
    expect(
      classifyAxiosError({
        isAxiosError: true,
        code: "ECONNREFUSED",
        message: "connect",
      }),
    ).toEqual({ kind: "network", status: undefined, message: "connect" });
  });

  test("shortens long stacks to the requested frame count", () => {
    const error = new Error("bad");
    error.stack = [
      "Error: bad",
      "    at one",
      "    at two",
      "    at three",
    ].join("\n");
    expect(shortErrorStack(error, 2)).toBe(
      ["Error: bad", "    at one", "    at two"].join("\n"),
    );
  });
});
