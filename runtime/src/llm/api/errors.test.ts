import { describe, expect, test } from "vitest";
import {
  LLMAuthenticationError,
  LLMContextWindowExceededError,
  LLMRateLimitError,
  LLMServerError,
} from "../errors.js";
import {
  AgenCApiError,
  classifyApiError,
  getPromptTooLongTokenGap,
  isMediaSizeError,
  mapAgenCApiErrorToLLMError,
  parsePromptTooLongTokenCounts,
} from "./errors.js";
import { AgenCApiError as CanonicalAgenCApiError } from "../../errors/api.js";

describe("llm api errors", () => {
  test("shares the canonical runtime API error class", () => {
    expect(AgenCApiError).toBe(CanonicalAgenCApiError);
  });

  test("parses prompt-too-long token counts and gap", () => {
    const raw = "Prompt is too long: 137500 tokens > 135000 maximum";

    expect(parsePromptTooLongTokenCounts(raw)).toEqual({
      actualTokens: 137500,
      limitTokens: 135000,
    });
    expect(getPromptTooLongTokenGap(raw)).toBe(2500);
  });

  test("classifies media and provider failures", () => {
    expect(isMediaSizeError("image exceeds 5 MB maximum")).toBe(true);
    expect(classifyApiError(new Error("maximum of 100 PDF pages"))).toBe(
      "pdf_too_large",
    );
    expect(classifyApiError({ status: 429, message: "rate limited" })).toBe(
      "rate_limit",
    );
    expect(
      classifyApiError({ status: 500, message: "{\"type\":\"overloaded_error\"}" }),
    ).toBe("server_overload");
  });

  test("maps API errors to runtime LLM errors", () => {
    expect(
      mapAgenCApiErrorToLLMError(
        "openai",
        new AgenCApiError("bad key", { status: 401 }),
        30_000,
      ),
    ).toBeInstanceOf(LLMAuthenticationError);
    expect(
      mapAgenCApiErrorToLLMError(
        "openai",
        new AgenCApiError("limited", { status: 429, retryAfterMs: 1000 }),
        30_000,
      ),
    ).toBeInstanceOf(LLMRateLimitError);
    expect(
      mapAgenCApiErrorToLLMError(
        "openai",
        new AgenCApiError("context length exceeded", { status: 413 }),
        30_000,
      ),
    ).toBeInstanceOf(LLMContextWindowExceededError);
    expect(
      mapAgenCApiErrorToLLMError(
        "openai",
        new AgenCApiError(
          "Prompt is too long: 137500 tokens > 135000 maximum",
          { status: 400 },
        ),
        30_000,
      ),
    ).toBeInstanceOf(LLMContextWindowExceededError);
    expect(
      mapAgenCApiErrorToLLMError(
        "openai",
        new AgenCApiError("unavailable", { status: 503 }),
        30_000,
      ),
    ).toBeInstanceOf(LLMServerError);
  });
});
