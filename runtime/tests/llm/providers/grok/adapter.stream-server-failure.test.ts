import { describe, expect, test, vi } from "vitest";

import { LLMAuthenticationError, LLMProviderError, LLMServerError } from "../../errors.js";
import type { LLMResponse } from "../../types.js";
import { StreamModelError } from "../../../phases/stream-model.js";
import { isRetryableStreamError } from "../../../session/run-turn-stream-retry.js";
import { GrokProvider } from "./adapter.js";

// A Terminal-Bench trial lost 2 h 23 min of work when xAI ended an HTTP 200
// stream with "Internal error during token generation": the adapter returned an
// untyped provider error and the turn failed instead of sampling again.

function withResponse<T>(data: T) {
  return {
    withResponse: async () => ({
      data,
      response: new Response("", { status: 200, headers: { "content-type": "text/event-stream" } }),
      request_id: null,
    }),
  };
}

function streamFromEvents(events: readonly Record<string, unknown>[]): AsyncIterable<Record<string, unknown>> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  };
}

const functionCall = {
  type: "function_call",
  id: "fc_streamed",
  call_id: "call_streamed",
  name: "exec_command",
  arguments: JSON.stringify({ cmd: "ls" }),
};

const reasoningDelta = {
  type: "response.reasoning_summary_text.delta",
  delta: "Checking the timings.",
  summary_index: 0,
};

async function streamOnce(events: readonly Record<string, unknown>[]): Promise<LLMResponse> {
  const provider = new GrokProvider({ apiKey: "xai-test", model: "grok-4.6" });
  const create = vi.fn(() => withResponse(streamFromEvents(events)));
  (provider as any).client = { responses: { create } };
  const response = await provider.chatStream([{ role: "user", content: "run it" }], () => {});
  expect(create).toHaveBeenCalledTimes(1);
  return response;
}

function retryable(response: LLMResponse): boolean {
  expect(response.error).toBeDefined();
  return isRetryableStreamError(new StreamModelError(response.error, response));
}

const failed = (error: Record<string, unknown>) => ({
  type: "response.failed",
  response: { id: "resp_failed", status: "failed", model: "grok-4.6", error },
});

describe("Grok stream server failures are retried, never after a streamed tool call", () => {
  test("a statusless internal generation failure in response.failed is a retryable server error", async () => {
    const response = await streamOnce([
      reasoningDelta,
      failed({ message: "Internal error during token generation" }),
    ]);
    expect(response.finishReason).toBe("error");
    expect(response.error).toBeInstanceOf(LLMServerError);
    expect(response.partial).toBeUndefined();
    expect(retryable(response)).toBe(true);
  });

  test("a symbolic server_error code is a retryable server error in response.failed and in an error event", async () => {
    const fromFailed = await streamOnce([failed({ code: "server_error", message: "The server had an error" })]);
    expect(fromFailed.error).toBeInstanceOf(LLMServerError);
    expect(retryable(fromFailed)).toBe(true);

    const fromEvent = await streamOnce([
      reasoningDelta,
      { type: "error", code: "server_error", message: "Internal error during token generation" },
    ]);
    expect(fromEvent.error).toBeInstanceOf(LLMServerError);
    expect(retryable(fromEvent)).toBe(true);
  });

  test("a numeric 5xx in response.failed is a retryable server error", async () => {
    const response = await streamOnce([failed({ code: 503, message: "Service unavailable" })]);
    expect(response.error).toBeInstanceOf(LLMServerError);
    expect(retryable(response)).toBe(true);
  });

  test("a server failure after a streamed tool call keeps the partial response and is not replayed", async () => {
    for (const error of [{ code: 503, message: "Service unavailable" }, { message: "Internal error during token generation" }]) {
      const response = await streamOnce([
        { type: "response.output_item.added", output_index: 0, item: functionCall },
        { type: "response.output_item.done", output_index: 0, item: functionCall },
        failed(error),
      ]);
      expect(response.finishReason).toBe("error");
      expect(response.partial).toBe(true);
      expect(response.toolCalls.map((call) => call.id)).toEqual(["call_streamed"]);
      expect(retryable(response)).toBe(false);
    }
  });

  test.each(["status", "statusCode", "status_code"])(
    "an explicit numeric %s wins over a symbolic server code in response.failed",
    async (field) => {
      for (const [status, expected] of [[400, false], [401, false], [403, false], [413, false], [422, false], [503, true]] as const) {
        const response = await streamOnce([
          failed({ code: "server_error", [field]: status, message: "Internal error during token generation" }),
        ]);
        expect({ field, status, retryable: retryable(response) }).toEqual({ field, status, retryable: expected });
        expect(response.error instanceof LLMServerError).toBe(expected);
      }
    },
  );

  test.each(["status", "statusCode", "status_code"])(
    "an explicit numeric %s wins over a symbolic server code in an error event",
    async (field) => {
      for (const [status, expected] of [[400, false], [401, false], [403, false], [413, false], [422, false], [503, true]] as const) {
        const response = await streamOnce([
          { type: "error", error: { code: "server_error", [field]: status, message: "Internal error during token generation" } },
        ]);
        expect({ field, status, retryable: retryable(response) }).toEqual({ field, status, retryable: expected });
      }
    },
  );

  test("a non-numeric status never hides a nested explicit 4xx", async () => {
    const response = await streamOnce([
      { type: "error", status: "failed", error: { status: 400, code: "server_error", message: "Internal error during token generation" } },
    ]);
    expect(response.error).not.toBeInstanceOf(LLMServerError);
    expect(retryable(response)).toBe(false);
  });

  test("client and authentication failures stay terminal", async () => {
    const invalid = await streamOnce([failed({ code: 400, message: "invalid request" })]);
    expect(invalid.error).toBeInstanceOf(LLMProviderError);
    expect(invalid.error).not.toBeInstanceOf(LLMServerError);
    expect(retryable(invalid)).toBe(false);

    const unnamed = await streamOnce([failed({ message: "Provider refused the request" })]);
    expect(unnamed.error).not.toBeInstanceOf(LLMServerError);
    expect(retryable(unnamed)).toBe(false);

    const auth = await streamOnce([{ type: "error", status: 401, message: "unauthorized" }]);
    expect(auth.error).toBeInstanceOf(LLMAuthenticationError);
    expect(retryable(auth)).toBe(false);
  });
});
