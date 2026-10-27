import { describe, expect, test } from "vitest";
import {
  buildOpenAICompatibilityErrorMessage,
  classifyOpenAIHttpFailure,
  classifyOpenAINetworkFailure,
  extractOpenAICategoryMarker,
  formatOpenAICategoryMarker,
} from "./openai-compatible.js";

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

  // During a provider outage the gateway answers with an HTML error page.
  // On 2026-10-16 a DeepSeek 502 like this ended a turn instead of retrying.
  test("a 5xx gateway error page is a retryable outage, not a malformed response", () => {
    const page = '<!DOCTYPE HTML>\n<html lang="en">\n<head><title>Error response</title></head>\n<body><h1>Error response</h1><p>Error code: 502</p></body>\n</html>';
    for (const status of [500, 502, 503, 504]) {
      expect(classifyOpenAIHttpFailure({ status, body: page })).toMatchObject({
        category: "provider_unavailable",
        retryable: true,
      });
    }
    // Non-JSON bodies on success and on client errors stay malformed.
    expect(classifyOpenAIHttpFailure({ status: 200, body: page }).category).toBe("malformed_provider_response");
    expect(classifyOpenAIHttpFailure({ status: 400, body: page }).category).toBe("malformed_provider_response");
    // A context overflow reported by a 5xx keeps its own category.
    expect(
      classifyOpenAIHttpFailure({ status: 502, body: "<html>maximum context length exceeded</html>" }).category,
    ).toBe("context_overflow");
  });

  test("embeds and extracts category markers in formatted messages", () => {
    expect(formatOpenAICategoryMarker("endpoint_not_found")).toBe(
      "[openai_category=endpoint_not_found]",
    );

    const formatted = buildOpenAICompatibilityErrorMessage(
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
        "OpenAI API error 500 [openai_category=totally_fake_category]",
      ),
    ).toBeUndefined();
  });
});
