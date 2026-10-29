import { afterEach, expect, it, vi } from "vitest";
import { stopDaemonAgentBestEffort, type AgenCDaemonCliDeps } from "../../src/bin/daemon-one-shot-cli.js";

afterEach(() => vi.useRealTimers());
const env = {};
function cleanup(request: ReturnType<typeof vi.fn>, fallback: ReturnType<typeof vi.fn>) {
  return stopDaemonAgentBestEffort({
    daemonClient: { request } as never,
    deps: { stopPromptAgent: fallback } as unknown as AgenCDaemonCliDeps,
    env, agentId: "owned", reason: "one_shot_failed",
  });
}
it("confirms stop on the existing connection and releases its budget timer", async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockResolvedValue({}), fallback = vi.fn();
  expect(await cleanup(request, fallback)).toBe(true);
  expect(request).toHaveBeenCalledWith("agent.stop", { agentId: "owned", reason: "one_shot_failed" },
    expect.objectContaining({ signal: expect.any(AbortSignal), reconnect: false }));
  expect(fallback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("gives fallback only the remaining shared budget and the same cancellation signal", async () => {
  vi.useFakeTimers();
  let firstSignal: AbortSignal | undefined;
  const request = vi.fn((_method, _params, options) => {
    firstSignal = options?.signal;
    return new Promise((_resolve, reject) => setTimeout(() => reject(new Error("disconnected")), 2_000));
  });
  const fallback = vi.fn().mockResolvedValue(undefined);
  const pending = cleanup(request, fallback);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(await pending).toBe(true);
  expect(fallback).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 3_000, signal: firstSignal }));
  expect(vi.getTimerCount()).toBe(0);
});
it("cancels an unacknowledged stop at five seconds without starting a new fallback", async () => {
  vi.useFakeTimers();
  const request = vi.fn((_method, _params, options) => new Promise((_resolve, reject) => {
    options?.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    // Test watchdog also lets the original implementation finish and fail.
    setTimeout(() => reject(new Error("watchdog")), 6_000);
  }));
  const fallback = vi.fn().mockResolvedValue(undefined);
  const pending = cleanup(request, fallback);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await pending).toBe(false);
  expect(fallback).not.toHaveBeenCalled();
});
it("bounds fallback failure and reports unconfirmed cleanup", async () => {
  vi.useFakeTimers();
  const request = vi.fn().mockRejectedValue(new Error("disconnected"));
  const fallback = vi.fn(options => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    setTimeout(() => reject(new Error("watchdog")), 6_000);
  }));
  const pending = cleanup(request, fallback);
  await vi.advanceTimersByTimeAsync(6_000);
  expect(await pending).toBe(false);
  expect(fallback).toHaveBeenCalledOnce();
  expect(fallback.mock.calls[0]![0].signal.aborted).toBe(true);
});
