import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ensureDaemonForLaunch,
  main,
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

test("main continues to the requested command when daemon autostart fails", async () => {
  await withTempHome(async (home) => {
    // Fake runtime: `daemon start` always fails; any other command records
    // its argv and succeeds. Models the bootstrap deadlock where a broken
    // daemon blocked `agenc update` — the command that would fix it.
    const marker = join(home, "spawned-args.json");
    const fakeRuntime = join(home, "fake-runtime.mjs");
    await writeFile(
      fakeRuntime,
      [
        'import { writeFileSync } from "node:fs";',
        "const args = process.argv.slice(2);",
        'if (args[0] === "daemon") process.exit(1);',
        `writeFileSync(${JSON.stringify(marker)}, JSON.stringify(args));`,
        "process.exit(0);",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      AGENC_HOME: home,
      AGENC_DAEMON_READY_TIMEOUT_MS: "25",
    };
    const stderrChunks = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = (chunk, ...rest) => {
      stderrChunks.push(String(chunk));
      return originalWrite.call(process.stderr, chunk, ...rest);
    };
    let exitCode;
    try {
      exitCode = await main(["update"], {
        env,
        cwd: home,
        runtimeBin: fakeRuntime,
        userHome: home,
      });
    } finally {
      process.stderr.write = originalWrite;
    }
    // Revert guard: the pre-0.7.3 launcher returned 1 here and never spawned
    // the runtime, so the marker file did not exist.
    assert.equal(exitCode, 0);
    assert.deepEqual(
      JSON.parse(await readFile(marker, "utf8")),
      ["update"],
    );
    const stderrText = stderrChunks.join("");
    assert.match(stderrText, /daemon autostart failed/);
    assert.match(stderrText, /continuing without the daemon/);
  });
});
