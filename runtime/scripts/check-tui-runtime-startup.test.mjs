import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COLD_WARMUP_FIRST_PAINT_MS,
  hasSemanticPtyReadiness,
  observePtySession,
  runImportProbe,
} from "./check-tui-runtime-startup.mjs";
import {
  createTuiGateProject,
  createTuiGateState,
  startTuiGateDaemon,
  teardownTuiGateState,
  TUI_GATE_TRUST_TIMESTAMP,
  tuiGateEnvironment,
  writeTuiGateTrust,
} from "./tui-gate-state.mjs";

async function probeFixture(source) {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-tui-import-proof-"));
  const artifactPath = path.join(root, "main.mjs");
  writeFileSync(artifactPath, source, { mode: 0o600 });
  try {
    return await runImportProbe({ artifactPath, containmentRoot: root, timeoutMs: 5_000 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("import proof succeeds only after the expected export returns", async () => {
  const result = await probeFixture("export function bootTUI() {}\n");
  assert.equal(result.ok, true, result.error?.stack ?? result.output);
});

test("top-level process.exit(0) cannot falsely green the import probe", async () => {
  const result = await probeFixture(
    "process.exit(0); export function bootTUI() {}\n",
  );
  assert.equal(result.ok, false);
  assert.match(result.error.message, /without a verified completion proof/u);
});

test("candidate code cannot forge a fixed IPC proof frame", async () => {
  const result = await probeFixture([
    "process.send?.({",
    "  type: 'proof',",
    "  protocol: 'agenc-tui-import-proof-v1',",
    "  signature: Buffer.alloc(64).toString('base64'),",
    "});",
    "export function bootTUI() {}",
    "",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.match(result.error.message, /signature verification failed/u);
});

test("missing bootTUI fails even when the module imports cleanly", async () => {
  const result = await probeFixture("export const notTheTui = true;\n");
  assert.equal(result.ok, false);
  assert.match(`${result.error.message}\n${result.output}`, /bootTUI/u);
});

test("candidate global monkeypatches cannot erase export requirements", async () => {
  const result = await probeFixture([
    "Object.entries = () => [];",
    "export const notTheTui = true;",
    "",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.match(`${result.error.message}\n${result.output}`, /bootTUI/u);
});

test("candidate iterator poisoning cannot skip export requirements", async () => {
  const result = await probeFixture([
    "Array.prototype[Symbol.iterator] = function* () {};",
    "export const notTheTui = true;",
    "",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.match(`${result.error.message}\n${result.output}`, /bootTUI/u);
});

const SEMANTIC_PAINT = `\x1b[?2004h${" ".repeat(128)}AgenC interactive screen`;

test("cold warmup leaves headroom for private daemon startup", () => {
  assert.ok(COLD_WARMUP_FIRST_PAINT_MS > 5_000);
});

test("startup PTYs replace poisoned operator roots with private gate state", () => {
  const operatorRoot = path.join(tmpdir(), "operator-state");
  const privateHome = path.join(tmpdir(), "private-startup-state");
  const env = tuiGateEnvironment(privateHome, {
    AGENC_AUTH_BACKEND: "remote",
    AGENC_CONFIG_DIR: path.join(operatorRoot, "config"),
    AGENC_DAEMON_WEBSOCKET_HOST: "0.0.0.0",
    AGENC_DAEMON_WEBSOCKET_PORT: "7766",
    AGENC_HOME: path.join(operatorRoot, ".agenc"),
    AGENC_ONBOARDING: "force",
    GIT_OPTIONAL_LOCKS: "1",
    HOME: operatorRoot,
    OPENAI_API_KEY: "operator-secret",
    OPENAI_COMPATIBLE_API_KEY: "operator-compatible-secret",
    OPENAI_COMPATIBLE_BASE_URL: "https://operator.invalid/v1",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: path.join(operatorRoot, "tmp"),
    XDG_CONFIG_HOME: path.join(operatorRoot, "xdg"),
  });

  assert.equal(env.HOME, path.resolve(privateHome));
  assert.equal(env.AGENC_HOME, path.join(path.resolve(privateHome), ".agenc"));
  assert.equal(env.AGENC_CONFIG_DIR, env.AGENC_HOME);
  assert.equal(env.TMPDIR, path.join(path.resolve(privateHome), "tmp"));
  assert.equal(env.XDG_CONFIG_HOME, path.join(path.resolve(privateHome), ".config"));
  assert.equal(env.AGENC_AUTH_BACKEND, "local");
  assert.equal(env.AGENC_DAEMON_WEBSOCKET_HOST, "127.0.0.1");
  assert.equal(env.AGENC_DAEMON_WEBSOCKET_PORT, "0");
  assert.equal(env.AGENC_ONBOARDING, "0");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.OPENAI_COMPATIBLE_API_KEY, undefined);
  assert.equal(env.OPENAI_COMPATIBLE_BASE_URL, undefined);
});

test("mock provider configuration must be injected explicitly", () => {
  const privateHome = path.join(tmpdir(), "private-provider-state");
  const env = tuiGateEnvironment(
    privateHome,
    {
      OPENAI_COMPATIBLE_API_KEY: "operator-secret",
      PATH: process.env.PATH,
    },
    {
      AGENC_PROVIDER: "openai-compatible",
      OPENAI_COMPATIBLE_API_KEY: "local-test-key",
      OPENAI_COMPATIBLE_BASE_URL: "http://127.0.0.1:43210/v1",
    },
  );
  assert.equal(env.OPENAI_COMPATIBLE_API_KEY, "local-test-key");
  assert.equal(env.OPENAI_COMPATIBLE_BASE_URL, "http://127.0.0.1:43210/v1");
  assert.equal(env.AGENC_PROVIDER, "openai-compatible");
});

test("private gate state publishes one canonical root through path aliases", async () => {
  const fixtureRoot = mkdtempSync(
    path.join(tmpdir(), "agenc-tui-root-alias-"),
  );
  const realParent = path.join(fixtureRoot, "canonical-parent");
  const aliasParent = path.join(fixtureRoot, "alias-parent");
  mkdirSync(realParent, { mode: 0o700 });
  symlinkSync(
    realParent,
    aliasParent,
    process.platform === "win32" ? "junction" : "dir",
  );

  const platformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  );
  if (platformDescriptor === undefined) {
    throw new Error("process.platform descriptor is unavailable");
  }
  const originalTemp = {
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
  };
  let state;
  try {
    Object.defineProperty(process, "platform", {
      ...platformDescriptor,
      value: "win32",
    });
    process.env.TEMP = aliasParent;
    process.env.TMP = aliasParent;
    process.env.TMPDIR = aliasParent;

    state = await createTuiGateState({
      prefix: "agenc-tui-canonical-root-test-",
    });

    assert.equal(path.dirname(state.root), realpathSync(realParent));
    assert.equal(state.root, realpathSync(state.root));
    assert.equal(state.canonicalRoot, state.root);
    assert.equal(state.home, state.root);
    assert.equal(state.env.HOME, state.root);
    assert.equal(state.agencHome, path.join(state.root, ".agenc"));
    const owner = JSON.parse(
      readFileSync(
        path.join(state.root, ".agenc-tui-gate-owner.json"),
        "utf8",
      ),
    );
    assert.equal(owner.root, state.root);

    await teardownTuiGateState(state);
    assert.equal(existsSync(state.root), false);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    for (const [key, value] of Object.entries(originalTemp)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (state && !state.cleaned) {
      rmSync(state.root, { recursive: true, force: true });
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test("private gate trust is canonical and deterministic without copied operator state", async () => {
  const operatorRoot = mkdtempSync(path.join(tmpdir(), "agenc-tui-operator-"));
  writeFileSync(path.join(operatorRoot, "auth.json"), '{"secret":true}\n');
  const state = await createTuiGateState({
    baseEnv: {
      HOME: operatorRoot,
      AGENC_HOME: operatorRoot,
      OPENAI_API_KEY: "operator-secret",
      PATH: process.env.PATH,
    },
    prefix: "agenc-tui-state-test-",
  });
  try {
    const project = path.join(state.root, "project");
    writeFileSync(path.join(state.root, "project"), "", { flag: "wx" });
    await writeTuiGateTrust(state.env, [project, project]);
    const trust = JSON.parse(
      readFileSync(path.join(state.agencHome, "trusted-projects.json"), "utf8"),
    );
    assert.deepEqual(trust, {
      version: 1,
      trustedProjects: [{
        path: project,
        trustedAt: TUI_GATE_TRUST_TIMESTAMP,
      }],
    });
    assert.equal(existsSync(path.join(state.agencHome, "auth.json")), false);
    assert.equal(state.env.OPENAI_API_KEY, undefined);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
    rmSync(operatorRoot, { recursive: true, force: true });
  }
});

test("private gate teardown removes only an owned root and proves it absent", async () => {
  const state = await createTuiGateState({ prefix: "agenc-tui-cleanup-test-" });
  try {
    assert.match(path.basename(state.root), /^agt-/u);
    assert.ok(
      Buffer.byteLength(path.join(state.agencHome, "daemon.sock")) < 96,
    );
    await teardownTuiGateState(state);
    assert.equal(existsSync(state.root), false);
    await assert.rejects(
      startTuiGateDaemon(state, "/not-used-after-cleanup"),
      /shutting down/u,
    );
    assert.equal(existsSync(state.root), false);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

test("private gate project fixtures are deterministic and can expose real diffs", async () => {
  const state = await createTuiGateState({
    prefix: "agenc-tui-project-fixture-",
  });
  try {
    const project = createTuiGateProject(state, { dirty: true });
    assert.equal(path.dirname(project), state.root);
    const status = spawn(
      "git",
      ["status", "--short", "--untracked-files=all"],
      { cwd: project, env: state.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    status.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const exit = await new Promise((resolve) => status.once("exit", resolve));
    assert.equal(exit, 0);
    assert.match(output, /^ M diff-fixture\.txt$/mu);
    assert.match(output, /^\?\? untracked-fixture\.txt$/mu);
    await teardownTuiGateState(state);
    assert.equal(existsSync(state.root), false);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

function fakeDelayedDaemonCli() {
  const root = mkdtempSync(path.join(tmpdir(), "agenc-tui-fake-daemon-"));
  const script = path.join(root, "agenc.mjs");
  writeFileSync(script, [
    "import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "const action = process.argv[3];",
    "const home = process.env.AGENC_HOME;",
    "const pidPath = path.join(home, 'daemon.pid');",
    "const socketPath = path.join(home, 'daemon.sock');",
    "if (action === 'status') {",
    "  try {",
    "    const pid = Number.parseInt(readFileSync(pidPath, 'utf8'), 10);",
    "    process.kill(pid, 0);",
    "    if (existsSync(socketPath)) { console.log(`AgenC daemon running (pid ${pid})`); process.exit(0); }",
    "  } catch {}",
    "  process.exit(1);",
    "}",
    "const cleanup = () => { rmSync(pidPath, { force: true }); rmSync(socketPath, { force: true }); process.exit(0); };",
    "process.on('SIGTERM', cleanup);",
    "setTimeout(() => {",
    "  mkdirSync(home, { recursive: true });",
    "  writeFileSync(pidPath, `${process.pid}\\n`);",
    "  writeFileSync(socketPath, 'fake socket\\n');",
    "}, 250);",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  return { root, script };
}

test("teardown serializes with an in-flight daemon start", async () => {
  const fake = fakeDelayedDaemonCli();
  const state = await createTuiGateState({
    prefix: "agenc-tui-start-cleanup-race-",
  });
  try {
    const starting = startTuiGateDaemon(state, fake.script);
    const deadline = Date.now() + 5_000;
    while (state.daemonProcesses.size === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(state.daemonProcesses.size, 1);
    const cleanup = teardownTuiGateState(state);
    const [startResult, cleanupResult] = await Promise.allSettled([
      starting,
      cleanup,
    ]);
    assert.equal(startResult.status, "rejected");
    assert.match(startResult.reason.message, /interrupted by cleanup/u);
    assert.equal(cleanupResult.status, "fulfilled");
    assert.equal(existsSync(state.root), false);
    for (const record of state.daemonProcesses.values()) {
      assert.notEqual(record.exit, null);
    }
  } finally {
    rmSync(state.root, { recursive: true, force: true });
    rmSync(fake.root, { recursive: true, force: true });
  }
});

test("pid-file poisoning never signals an unowned process", async () => {
  const state = await createTuiGateState({ prefix: "agenc-tui-pid-poison-" });
  try {
    writeFileSync(path.join(state.agencHome, "daemon.pid"), `${process.pid}\n`);
    await assert.rejects(
      teardownTuiGateState(state),
      /refusing to signal unowned pid/u,
    );
    process.kill(process.pid, 0);
    assert.equal(existsSync(state.root), true);
  } finally {
    rmSync(state.root, { recursive: true, force: true });
  }
});

function retainDaemonChildForTest(state, child) {
  const record = {
    child,
    pid: child.pid,
    stdout: "",
    stderr: "",
    exit: null,
    exitPromise: null,
  };
  record.exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      record.exit = { code, signal };
      resolve(record.exit);
    });
  });
  state.daemonPids.add(child.pid);
  state.daemonProcesses.set(child.pid, record);
  return record;
}

test("a symlinked private daemon home cannot redirect cleanup", async () => {
  const operatorRoot = mkdtempSync(path.join(tmpdir(), "agenc-tui-operator-"));
  const operatorAgencHome = path.join(operatorRoot, ".agenc");
  mkdirSync(operatorAgencHome, { mode: 0o700 });
  const marker = path.join(operatorAgencHome, "operator-marker");
  writeFileSync(marker, "untouched\n");
  const state = await createTuiGateState({ prefix: "agenc-tui-symlink-poison-" });
  const shutdownWrite = path.join(state.agencHome, "shutdown-followed-symlink");
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        "const fs = require('node:fs');",
        "const target = process.argv[1];",
        "process.on('SIGTERM', () => { fs.writeFileSync(target, 'poisoned\\n'); process.exit(0); });",
        "process.stdout.write('ready\\n');",
        "setInterval(() => {}, 1000);",
      ].join(" "),
      shutdownWrite,
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const record = retainDaemonChildForTest(state, child);
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
    });
    rmSync(state.agencHome, { recursive: true });
    symlinkSync(operatorAgencHome, state.agencHome, "dir");
    await assert.rejects(
      teardownTuiGateState(state),
      /symlinked TUI gate directory/u,
    );
    await record.exitPromise;
    assert.equal(record.exit.signal, "SIGKILL");
    assert.equal(readFileSync(marker, "utf8"), "untouched\n");
    assert.equal(existsSync(path.join(operatorAgencHome, "shutdown-followed-symlink")), false);
  } finally {
    if (record.exit === null) child.kill("SIGKILL");
    rmSync(state.root, { recursive: true, force: true });
    rmSync(operatorRoot, { recursive: true, force: true });
  }
});

test("a deleted private root still terminates every retained daemon child", async () => {
  const state = await createTuiGateState({ prefix: "agenc-tui-missing-root-" });
  const child = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"],
    { stdio: "ignore" },
  );
  const record = retainDaemonChildForTest(state, child);
  rmSync(state.root, { recursive: true });
  await assert.rejects(
    teardownTuiGateState(state),
    /root disappeared before cleanup/u,
  );
  await record.exitPromise;
  try {
    process.kill(child.pid, 0);
    assert.fail("retained daemon child remained alive");
  } catch (error) {
    assert.equal(error.code, "ESRCH");
  }
});

async function runGateSignalProbe(signal, expectedExitCode) {
  const helperUrl = new URL("./tui-gate-state.mjs", import.meta.url).href;
  const source = [
    "import { spawn } from 'node:child_process';",
    `import { createTuiGateState, installTuiGateSignalHandlers, teardownTuiGateState } from ${JSON.stringify(helperUrl)};`,
    "const state = await createTuiGateState();",
    "const daemon = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "const record = { child: daemon, pid: daemon.pid, stdout: '', stderr: '', exit: null, exitPromise: null };",
    "record.exitPromise = new Promise((resolve) => daemon.once('exit', (code, signal) => { record.exit = { code, signal }; resolve(record.exit); }));",
    "state.daemonPids.add(daemon.pid);",
    "state.daemonProcesses.set(daemon.pid, record);",
    "installTuiGateSignalHandlers(() => teardownTuiGateState(state));",
    "process.stdout.write(`${JSON.stringify({ root: state.root, daemonPid: daemon.pid })}\\n`);",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const firstLine = await new Promise((resolve, reject) => {
    let finished = false;
    const timeout = setTimeout(() => {
      finished = true;
      reject(new Error(`signal probe did not become ready: ${stderr}`));
    }, 5_000);
    const poll = () => {
      if (finished) return;
      const newline = stdout.indexOf("\n");
      if (newline === -1) {
        setTimeout(poll, 10);
        return;
      }
      finished = true;
      clearTimeout(timeout);
      resolve(stdout.slice(0, newline));
    };
    child.once("error", (error) => {
      finished = true;
      clearTimeout(timeout);
      reject(error);
    });
    poll();
  });
  const { root, daemonPid } = JSON.parse(firstLine);
  assert.equal(existsSync(root), true);
  process.kill(daemonPid, 0);
  child.kill(signal);
  const exit = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  assert.deepEqual(exit, { code: expectedExitCode, signal: null });
  assert.equal(existsSync(root), false);
  assert.throws(
    () => process.kill(daemonPid, 0),
    (error) => error?.code === "ESRCH",
  );
}

test("catchable terminal signals clean state and retained daemons before exit", async () => {
  for (const [signal, exitCode] of [["SIGHUP", 129], ["SIGTERM", 143]]) {
    await runGateSignalProbe(signal, exitCode);
  }
});

function fakeTerm({
  earlyExit = false,
  ignoreKills = false,
  ignoreSigterm = false,
  terminationExit,
  paint = SEMANTIC_PAINT,
  spontaneousExitMs,
} = {}) {
  const dataHandlers = [];
  const exitHandlers = [];
  let exited = false;
  const emitExit = (value) => {
    if (exited) return;
    exited = true;
    for (const handler of exitHandlers) handler(value);
  };
  return {
    onData(handler) {
      dataHandlers.push(handler);
      return { dispose() {} };
    },
    onExit(handler) {
      exitHandlers.push(handler);
      if (earlyExit) setTimeout(() => emitExit({ exitCode: 0, signal: 0 }), 0);
      else {
        setTimeout(() => dataHandlers.forEach((emit) => emit(paint)), 0);
        if (spontaneousExitMs !== undefined) {
          setTimeout(() => emitExit({ exitCode: 0, signal: 0 }), spontaneousExitMs);
        }
      }
      return { dispose() {} };
    },
    write() {},
    kill(signal) {
      if (ignoreKills) return;
      if (ignoreSigterm && signal === "SIGTERM") return;
      emitExit(terminationExit ?? { exitCode: 0, signal: signal === "SIGKILL" ? 9 : 15 });
    },
  };
}

test("a clean PTY exit before first paint is a failure", async () => {
  const passed = await observePtySession(fakeTerm({ earlyExit: true }), {
    label: "early-exit",
    viewport: { cols: 80, rows: 24 },
    firstPaintMs: 20,
    postReplyMs: 20,
    sigtermGraceMs: 20,
    forceKillGraceMs: 20,
  });
  assert.equal(passed, false);
});

test("one byte followed by a hang is not a functional TUI startup", async () => {
  assert.equal(hasSemanticPtyReadiness("x"), false);
  const passed = await observePtySession(fakeTerm({ paint: "x" }), {
    label: "one-byte-hang",
    viewport: { cols: 80, rows: 24 },
    firstPaintMs: 10,
    postReplyMs: 10,
    sigtermGraceMs: 10,
    forceKillGraceMs: 10,
  });
  assert.equal(passed, false);
});

test("a spontaneous clean exit at the post-reply boundary cannot race green", async () => {
  const passed = await observePtySession(fakeTerm({ spontaneousExitMs: 9 }), {
    label: "post-reply-exit-race",
    viewport: { cols: 80, rows: 24 },
    firstPaintMs: 5,
    postReplyMs: 10,
    sigtermGraceMs: 10,
    forceKillGraceMs: 10,
  });
  assert.equal(passed, false);
});

test("a painted PTY that stays alive until requested termination passes", async () => {
  const passed = await observePtySession(fakeTerm(), {
    label: "healthy",
    viewport: { cols: 80, rows: 24 },
    firstPaintMs: 20,
    postReplyMs: 20,
    sigtermGraceMs: 20,
    forceKillGraceMs: 20,
  });
  assert.equal(passed, true);
});

test("a PTY crash during the requested termination grace is a failure", async () => {
  for (const terminationExit of [
    { exitCode: 1, signal: 0 },
    { exitCode: 0, signal: 11 },
  ]) {
    const passed = await observePtySession(
      fakeTerm({ terminationExit }),
      {
        label: "termination-race",
        viewport: { cols: 80, rows: 24 },
        firstPaintMs: 20,
        postReplyMs: 20,
        sigtermGraceMs: 20,
        forceKillGraceMs: 20,
      },
    );
    assert.equal(passed, false);
  }
});

test("an ignored warmup cannot hide a PTY that survives SIGKILL", async () => {
  await assert.rejects(
    observePtySession(
      fakeTerm({ ignoreKills: true }),
      {
        label: "unkillable-warmup",
        viewport: { cols: 80, rows: 24 },
        firstPaintMs: 5,
        postReplyMs: 5,
        sigtermGraceMs: 5,
        forceKillGraceMs: 5,
        resultIgnored: true,
      },
    ),
    /PTY survived the final SIGKILL grace period/u,
  );
});

test("an ignored warmup cannot hide a PTY that requires SIGKILL", async () => {
  const passed = await observePtySession(
    fakeTerm({ ignoreSigterm: true }),
    {
      label: "sigkill-only-warmup",
      viewport: { cols: 80, rows: 24 },
      firstPaintMs: 5,
      postReplyMs: 5,
      sigtermGraceMs: 5,
      forceKillGraceMs: 5,
      resultIgnored: true,
    },
  );
  assert.equal(passed, false);
});
