import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, vi } from "vitest";
import { itOnDarwin, itWhen } from "../helpers/platform-registration.js";

// On darwin every contained command starts behind a fresh Node gate and waits
// for a fresh Node watchdog to record the gate's identity: two Node startups
// and a `ps` before the command runs. A prepared launch does that work ahead
// of time. These tests hold it to the same boundary as an unprepared launch:
// the command gets exactly its own cwd, environment and argv0, it starts only
// after the watchdog is ready, the idle watchdog costs nothing, and nothing is
// left behind when the launch is dropped or its owner exits.

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const {
  POSIX_PROCESS_GATE_SCRIPT,
  discardPreparedContainedProcessLaunch,
  prepareContainedProcessLaunch,
  preparedContainedProcessLaunchForTesting,
  setContainedWatchdogReadyTimeoutForTesting,
  setPreparedLaunchIdleTimeoutForTesting,
  spawnContainedProcess,
  terminateProcessTreeAndReport,
  waitForContainedProcessSettlement,
} = await import("../../src/utils/supervisedProcess.js");
const { UnifiedExecProcessManager } = await import("../../src/unified-exec/process-manager.js");

const actualSpawn = (
  await vi.importActual<typeof import("node:child_process")>("node:child_process")
).spawn;
const spawnMock = vi.mocked(childProcess.spawn);

const OWNER_FIXTURE = fileURLToPath(new URL("./fixtures/prepared-launch-owner.ts", import.meta.url));
const NODE_TEST_LOADER = fileURLToPath(
  new URL("../durability/fixtures/node-test-loader.mjs", import.meta.url),
);
const TSX_IMPORT = fileURLToPath(import.meta.resolve("tsx"));

const env = { PATH: "/usr/bin:/bin", AGENC_PREPARED_PROBE: "value with spaces" };
const PROBE = [
  "process.stdout.write(JSON.stringify({",
  "cwd: process.cwd(),",
  "argv0: process.argv0,",
  "env: Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)),",
  "}))",
].join("");

const scratchRoots: string[] = [];
const restores: Array<() => void> = [];

afterEach(() => {
  discardPreparedContainedProcessLaunch();
  spawnMock.mockReset();
  spawnMock.mockImplementation(actualSpawn);
  for (const restore of restores.splice(0)) restore();
  for (const root of scratchRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agenc-prepared-launch-")));
  scratchRoots.push(root);
  return root;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitFor(condition: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function readyLaunch(cwd: string) {
  await waitFor(
    () => preparedContainedProcessLaunchForTesting()?.ready === true,
    20_000,
    "the prepared watchdog to report ready",
  );
  const launch = preparedContainedProcessLaunchForTesting()!;
  expect(launch.cwd).toBe(cwd);
  return launch;
}

type Outcome = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string };

function outcome(child: childProcess.ChildProcessWithoutNullStreams): Promise<Outcome> {
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.stdin.end();
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function settle(child: childProcess.ChildProcessWithoutNullStreams) {
  await waitForContainedProcessSettlement(child);
  return terminateProcessTreeAndReport(child, { label: "prepared launch test" });
}

/** Count samples in which `pid` had a child process, over `ms`. */
function samplesWithChildren(pid: number, ms: number): number {
  const deadline = Date.now() + ms;
  let seen = 0;
  while (Date.now() < deadline) {
    const result = childProcess.spawnSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim().length > 0) seen += 1;
  }
  return seen;
}

/** A watchdog stand-in that reports ready only when told to, and records what it is sent. */
function fakeWatchdogSpawns() {
  const written: Buffer[] = [];
  const channel = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      written.push(Buffer.from(chunk));
      callback();
    },
  });
  const watchdog = Object.assign(new EventEmitter(), {
    pid: 424_243,
    exitCode: null,
    signalCode: null,
    stdio: [null, null, null, channel],
    kill: vi.fn(() => true),
    ref() {},
    unref() {},
  });
  spawnMock.mockImplementation(((command: string, args: readonly string[], options: object) => {
    if (args[0] === "-e" && args[1] !== POSIX_PROCESS_GATE_SCRIPT) {
      return watchdog as unknown as childProcess.ChildProcess;
    }
    return actualSpawn(command, args, options as childProcess.SpawnOptions);
  }) as typeof childProcess.spawn);
  return {
    ready: () => channel.push("ready\n"),
    sent: () => Buffer.concat(written).toString("utf8"),
  };
}

// Off darwin there is no prepared launch: preparing one starts nothing, and a
// command that asks to claim one starts through the platform's own contained
// launch and settles like any other. These cases also give the suite a test
// on every platform.
const itOffDarwin = itWhen(process.platform !== "darwin");
const itOnOtherPosix = itWhen(process.platform !== "darwin" && process.platform !== "win32");

describe("prepared contained launches", () => {
  itOnDarwin("give the command the same cwd, environment and argv0 as an unprepared launch", async () => {
    const cwd = scratch();
    const unprepared = spawnContainedProcess(process.execPath, ["-e", PROBE], {
      cwd,
      env,
      argv0: "agenc-probe",
    });
    const expected = await outcome(unprepared);
    await settle(unprepared);

    prepareContainedProcessLaunch(cwd);
    const launch = await readyLaunch(cwd);
    const child = spawnContainedProcess(process.execPath, ["-e", PROBE], {
      cwd,
      env,
      argv0: "agenc-probe",
      usePreparedLaunch: true,
    });
    // The command runs as the prepared gate, and the launch is used up.
    expect(child.pid).toBe(launch.gatePid);
    expect(preparedContainedProcessLaunchForTesting()).toBeUndefined();
    const result = await outcome(child);

    expect(expected.code).toBe(0);
    expect(result).toEqual(expected);
    expect(JSON.parse(result.stdout)).toMatchObject({ cwd, argv0: "agenc-probe" });
    await expect(settle(child)).resolves.toMatchObject({ residualProcessesTerminated: false });
  }, 60_000);

  itOnDarwin("start the command only after the watchdog reports ready, and tell the watchdog first", async () => {
    const cwd = scratch();
    const marker = join(cwd, "ran");
    const watchdog = fakeWatchdogSpawns();
    prepareContainedProcessLaunch(cwd);
    const child = spawnContainedProcess("/bin/sh", ["-c", `: > '${marker}'`], {
      cwd,
      env,
      usePreparedLaunch: true,
    });
    const result = outcome(child);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(existsSync(marker)).toBe(false);
    expect(watchdog.sent()).toBe("");

    watchdog.ready();
    expect((await result).code).toBe(0);
    expect(existsSync(marker)).toBe(true);
    expect(watchdog.sent()).toBe("go\n");
    await settle(child);
  }, 60_000);

  itOnDarwin("abandon the command when the watchdog never reports ready", async () => {
    const cwd = scratch();
    const marker = join(cwd, "ran");
    restores.push(setContainedWatchdogReadyTimeoutForTesting(200));
    const watchdog = fakeWatchdogSpawns();
    prepareContainedProcessLaunch(cwd);
    const child = spawnContainedProcess("/bin/sh", ["-c", `: > '${marker}'`], {
      cwd,
      env,
      usePreparedLaunch: true,
    });

    const result = await outcome(child);
    expect(result.signal).toBe("SIGKILL");
    expect(existsSync(marker)).toBe(false);
    expect(watchdog.sent()).toBe("");
  }, 60_000);

  itOnDarwin("keep the idle watchdog off the process table until a command is handed over", async () => {
    const cwd = scratch();
    prepareContainedProcessLaunch(cwd);
    const launch = await readyLaunch(cwd);

    // Idle: no `ps` children at all.
    expect(samplesWithChildren(launch.watchdogPid, 600)).toBe(0);

    // Holding a command, it polls (the sampler does see its `ps` children).
    const child = spawnContainedProcess("/bin/sleep", ["2"], { cwd, env, usePreparedLaunch: true });
    expect(child.pid).toBe(launch.gatePid);
    const result = outcome(child);
    expect(samplesWithChildren(launch.watchdogPid, 600)).toBeGreaterThan(0);
    expect((await result).code).toBe(0);
    await settle(child);
  }, 60_000);

  itOnDarwin("are not used once their directory was replaced, and leave nothing behind", async () => {
    const cwd = join(scratch(), "work");
    mkdirSync(cwd);
    prepareContainedProcessLaunch(cwd);
    const launch = await readyLaunch(cwd);

    rmSync(cwd, { recursive: true });
    mkdirSync(cwd);
    const child = spawnContainedProcess("/bin/sh", ["-c", "pwd -P; test -d ."], {
      cwd,
      env,
      usePreparedLaunch: true,
    });
    expect(child.pid).not.toBe(launch.gatePid);
    const result = await outcome(child);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(cwd);
    await settle(child);
    await waitFor(
      () => !alive(launch.gatePid) && !alive(launch.watchdogPid),
      10_000,
      "the replaced launch's processes to exit",
    );
  }, 60_000);

  itOnDarwin("are dropped after their idle period", async () => {
    const cwd = scratch();
    restores.push(setPreparedLaunchIdleTimeoutForTesting(300));
    prepareContainedProcessLaunch(cwd);
    const launch = await readyLaunch(cwd);

    await waitFor(() => preparedContainedProcessLaunchForTesting() === undefined, 10_000, "the idle drop");
    await waitFor(
      () => !alive(launch.gatePid) && !alive(launch.watchdogPid),
      10_000,
      "the dropped launch's processes to exit",
    );
  }, 60_000);

  itOnDarwin("stop when their owner exits", async () => {
    const cwd = scratch();
    const owner = actualSpawn(
      process.execPath,
      ["--loader", NODE_TEST_LOADER, "--import", TSX_IMPORT, OWNER_FIXTURE, cwd],
      {
        cwd: dirname(dirname(dirname(dirname(OWNER_FIXTURE)))),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    owner.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    owner.stderr!.resume();
    try {
      await waitFor(() => stdout.includes("\n"), 30_000, "the owner to report its prepared launch");
      const launch = JSON.parse(stdout.split("\n")[0]!) as { gatePid: number; watchdogPid: number };
      expect(alive(launch.gatePid) && alive(launch.watchdogPid)).toBe(true);

      owner.kill("SIGKILL");
      await waitFor(
        () => !alive(launch.gatePid) && !alive(launch.watchdogPid),
        10_000,
        "the orphaned launch's processes to exit",
      );
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
    }
  }, 60_000);

  itOnDarwin("serve an exec manager's next command, which then runs as the prepared gate", async () => {
    const cwd = scratch();
    const manager = new UnifiedExecProcessManager({ cwd, prepareContainedLaunches: true });
    try {
      const first = await manager.execCommand({ cmd: "echo first", yield_time_ms: 10_000 });
      expect(first.exitCode).toBe(0);
      const launch = await readyLaunch(cwd);

      const second = await manager.execCommand({ cmd: "echo $$", yield_time_ms: 10_000 });
      expect(second.exitCode).toBe(0);
      expect(second.stdout.trim()).toBe(String(launch.gatePid));

      const next = await readyLaunch(cwd);
      expect(next.gatePid).not.toBe(launch.gatePid);
      await manager.closeAll("test");
      expect(preparedContainedProcessLaunchForTesting()).toBeUndefined();
      await waitFor(
        () => !alive(next.gatePid) && !alive(next.watchdogPid),
        10_000,
        "the discarded launch's processes to exit",
      );
    } finally {
      await manager.closeAll("test cleanup");
    }
  }, 60_000);

  itOffDarwin("prepare nothing: no gate and no watchdog are started", () => {
    const cwd = scratch();
    prepareContainedProcessLaunch(cwd);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(preparedContainedProcessLaunchForTesting()).toBeUndefined();
  });

  itOnOtherPosix("run a command that asks for one like any other contained command, and settle it", async () => {
    const cwd = scratch();
    prepareContainedProcessLaunch(cwd);
    const plain = spawnContainedProcess(process.execPath, ["-e", PROBE], {
      cwd,
      env,
      argv0: "agenc-probe",
    });
    const expected = await outcome(plain);
    await settle(plain);
    expect(expected.code).toBe(0);

    const asked = spawnContainedProcess(process.execPath, ["-e", PROBE], {
      cwd,
      env,
      argv0: "agenc-probe",
      usePreparedLaunch: true,
    });
    const actual = await outcome(asked);
    await settle(asked);
    expect(actual).toMatchObject({ code: 0, signal: null });
    const seen = JSON.parse(actual.stdout) as { cwd: string; argv0: string; env: Array<[string, string]> };
    const before = JSON.parse(expected.stdout) as typeof seen;
    expect(seen.cwd).toBe(cwd);
    expect(seen.argv0).toBe(before.argv0);
    expect(seen.env).toContainEqual(["AGENC_PREPARED_PROBE", "value with spaces"]);
    expect(preparedContainedProcessLaunchForTesting()).toBeUndefined();
  }, 60_000);
});
