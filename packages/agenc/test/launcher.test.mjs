import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureDaemonForLaunch,
  readDaemonPid,
  resolveAgenCHome,
  resolveDaemonCookiePath,
  resolveDaemonPidPath,
  resolveReadyTimeoutMs,
  shouldAutostartDaemon,
  waitForDaemonReady,
} from "../src/launcher.mjs";

async function withTempHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), "agenc-launcher-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("daemon autostart env opt-out disables launcher startup", () => {
  assert.equal(shouldAutostartDaemon({}), true);
  assert.equal(shouldAutostartDaemon({ AGENC_DAEMON_AUTOSTART: "0" }), false);
  assert.equal(shouldAutostartDaemon({ AGENC_DAEMON_AUTOSTART: "false" }), false);
  assert.equal(shouldAutostartDaemon({ AGENC_DAEMON_AUTOSTART: "off" }), false);
  assert.equal(shouldAutostartDaemon({ AGENC_DAEMON_AUTOSTART: "1" }), true);
});

test("ready timeout env must be a positive integer", () => {
  assert.equal(resolveReadyTimeoutMs({}), 2000);
  assert.equal(resolveReadyTimeoutMs({ AGENC_DAEMON_READY_TIMEOUT_MS: "50" }), 50);
  assert.throws(
    () => resolveReadyTimeoutMs({ AGENC_DAEMON_READY_TIMEOUT_MS: "0" }),
    /AGENC_DAEMON_READY_TIMEOUT_MS must be a positive integer/,
  );
  assert.throws(
    () => resolveReadyTimeoutMs({ AGENC_DAEMON_READY_TIMEOUT_MS: "1.5" }),
    /AGENC_DAEMON_READY_TIMEOUT_MS must be a positive integer/,
  );
});

test("daemon home and pid paths prefer AGENC_HOME over HOME", async () => {
  await withTempHome(async (home) => {
    const env = { AGENC_HOME: join(home, "custom") };
    assert.equal(resolveAgenCHome(env, home), env.AGENC_HOME);
    assert.equal(resolveDaemonPidPath(env, home), join(env.AGENC_HOME, "daemon.pid"));
    assert.equal(resolveDaemonCookiePath(env, home), join(env.AGENC_HOME, "daemon.cookie"));
  });
});

test("readDaemonPid ignores missing or malformed pid files", async () => {
  await withTempHome(async (home) => {
    const pidPath = join(home, "daemon.pid");
    assert.equal(await readDaemonPid(pidPath), null);
    await writeFile(pidPath, "not-a-pid\n");
    assert.equal(await readDaemonPid(pidPath), null);
    await writeFile(pidPath, "42\n");
    assert.equal(await readDaemonPid(pidPath), 42);
  });
});

test("waitForDaemonReady requires a running pid and non-empty cookie", async () => {
  await withTempHome(async (home) => {
    const env = { AGENC_HOME: home };
    await writeFile(resolveDaemonPidPath(env, home), "4201\n");
    await writeFile(resolveDaemonCookiePath(env, home), "secret\n");
    const ready = await waitForDaemonReady({
      env,
      userHome: home,
      timeoutMs: 1,
      pollMs: 1,
      signalPid: (pid, signal) => {
        assert.equal(pid, 4201);
        assert.equal(signal, 0);
      },
      sleep: async () => {},
    });
    assert.equal(ready, true);
  });
});

test("ensureDaemonForLaunch skips daemon management commands", async () => {
  let started = false;
  const result = await ensureDaemonForLaunch({
    argv: ["daemon", "status"],
    runtimeBin: "/tmp/runtime-bin",
    spawnDaemonFn: async () => {
      started = true;
    },
  });
  assert.equal(result.status, "skipped-daemon-command");
  assert.equal(started, false);
});

test("ensureDaemonForLaunch respects AGENC_DAEMON_AUTOSTART=0", async () => {
  let started = false;
  const result = await ensureDaemonForLaunch({
    env: { AGENC_DAEMON_AUTOSTART: "0" },
    runtimeBin: "/tmp/runtime-bin",
    spawnDaemonFn: async () => {
      started = true;
    },
  });
  assert.equal(result.status, "disabled");
  assert.equal(started, false);
});

test("ensureDaemonForLaunch starts daemon and waits for health check", async () => {
  await withTempHome(async (home) => {
    const env = { AGENC_HOME: home, AGENC_DAEMON_READY_TIMEOUT_MS: "25" };
    const calls = [];
    const result = await ensureDaemonForLaunch({
      argv: ["agent", "list"],
      env,
      userHome: home,
      cwd: "/tmp/project",
      runtimeBin: "/tmp/runtime-bin",
      waitForReadyFn: async (options) => {
        calls.push(options.timeoutMs);
        return calls.length > 1;
      },
      spawnDaemonFn: async (runtimeBin, options) => {
        assert.equal(runtimeBin, "/tmp/runtime-bin");
        assert.equal(options.cwd, "/tmp/project");
        assert.equal(options.env, env);
      },
    });
    assert.equal(result.status, "started");
    assert.deepEqual(calls, [1, undefined]);
  });
});
