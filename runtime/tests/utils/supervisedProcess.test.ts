import { execFileSync, spawn } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  isProcessTreeAlive,
  runSupervisedProcess,
  signalProcessTree,
  spawnContainedProcess,
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

async function withLinuxBrokerFaultLibrary<T>(
  run: (libraryPath: string, scratchDirectory: string) => Promise<T>,
): Promise<T> {
  const scratchDirectory = mkdtempSync(
    join(tmpdir(), "agenc-broker-fault-test-"),
  );
  const sourcePath = join(scratchDirectory, "broker-faults.c");
  const libraryPath = join(scratchDirectory, "broker-faults.so");
  const compiler = ["/usr/bin/cc", "/bin/cc"].find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (compiler === undefined) {
    rmSync(scratchDirectory, { recursive: true, force: true });
    throw new Error("Linux broker regression tests require cc");
  }
  writeFileSync(
    sourcePath,
    String.raw`
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static int wait_signal_sent = 0;

static const char *agenc_fault(void) {
  const char *fault = getenv("AGENC_TEST_BROKER_FAULT");
  return fault == NULL ? "" : fault;
}

pid_t waitpid(pid_t pid, int *status, int options) {
  static pid_t (*real_waitpid)(pid_t, int *, int) = NULL;

  if (real_waitpid == NULL) {
    real_waitpid = (pid_t (*)(pid_t, int *, int))dlsym(RTLD_NEXT, "waitpid");
    if (real_waitpid == NULL) {
      errno = ENOSYS;
      return -1;
    }
  }
  if (!wait_signal_sent && strcmp(agenc_fault(), "wait-signal") == 0) {
    const char *marker = getenv("AGENC_TEST_BROKER_MARKER");
    const struct timespec retry = {0, 1000000};
    int attempt;

    wait_signal_sent = 1;
    for (attempt = 0; attempt < 2000; attempt += 1) {
      if (marker != NULL && access(marker, F_OK) == 0) {
        break;
      }
      (void)nanosleep(&retry, NULL);
    }
    (void)kill(getpid(), SIGTERM);
  }
  return real_waitpid(pid, status, options);
}

pid_t setsid(void) {
  static pid_t (*real_setsid)(void) = NULL;

  if (strcmp(agenc_fault(), "setsid") == 0) {
    errno = EPERM;
    return -1;
  }
  if (real_setsid == NULL) {
    real_setsid = (pid_t (*)(void))dlsym(RTLD_NEXT, "setsid");
    if (real_setsid == NULL) {
      errno = ENOSYS;
      return -1;
    }
  }
  return real_setsid();
}

FILE *fopen(const char *path, const char *mode) {
  static FILE *(*real_fopen)(const char *, const char *) = NULL;

  if (
    strcmp(agenc_fault(), "children") == 0 &&
    strstr(path, "/children") != NULL
  ) {
    errno = ENOENT;
    return NULL;
  }
  if (real_fopen == NULL) {
    real_fopen = (FILE *(*)(const char *, const char *))dlsym(
      RTLD_NEXT,
      "fopen"
    );
    if (real_fopen == NULL) {
      errno = ENOSYS;
      return NULL;
    }
  }
  return real_fopen(path, mode);
}
`,
  );
  try {
    execFileSync(
      compiler,
      [
        "-shared",
        "-fPIC",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        "-o",
        libraryPath,
        sourcePath,
        "-ldl",
      ],
      { stdio: "pipe" },
    );
    return await run(libraryPath, scratchDirectory);
  } finally {
    rmSync(scratchDirectory, { recursive: true, force: true });
  }
}

function linuxBrokerFaultEnvironment(
  libraryPath: string,
  fault: "children" | "setsid" | "wait-signal",
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...extra,
    AGENC_TEST_BROKER_FAULT: fault,
    LD_PRELOAD: process.env.LD_PRELOAD === undefined
      ? libraryPath
      : `${libraryPath}:${process.env.LD_PRELOAD}`,
  };
}

function waitForChildClose(
  child: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timed out waiting for process ${child.pid} to close`));
    }, timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
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
  it("runs without an implicit deadline when timeoutMs is omitted", async () => {
    const result = await runSupervisedProcess(
      nodeCommand("setTimeout(() => process.stdout.write('done'), 75)"),
      {
        maxOutputBytes: 1_024,
      },
    );

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      forced: false,
      backstopExpired: false,
    });
    expect(result.stopReason).toBeUndefined();
    expect(result.stdout.toString()).toBe("done");
  });

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

  it.runIf(process.platform === "linux")(
    "contains an immediate setsid descendant after its leader exits",
    async () => {
      let descendantPid = 0;
      try {
        const result = await runSupervisedProcess(
          nodeCommand(
            "const descendant = require('node:child_process').spawn(" +
              "process.execPath," +
              "['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"]," +
              "{ detached: true, stdio: 'ignore' });" +
              "process.stdout.write(String(descendant.pid), () => process.exit(0))",
          ),
          {
            maxOutputBytes: 1_024,
            terminateGraceMs: 25,
            settleBackstopMs: 1_000,
          },
        );

        descendantPid = Number(result.stdout.toString());
        expect(Number.isSafeInteger(descendantPid) && descendantPid > 0).toBe(true);
        expect(result).toMatchObject({
          exitCode: 0,
          stopReason: "residual_process",
          backstopExpired: false,
        });
        expect(await waitForProcessExit(descendantPid, 1_000)).toBe(true);
      } finally {
        if (processIsRunning(descendantPid)) {
          try {
            process.kill(descendantPid, "SIGKILL");
          } catch {
            // The descendant exited between the liveness check and cleanup.
          }
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "shares one cgroup watchdog and kills every boundary when its owner dies",
    async () => {
      const supervisedProcessUrl = new URL(
        "../../src/utils/supervisedProcess.ts",
        import.meta.url,
      ).href;
      const descendantSource =
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)";
      const leaderSource = [
        "const { spawn } = require('node:child_process');",
        `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(
          descendantSource,
        )}], { detached: true, stdio: 'ignore' });`,
        "process.stdout.write(JSON.stringify({ leader: process.pid, descendant: descendant.pid }) + '\\n');",
        "setInterval(() => {}, 1000);",
      ].join("");
      const ownerSource = [
        `const { spawnContainedProcess } = await import(${JSON.stringify(
          supervisedProcessUrl,
        )});`,
        `const leaderSource = ${JSON.stringify(leaderSource)};`,
        "for (let index = 0; index < 4; index += 1) {",
        "  const child = spawnContainedProcess(process.execPath, ['-e', leaderSource], {",
        "    cwd: process.cwd(),",
        "    env: process.env,",
        "  });",
        "  child.stdin.end();",
        "  child.stdout.pipe(process.stdout, { end: false });",
        "  child.stderr.pipe(process.stderr, { end: false });",
        "}",
        "setInterval(() => {}, 1000);",
      ].join("\n");
      const owner = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", ownerSource],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const processes: Array<{ leader: number; descendant: number }> = [];
      let output = "";
      let stderr = "";
      owner.stdout.setEncoding("utf8");
      owner.stderr.setEncoding("utf8");
      owner.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for contained processes: ${stderr}`));
        }, 5_000);
        owner.stdout.on("data", (chunk: string) => {
          output += chunk;
          while (true) {
            const newline = output.indexOf("\n");
            if (newline < 0) break;
            const line = output.slice(0, newline);
            output = output.slice(newline + 1);
            processes.push(JSON.parse(line) as {
              leader: number;
              descendant: number;
            });
          }
          if (processes.length < 4) return;
          clearTimeout(timer);
          resolve();
        });
        owner.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        owner.once("exit", (code, signal) => {
          if (processes.length >= 4) return;
          clearTimeout(timer);
          reject(
            new Error(
              `Containment owner exited before readiness: ${code ?? signal}; ${stderr}`,
            ),
          );
        });
      });

      try {
        await ready;
        const watchdogPids = readFileSync(
          `/proc/${owner.pid}/task/${owner.pid}/children`,
          "utf8",
        )
          .trim()
          .split(/\s+/u)
          .filter(Boolean)
          .map(Number)
          .filter((pid) => {
            try {
              return readFileSync(`/proc/${pid}/cmdline`, "utf8")
                .includes("agenc-cgroup-owner-watchdog");
            } catch {
              return false;
            }
          });
        const hasPrivateCgroup = processes.every(({ descendant }) => {
          try {
            return readFileSync(`/proc/${descendant}/cgroup`, "utf8")
              .includes("/agenc-process-");
          } catch {
            return false;
          }
        });
        if (hasPrivateCgroup) {
          expect(watchdogPids).toHaveLength(1);
        }

        const ownerExit = new Promise<void>((resolve) => {
          owner.once("exit", () => resolve());
        });
        process.kill(owner.pid!, "SIGKILL");
        await ownerExit;

        for (const { leader, descendant } of processes) {
          expect(await waitForProcessExit(leader, 2_000)).toBe(true);
          expect(await waitForProcessExit(descendant, 2_000)).toBe(true);
        }
        for (const watchdogPid of watchdogPids) {
          expect(await waitForProcessExit(watchdogPid, 2_000)).toBe(true);
        }
      } finally {
        if (processIsRunning(owner.pid!)) {
          try {
            process.kill(owner.pid!, "SIGKILL");
          } catch {
            // The owner exited between the liveness check and cleanup.
          }
        }
        for (const { leader, descendant } of processes) {
          for (const pid of [leader, descendant]) {
            if (!processIsRunning(pid)) continue;
            try {
              process.kill(pid, "SIGKILL");
            } catch {
              // The process exited between the liveness check and cleanup.
            }
          }
        }
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "terminates a session-long TERM-resistant process-group leader",
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

describe("process-tree root safety", () => {
  it.runIf(process.platform === "linux")(
    "contains Bash startup hooks behind the POSIX process gate",
    async () => {
      const scratchDirectory = mkdtempSync(
        join(tmpdir(), "agenc-posix-gate-test-"),
      );
      const bashEnvPath = join(scratchDirectory, "bash-env.sh");
      const escapedMarkerPath = join(scratchDirectory, "escaped-marker");
      writeFileSync(
        bashEnvPath,
        `/usr/bin/setsid /usr/bin/touch "${escapedMarkerPath}" ` +
          "</dev/null >/dev/null 2>&1 &\n",
      );
      const platformDescriptor =
        Object.getOwnPropertyDescriptor(process, "platform")!;
      let child: ReturnType<typeof spawnContainedProcess> | undefined;

      try {
        Object.defineProperty(process, "platform", {
          ...platformDescriptor,
          value: "darwin",
        });
        try {
          child = spawnContainedProcess(
            process.execPath,
            [
              "-e",
              "process.stdout.write(JSON.stringify({" +
                "argv0: process.argv0," +
                "bashEnv: process.env.BASH_ENV" +
                "}))",
            ],
            {
              cwd: process.cwd(),
              env: {
                ...process.env,
                BASH_ENV: bashEnvPath,
              },
              argv0: "agenc-posix-gate-target",
            },
          );
        } finally {
          Object.defineProperty(process, "platform", platformDescriptor);
        }

        let stdout = "";
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        const processClosed = waitForChildClose(child, 2_000);
        child.stdin.end();
        await expect(processClosed).resolves.toMatchObject({
          code: 0,
          signal: null,
        });
        expect(JSON.parse(stdout)).toEqual({
          argv0: "agenc-posix-gate-target",
          bashEnv: bashEnvPath,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(existsSync(escapedMarkerPath)).toBe(false);
        await expect(
          terminateProcessTreeAndWait(child, {
            terminateGraceMs: 50,
            killGraceMs: 1_000,
            label: "POSIX gate process",
          }),
        ).resolves.toBeUndefined();
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
        if (child?.pid !== undefined && processIsRunning(child.pid)) {
          signalProcessTree(child, "SIGKILL");
          await waitForProcessExit(child.pid, 1_000);
        }
        rmSync(scratchDirectory, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "queues the strongest cleanup until subreaper readiness is consumed",
    async () => {
      const child = spawnContainedProcess(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          linuxContainment: "subreaper",
        },
      );
      const status = child.stdio[3];
      if (
        status === undefined ||
        status === null ||
        typeof status === "number" ||
        !("pause" in status)
      ) {
        throw new Error("contained process status stream is unavailable");
      }
      status.pause();
      const processClosed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });

      try {
        expect(child.kill(0)).toBe(true);
        expect(() => child.kill("SIGSTOP")).toThrow(
          "Linux contained-process handles accept only signal 0",
        );
        signalProcessTree(child, "SIGTERM");
        signalProcessTree(child, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(processIsRunning(child.pid!)).toBe(true);

        status.resume();
        await processClosed;
        await terminateProcessTreeAndWait(child, {
          terminateGraceMs: 50,
          killGraceMs: 1_000,
          label: "delayed-proof process",
        });
        expect(isProcessTreeAlive(child)).toBe(false);
      } finally {
        status.resume();
        try {
          await terminateProcessTreeAndWait(child, {
            terminateGraceMs: 25,
            killGraceMs: 1_000,
            label: "delayed-proof cleanup",
          });
        } catch {
          // Preserve the primary assertion when testing the broken ordering.
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "delivers a queued TERM only after the child setup acknowledgement",
    async () => {
      const child = spawnContainedProcess(
        process.execPath,
        ["-e", "setInterval(() => {}, 1000)"],
        {
          cwd: process.cwd(),
          env: process.env,
          linuxContainment: "subreaper",
        },
      );
      const status = child.stdio[3];
      if (
        status === undefined ||
        status === null ||
        typeof status === "number" ||
        !("pause" in status)
      ) {
        throw new Error("contained process status stream is unavailable");
      }
      status.pause();
      const processClosed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });

      try {
        expect(child.killed).toBe(false);
        signalProcessTree(child, "SIGTERM");
        expect(child.killed).toBe(false);
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(processIsRunning(child.pid!)).toBe(true);

        status.resume();
        expect(await waitForProcessExit(child.pid!, 1_000)).toBe(true);
        await processClosed;
        await terminateProcessTreeAndWait(child, {
          terminateGraceMs: 50,
          killGraceMs: 1_000,
          label: "queued-TERM process",
        });
        expect(isProcessTreeAlive(child)).toBe(false);
      } finally {
        status.resume();
        try {
          await terminateProcessTreeAndWait(child, {
            terminateGraceMs: 25,
            killGraceMs: 1_000,
            label: "queued-TERM cleanup",
          });
        } catch {
          // Preserve the primary assertion when testing a broken handshake.
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "does not lose a control signal delivered between reaping and waiting",
    async () => {
      await withLinuxBrokerFaultLibrary(async (libraryPath, scratchDirectory) => {
        const markerPath = join(scratchDirectory, "target-ready");
        const child = spawnContainedProcess(
          process.execPath,
          [
            "-e",
            "require('node:fs').writeFileSync(" +
              `${JSON.stringify(markerPath)}, 'ready');` +
              "setInterval(() => {}, 1000)",
          ],
          {
            cwd: process.cwd(),
            env: linuxBrokerFaultEnvironment(
              libraryPath,
              "wait-signal",
              { AGENC_TEST_BROKER_MARKER: markerPath },
            ),
            linuxContainment: "subreaper",
          },
        );
        const processClosed = waitForChildClose(child, 1_500);
        child.stdin.end();

        try {
          await expect(processClosed).resolves.toMatchObject({
            code: null,
            signal: "SIGTERM",
          });
          await expect(
            terminateProcessTreeAndWait(child, {
              terminateGraceMs: 50,
              killGraceMs: 1_000,
              label: "signal-wakeup process",
            }),
          ).resolves.toBeUndefined();
          expect(isProcessTreeAlive(child)).toBe(false);
        } finally {
          if (processIsRunning(child.pid!)) {
            signalProcessTree(child, "SIGKILL");
            await waitForProcessExit(child.pid!, 1_000);
          }
        }
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "does not publish readiness when child ownership setup fails",
    async () => {
      await withLinuxBrokerFaultLibrary(async (libraryPath) => {
        const child = spawnContainedProcess(
          process.execPath,
          ["-e", "process.exit(99)"],
          {
            cwd: process.cwd(),
            env: linuxBrokerFaultEnvironment(libraryPath, "setsid"),
            linuxContainment: "subreaper",
          },
        );
        const processClosed = waitForChildClose(child, 1_000);
        child.stdin.end();

        try {
          await expect(processClosed).resolves.toMatchObject({
            code: 125,
            signal: null,
          });
          await expect(
            terminateProcessTreeAndWait(child, {
              terminateGraceMs: 50,
              killGraceMs: 1_000,
              label: "failed-setup process",
            }),
          ).rejects.toThrow(/before readiness/u);
          expect(isProcessTreeAlive(child)).toBe(false);
        } finally {
          if (processIsRunning(child.pid!)) {
            signalProcessTree(child, "SIGKILL");
            await waitForProcessExit(child.pid!, 1_000);
          }
        }
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "fails before launch when child ownership enumeration is unavailable",
    async () => {
      await withLinuxBrokerFaultLibrary(async (libraryPath) => {
        const child = spawnContainedProcess(
          process.execPath,
          ["-e", "process.exit(99)"],
          {
            cwd: process.cwd(),
            env: linuxBrokerFaultEnvironment(libraryPath, "children"),
            linuxContainment: "subreaper",
          },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        const processClosed = waitForChildClose(child, 1_000);
        child.stdin.end();

        try {
          await expect(processClosed).resolves.toMatchObject({
            code: 125,
            signal: null,
          });
          expect(stderr).toContain(
            "child ownership enumeration unavailable",
          );
          await expect(
            terminateProcessTreeAndWait(child, {
              terminateGraceMs: 50,
              killGraceMs: 1_000,
              label: "unavailable-enumeration process",
            }),
          ).rejects.toThrow("exited before readiness");
          expect(isProcessTreeAlive(child)).toBe(false);
        } finally {
          if (processIsRunning(child.pid!)) {
            signalProcessTree(child, "SIGKILL");
            await waitForProcessExit(child.pid!, 1_000);
          }
        }
      });
    },
  );

  it.runIf(process.platform === "linux")(
    "consumes buffered cleanup proof before accepting broker closure",
    async () => {
      const child = spawnContainedProcess(
        process.execPath,
        [
          "-e",
          "process.stdout.write('target-ready\\n'); setInterval(() => {}, 1000)",
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          linuxContainment: "subreaper",
        },
      );
      const status = child.stdio[3];
      if (
        status === undefined ||
        status === null ||
        typeof status === "number" ||
        !("pause" in status)
      ) {
        throw new Error("contained process status stream is unavailable");
      }

      try {
        await new Promise<void>((resolve, reject) => {
          child.stdout.once("data", () => resolve());
          child.once("error", reject);
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        status.pause();
        const processClosed = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        });
        signalProcessTree(child, "SIGKILL");
        await processClosed;
        expect(isProcessTreeAlive(child)).toBe(false);

        status.resume();
        await terminateProcessTreeAndWait(child, {
          terminateGraceMs: 50,
          killGraceMs: 1_000,
          label: "delayed-proof process",
        });
        expect(isProcessTreeAlive(child)).toBe(false);
      } finally {
        status.resume();
        try {
          await terminateProcessTreeAndWait(child, {
            terminateGraceMs: 25,
            killGraceMs: 1_000,
            label: "delayed-proof cleanup",
          });
        } catch {
          // Preserve the primary assertion when testing the broken ordering.
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "ships the deterministic subreaper fallback in Linux runtime builds",
    () => {
      const brokerSource = readFileSync(
        new URL("../../native/agenc-process-broker.c", import.meta.url),
        "utf8",
      );
      const buildConfig = readFileSync(
        new URL("../../build.config.ts", import.meta.url),
        "utf8",
      );
      const packageManifest = JSON.parse(
        readFileSync(
          new URL("../../package.json", import.meta.url),
          "utf8",
        ),
      ) as { readonly agencExecutableFiles?: readonly string[] };
      const modeCanonicalizer = readFileSync(
        new URL("../../../scripts/canonicalize-package-modes.mjs", import.meta.url),
        "utf8",
      );

      expect(brokerSource).toContain("PR_SET_CHILD_SUBREAPER");
      expect(brokerSource).toContain("PR_SET_PDEATHSIG");
      expect(brokerSource).toContain('write_status("S", 1U)');
      expect(brokerSource.match(/write_status\("S", 1U\)/gu)).toHaveLength(1);
      const childSetupStart = brokerSource.indexOf("if (root_pid == 0)");
      const childSetupEnd = brokerSource.indexOf(
        "free(target_argv);",
        childSetupStart,
      );
      const childSetup = brokerSource.slice(childSetupStart, childSetupEnd);
      expect(childSetupStart).toBeGreaterThanOrEqual(0);
      expect(childSetupEnd).toBeGreaterThan(childSetupStart);
      expect(childSetup).toContain("setsid()");
      expect(childSetup).toContain('write_status("S", 1U)');
      expect(childSetup.indexOf('write_status("S", 1U)')).toBeGreaterThan(
        childSetup.indexOf("setsid()"),
      );
      expect(brokerSource).toContain("sigwaitinfo(&wait_mask");
      expect(brokerSource).toContain(
        "child ownership enumeration unavailable",
      );
      expect(brokerSource).toContain("waitpid(-1");
      expect(brokerSource).toContain("signal_direct_children(SIGKILL)");
      expect(buildConfig).toContain("compileLinuxProcessBroker");
      expect(packageManifest.agencExecutableFiles).toContain(
        "dist/agenc-process-broker",
      );
      expect(modeCanonicalizer).toContain("agencExecutableFiles");
    },
  );

  it("ships one precompiled Windows Job Object broker per runtime build", () => {
    const brokerSource = readFileSync(
      new URL("../../native/agenc-process-job-broker.cs", import.meta.url),
      "utf8",
    );
    const buildConfig = readFileSync(
      new URL("../../build.config.ts", import.meta.url),
      "utf8",
    );
    const supervisionSource = readFileSync(
      new URL("../../src/utils/supervisedProcess.ts", import.meta.url),
      "utf8",
    );
    const discoverySource = readFileSync(
      new URL(
        "../../src/tui/workbench/buffer/neovim/NeovimDiscovery.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const packageManifest = JSON.parse(
      readFileSync(
        new URL("../../package.json", import.meta.url),
        "utf8",
      ),
    ) as { readonly agencExecutableFiles?: readonly string[] };
    const entrypointCheck = readFileSync(
      new URL(
        "../../scripts/check-package-entrypoints.mjs",
        import.meta.url,
      ),
      "utf8",
    );

    expect(brokerSource).toContain("JobObjectLimitKillOnJobClose");
    expect(brokerSource).toContain("CreateSuspended");
    expect(brokerSource).toContain("AssignProcessToJobObject");
    expect(brokerSource).toContain("WaitForMultipleObjects");
    expect(brokerSource).toContain("CloseHandle(job)");
    const launch = brokerSource.indexOf(
      "CreateProcess(\n                        applicationName,",
    );
    const assignment = brokerSource.indexOf(
      "AssignProcessToJobObject(job, process.hProcess)",
      launch,
    );
    const resume = brokerSource.indexOf(
      "ResumeThread(process.hThread)",
      assignment,
    );
    expect(launch).toBeGreaterThanOrEqual(0);
    expect(assignment).toBeGreaterThan(launch);
    expect(resume).toBeGreaterThan(assignment);
    const clearOwnerInput = brokerSource.indexOf(
      '"AGENC_PROCESS_JOB_OWNER_PID",\n                    null',
    );
    expect(clearOwnerInput).toBeGreaterThanOrEqual(0);
    expect(clearOwnerInput).toBeLessThan(launch);

    expect(buildConfig).toContain("compileWindowsProcessBroker");
    expect(buildConfig).toContain("/deterministic+");
    expect(buildConfig).toContain("/pathmap:");
    expect(buildConfig).toContain("Visual Studio/Installer/vswhere.exe");
    expect(supervisionSource).toContain(
      'resolve(moduleDirectory, "../../dist", WINDOWS_JOB_BROKER_NAME)',
    );
    expect(supervisionSource).toContain(
      'mkdtempSync(\n    join(tmpdir(), "agenc-process-job-broker-")',
    );
    expect(supervisionSource).toContain(
      'process.once("exit", cleanupCompiledWindowsJobBroker)',
    );
    expect(supervisionSource).toContain("spawn(broker, [],");
    expect(supervisionSource).not.toContain("Add-Type -TypeDefinition");
    expect(supervisionSource).not.toContain(
      "WINDOWS_JOB_BROKER_SCRIPT",
    );
    expect(packageManifest.agencExecutableFiles).toContain(
      "dist/agenc-process-job-broker.exe",
    );
    expect(entrypointCheck).toContain(
      '"dist/agenc-process-job-broker.exe"',
    );
    expect(discoverySource).toContain(
      'process.platform === "win32" ? 5_000 : 1200',
    );
  });

  it("guards PID 1 inside the detached POSIX owner watchdog", () => {
    const source = readFileSync(
      new URL("../../src/utils/supervisedProcess.ts", import.meta.url),
      "utf8",
    );
    const start = source.indexOf("const POSIX_OWNER_WATCHDOG_SCRIPT");
    const end = source.indexOf("\ntype ProcessTreeChild", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const watchdogSource = source.slice(start, end);

    expect(watchdogSource).toContain(
      "!Number.isSafeInteger(config.rootPid) || config.rootPid <= 1",
    );
    expect(watchdogSource).toContain(
      "!Number.isSafeInteger(pid) || pid <= 1",
    );
    expect(watchdogSource).toContain("if (record.pid <= 1) continue;");
  });

  it.runIf(process.platform !== "win32")(
    "never treats PID 1 as an owned process tree or process group",
    async () => {
      const directKill = vi.fn(() => true);
      const invalidRoot = {
        pid: 1,
        exitCode: 0,
        signalCode: null,
        kill: directKill,
      };
      const osKill = vi.spyOn(process, "kill").mockImplementation(() => true);

      try {
        expect(isProcessTreeAlive(invalidRoot)).toBe(false);
        await expect(
          terminateProcessTreeAndWait(invalidRoot, {
            terminateGraceMs: 1,
            killGraceMs: 1,
            label: "invalid root",
          }),
        ).resolves.toBeUndefined();

        const liveInvalidRoot = {
          ...invalidRoot,
          exitCode: null,
          kill: directKill,
        };
        signalProcessTree(liveInvalidRoot, "SIGKILL");

        expect(osKill).not.toHaveBeenCalled();
        expect(directKill).toHaveBeenCalledOnce();
        expect(directKill).toHaveBeenCalledWith("SIGKILL");
      } finally {
        osKill.mockRestore();
      }
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

  it("never passes PID 1 to taskkill", async () => {
    await withFakeWindowsTaskkill(0, async (logPath) => {
      const directKill = vi.fn(() => true);
      await expect(
        terminateProcessTreeAndWait({
          pid: 1,
          exitCode: 0,
          signalCode: null,
          kill: directKill,
        }, {
          terminateGraceMs: 1,
          killGraceMs: 1,
          label: "invalid Windows root",
        }),
      ).resolves.toBeUndefined();

      expect(directKill).not.toHaveBeenCalled();
      expect(existsSync(logPath)).toBe(false);
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
