import { afterEach, describe, expect, test, vi } from "vitest";
import { runTurn } from "../../src/session/run-turn.js";
import { StreamProgressError, STREAM_STALL_RETRY_BUDGET_MS } from "../../src/llm/stream-progress.js";
import { LLMServerError } from "../../src/llm/errors.js";
import { childDispatchCertainty, childTerminalOutcome } from "../../src/agents/child-terminal.js";
import { mkCtx, mkSession } from "../fixtures.js";
import { goodSample, recordingAdmission, repeatingSample, scriptedProvider, type Sample } from "../helpers/stream-progress-fixture.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function turn(samples: Sample[], admitted = false, child = false) {
  const scripted = scriptedProvider(samples);
  // Exercise the requested user-visible Grok wording through the shared path.
  Object.defineProperty(scripted.provider, "name", { value: "grok" });
  const admission = recordingAdmission();
  const { session, events } = mkSession({ provider: scripted.provider, services: admitted ? {
    admissionRequired: true, executionAdmission: admission.client,
  } : undefined });
  const reset = vi.spyOn(session, "resetProviderIncrementalState");
  const ctx = mkCtx(child ? { depth: 1, sessionSource: "cli_subagent" } : {});
  const pending = (async () => {
    const phases = [];
    const gen = runTurn(session, ctx, "Solve the problem");
    for (;;) {
      const next = await gen.next();
      if (next.done) return { terminal: next.value, phases };
      phases.push(next.value);
    }
  })();
  return { ...scripted, pending, events, reset, admission };
}

describe("runTurn bounded stream recovery", () => {
  test("a loop then a good retry succeeds, settling each physical call separately", async () => {
    vi.useFakeTimers();
    const run = turn([repeatingSample(), goodSample], true);
    await vi.waitFor(() => expect(run.calls()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await run.pending;
    expect(run.calls()).toBe(2);
    expect(result.phases.at(-1)).toMatchObject({ stopReason: "completed", content: "The answer is ready." });
    expect(run.reset).toHaveBeenCalledOnce();
    const { spies, order } = run.admission;
    expect(spies.acquire).toHaveBeenCalledTimes(2);
    expect(spies.holdUnknown).toHaveBeenCalledOnce();
    expect(spies.reconcile).toHaveBeenCalledOnce();
    expect(spies.acknowledgeCompletion).toHaveBeenCalledTimes(2);
    expect(spies.void).not.toHaveBeenCalled();
    const ids = spies.acquire.mock.calls.map(([input]) => input.stepId);
    expect(new Set(ids).size).toBe(2);
    expect(order.indexOf(`complete:${ids[0]}`)).toBeLessThan(order.indexOf(`acquire:${ids[1]}`));
    expect(run.events.filter(e => e.msg.type === "turn_failed")).toHaveLength(0);
  });

  test.each([false, true])("two loops end visibly without outage retries (child=%s)", async child => {
    vi.useFakeTimers();
    const run = turn([repeatingSample()], false, child);
    await vi.waitFor(() => expect(run.calls()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(2 * STREAM_STALL_RETRY_BUDGET_MS);
    const result = await run.pending;
    expect(run.calls()).toBe(2);
    expect(result.terminal).toMatchObject({ reason: "model_error", error: { reason: "stream_loop" } });
    const failed = run.events.filter(e => e.msg.type === "turn_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.msg.payload).toMatchObject({
      code: "stream_loop", message: "Grok got stuck repeating itself. Try again or switch model.",
    });
    expect(run.events.some(e => e.msg.type === "turn_aborted")).toBe(false);
    const error = result.terminal.error;
    expect(childTerminalOutcome({ provider: "grok", model: "test-model", error,
      dispatch: childDispatchCertainty(error) })).toMatchObject({
      reason: "model_loop", retryable: false, dispatch: "sent",
    });
  });

  test("stream_idle retries once and reconnect telemetry has a finite budget", async () => {
    vi.useFakeTimers();
    const silent: Sample = (_emit, options) => new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
    const run = turn([silent]);
    await vi.waitFor(() => expect(run.calls()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(1_300_000);
    const result = await run.pending;
    expect(run.calls()).toBe(2);
    expect(result.phases.at(-1)).toMatchObject({ stopReason: "error" });
    const telemetry = run.events.filter(e => e.msg.type === "warning" &&
      String(e.msg.payload.message).includes("remainingBudgetMs="));
    expect(telemetry.length).toBeGreaterThan(0);
    expect(JSON.stringify(telemetry)).not.toContain("unbounded");
  });

  test("two slow reasoning stalls end as no_progress, never a child timeout", async () => {
    vi.useFakeTimers();
    const run = turn([repeatingSample({ delayMs: 10_000 })], false, true);
    await vi.waitFor(() => expect(run.calls()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(600_000);
    const result = await run.pending;
    expect(run.calls()).toBe(2);
    expect(result.terminal.error).toMatchObject({ reason: "stream_no_progress" });
    expect(childTerminalOutcome({ provider: "grok", model: "test-model", error: result.terminal.error,
      dispatch: "sent" })).toMatchObject({ reason: "no_progress", retryable: false });
  });

  test("a stalled retry cannot enter the provider outage ladder after a 503", async () => {
    vi.useFakeTimers();
    const run = turn([repeatingSample(), async () => { throw new LLMServerError("grok", 503, "overloaded"); }]);
    await vi.waitFor(() => expect(run.calls()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(2 * STREAM_STALL_RETRY_BUDGET_MS);
    expect((await run.pending).phases.at(-1)).toMatchObject({ stopReason: "error" });
    expect(run.calls()).toBe(2);
  });

  test("the recovery request has a hard finite budget even if it emits new data", async () => {
    vi.useFakeTimers();
    const stillRunning: Sample = (emit, options) => new Promise((_resolve, reject) => {
      let i = 0;
      const timer = setInterval(() => emit({ content: `Still working on section ${i++}. `, done: false }), 1_000);
      options.signal!.addEventListener("abort", () => {
        clearInterval(timer);
        // Some adapters map abort into their own timeout error. The shared
        // path must preserve the runtime's typed progress-stop reason.
        reject(new Error("provider transport aborted"));
      }, { once: true });
    });
    const run = turn([repeatingSample(), stillRunning]);
    await vi.waitFor(() => expect(run.calls()).toBeGreaterThan(0));
    await vi.advanceTimersByTimeAsync(STREAM_STALL_RETRY_BUDGET_MS + 10_000);
    expect(run.calls()).toBe(2);
    const result = await run.pending;
    expect(result.terminal.error).toBeInstanceOf(StreamProgressError);
    expect(result.terminal.error).toMatchObject({ reason: "stream_retry_budget" });
    expect(childTerminalOutcome({ provider: "grok", model: "test-model", error: result.terminal.error,
      dispatch: "sent" }).reason).toBe("no_progress");
  });
});
