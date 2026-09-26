import { describe, expect, test } from "vitest";
import {
  LLMAuthenticationError,
  LLMFundsError,
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
  test.each([403, 402])("preserves sanitized billing text from HTTP %s", (status) => {
    const error = new AgenCApiError("Forbidden", {
      status,
      body: JSON.stringify({
        code: "permission-denied", request_id: "private-request",
        error: "  Your team has used all available credits. Request ID: req_private  ",
      }),
    });
    const mapped = mapAgenCApiErrorToLLMError("grok", error, 30_000);
    expect(mapped).toBeInstanceOf(LLMFundsError);
    expect(mapped).toMatchObject({ statusCode: status });
    expect(mapped.message).toContain("grok error: Your team has used all available credits.");
    expect(mapped.message).not.toMatch(/permission-denied|private-request|req_private/);
    expect(mapped.message).toBe(mapped.message.trim());
  });

  test("keeps genuine API permission failures as authentication", () => {
    const mapped = mapAgenCApiErrorToLLMError("grok",
      new AgenCApiError("Cannot view credits", { status: 403 }), 30_000);
    expect(mapped).toBeInstanceOf(LLMAuthenticationError);
    expect(mapped.message).toBe("grok authentication failed (HTTP 403)");
  });

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
