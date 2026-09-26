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
  test.each(["cause", "originalError"])("uses a fixed billing message for a refusal in %s", (causeKey) => {
    const message = "Please check your plan and billing details.";
    const error = {
      status: 429,
      message: "Request failed with status code 429",
      [causeKey]: { status: 429, error: { code: "insufficient_quota", message } },
    };
    expect(mapAgenCApiErrorToLLMError("openai", error, 30_000)).toMatchObject({
      name: "LLMFundsError", message: `openai error: OpenAI says the account has no credits left or has reached its spending limit.`,
    });
  });

  test.each([
    undefined,
    'Insufficient credits. "request_id": "f00d-1234"',
    "Insufficient credits. 'request-id': 'f00d-1234'",
    'Insufficient credits. "trace": "f00d-1234"',
    'Insufficient credits. request_id=f00d-1234',
    'Insufficient credits. trace=f00d-1234',
  ])("ignores billing cause prose: %s", (message) => {
    const error = {
      status: 429,
      message: "Request failed with status code 429",
      cause: { status: 429, error: { code: "insufficient_quota", message } },
    };
    expect(mapAgenCApiErrorToLLMError("openai", error, 30_000)).toMatchObject({
      name: "LLMFundsError", message: "openai error: OpenAI says the account has no credits left or has reached its spending limit.",
    });
  });

  test.each([
    "HTTP 403",
    '{"error":{"code":"insufficient_quota"}}',
    '403 {"error":{"code":"insufficient_quota"}}',
    'HTTP 403: {"error":{"code":"insufficient_quota"}}',
  ])("uses the default billing message instead of transport details: %s", (message) => {
    const error = new AgenCApiError(message, {
      status: 403, body: { error: { code: "insufficient_quota" } },
    });
    const mapped = mapAgenCApiErrorToLLMError("openai", error, 30_000);
    expect(mapped).toBeInstanceOf(LLMFundsError);
    expect(mapped).toMatchObject({
      statusCode: 403, message: "openai error: OpenAI says the account has no credits left or has reached its spending limit.",
    });
  });

  test.each([403, 402])("uses fixed billing wording for HTTP %s", (status) => {
    const error = new AgenCApiError("Forbidden", {
      status,
      body: {
        code: "permission-denied", request_id: "private-request",
        error: "  Your team has used all available credits.  ",
      },
    });
    const mapped = mapAgenCApiErrorToLLMError("grok", error, 30_000);
    expect(mapped).toBeInstanceOf(LLMFundsError);
    expect(mapped).toMatchObject({
      statusCode: status, message: "grok error: xAI says the account has no credits left or has reached its spending limit.",
    });
  });

  test.each([
    'Insufficient credits. Bearer abc',
    'Your team has reached its monthly spending limit. Request ID f00d-1234',
    'Insufficient credits. Bearer short-token',
    'Insufficient credits. Request ID f00d-1234',
    'Insufficient credits. "request_id": "private-request"',
    'Insufficient credits. Authorization: Basic short-token',
    'Insufficient credits. Cookie: private',
    '<html>Insufficient credits.</html>',
    '{"error":{"message":"Insufficient credits."}}',
    '403 {"error":{"message":"Insufficient credits."}}',
  ])("uses the fixed billing message for body text: %s", (text) => {
    for (const status of [402, 403]) {
      for (const body of [text, { error: text }, { error: { message: text } }]) {
        const error = new AgenCApiError("HTTP 403", {
          status, body,
        });
        const mapped = mapAgenCApiErrorToLLMError("grok", error, 30_000);
        expect(mapped).toBeInstanceOf(LLMFundsError);
        expect(mapped).toMatchObject({
          statusCode: status, message: "grok error: xAI says the account has no credits left or has reached its spending limit.",
        });
      }
    }
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
