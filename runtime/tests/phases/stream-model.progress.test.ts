import { afterEach, describe, expect, test, vi } from "vitest";
import { streamModel, StreamModelError } from "../../src/phases/stream-model.js";
import { REASONING_NO_PROGRESS_MS, StreamProgressError, StreamProgressTracker } from "../../src/llm/stream-progress.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { mkCtx, mkSession } from "../fixtures.js";
import { answer, longReasoningTrace, recordingAdmission, repeatingSample, scriptedProvider, type Sample } from "../helpers/stream-progress-fixture.js";

afterEach(() => vi.useRealTimers());

function sampleTurn(sample: Sample, admitted = false, ctx = mkCtx()) {
  const { provider } = scriptedProvider([sample]);
  const admission = recordingAdmission();
  const { session, events } = mkSession({ provider, services: admitted ? {
    admissionRequired: true, executionAdmission: admission.client,
  } : undefined });
  const state = buildInitialTurnState(ctx, { role: "user", content: "Solve the problem" });
  const pending = streamModel(state, ctx, session, {
    input: state.messages, tools: [], parallelToolCalls: false, baseInstructions: "",
    maxOutputTokens: 8192,
  }).then(() => undefined, error => error);
  return { pending, state, events, admission };
}

describe("shared stream progress guard", () => {
  test("metadata and repeated tool snapshots are not progress, new arguments are", () => {
    const tracker = new StreamProgressTracker();
    expect(tracker.observe({ content: "", done: false, thinkingBlockStart: { index: 0, redacted: false } }, false).progress).toBe(false);
    const toolCalls = [{ id: "call-1", name: "read_file", arguments: '{"path":"a"}' }];
    expect(tracker.observe({ content: "", done: false, toolCalls }, false).progress).toBe(true);
    expect(tracker.observe({ content: "", done: false, toolCalls }, false).progress).toBe(false);
    expect(tracker.observe({ content: "", done: false, toolInputDelta: { callId: "call-2", index: 1, partialJson: '"path":' } }, false).progress).toBe(true);
    expect(tracker.observe({ content: "", done: false, toolInputDelta: { callId: "call-2", index: 1, partialJson: '   ' } }, false).progress).toBe(false);
  });

  test.each(["visible", "tool"])("new %s output breaks a reasoning stall", async channel => {
    vi.useFakeTimers();
    const { pending } = sampleTurn(async (emit, options) => {
      // Empty reasoning starts the progress timer; real work must disarm it.
      emit({ content: "", done: false, thinkingDelta: { index: 0, delta: " " } });
      await new Promise(resolve => setTimeout(resolve, REASONING_NO_PROGRESS_MS - 1));
      emit(channel === "visible" ? { content: "Working result.", done: false } : {
        content: "", done: false, toolInputDelta: { callId: "read", index: 0, partialJson: '{"path":' },
      });
      await new Promise(resolve => setTimeout(resolve, REASONING_NO_PROGRESS_MS));
      expect(options.signal?.aborted).toBe(false);
      return answer;
    });
    await vi.advanceTimersByTimeAsync(REASONING_NO_PROGRESS_MS * 2);
    expect(await pending).toBeUndefined();
  });

  test.each(["visible", "plan"])("replayed %s snapshots do not keep reasoning alive", async channel => {
    vi.useFakeTimers();
    const content = channel === "plan" ? "<proposed_plan>\nExisting plan.\n</proposed_plan>" : "Existing answer.";
    const { pending } = sampleTurn((emit, options) => new Promise((_resolve, reject) => {
      emit({ content, done: false, resetBuffer: true });
      emit({ content: "", done: false, thinkingDelta: { index: 0, delta: " " } });
      const timer = setInterval(() => emit({ content, done: false, resetBuffer: true }), 1000);
      options.signal!.addEventListener("abort", () => {
        clearInterval(timer); reject(options.signal!.reason);
      }, { once: true });
    }), false, mkCtx({ permissionMode: channel === "plan" ? "plan" : "default" }));
    await vi.advanceTimersByTimeAsync(REASONING_NO_PROGRESS_MS + 1);
    expect((await pending).cause).toMatchObject({ reason: "stream_no_progress" });
  });

  test("slow proposed-plan output clears reasoning stalls and keeps the watchdog alive", async () => {
    vi.useFakeTimers();
    const { pending } = sampleTurn(async (emit, options) => {
      emit({ content: "", done: false, thinkingDelta: { index: 0, delta: "Let me prepare the plan." } });
      emit({ content: "<proposed_plan>\n", done: false });
      for (let step = 0; step < 12; step++) {
        await new Promise(resolve => setTimeout(resolve, 60_000));
        expect(options.signal?.aborted).toBe(false);
        emit({ content: `Step ${step}: validate the next partition.\n`, done: false });
      }
      emit({ content: "</proposed_plan>", done: true });
      return { ...answer, content: "<proposed_plan>\nValidate the partitions.\n</proposed_plan>" };
    }, false, mkCtx({ permissionMode: "plan" }));
    await vi.advanceTimersByTimeAsync(12 * 60_000);
    expect(await pending).toBeUndefined();
  });

  test("long engineering-trace replays stop being novel and trigger loop detection", () => {
    const tracker = new StreamProgressTracker();
    const trace = longReasoningTrace().slice(0, 20);
    let detectedLoop = false;
    let replayProgress = false;
    for (let replay = 0; replay < 10; replay++) {
      for (const paragraph of trace) {
        for (let i = 0; i < paragraph.length; i += 13) {
          const result = tracker.observe({ content: "", done: false,
            reasoningSummaryDelta: { delta: paragraph.slice(i, i + 13), summaryIndex: replay % 2 } }, false);
          detectedLoop ||= result.loop;
          if (replay >= 2) replayProgress ||= result.progress;
        }
      }
    }
    expect(replayProgress).toBe(false);
    expect(detectedLoop).toBe(true);
  });

  test("slow engineering-trace replays expire the no-progress deadline", async () => {
    vi.useFakeTimers();
    const trace = longReasoningTrace().slice(0, 20);
    const delayMs = 90_000;
    const { pending } = sampleTurn((emit, options) => new Promise((_resolve, reject) => {
      let index = 0;
      const timer = setInterval(() => {
        emit({ content: "", done: false,
          thinkingDelta: { index: 0, delta: trace[index++ % trace.length]! } });
      }, delayMs);
      options.signal!.addEventListener("abort", () => {
        clearInterval(timer); reject(options.signal!.reason);
      }, { once: true });
    }));
    await vi.advanceTimersByTimeAsync(trace.length * delayMs * 2 + REASONING_NO_PROGRESS_MS);
    expect((await pending).cause).toMatchObject({ reason: "stream_no_progress" });
  });

  test.each([false, true])("alternating summaries stop across chunk boundaries (fragmented=%s)", async fragment => {
    vi.useFakeTimers();
    const { pending, events } = sampleTurn(repeatingSample({ fragment }));
    await vi.advanceTimersByTimeAsync(150_000);
    const error = await pending;
    expect(error).toBeInstanceOf(StreamModelError);
    expect(error.cause).toMatchObject({ reason: "stream_loop" });
    expect(events.filter(e => e.msg.type === "stream_error")).toHaveLength(1);
    expect(events.some(e => e.msg.type === "assistant_thinking_block_stop")).toBe(true);
  });

  test("low-rate repetition stops on elapsed no-progress, not byte activity", async () => {
    vi.useFakeTimers();
    const { pending } = sampleTurn(repeatingSample({ delayMs: 10_000 }));
    await vi.advanceTimersByTimeAsync(REASONING_NO_PROGRESS_MS + 80_000);
    expect((await pending).cause).toMatchObject({ reason: "stream_no_progress" });
  });

  test.each(["thinking", "summary"])("long genuine %s with repeated checklists is not cut", async channel => {
    vi.useFakeTimers();
    const trace = longReasoningTrace();
    expect(trace.join("").length / 4).toBeGreaterThan(32_000);
    const { pending, state } = sampleTurn(async (emit, options) => {
      for (const paragraph of trace) {
        await new Promise(resolve => setTimeout(resolve, 20_000));
        expect(options.signal?.aborted).toBe(false);
        // Token-like boundaries, including a repeated phrase split midway.
        for (let i = 0; i < paragraph.length; i += 13) {
          const delta = paragraph.slice(i, i + 13);
          emit({ content: "", done: false, ...(channel === "thinking"
            ? { thinkingDelta: { delta, index: 0 } }
            : { reasoningSummaryDelta: { delta, summaryIndex: 0 } }) });
        }
      }
      return answer;
    });
    await vi.advanceTimersByTimeAsync(trace.length * 20_000);
    expect(await pending).toBeUndefined();
    expect(state.assistantMessages.at(-1)?.text).toBe(answer.content);
  });

  test.each([false, true])("aborted calls settle admission once (late reported usage=%s)", async lateUsage => {
    vi.useFakeTimers();
    const { pending, admission } = sampleTurn(repeatingSample({ lateUsage }), true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).cause).toBeInstanceOf(StreamProgressError);
    const { spies } = admission;
    expect(spies.acknowledgeCompletion).toHaveBeenCalledOnce();
    expect(spies.void).not.toHaveBeenCalled();
    if (lateUsage) {
      expect(spies.holdUnknown).not.toHaveBeenCalled();
      expect(spies.reconcile).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
        inputTokens: 100, outputTokens: 20, costUsd: expect.any(Number),
      }));
    } else {
      expect(spies.holdUnknown).toHaveBeenCalledWith(expect.any(String), "provider_call_failed_after_dispatch");
      expect(spies.reconcile).not.toHaveBeenCalled();
    }
  });

  test("empty heartbeat chunks do not reset the configured idle watchdog", async () => {
    vi.useFakeTimers();
    const { pending } = sampleTurn((emit, options) => new Promise((_resolve, reject) => {
      const timer = setInterval(() => emit({ content: "", done: false }), 10_000);
      options.signal!.addEventListener("abort", () => {
        clearInterval(timer); reject(options.signal!.reason);
      }, { once: true });
    }));
    await vi.advanceTimersByTimeAsync(600_001);
    expect((await pending).message).toMatch(/^stream_idle:/);
  });
});
