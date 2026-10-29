import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as cli from "../../src/bin/daemon-one-shot-cli.js";
import type { AgenCDaemonCliDeps } from "../../src/bin/daemon-one-shot-cli.js";

afterEach(() => vi.useRealTimers());

type Probe = (env: NodeJS.ProcessEnv) => Promise<boolean>;

function waitingFallback() {
  // Models the fallback client retrying a missing daemon endpoint until aborted.
  return vi.fn((options: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    setTimeout(() => reject(new Error("watchdog")), 6_000);
  }));
}

function cleanup(fallback: ReturnType<typeof vi.fn>, daemonMayHostAgent: Probe) {
  let settled = false;
  const pending = cli.stopDaemonAgentBestEffort({
    daemonClient: { request: vi.fn().mockRejectedValue(new Error("Daemon connection is disconnected")) } as never,
    deps: { stopPromptAgent: fallback } as unknown as AgenCDaemonCliDeps,
    env: {}, agentId: "owned", reason: "one_shot_failed", daemonMayHostAgent,
  } as Parameters<typeof cli.stopDaemonAgentBestEffort>[0]).then((value) => { settled = true; return value; });
  return { pending, settled: () => settled };
}

it("returns as soon as the daemon exits while the fallback waits for its endpoint", async () => {
  vi.useFakeTimers();
  let alive = true;
  const fallback = waitingFallback();
  const run = cleanup(fallback, async () => alive);
  await vi.advanceTimersByTimeAsync(100);
  expect(run.settled()).toBe(false);
  expect(fallback).toHaveBeenCalledOnce();
  alive = false; // an external `daemon stop` finished while a retry backoff was pending
  await vi.advanceTimersByTimeAsync(100);
  expect(run.settled()).toBe(true);
  expect(await run.pending).toBe(true);
  expect(fallback.mock.calls[0]![0].signal?.aborted).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(1); // only the test watchdog of the aborted fallback remains
});

it("does not start the fallback when no daemon remains", async () => {
  vi.useFakeTimers();
  const fallback = waitingFallback();
  const run = cleanup(fallback, async () => false);
  await vi.advanceTimersByTimeAsync(0);
  expect(run.settled()).toBe(true);
  expect(await run.pending).toBe(true);
  expect(fallback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the bounded fallback while the daemon process stays alive", async () => {
  vi.useFakeTimers();
  const fallback = waitingFallback();
  const run = cleanup(fallback, async () => true);
  await vi.advanceTimersByTimeAsync(4_900);
  expect(run.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(200);
  expect(await run.pending).toBe(false);
  expect(fallback.mock.calls[0]![0].signal?.aborted).toBe(true);
});

it("treats a failing liveness probe as a live daemon", async () => {
  vi.useFakeTimers();
  const fallback = waitingFallback();
  const run = cleanup(fallback, async () => { throw new Error("unreadable pid file"); });
  await vi.advanceTimersByTimeAsync(4_900);
  expect(run.settled()).toBe(false);
  await vi.advanceTimersByTimeAsync(200);
  expect(await run.pending).toBe(false);
});

it("still confirms a stop delivered by the fallback and leaves no poll timer", async () => {
  vi.useFakeTimers();
  const fallback = vi.fn().mockResolvedValue(undefined);
  const run = cleanup(fallback, async () => true);
  expect(await run.pending).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("tracks the daemon pid recorded when cleanup starts", async () => {
  const home = mkdtempSync(join(tmpdir(), "agenc-liveness-"));
  try {
    const env = { AGENC_HOME: home };
    // Nothing recorded: keep the previous bounded fallback.
    expect(cli.recordedDaemonLivenessProbe(env)).toBeNull();
    writeFileSync(join(home, "daemon.pid"), `${process.pid}\n`);
    const live = cli.recordedDaemonLivenessProbe(env);
    expect(await live!()).toBe(true);
    const exited = spawnSync(process.execPath, ["-e", ""]);
    expect(exited.status).toBe(0);
    writeFileSync(join(home, "daemon.pid"), `${exited.pid}\n`);
    const gone = cli.recordedDaemonLivenessProbe(env);
    // `daemon stop` removes the pid file after proving exit; the captured pid still decides.
    rmSync(join(home, "daemon.pid"));
    expect(await gone!()).toBe(false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
