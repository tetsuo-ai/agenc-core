import { describe, expect, test } from "vitest";
import {
  AgenCApiError,
  API_ERROR_MESSAGE_PREFIX,
  categorizeRetryableAPIError,
  classifyApiError,
  extractApiErrorMessage,
  extractConnectionErrorDetails,
  formatAPIError,
  getPromptTooLongTokenGap,
  getSSLErrorHint,
  isMediaSizeError,
  parsePromptTooLongTokenCounts,
  redactSensitiveAPIText,
  sanitizeAPIError,
  startsWithApiErrorPrefix,
} from "./api.js";

describe("API error UX helpers", () => {
  test("extracts and formats SSL connection failures", () => {
    const cause = Object.assign(new Error("leaf signature rejected"), {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });
    const error = new Error("Connection error.", { cause });

    expect(extractConnectionErrorDetails(error)).toEqual({
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      message: "leaf signature rejected",
      isSSLError: true,
    });
    expect(formatAPIError(error)).toContain("SSL certificate verification failed");
    expect(getSSLErrorHint(error)).toContain("NODE_EXTRA_CA_CERTS");
  });

  test("sanitizes HTML and nested API error messages", () => {
    expect(
      sanitizeAPIError({
        message: "<!DOCTYPE html><html><title>Gateway</title></html>",
      }),
    ).toBe("Gateway");
    expect(
      sanitizeAPIError({
        message: '<!doctype HTML><HTML><TITLE class="x">Proxy</TITLE></HTML>',
      }),
    ).toBe("Proxy");
    expect(
      formatAPIError({
        status: 400,
        error: { error: { message: "nested detail" } },
      }),
    ).toBe("nested detail");
  });

  test("redacts high-risk secrets from display text", () => {
    expect(
      redactSensitiveAPIText(
        "Authorization: Bearer abc.def\nCookie: sid=secret\nkey sk-abc123456789",
      ),
    ).toBe(
      "Authorization: [REDACTED]\nCookie: [REDACTED]\nkey sk-[REDACTED]",
    );
  });

  test("parses prompt-too-long and media-size sentinels", () => {
    const raw = "Prompt is too long: 137500 tokens > 135000 maximum";
    expect(parsePromptTooLongTokenCounts(raw)).toEqual({
      actualTokens: 137500,
      limitTokens: 135000,
    });
    expect(getPromptTooLongTokenGap(raw)).toBe(2500);
    expect(isMediaSizeError("image exceeds 5 MB maximum")).toBe(true);
    expect(isMediaSizeError("maximum of 100 PDF pages")).toBe(true);
  });

  test("classifies and extracts API error details", () => {
    expect(classifyApiError(new AgenCApiError("slow", { status: 429 }))).toBe(
      "rate_limit",
    );
    expect(classifyApiError({ status: 500, message: "overloaded_error" })).toBe(
      "server_overload",
    );
    expect(
      extractApiErrorMessage(
        { error: { message: "bad sk-abc123456789" } },
        "fallback",
      ),
    ).toBe("bad sk-[REDACTED]");
    expect(startsWithApiErrorPrefix(`${API_ERROR_MESSAGE_PREFIX}: bad`)).toBe(
      true,
    );
    expect(startsWithApiErrorPrefix("Please run /login - API Error: bad")).toBe(
      true,
    );
    expect(startsWithApiErrorPrefix("Please run /login · API Error: bad")).toBe(
      true,
    );
    expect(categorizeRetryableAPIError({ status: 503 })).toBe("server_error");
  });
});
