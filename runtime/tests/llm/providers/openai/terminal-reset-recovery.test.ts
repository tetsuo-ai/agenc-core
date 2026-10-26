import { describe, expect, test, vi } from "vitest";

import { runAdmittedModelCall } from "../../../../src/budget/admitted-model-call.js";
import type { ProviderHttpStreamChunk, ProviderHttpStreamResponse } from "../../../../src/llm/client-session.js";
import { LLMInvalidResponseError, LLMProviderError, LLMServerError, LLMTimeoutError } from "../../../../src/llm/errors.js";
import { DeepSeekProvider } from "../../../../src/llm/providers/deepseek/index.js";
import { OpenAICompatibleProvider } from "../../../../src/llm/providers/openai-compatible/index.js";
import type { LLMTool, StreamProgressCallback } from "../../../../src/llm/types.js";
import type { Session } from "../../../../src/session/session.js";
import { createAllowAdmissionHarness } from "../../../budget/admission-test-harness.js";

const messages = [{ role: "user" as const, content: "synthetic completion probe" }];
const tool: LLMTool = { type: "function", function: {
  name: "write_once", description: "Synthetic effect", parameters: { type: "object" },
} };
const frame = (delta: object, finishReason?: string, usage?: object) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta,
    ...(finishReason === undefined ? {} : { finish_reason: finishReason }),
  }], ...(usage === undefined ? {} : { usage }) })}\n\n`;
const reportedUsage = { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 };
const reset = () => Object.assign(new TypeError("terminated"), {
  cause: Object.assign(new Error("synthetic socket closed"), { code: "UND_ERR_SOCKET" }),
});

// No prefetch: every frame is delivered before the following read fails.
function resetResponse(parts: string[], error: Error, beforeFailure?: () => void): Response {
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < parts.length) {
        controller.enqueue(new TextEncoder().encode(parts[index++]!));
      } else {
        beforeFailure?.();
        controller.error(error);
      }
    },
  }, { highWaterMark: 0 }), { headers: { "content-type": "text/event-stream" } });
}

describe("SSE iterator cleanup parity", () => {
  // Exercise the iterator boundary directly: the HTTP client's own cleanup
  // intentionally suppresses reader.cancel failures before they reach here.
  function readEvents(iterator: AsyncIterator<ProviderHttpStreamChunk>) {
    const provider = new OpenAICompatibleProvider({ model: "fixture-model" });
    return (provider as unknown as {
      readSseEvents(response: ProviderHttpStreamResponse): AsyncGenerator<unknown>;
    }).readSseEvents({ status: 200, headers: new Headers(), url: "http://fixture.invalid",
      [Symbol.asyncIterator]: () => iterator,
    });
  }
  const chunk = (text: string): IteratorResult<ProviderHttpStreamChunk> => ({
    done: false, value: { value: new TextEncoder().encode(text), index: 0 },
  });

  test("does not close an iterator that reached natural completion", async () => {
    const close = vi.fn(async () => { throw new Error("unnecessary close"); });
    const events = readEvents({ next: async () => ({ done: true, value: undefined }), return: close });
    await expect(events.next()).resolves.toMatchObject({ done: true });
    expect(close).not.toHaveBeenCalled();
  });

  test("preserves a rejected read without attempting another close", async () => {
    const primary = reset();
    const close = vi.fn(async () => { throw new Error("secondary close failure"); });
    const events = readEvents({ next: async () => { throw primary; }, return: close });
    await expect(events.next()).rejects.toBe(primary);
    expect(close).not.toHaveBeenCalled();
  });

  test("preserves parser failure when closing also fails", async () => {
    const close = vi.fn(async () => { throw new Error("secondary close failure"); });
    const events = readEvents({ next: async () => chunk("data: {not-json}\n\n"), return: close });
    await expect(events.next()).rejects.toBeInstanceOf(LLMInvalidResponseError);
    expect(close).toHaveBeenCalledOnce();
  });

  test("closes the underlying iterator when a consumer stops after a yield", async () => {
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const events = readEvents({ next: async () => chunk(frame({ content: "one event" })), return: close });
    for await (const _event of events) break;
    expect(close).toHaveBeenCalledOnce();
  });

  test("reports a close failure on otherwise successful early completion", async () => {
    const failure = new Error("close failure after DONE");
    const close = vi.fn(async () => { throw failure; });
    const events = readEvents({ next: async () => chunk("data: [DONE]\n\n"), return: close });
    await expect(events.next()).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });
});

for (const name of ["deepseek", "openai-compatible"] as const) {
  const model = name === "deepseek" ? "deepseek-v4-pro" : "fixture-model";
  function setup(parts: string[], error = reset(), beforeFailure?: () => void) {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () =>
      resetResponse(parts, error, beforeFailure));
    const config = { model, apiKey: "synthetic-test", fetchImpl, maxRetries: 0, tools: [tool] };
    const provider = name === "deepseek"
      ? new DeepSeekProvider(config) : new OpenAICompatibleProvider(config);
    const chunks: Parameters<StreamProgressCallback>[0][] = [];
    return { provider, fetchImpl, chunks, error,
      invoke: (signal?: AbortSignal, onChunk: StreamProgressCallback = chunk => chunks.push(chunk)) =>
        provider.chatStream(messages, onChunk, { singleWireAttempt: true, signal }),
    };
  }

  describe(`${name} reset after generation completion`, () => {
    test("preserves finished text and terminal usage without another request", async () => {
      const probe = setup([frame({ content: "Finished." }, "stop", reportedUsage)]);
      await expect(probe.invoke()).resolves.toMatchObject({
        content: "Finished.", finishReason: "stop", toolCalls: [],
        usage: { promptTokens: 5, completionTokens: 2, availability: "reported", provenance: "provider" },
      });
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
      expect(probe.chunks.filter(chunk => chunk.done)).toHaveLength(1);
    });

    test("also recognizes a direct connection-reset code", async () => {
      const error = Object.assign(new Error("synthetic read failure"), { code: "ECONNRESET" });
      const probe = setup([frame({ content: "Finished." }, "stop", reportedUsage)], error);
      await expect(probe.invoke()).resolves.toMatchObject({ content: "Finished.", finishReason: "stop" });
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });

    test("retains authoritative usage received in a separate post-finish trailer", async () => {
      const probe = setup([frame({ content: "Finished." }, "stop"),
        `data: ${JSON.stringify({ choices: [], usage: reportedUsage })}\n\n`]);
      await expect(probe.invoke()).resolves.toMatchObject({ usage: {
        promptTokens: 5, completionTokens: 2, availability: "reported", provenance: "provider",
      } });
    });

    test("preserves the provider's existing policy for a complete buffered usage trailer", async () => {
      const probe = setup([frame({ content: "Finished." }, "stop"),
        `data: ${JSON.stringify({ choices: [], usage: reportedUsage })}`]);
      if (name === "deepseek") {
        await expect(probe.invoke()).rejects.toBeInstanceOf(LLMInvalidResponseError);
        expect(probe.chunks.some(chunk => chunk.done)).toBe(false);
      } else {
        await expect(probe.invoke()).resolves.toMatchObject({ usage: {
          promptTokens: 5, completionTokens: 2, availability: "reported", provenance: "provider",
        } });
      }
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });

    test.each(["unclassified", "provider-server"] as const)("does not recover a %s read error", async kind => {
      const error = kind === "unclassified"
        ? new Error("synthetic socket read failure without a transport code")
        : new LLMServerError(name, 503, "synthetic server failure");
      const probe = setup([frame({ content: "Finished." }, "stop")], error);
      const failure = await probe.invoke().catch(error => error);
      if (kind === "provider-server") {
        expect(failure).toBe(error);
      } else {
        expect(failure).toBeInstanceOf(LLMProviderError);
        // The existing compatibility network mapper preserves the message
        // and classification, but does not attach the original cause.
        expect(failure).toMatchObject({ code: "LLM_PROVIDER_ERROR", providerName: name });
        expect(failure.message).toContain(error.message);
        expect(failure.message).toContain("openai_category=network_error");
      }
      expect(probe.chunks.some(chunk => chunk.done)).toBe(false);
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });

    test("keeps a reset before finish as failure and publishes no executable tools", async () => {
      const probe = setup([frame({ tool_calls: [{ index: 0, id: "effect-1", type: "function",
        function: { name: "write_once", arguments: "{}" },
      }] })]);
      const failure = await probe.invoke().catch(error => error);
      expect(failure).toBeInstanceOf(LLMProviderError);
      expect(failure).toMatchObject({ code: "LLM_PROVIDER_ERROR", providerName: name });
      expect(failure.cause).toBe(probe.error);
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
      expect(probe.chunks.some(chunk => chunk.done || (chunk.toolCalls?.length ?? 0) > 0)).toBe(false);
    });

    test("propagates explicit abort even after finish", async () => {
      const controller = new AbortController();
      const aborted = new DOMException("synthetic cancellation", "AbortError");
      const probe = setup([frame({ content: "Finished." }, "stop")], aborted,
        () => controller.abort(aborted));
      const failure = await probe.invoke(controller.signal).catch(error => error);
      expect(failure).toBeInstanceOf(LLMTimeoutError);
      expect(failure).toMatchObject({ code: "LLM_TIMEOUT", providerName: name });
      expect(controller.signal.reason).toBe(aborted);
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
      expect(probe.chunks.some(chunk => chunk.done)).toBe(false);
    });

    test("does not swallow a consumer error that resembles a socket reset", async () => {
      const failure = reset();
      // Establish completion before the callback throws, so a catch around
      // the entire event loop would incorrectly turn this into success.
      const probe = setup([frame({}, "stop", reportedUsage), frame({ content: "callback probe" })]);
      const mapped = await probe.invoke(undefined, () => { throw failure; }).catch(error => error);
      expect(mapped).toBeInstanceOf(LLMProviderError);
      expect(mapped).toMatchObject({ code: "LLM_PROVIDER_ERROR", providerName: name });
      expect(mapped.cause).toBe(failure);
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });

    test("keeps malformed provider events fatal after finish", async () => {
      const probe = setup([frame({ content: "Finished." }, "stop"), "data: {not-json}\n\n"]);
      await expect(probe.invoke()).rejects.toBeInstanceOf(LLMInvalidResponseError);
      expect(probe.chunks.some(chunk => chunk.done)).toBe(false);
    });

    test.each([
      'data: {"choices":[{"delta":{"tool_calls":',
      'data: {"tool_calls": malformed}',
    ])("keeps buffered tool trailers invalid after a reset: %s", async trailer => {
      const probe = setup([frame({ content: "Finished." }, "stop"), trailer]);
      await expect(probe.invoke()).rejects.toBeInstanceOf(LLMInvalidResponseError);
      expect(probe.chunks.some(chunk => chunk.done || (chunk.toolCalls?.length ?? 0) > 0)).toBe(false);
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });

    test("publishes one valid finished tool call only once", async () => {
      const probe = setup([frame({ tool_calls: [{ index: 0, id: "effect-1", type: "function",
        function: { name: "write_once", arguments: "{}" },
      }] }, "tool_calls", reportedUsage)]);
      const result = await probe.invoke();
      expect(result.toolCalls).toEqual([{ id: "effect-1", name: "write_once", arguments: "{}" }]);
      expect(probe.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual(result.toolCalls);
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });

    test.each(["clean EOF", "reset"] as const)("retains invalid-argument recovery at %s without publishing the tool", async ending => {
      // A solitary "{" is repaired to {} by existing argument normalization.
      // This established invalid-JSON fixture must instead enter recovery.
      const body = frame({ tool_calls: [{ index: 0, id: "effect-1", type: "function",
        function: { name: "write_once", arguments: "not-json" },
      }] }, "tool_calls");
      const probe = setup([body]);
      if (ending === "clean EOF") {
        probe.fetchImpl.mockResolvedValue(new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }));
      }
      await expect(probe.invoke()).resolves.toMatchObject({ toolCalls: [],
        toolCallRecovery: { source: "native", reason: "invalid_arguments", toolName: "write_once" },
      });
      expect(probe.chunks.flatMap(chunk => chunk.toolCalls ?? [])).toEqual([]);
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });

    test.each([false, true])("preserves the unknown reservation when final usage was lost (interim=%s)", async interim => {
      const probe = setup([
        ...(interim ? [frame({}, undefined, { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 })] : []),
        frame({ content: "Finished." }, "stop"),
      ]);
      const admission = createAllowAdmissionHarness();
      const session = { conversationId: "terminal-reset", services: {
        executionAdmission: admission.admission, admissionRequired: true,
        agentControl: { shutdownAgentTree: vi.fn() },
      }, abortTerminal: vi.fn() } as unknown as Session;
      const result = await runAdmittedModelCall({ session, provider: probe.provider, messages,
        options: { maxOutputTokens: 200 }, stepId: "terminal-reset:1", model, providerName: name,
        invoke: options => probe.provider.chatStream(messages, chunk => probe.chunks.push(chunk), options),
      });
      expect(result.content).toBe("Finished.");
      expect(result.usage).toMatchObject({ availability: "unknown", provenance: "synthetic" });
      expect(admission.holdUnknown).toHaveBeenCalledExactlyOnceWith("reservation-1", "missing_provider_usage");
      expect(admission.reconcile).not.toHaveBeenCalled();
      expect(admission.voidReservation).not.toHaveBeenCalled();
      expect(admission.acknowledgeCompletion).toHaveBeenCalledOnce();
      expect(probe.fetchImpl).toHaveBeenCalledOnce();
    });
  });
}
