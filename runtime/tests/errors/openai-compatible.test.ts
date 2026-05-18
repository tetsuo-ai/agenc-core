import { describe, expect, test } from "vitest";
import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAIHttpFailure,
  classifyOpenAINetworkFailure,
  extractOpenAICategoryMarker,
  formatOpenAICategoryMarker,
} from "./openai-compatible.js";

// branding-scan: allow real OpenAI provider identifier
describe("OpenAI-compatible error classification", () => {
  test("classifies localhost ECONNREFUSED as connection_refused", () => {
    const error = Object.assign(new TypeError("fetch failed"), {
      code: "ECONNREFUSED",
    });

    const failure = classifyOpenAINetworkFailure(error, {
      url: "http://localhost:11434/v1/chat/completions",
    });

    expect(failure.category).toBe("connection_refused");
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("ECONNREFUSED");
    expect(failure.hint).toContain("local server is running");
  });

  test("classifies nested localhost ENOTFOUND as localhost_resolution_failed", () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND localhost"), {
      code: "ENOTFOUND",
    });
    const error = new TypeError("fetch failed", { cause });

    const failure = classifyOpenAINetworkFailure(error, {
      url: "http://localhost:11434/v1/chat/completions",
    });

    expect(failure.category).toBe("localhost_resolution_failed");
    expect(failure.retryable).toBe(true);
    expect(failure.code).toBe("ENOTFOUND");
    expect(failure.hint).toContain("127.0.0.1");
  });

  test("classifies HTTP failures with actionable categories", () => {
    expect(
      classifyOpenAIHttpFailure({
        status: 404,
        body: "The model qwen2.5-coder:7b was not found",
      }).category,
    ).toBe("model_not_found");
    expect(
      classifyOpenAIHttpFailure({
        status: 404,
        body: "Not Found",
      }),
    ).toMatchObject({
      category: "endpoint_not_found",
      retryable: false,
    });
    expect(
      classifyOpenAIHttpFailure({
        status: 500,
        body: "request too large: maximum context length exceeded",
      }).category,
    ).toBe("context_overflow");
    expect(
      classifyOpenAIHttpFailure({
        status: 400,
        body: "tool_calls are not supported by this model",
      }).category,
    ).toBe("tool_call_incompatible");
  });

  test("embeds and extracts category markers in formatted messages", () => {
    expect(formatOpenAICategoryMarker("endpoint_not_found")).toBe(
      "[openai_category=endpoint_not_found]",
    );

    const formatted = buildOpenAICompatibilityErrorMessage(
      // branding-scan: allow real OpenAI provider identifier
      "OpenAI API error 404: Not Found",
      {
        category: "endpoint_not_found",
        hint: "Confirm OPENAI_BASE_URL includes /v1.",
      },
    );

    expect(formatted).toContain("[openai_category=endpoint_not_found]");
    expect(formatted).toContain("Hint: Confirm OPENAI_BASE_URL includes /v1.");
    expect(extractOpenAICategoryMarker(formatted)).toBe("endpoint_not_found");
    expect(
      extractOpenAICategoryMarker(
        // branding-scan: allow real OpenAI provider identifier
        "OpenAI API error 500 [openai_category=totally_fake_category]",
      ),
    ).toBeUndefined();
  });
});
