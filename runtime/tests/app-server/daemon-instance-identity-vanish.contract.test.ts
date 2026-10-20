import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  AgenCDaemonProcessScanIncompleteError,
  findLinuxAgenCDaemonProcesses,
  readAgenCDaemonProcessStart,
  type AgenCDaemonProcessInspectionHost,
  type LinuxAgenCDaemonProcessEntry,
  type LinuxAgenCDaemonProcessScanLimits,
} from "./daemon-instance-identity.js";

/**
 * A process that exits while daemon discovery inspects it is not a running
 * daemon and must not block a daemon start. Every other failure keeps the
 * fail-closed result. Each case first proves that the live candidate is found
 * as a same-home daemon, then makes it exit at one /proc read.
 */

const linux = process.platform === "linux";
const PYTHON = "/usr/bin/python3";

/** Candidate /proc reads, in the order a same-home candidate reaches them. */
const READ_POINTS = [
  "cmdline",
  "exe",
  "environ",
  "root-open",
  "root-walk",
  "cwd",
  "cwd-after",
  "root-after",
] as const;
type ReadPoint = (typeof READ_POINTS)[number];

function reachedReadPoint(
  point: ReadPoint,
  calls: readonly LinuxAgenCDaemonProcessEntry[],
): boolean {
  const current = calls[calls.length - 1];
  const count = (entry: LinuxAgenCDaemonProcessEntry) =>
    calls.filter((call) => call === entry).length;
  switch (point) {
    case "cmdline":
    case "exe":
    case "environ":
      return current === point && count(point) === 1;
    case "root-open":
      return current === "root" && count("root") === 1;
    case "root-walk":
      return current === "root" && count("root") === 2;
    case "cwd":
      return current === "cwd" && count("cwd") === 1;
    case "cwd-after":
      return current === "cwd" && count("cwd") === 2;
    case "root-after":
      return (
        current === "root" &&
        count("cwd") === 2 &&
        calls.slice(calls.lastIndexOf("cwd")).filter((call) => call === "root")
          .length === 1
      );
  }
}

function hookAt(point: ReadPoint, action: () => Promise<void> | void) {
  const calls: LinuxAgenCDaemonProcessEntry[] = [];
  let fired = false;
  return {
    beforeProcessRead: async (_pid: number, entry: LinuxAgenCDaemonProcessEntry) => {
      calls.push(entry);
      if (!fired && reachedReadPoint(point, calls)) {
        fired = true;
        await action();
      }
    },
    fired: () => fired,
  };
}

function errno(code: string, syscall = "open"): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected ${code}`), { code, syscall });
}

function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readTask(
  pid: number,
): Promise<{ readonly state: string; readonly threads: number } | null> {
  try {
    const record = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = record.slice(record.lastIndexOf(")") + 2).trim().split(/\s+/u);
    return { state: fields[0] ?? "", threads: Number(fields[17]) };
  } catch {
    return null;
  }
}

async function waitFor(
  what: string,
  predicate: () => Promise<boolean> | boolean,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

type CandidateKind = "child" | "held" | "python";

interface Candidate {
  readonly pid: number;
  readonly root: string;
  readonly home: string;
  readonly entrypoint: string;
  /** SIGKILL the candidate and wait until its parent has reaped it. */
  reap(): Promise<void>;
  /** SIGKILL the candidate and wait until it is an exited, unreaped task. */
  exitUnreaped(): Promise<void>;
  /** End only the group leader thread; another thread keeps running. */
  exitLeaderThread(): Promise<void>;
  host(
    overrides?: Partial<AgenCDaemonProcessInspectionHost>,
  ): AgenCDaemonProcessInspectionHost;
  dispose(): Promise<void>;
}

const candidates: Candidate[] = [];

afterEach(async () => {
  await Promise.all(candidates.splice(0).map((candidate) => candidate.dispose()));
});

const HOLDER_SCRIPT =
  '"$1" "$2" daemon start --foreground >/dev/null 2>&1 &\n' +
  'echo "$!"\n' +
  "exec sleep 600\n";

const LEADER_EXIT_SCRIPT = [
  "import ctypes, os, sys, threading, time",
  "threading.Thread(target=time.sleep, args=(600,), daemon=True).start()",
  'sys.stdout.write("ready\\n")',
  "sys.stdout.flush()",
  "sys.stdin.readline()",
  // SYS_exit ends only the calling thread, unlike exit_group.
  'ctypes.CDLL(None).syscall({"x86_64": 60, "aarch64": 93}[os.uname().machine], 0)',
].join("\n");

async function readLine(stream: NodeJS.ReadableStream): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
    const newline = text.indexOf("\n");
    if (newline >= 0) return text.slice(0, newline);
  }
  throw new Error("stream ended before a line was written");
}

async function spawnCandidate(kind: CandidateKind = "child"): Promise<Candidate> {
  const root = await mkdtemp(join(tmpdir(), "agenc-vanish-"));
  const home = join(root, "home");
  const entrypoint = join(root, "daemon-entrypoint.js");
  await mkdir(home);
  await writeFile(entrypoint, "setInterval(() => {}, 1_000);\n");
  const env = { ...process.env, AGENC_HOME: home };
  let child: ChildProcess;
  let pid: number;
  if (kind === "held") {
    // The holder never waits for its background job, so a killed candidate
    // stays an unreaped zombie until the holder itself is gone.
    child = spawn(
      "/bin/sh",
      ["-c", HOLDER_SCRIPT, "agenc-vanish-holder", process.execPath, entrypoint],
      { cwd: root, env, stdio: ["ignore", "pipe", "ignore"] },
    );
    pid = Number.parseInt(await readLine(child.stdout!), 10);
  } else if (kind === "python") {
    child = spawn(
      PYTHON,
      ["-c", LEADER_EXIT_SCRIPT, entrypoint, "daemon", "start", "--foreground"],
      { cwd: root, env, stdio: ["pipe", "pipe", "ignore"] },
    );
    expect(await readLine(child.stdout!)).toBe("ready");
    pid = child.pid!;
  } else {
    child = spawn(process.execPath, [entrypoint, "daemon", "start", "--foreground"], {
      cwd: root,
      env,
      stdio: "ignore",
    });
    await once(child, "spawn");
    pid = child.pid!;
  }
  await waitFor("the candidate argv", async () =>
    (await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "")).includes(entrypoint));

  const candidate: Candidate = {
    pid,
    root,
    home,
    entrypoint,
    async reap() {
      if (kind !== "child") throw new Error("only a direct child is reaped here");
      child.kill("SIGKILL");
      await waitForExit(child);
    },
    async exitUnreaped() {
      if (kind !== "held") throw new Error("only a held candidate stays unreaped");
      process.kill(pid, "SIGKILL");
      await waitFor("an exited unreaped task", async () => {
        const task = await readTask(pid);
        return task !== null && task.state === "Z" && task.threads === 1;
      });
    },
    async exitLeaderThread() {
      if (kind !== "python") throw new Error("only the python candidate ends its leader");
      child.stdin!.write("go\n");
      await waitFor("a zombie group leader with a live thread", async () => {
        const task = await readTask(pid);
        return task !== null && task.state === "Z" && task.threads > 1;
      });
    },
    host(overrides = {}) {
      return {
        entrypointPath: entrypoint,
        pid: process.pid,
        platform: "linux",
        isPidRunning: (candidatePid) => candidatePid === pid && pidExists(candidatePid),
        ...overrides,
      };
    },
    async dispose() {
      if (kind === "held" && pidExists(pid)) process.kill(pid, "SIGKILL");
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForExit(child);
      }
      await rm(root, { recursive: true, force: true });
    },
  };
  candidates.push(candidate);
  return candidate;
}

function discover(
  candidate: Candidate,
  host: AgenCDaemonProcessInspectionHost = candidate.host(),
  limits: LinuxAgenCDaemonProcessScanLimits = {},
  daemonHome = candidate.home,
) {
  return findLinuxAgenCDaemonProcesses(host, daemonHome, "exact", limits);
}

/** Run discovery with a hook that runs before each of the candidate's reads. */
function discoverWithHook(
  candidate: Candidate,
  hook: ReturnType<typeof hookAt>,
  host: AgenCDaemonProcessInspectionHost = candidate.host(),
) {
  return discover(candidate, host, { beforeProcessRead: hook.beforeProcessRead });
}

/** The live candidate is a same-home daemon, so it would block a start. */
async function expectFoundWhileLive(candidate: Candidate): Promise<void> {
  await expect(discover(candidate)).resolves.toEqual([
    expect.objectContaining({ pid: candidate.pid }),
  ]);
}

function expectRefusal(candidate: Candidate, pattern?: RegExp) {
  return async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgenCDaemonProcessScanIncompleteError);
    expect((error as Error).message).toContain(`process ${candidate.pid}`);
    if (pattern !== undefined) expect((error as Error).message).toMatch(pattern);
  };
}

describe.skipIf(!linux)("daemon discovery when a candidate exits mid-inspection", () => {
  it.each(READ_POINTS)("skips a candidate reaped at the %s read", async (point) => {
    const candidate = await spawnCandidate();
    await expectFoundWhileLive(candidate);
    const hook = hookAt(point, () => candidate.reap());

    await expect(discoverWithHook(candidate, hook)).resolves.toEqual([]);
    expect(hook.fired()).toBe(true);
  });

  it.each(READ_POINTS)(
    "skips a candidate that exited but is not yet reaped at the %s read",
    async (point) => {
      const candidate = await spawnCandidate("held");
      await expectFoundWhileLive(candidate);
      const hook = hookAt(point, () => candidate.exitUnreaped());

      await expect(discoverWithHook(candidate, hook)).resolves.toEqual([]);
      expect(hook.fired()).toBe(true);
      // The unreaped task still answers signal 0 and keeps its start token.
      expect(pidExists(candidate.pid)).toBe(true);
    },
  );

  it.each(READ_POINTS)(
    "skips a candidate whose PID carries another start token after the %s read fails",
    async (point) => {
      const candidate = await spawnCandidate();
      await expectFoundWhileLive(candidate);
      let reused = false;
      const host = candidate.host({
        // A new process holds the PID now, so signal 0 still succeeds.
        isPidRunning: (pid) => pid === candidate.pid,
        readProcessIdentity: async (pid) =>
          reused ? "linux:reused-pid:1" : await readAgenCDaemonProcessStart(pid),
      });
      const hook = hookAt(point, async () => {
        await candidate.reap();
        reused = true;
      });

      await expect(discoverWithHook(candidate, hook, host)).resolves.toEqual([]);
      expect(hook.fired()).toBe(true);
    },
  );

  // These two use only the cwd and identity seams that predate the read hook.
  it("skips a candidate that exited unreaped when its cwd is read", async () => {
    const candidate = await spawnCandidate("held");
    await expectFoundWhileLive(candidate);
    let cwdReads = 0;

    await expect(
      discover(candidate, candidate.host(), {
        readProcessCwdPath: async (procDir) => {
          if (++cwdReads === 1) await candidate.exitUnreaped();
          return realpath(join(procDir, "cwd"));
        },
      }),
    ).resolves.toEqual([]);
    expect(cwdReads).toBe(1);
  });

  it("skips a candidate whose PID carries another start token when its cwd is read", async () => {
    const candidate = await spawnCandidate();
    await expectFoundWhileLive(candidate);
    let reused = false;
    const host = candidate.host({
      isPidRunning: (pid) => pid === candidate.pid,
      readProcessIdentity: async (pid) =>
        reused ? "linux:reused-pid:1" : await readAgenCDaemonProcessStart(pid),
    });

    await expect(
      discover(candidate, host, {
        readProcessCwdPath: async (procDir) => {
          if (!reused) {
            await candidate.reap();
            reused = true;
          }
          return realpath(join(procDir, "cwd"));
        },
      }),
    ).resolves.toEqual([]);
  });

  it.each(["child", "held"] as const)(
    "skips a %s candidate that exits just before its start token is confirmed",
    async (kind) => {
      const candidate = await spawnCandidate(kind);
      await expectFoundWhileLive(candidate);
      let tokenReads = 0;
      const host = candidate.host({
        readProcessIdentity: async (pid) => {
          tokenReads += 1;
          if (tokenReads === 2) {
            await (kind === "child" ? candidate.reap() : candidate.exitUnreaped());
          }
          return readAgenCDaemonProcessStart(pid);
        },
      });

      await expect(discover(candidate, host)).resolves.toEqual([]);
      expect(tokenReads).toBeGreaterThanOrEqual(2);
    },
  );
});

describe.skipIf(!linux)("daemon discovery still fails closed", () => {
  it.each(READ_POINTS)(
    "for a running candidate whose %s read reports ENOENT",
    async (point) => {
      const candidate = await spawnCandidate();
      await expectFoundWhileLive(candidate);
      const hook = hookAt(point, () => {
        throw errno("ENOENT");
      });

      await expectRefusal(candidate)(discoverWithHook(candidate, hook));
      expect(hook.fired()).toBe(true);
      expect(pidExists(candidate.pid)).toBe(true);
    },
  );

  it.each(READ_POINTS)(
    "for an EIO at the %s read even after the candidate is gone",
    async (point) => {
      const candidate = await spawnCandidate();
      await expectFoundWhileLive(candidate);
      const hook = hookAt(point, async () => {
        await candidate.reap();
        throw errno("EIO", "read");
      });

      await expectRefusal(candidate)(discoverWithHook(candidate, hook));
      expect(hook.fired()).toBe(true);
    },
  );

  it.each(READ_POINTS.filter((point) => point !== "environ"))(
    "for an EACCES at the %s read even after the candidate is gone",
    async (point) => {
      const candidate = await spawnCandidate();
      await expectFoundWhileLive(candidate);
      const hook = hookAt(point, async () => {
        await candidate.reap();
        throw errno("EACCES");
      });

      await expectRefusal(candidate)(discoverWithHook(candidate, hook));
      expect(hook.fired()).toBe(true);
    },
  );

  it("for a running candidate whose environ is unreadable", async () => {
    const candidate = await spawnCandidate();
    await expectFoundWhileLive(candidate);
    const hook = hookAt("environ", () => {
      throw errno("EACCES");
    });

    await expectRefusal(candidate, /process identity file unavailable/u)(
      discoverWithHook(candidate, hook),
    );
    expect(pidExists(candidate.pid)).toBe(true);
  });

  it.skipIf(!existsSync(PYTHON))(
    "for a candidate whose group leader exited while another thread runs",
    async () => {
      const candidate = await spawnCandidate("python");
      await expectFoundWhileLive(candidate);
      const hook = hookAt("exe", () => candidate.exitLeaderThread());

      await expectRefusal(candidate, /identity could not be proved/u)(
        discoverWithHook(candidate, hook),
      );
      expect(hook.fired()).toBe(true);
      expect(pidExists(candidate.pid)).toBe(true);
    },
  );

  it("when the scan budget runs out after a candidate is gone", async () => {
    const candidate = await spawnCandidate();
    await expectFoundWhileLive(candidate);
    let now = 0;
    const hook = hookAt("exe", async () => {
      await candidate.reap();
      now = 10_000;
    });

    await expect(
      discover(candidate, candidate.host(), {
        beforeProcessRead: hook.beforeProcessRead,
        now: () => now,
        maxElapsedMs: 1_000,
      }),
    ).rejects.toThrow(/longer than 1000ms/u);
    expect(hook.fired()).toBe(true);
  });

  it("when the target daemon home disappears during inspection", async () => {
    const candidate = await spawnCandidate();
    await expectFoundWhileLive(candidate);
    const hook = hookAt("cwd-after", () =>
      rename(candidate.home, `${candidate.home}.moved`));

    await expectRefusal(candidate, /daemon home identity unavailable/u)(
      discoverWithHook(candidate, hook),
    );
  });

  it("when the candidate cwd is replaced under an unchanged start token", async () => {
    const candidate = await spawnCandidate();
    await expectFoundWhileLive(candidate);
    const other = join(candidate.root, "other");
    await mkdir(other);
    let cwdReads = 0;

    await expectRefusal(candidate, /changed during inspection/u)(
      discover(candidate, candidate.host(), {
        readProcessCwdPath: async () => (++cwdReads === 1 ? candidate.root : other),
      }),
    );
    expect(cwdReads).toBe(2);
  });

  it("when the candidate home is replaced under an unchanged start token", async () => {
    const candidate = await spawnCandidate();
    await expectFoundWhileLive(candidate);
    const hook = hookAt("root-after", async () => {
      await rename(candidate.home, `${candidate.home}.old`);
      await mkdir(candidate.home);
    });

    await expectRefusal(candidate, /changed during inspection/u)(
      discoverWithHook(candidate, hook),
    );
    expect(hook.fired()).toBe(true);
  });
});

/** The error Node's Dir throws when it lstat()s a procfs DT_UNKNOWN entry. */
function directoryEntryError(
  path: string,
  code = "ENOENT",
  syscall = "lstat",
): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`${code}: no such file or directory, ${syscall} '${path}'`),
    { code, errno: -2, syscall, path },
  );
}

/** Each open returns the next listing; the last one repeats. */
function fakeProcDirectory(listings: ReadonlyArray<ReadonlyArray<string | Error>>) {
  let opens = 0;
  let closes = 0;
  return {
    openProcDirectory: async () => {
      const entries = [...(listings[Math.min(opens, listings.length - 1)] ?? [])];
      opens += 1;
      return {
        read: async () => {
          const entry = entries.shift();
          if (entry === undefined) return null;
          if (entry instanceof Error) throw entry;
          return { name: entry, isDirectory: () => true };
        },
        close: async () => {
          closes += 1;
        },
      };
    },
    opens: () => opens,
    closes: () => closes,
  };
}

const IDLE_HOST: AgenCDaemonProcessInspectionHost = {
  entrypointPath: "/opt/agenc/bin/agenc",
  pid: 99,
  platform: "linux",
  isPidRunning: () => false,
};

describe("daemon discovery when a process is reaped while /proc is listed", () => {
  it.skipIf(!linux)(
    "lists /proc again and still inspects the entries the failed read dropped",
    async () => {
      const candidate = await spawnCandidate();
      // The candidate's entry was in the same read batch as the reaped one,
      // so the first listing never returns it.
      const directory = fakeProcDirectory([
        ["self", String(process.pid), directoryEntryError("/proc/4194301")],
        [String(process.pid), String(candidate.pid)],
      ]);

      await expect(
        discover(candidate, candidate.host(), {
          openProcDirectory: directory.openProcDirectory,
          // Two distinct PIDs: an entry counted twice would exceed this.
          maxProcessEntries: 2,
        }),
      ).resolves.toEqual([expect.objectContaining({ pid: candidate.pid })]);
      expect(directory.opens()).toBe(2);
      expect(directory.closes()).toBe(2);
    },
  );

  it("skips a reaped entry when no live entry was dropped", async () => {
    const directory = fakeProcDirectory([
      ["100", directoryEntryError("/proc/101")],
      ["100"],
    ]);

    await expect(
      findLinuxAgenCDaemonProcesses(IDLE_HOST, "/tmp/agenc-test-home", "any-install", {
        openProcDirectory: directory.openProcDirectory,
      }),
    ).resolves.toEqual([]);
    expect(directory.opens()).toBe(2);
  });

  it("fails closed when every listing loses an entry", async () => {
    const directory = fakeProcDirectory([[directoryEntryError("/proc/4194301")]]);

    await expect(
      findLinuxAgenCDaemonProcesses(IDLE_HOST, "/tmp/agenc-test-home", "any-install", {
        openProcDirectory: directory.openProcDirectory,
        maxDirectoryPasses: 3,
      }),
    ).rejects.toThrow(
      /process 4194301 was reaped while \/proc was listed and 3 listings did not complete/u,
    );
    expect(directory.opens()).toBe(3);
    expect(directory.closes()).toBe(3);
  });

  it.each([
    ["EIO from the listing itself", errno("EIO", "read")],
    ["ENOENT for a non-process entry", directoryEntryError("/proc/self")],
    ["ENOENT for a malformed PID", directoryEntryError("/proc/12a")],
    ["ENOENT below a process entry", directoryEntryError("/proc/1234/task")],
    ["ENOENT outside /proc", directoryEntryError("/tmp/1234")],
    ["ENOENT from another syscall", directoryEntryError("/proc/1234", "ENOENT", "scandir")],
    ["EACCES for a process entry", directoryEntryError("/proc/1234", "EACCES")],
  ] as const)("still fails on %s", async (_label, error) => {
    const directory = fakeProcDirectory([["100", error]]);

    await expect(
      findLinuxAgenCDaemonProcesses(IDLE_HOST, "/tmp/agenc-test-home", "any-install", {
        openProcDirectory: directory.openProcDirectory,
      }),
    ).rejects.toBe(error);
    expect(directory.opens()).toBe(1);
    expect(directory.closes()).toBe(1);
  });
});
