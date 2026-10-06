import { describe, expect, test, vi } from "vitest";
import {
  LLMAuthenticationError, LLMFundsError, LLMProviderError,
  LLMServerError, LLMStreamRetryDeniedError,
} from "../../../../src/llm/errors.js";
import { OpenAIProvider } from "../../../../src/llm/providers/openai/adapter.js";
import { StreamModelError } from "../../../../src/phases/stream-model.js";
import { isTransientProviderError } from "../../../../src/recovery/api-errors.js";
import { isRetryableStreamError } from "../../../../src/session/run-turn-stream-retry.js";

const overload = { code: "server_is_overloaded", message: "The server is overloaded." };
const frame = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const failed = (error: object) => frame("response.failed", { response: { status: "failed", error } });

async function failure(frames: string[], fallback = false, headers: Record<string, string> = {}) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(frames.join(""), {
    headers: { "content-type": "text/event-stream", ...headers },
  }));
  const provider = new OpenAIProvider({ apiKey: "test", model: "gpt-6-luna", useResponsesApi: true, fetchImpl,
    ...(fallback ? { providerFallback: { provider: "openai", model: "gpt-6-luna",
      targets: [{ provider: "grok", model: "grok-4-fast" }] } } : {}),
  });
  const chunks: unknown[] = [];
  const error = await provider.chatStream([{ role: "user", content: "go" }], chunk => chunks.push(chunk))
    .then(() => undefined, (caught: unknown) => caught);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(error).toBeInstanceOf(Error);
  return { error, chunks };
}

function terminal(error: unknown) {
  expect(isTransientProviderError(error)).toBe(false);
  expect(isTransientProviderError(new StreamModelError(error))).toBe(false);
  expect(isRetryableStreamError(new StreamModelError(error))).toBe(false);
}

describe("Responses structured overload failures", () => {
  test.each([false, true])("statusless overload uses existing server retry classification (error-only=%s)", async errorOnly => {
    const { error } = await failure(errorOnly ? [frame("error", overload)] : [failed(overload)]);
    expect(error).toBeInstanceOf(LLMServerError);
    expect(error).toMatchObject({ statusCode: 503 });
    expect(isTransientProviderError(error)).toBe(true);
    expect(isRetryableStreamError(new StreamModelError(error))).toBe(true);
  });

  test("keeps the typed overload classification despite network-like provider prose", async () => {
    const { error } = await failure([failed({ ...overload, message: "socket hang up" })]);
    expect(error).toBeInstanceOf(LLMServerError);
    expect(error).toMatchObject({ statusCode: 503 });
  });

  test("honors an HTTP no-retry header on a statusless overload", async () => {
    const { error } = await failure([failed(overload)], true, { "x-retry-metadata": "NO_MORE_RETRY" });
    expect(error).toMatchObject({ reason: "provider_directive" });
    terminal(error);
  });

  test.each(["earlier", "terminal", "error-only"])("NO_MORE_RETRY stays terminal from %s, including fallback and misleading network prose", async where => {
    const error = { ...overload, message: "socket hang up", headers: { "X-Retry-Metadata": "NO_MORE_RETRY" } };
    const frames = where === "earlier" ? [frame("error", error), failed(overload)]
      : where === "terminal" ? [failed(error)] : [frame("error", error)];
    const result = await failure(frames, true);
    expect(result.error).toBeInstanceOf(LLMStreamRetryDeniedError);
    expect(result.error).toMatchObject({ reason: "provider_directive" });
    terminal(result.error);
  });

  test.each([
    ["response.output_text.delta", { delta: "Visible text" }],
    ["response.output_item.added", { item: { id: "fc1", type: "function_call", call_id: "call1", name: "exec", arguments: "" } }],
    ["response.function_call_arguments.delta", { item_id: "fc1", delta: '{"command":' }],
    ["response.output_item.done", { item: { id: "fc1", type: "function_call", call_id: "call1", name: "exec", arguments: "{}" } }],
    ["response.reasoning_summary_text.delta", { item_id: "r1", summary_index: 0, delta: "Consider" }],
  ] as const)("does not resample after %s", async (type, data) => {
    const { error, chunks } = await failure([frame(type, data), failed(overload)], true);
    expect(error).toMatchObject({ reason: "partial_output" });
    terminal(error);
    if (type === "response.output_text.delta") expect(chunks).toContainEqual({ content: "Visible text", done: false });
  });

  test("retains an earlier explicit status when response.failed omits it", async () => {
    const { error } = await failure([frame("error", { ...overload, status: 401 }), failed(overload)]);
    expect(error).toBeInstanceOf(LLMAuthenticationError);
    terminal(error);
  });

  test.each([400, 401, 403, 404, 422])("explicit status %s takes precedence over overload synthesis and network prose", async status => {
    const { error } = await failure([failed({ ...overload, message: "socket hang up", status })]);
    expect(error).not.toBeInstanceOf(LLMServerError);
    expect(error).toBeInstanceOf(status === 401 || status === 403 ? LLMAuthenticationError : LLMProviderError);
    terminal(error);
  });

  test.each(["insufficient_quota", "invalid_request_error", "context_length_exceeded", "unknown_failure"])("does not broaden statusless %s into server retry", async code => {
    const { error } = await failure([failed({ code, message: "Request failed" })]);
    expect(error).not.toBeInstanceOf(LLMServerError);
    if (code === "insufficient_quota") expect(error).toBeInstanceOf(LLMFundsError);
    terminal(error);
  });
});
