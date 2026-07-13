import { describe, expect, test } from "vitest";

import {
  LLMContextWindowExceededError,
  LLMServerError,
  mapLLMError,
} from "../../src/llm/errors.js";

// M-LLM-1 (core-todo.md): CONTEXT_WINDOW_EXCEEDED_MESSAGE_RE contained a bare `413`
// with no boundary, so any error whose body merely contained the substring "413"
// (a request id, trace id, timestamp) was mapped to the NON-retryable
// LLMContextWindowExceededError instead of a retryable LLMServerError — dropping
// history / failing the turn on a recoverable transient server error.

describe("mapLLMError — 413 substring must not hijack transient 5xx", () => {
  test.each([
    { status: 500, message: "Internal Server Error (request req_84413)" },
    { status: 503, message: "upstream failure trace 8c4130a2" },
    { status: 502, message: "bad gateway id=413200" },
  ])("maps a $status with an incidental '413' substring to LLMServerError", ({ status, message }) => {
    const mapped = mapLLMError("openai", { status, message }, 30_000);
    expect(mapped).toBeInstanceOf(LLMServerError);
    expect(mapped).not.toBeInstanceOf(LLMContextWindowExceededError);
  });

  test("a real HTTP 413 status still maps to context-window-exceeded", () => {
    const mapped = mapLLMError("openai", { status: 413, message: "Payload Too Large" }, 30_000);
    expect(mapped).toBeInstanceOf(LLMContextWindowExceededError);
  });

  test("a 'payload too large' message (no status) still maps to context-window-exceeded", () => {
    const mapped = mapLLMError("openai", { message: "request payload too large" }, 30_000);
    expect(mapped).toBeInstanceOf(LLMContextWindowExceededError);
  });

  test("a genuine context-length message still maps to context-window-exceeded", () => {
    const mapped = mapLLMError(
      "openai",
      { status: 400, message: "This model's maximum context length is 200000 tokens" },
      30_000,
    );
    expect(mapped).toBeInstanceOf(LLMContextWindowExceededError);
  });
});
