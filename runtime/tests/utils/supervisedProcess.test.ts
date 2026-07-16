import { spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  runSupervisedProcess,
  terminateProcessTreeAndWait,
} from "../../src/utils/supervisedProcess.js";

function nodeCommand(source: string) {
  return {
    program: process.execPath,
    args: ["-e", source],
    cwd: process.cwd(),
    env: { ...process.env } as Record<string, string>,
  };
}

function processIsRunning(pid: number): boolean {
  try {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const processNameEnd = stat.lastIndexOf(")");
      const state = stat.slice(processNameEnd + 2, processNameEnd + 3);
      return state !== "Z";
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsRunning(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !processIsRunning(pid);
}

async function withFakeWindowsTaskkill(
  exitCode: number,
  run: (logPath: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "agenc-taskkill-test-"));
  const system32 = join(dir, "System32");
  const taskkill = join(system32, "taskkill.exe");
  const logPath = join(dir, "taskkill.log");
  mkdirSync(system32);
  writeFileSync(
    taskkill,
    `#!/bin/sh\nsleep 0.05\nprintf '%s ' "$@" >> "$AGENC_TASKKILL_TEST_LOG"\nprintf '\\n' >> "$AGENC_TASKKILL_TEST_LOG"\nexit ${exitCode}\n`,
  );
  chmodSync(taskkill, 0o700);
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  const previousSystemRoot = process.env.SystemRoot;
  const previousLog = process.env.AGENC_TASKKILL_TEST_LOG;
  Object.defineProperty(process, "platform", {
    ...platformDescriptor,
    value: "win32",
  });
  process.env.SystemRoot = dir;
  process.env.AGENC_TASKKILL_TEST_LOG = logPath;
  try {
    await run(logPath);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    if (previousSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = previousSystemRoot;
    if (previousLog === undefined) delete process.env.AGENC_TASKKILL_TEST_LOG;
    else process.env.AGENC_TASKKILL_TEST_LOG = previousLog;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("runSupervisedProcess", () => {
  it("does not spawn when the caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runSupervisedProcess(
      {
        program: "/definitely/not/a/real/agenc-test-executable",
        args: [],
        cwd: process.cwd(),
        env: {},
      },
      {
        timeoutMs: 100,
        maxOutputBytes: 16,
        signal: controller.signal,
      },
    );

    expect(result).toMatchObject({
      exitCode: null,
      signal: null,
      stopReason: "aborted",
      forced: false,
      backstopExpired: false,
    });
    expect(result.error).toBeUndefined();
  });

  it("enforces one combined byte cap across stdout and stderr", async () => {
    const result = await runSupervisedProcess(
      nodeCommand(
        "process.stdout.write('a'.repeat(32));" +
          "process.stderr.write('b'.repeat(32));" +
          "setInterval(() => {}, 1000)",
      ),
      {
        timeoutMs: 2_000,
        maxOutputBytes: 40,
        terminateGraceMs: 50,
        settleBackstopMs: 500,
      },
    );

    expect(result.stopReason).toBe("output_limit");
    expect(result.stdout.byteLength + result.stderr.byteLength).toBe(40);
    expect(result.stdout.toString()).toMatch(/^a+$/);
    expect(result.stderr.toString()).toMatch(/^b*$/);
  });

  it.runIf(process.platform !== "win32")(
    "kills a TERM-resistant process group after the grace period",
    async () => {
      accessSync(process.execPath, constants.X_OK);
      const started = Date.now();
      const result = await runSupervisedProcess(
        nodeCommand(
          "process.on('SIGTERM', () => {});" +
            "const descendant = require('node:child_process').spawn(" +
            "process.execPath," +
            "['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"]," +
            "{ stdio: 'ignore' });" +
            "process.stdout.write('ready:' + descendant.pid);" +
            "setInterval(() => {}, 1000)",
        ),
        {
          timeoutMs: 250,
          maxOutputBytes: 1_024,
          terminateGraceMs: 75,
          settleBackstopMs: 750,
        },
      );

      const output = result.stdout.toString();
      expect(output).toMatch(/^ready:\d+$/);
      const descendantPid = Number(output.slice("ready:".length));
      expect(result.stopReason).toBe("timeout");
      expect(result.forced).toBe(true);
      expect(Date.now() - started).toBeLessThan(2_500);
      try {
        expect(await waitForProcessExit(descendantPid, 1_000)).toBe(true);
      } finally {
        if (processIsRunning(descendantPid)) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The process exited between the liveness check and cleanup.
          }
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "proves a session-long TERM-resistant process tree is gone",
    async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {});" +
            "require('node:child_process').spawn(process.execPath," +
            "['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"]," +
            "{ stdio: 'ignore' });" +
            "setInterval(() => {}, 1000)",
        ],
        { detached: true, stdio: "ignore" },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });

      await terminateProcessTreeAndWait(child, {
        terminateGraceMs: 50,
        killGraceMs: 1_000,
        label: "test process",
      });

      expect(processIsRunning(child.pid!)).toBe(false);
    },
  );
});

describe("terminateProcessTreeAndWait on Windows", () => {
  const exitedLeader = {
    pid: 4_242,
    exitCode: 0,
    signalCode: null,
    kill: () => true,
  };

  it("awaits taskkill /T even when the process leader already exited", async () => {
    await withFakeWindowsTaskkill(0, async (logPath) => {
      await terminateProcessTreeAndWait(exitedLeader, {
        terminateGraceMs: 500,
        killGraceMs: 500,
        label: "Windows test process",
      });

      expect(readFileSync(logPath, "utf8").trim()).toBe("/PID 4242 /T");
    });
  });

  it("fails closed when taskkill cannot verify tree teardown", async () => {
    await withFakeWindowsTaskkill(9, async (logPath) => {
      await expect(
        terminateProcessTreeAndWait(exitedLeader, {
          terminateGraceMs: 500,
          killGraceMs: 500,
          label: "Windows test process",
        }),
      ).rejects.toMatchObject({
        name: "AggregateError",
        message:
          "Windows test process tree cleanup could not be verified by taskkill /T (pid 4242)",
      });

      expect(
        readFileSync(logPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.trim()),
      ).toEqual(["/PID 4242 /T", "/PID 4242 /T /F"]);
    });
  });
});
