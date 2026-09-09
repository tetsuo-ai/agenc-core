import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, getEventListeners, once } from "node:events";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { ensureDaemonForLaunch, spawnDaemon, spawnNodeScript, waitForDaemonReady } from "../src/launcher.mjs";

function fakeChild(closeOn = "SIGTERM") {
  const child = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === closeOn) {
      child.emit("exit", null, signal);
      child.emit("close", null, signal);
    }
    return true;
  };
  return child;
}

function launchWithChild(child, options = {}) {
  return ensureDaemonForLaunch({
    argv: [], env: { AGENC_DAEMON_READY_TIMEOUT_MS: "10" }, runtimeBin: "/unused/runtime.mjs",
    waitForReadyFn: async () => false,
    spawnDaemonFn: (runtimeBin, spawnOptions) => spawnDaemon(runtimeBin, {
      ...spawnOptions, spawnFn: () => child,
    }),
    ...options,
  });
}

async function boundedOutcome(operation) {
  let timer;
  try {
    return await Promise.race([
      operation.then((value) => ({ value }), (error) => ({ error })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ pending: true }), 300); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("launcher readiness budget bounds a never-settling daemon starter", async () => {
  let started = false;
  const outcome = await boundedOutcome(ensureDaemonForLaunch({
    argv: [], env: { AGENC_DAEMON_READY_TIMEOUT_MS: "10" }, runtimeBin: "/unused/runtime.mjs",
    waitForReadyFn: async () => false,
    spawnDaemonFn: () => {
      started = true;
      return new Promise(() => {});
    },
  }));
  assert.equal(started, true);
  assert.equal(outcome.pending, undefined, "startup stayed pending beyond its readiness budget");
  assert.match(outcome.error?.message ?? "", /timeout|timed out|within.*ms/iu);
});

test("disabled autostart still returns without starting a child", async () => {
  const result = await ensureDaemonForLaunch({
    argv: [], env: { AGENC_DAEMON_AUTOSTART: "0" },
    spawnDaemonFn: () => { throw new Error("disabled startup spawned a child"); },
  });
  assert.deepEqual(result, { status: "disabled" });
});

test("timeout reaps a managed child and removes its listeners", async () => {
  const child = fakeChild();
  await assert.rejects(launchWithChild(child), /within 10ms/);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.deepEqual(child.eventNames(), []);
});

test("termination escalates and waits for the child's close event", async () => {
  const child = fakeChild("SIGKILL");
  await assert.rejects(launchWithChild(child), /within 10ms/);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(child.eventNames(), []);
});

test("an unresponsive child reports failed cleanup after a bounded wait", async () => {
  const child = fakeChild(null);
  await assert.rejects(launchWithChild(child), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.match(error.message, /did not close/);
    assert.match(error.cause.message, /within 10ms/);
    return true;
  });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.deepEqual(child.eventNames(), []);
});

test("launcher kills and reaps its real starter before rejecting", async () => {
  let child;
  let closed = false;
  try {
    await assert.rejects(ensureDaemonForLaunch({
      argv: [], runtimeBin: "/unused/runtime.mjs",
      env: { AGENC_DAEMON_READY_TIMEOUT_MS: "150" },
      waitForReadyFn: async () => false,
      spawnDaemonFn: (runtimeBin, options) => spawnDaemon(runtimeBin, {
        ...options,
        spawnFn: () => {
          child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          child.once("close", () => { closed = true; });
          return child;
        },
      }),
    }), /within 150ms/);
    assert.equal(closed, true);
    assert.equal(typeof child.pid, "number");
    assert.throws(() => process.kill(child.pid, 0));
  } finally {
    if (child && !closed) {
      const reaped = once(child, "close");
      child.kill("SIGKILL");
      await reaped;
    }
  }
});

test("a slow initial probe and starter share the final readiness budget", async (context) => {
  let now = 0;
  context.mock.method(performance, "now", () => now);
  const env = { AGENC_DAEMON_READY_TIMEOUT_MS: "100" };
  let nestedBudget;
  const timeouts = [];
  const result = await ensureDaemonForLaunch({
    argv: [], env, runtimeBin: "/unused/runtime.mjs",
    waitForReadyFn: async (options) => {
      timeouts.push(options.timeoutMs);
      if (options.probeOnly) { now = 30; return false; }
      return true;
    },
    spawnDaemonFn: async (_runtimeBin, options) => {
      nestedBudget = options.env.AGENC_DAEMON_READY_TIMEOUT_MS;
      now = 80;
    },
  });
  assert.equal(result.status, "started");
  assert.equal(nestedBudget, "70");
  assert.deepEqual(timeouts, [100, 20]);
  assert.equal(env.AGENC_DAEMON_READY_TIMEOUT_MS, "100");
});

test("monotonic expiry prevents a spawn even before timers have fired", async (context) => {
  let now = 0;
  context.mock.method(performance, "now", () => now);
  await assert.rejects(ensureDaemonForLaunch({
    argv: [], env: { AGENC_DAEMON_READY_TIMEOUT_MS: "10" }, runtimeBin: "/unused/runtime.mjs",
    waitForReadyFn: async () => { now = 11; return false; },
    spawnDaemonFn: () => { assert.fail("spawned after the initial probe expired"); },
  }), /within 10ms/);
});

test("caller cancellation during spawn preserves its reason after cleanup", async () => {
  const controller = new AbortController();
  const reason = { cancel: "startup" };
  const child = fakeChild();
  await assert.rejects(launchWithChild(child, {
    signal: controller.signal,
    spawnDaemonFn: (runtimeBin, options) => spawnDaemon(runtimeBin, {
      ...options, spawnFn: () => { controller.abort(reason); return child; },
    }),
  }), (error) => error === reason);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.deepEqual(child.eventNames(), []);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("already cancelled startup never probes or spawns", async () => {
  const reason = new Error("cancelled before startup");
  await assert.rejects(ensureDaemonForLaunch({
    argv: [], runtimeBin: "/unused/runtime.mjs", signal: AbortSignal.abort(reason),
    waitForReadyFn: () => assert.fail("cancelled startup probed"),
    spawnDaemonFn: () => assert.fail("cancelled startup spawned"),
  }), (error) => error === reason);
});

test("a wedged initial read is bounded without spawning", async () => {
  await assert.rejects(ensureDaemonForLaunch({
    argv: [], env: { AGENC_DAEMON_READY_TIMEOUT_MS: "10" }, runtimeBin: "/unused/runtime.mjs",
    readText: () => new Promise(() => {}),
    spawnDaemonFn: () => assert.fail("spawned after a wedged read"),
  }), /within 10ms/);
});

test("standalone polling bounds its initial and final file probes", async () => {
  assert.equal(await waitForDaemonReady({
    timeoutMs: 10, readText: () => new Promise(() => {}),
  }), false);
});

test("normal CLI commands still run without a startup deadline", async () => {
  const child = fakeChild();
  const operation = spawnNodeScript("/unused/runtime.mjs", ["agent"], { spawnFn: () => child });
  child.emit("exit", 0, null);
  assert.equal(await operation, 0);
  assert.deepEqual(child.signals, []);
});
