import { describe, expect, it } from "vitest";
import { RuntimeError, RuntimeErrorCodes } from "../types/errors.js";
import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMInvalidResponseError,
  LLMMessageValidationError,
  LLMProviderError,
  LLMRateLimitError,
  LLMServerError,
  LLMTimeoutError,
  classifyLLMFailure,
  mapLLMError,
} from "./errors.js";

describe("classifyLLMFailure", () => {
  it("classifies typed LLM errors", () => {
    expect(classifyLLMFailure(new LLMTimeoutError("grok", 1000))).toBe("timeout");
    expect(classifyLLMFailure(new LLMRateLimitError("grok", 1000))).toBe("rate_limited");
    expect(classifyLLMFailure(new LLMAuthenticationError("grok", 401))).toBe("authentication_error");
    expect(
      classifyLLMFailure(
        new LLMMessageValidationError("grok", {
          validationCode: "missing",
          messageIndex: 2,
          reason: "missing tool_call_id",
        }),
      ),
    ).toBe("validation_error");
    expect(classifyLLMFailure(new LLMProviderError("grok", "bad request", 400))).toBe(
      "provider_error",
    );
    expect(
      classifyLLMFailure(
        new LLMInvalidResponseError("grok", "malformed response envelope"),
      ),
    ).toBe("provider_error");
  });

  it("classifies runtime budget errors", () => {
    const err = new RuntimeError(
      "budget exceeded",
      RuntimeErrorCodes.CHAT_BUDGET_EXCEEDED,
    );
    expect(classifyLLMFailure(err)).toBe("budget_exceeded");
  });

  it("maps unknown cancel-like failures to cancelled", () => {
    expect(classifyLLMFailure(new Error("Request aborted by caller"))).toBe(
      "cancelled",
    );
  });

  it("maps non-matching unknown errors to unknown", () => {
    expect(classifyLLMFailure(new Error("mystery failure"))).toBe("unknown");
  });
});

describe("mapLLMError", () => {
  it("maps transient provider outage text without status to server error", () => {
    const mapped = mapLLMError(
      "grok",
      new Error("Service temporarily unavailable."),
      30_000,
    );

    expect(mapped).toBeInstanceOf(LLMServerError);
    expect((mapped as LLMServerError).statusCode).toBe(503);
  });

  // Phase I: context window overflow mapping
  describe("context window overflow (Phase I)", () => {
    it("maps HTTP 413 status to LLMContextWindowExceededError", () => {
      const raw = { status: 413, message: "Payload Too Large" };
      const mapped = mapLLMError("grok", raw, 30_000);
      expect(mapped).toBeInstanceOf(LLMContextWindowExceededError);
      expect((mapped as LLMContextWindowExceededError).statusCode).toBe(413);
    });

    it("maps 'context_length_exceeded' message to LLMContextWindowExceededError", () => {
      const raw = new Error(
        "This model's maximum context length is 200000 tokens. However, your messages resulted in 215000 tokens",
      );
      const mapped = mapLLMError("grok", raw, 30_000);
      expect(mapped).toBeInstanceOf(LLMContextWindowExceededError);
    });

    it("maps 'prompt too long' message to LLMContextWindowExceededError", () => {
      const mapped = mapLLMError(
        "grok",
        new Error("Prompt too long: tokens exceeds the model's window"),
        30_000,
      );
      expect(mapped).toBeInstanceOf(LLMContextWindowExceededError);
    });

    it("passes LLMContextWindowExceededError through untouched", () => {
      const err = new LLMContextWindowExceededError("grok", "context_length_exceeded");
      const mapped = mapLLMError("grok", err, 30_000);
      expect(mapped).toBe(err);
    });

    it("classifies LLMContextWindowExceededError as provider_error for cooldown purposes", () => {
      const err = new LLMContextWindowExceededError("grok", "too long");
      expect(classifyLLMFailure(err)).toBe("provider_error");
    });
  });
});
