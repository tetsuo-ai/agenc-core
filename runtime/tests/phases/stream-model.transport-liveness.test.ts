import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { DeepSeekProvider } from "../../src/llm/providers/deepseek/index.js";
import { GrokProvider } from "../../src/llm/providers/grok/adapter.js";
import { streamModel } from "../../src/phases/stream-model.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { SessionProviderService } from "../../src/session/provider-service.js";
import { isRetryableStreamError, isStreamProgressStop } from "../../src/session/run-turn-stream-retry.js";
import { mkCtx, mkSession } from "../fixtures.js";
import { longReasoningTrace } from "../helpers/stream-progress-fixture.js";

beforeAll(async () => { await import("openai"); });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fakeProvider(mode: "keepalive" | "reasoning" | "silent" | "partial", grok: boolean, warningMs = 600_000) {
  const durationMs = 25 * 60_000;
  let wireSignal: AbortSignal | null | undefined;
  let phaseSignal: AbortSignal | undefined;
  let requestEffort: string | undefined;
  const trace = longReasoningTrace();
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
    wireSignal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (text: string) => controller.enqueue(new TextEncoder().encode(text));
        const event = (data: object) => send(`data: ${JSON.stringify(data)}\n\n`);
        // Begin a legitimate reasoning phase, then let it go quiet. This
        // exercises the independent reasoning-progress guard as well.
        if (mode === "keepalive") event(grok
          ? { type: "response.reasoning_summary_text.delta", delta: "Consider the first premise.", summary_index: 0, item_id: "r1" }
          : { choices: [{ index: 0, delta: { reasoning_content: "Consider the first premise." } }] });
        let index = 0;
        const beat = mode === "silent" ? undefined : setInterval(() => {
          if (mode === "keepalive") send(": keepalive\n\n");
          else if (mode === "partial") send(":"); // No complete SSE frame.
          else event(grok
            ? { type: "response.reasoning_summary_text.delta", delta: trace[index++], summary_index: 0, item_id: "r1" }
            : { choices: [{ index: 0, delta: { reasoning_content: trace[index++] } }] });
        }, 60_000);
        const done = setTimeout(() => {
          cleanup();
          if (mode === "partial") send("\n\n");
          if (grok) {
            event({ type: "response.output_text.delta", delta: "Solved." });
            event({ type: "response.completed", response: {
              id: "resp_fake", status: "completed", model: "grok-4.5", output_text: "Solved.",
              output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Solved." }] }],
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            } });
          } else {
            event({ choices: [{ index: 0, delta: { content: "Solved." }, finish_reason: "stop" }] });
            send("data: [DONE]\n\n");
          }
          controller.close();
        }, durationMs);
        const cleanup = () => {
          clearInterval(beat); clearTimeout(done);
          wireSignal?.removeEventListener("abort", abort);
        };
        const abort = () => { cleanup(); controller.error(wireSignal?.reason); };
        wireSignal?.addEventListener("abort", abort, { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  const provider = grok
    ? new GrokProvider({ apiKey: "local-fake", model: "grok-4.5", fetchImpl })
    : new DeepSeekProvider({ apiKey: "local-fake", model: "deepseek-flash", fetchImpl });
  const chatStream = provider.chatStream.bind(provider);
  vi.spyOn(provider, "chatStream").mockImplementation((input, emit, options) => {
    phaseSignal = options?.signal;
    requestEffort = options?.reasoningEffort;
    return chatStream(input, emit, options);
  });
  const { session, events } = mkSession({ provider, services: {
    providerService: new SessionProviderService({ initialProvider: provider }),
  } });
  vi.spyOn(session.services.configStore!, "current").mockReturnValue({
    ...session.services.configStore!.current(),
    reasoning_effort: "high",
    stream_watchdog_timeout_ms: 1_200_000, stream_quiet_warning_ms: warningMs,
  });
  // The turn's admitted effort differs from settings; the warning must name
  // this request, not a newer UI/config selection.
  const ctx = mkCtx({ reasoningEffort: "low" });
  const state = buildInitialTurnState(ctx, { role: "user", content: "Reason carefully." });
  const pending = streamModel(state, ctx, session, {
    input: state.messages, tools: [], parallelToolCalls: false,
    baseInstructions: "", maxOutputTokens: 8192,
  }).then(() => undefined, error => error);
  const warnings = () => events.filter(e => e.msg.type === "warning" && e.msg.payload.cause === "stream_idle_warning");
  return { pending, state, events, fetchImpl, warnings, signal: () => phaseSignal, effort: () => requestEffort };
}

describe.each([false, true])("raw provider liveness (Grok SDK=%s)", grok => {
  test("25 minutes of keepalives after initial reasoning warns once and completes without retry", async () => {
    vi.useFakeTimers();
    const run = fakeProvider("keepalive", grok);
    await vi.advanceTimersByTimeAsync(600_001);
    expect(run.warnings()).toHaveLength(1);
    expect(run.effort()).toBe("low");
    expect(run.warnings()[0]!.msg.payload.details).toEqual({ reasoningEffort: "low" });
    expect(run.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(900_000);
    expect(await run.pending).toBeUndefined();
    expect(run.fetchImpl).toHaveBeenCalledOnce();
    expect(run.warnings()).toHaveLength(1);
    expect(run.state.assistantMessages.at(-1)?.text).toBe("Solved.");
  });

  test("no bytes produces a retryable stream_idle at the configured byte deadline", async () => {
    vi.useFakeTimers();
    const run = fakeProvider("silent", grok);
    await vi.advanceTimersByTimeAsync(1_199_999);
    expect(run.signal()?.aborted).toBe(false);
    expect(run.warnings()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2);
    const error = await run.pending;
    expect(error.message).toMatch(/^stream_idle: no bytes for 1200000ms/);
    expect(isRetryableStreamError(error)).toBe(true);
    expect(isStreamProgressStop(error)).toBe(false);
    expect(run.signal()?.aborted).toBe(true);
  });

  test("25 minutes of novel reasoning frames does not warn or abort", async () => {
    vi.useFakeTimers();
    const run = fakeProvider("reasoning", grok);
    await vi.advanceTimersByTimeAsync(1_500_001);
    expect(await run.pending).toBeUndefined();
    expect(run.warnings()).toHaveLength(0);
    expect(run.signal()?.aborted).toBe(false);
  });

  test("partial frame bytes protect the socket and the soft threshold is configurable", async () => {
    vi.useFakeTimers();
    const run = fakeProvider("partial", grok, 120_000);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(run.warnings()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2);
    expect(run.warnings()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_380_000);
    expect(await run.pending).toBeUndefined();
    expect(run.signal()?.aborted).toBe(false);
  });

  test("zero disables the soft warning without disabling byte liveness", async () => {
    vi.useFakeTimers();
    const run = fakeProvider("silent", grok, 0);
    await vi.advanceTimersByTimeAsync(1_200_001);
    expect((await run.pending).message).toMatch(/^stream_idle:/);
    expect(run.warnings()).toHaveLength(0);
  });
});
