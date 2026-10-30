/**
 * The process-tree proof a unified exec settlement runs, checked again after
 * it failed. A member that accepted SIGKILL but cannot exit until its disk read
 * returns keeps the proof failing; once it has exited, running the same proof
 * again on the same handle passes. The manager relies on that to resume shell
 * commands instead of closing them for the rest of the session.
 */
import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { closeSync, constants, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  liveProcessTreeDescendants,
  processTreeCleanupRecheckable,
  terminateProcessTreeAndReport,
  waitForProcessTreeExit,
} from "../../src/utils/supervisedProcess.js";

const realKill = process.kill.bind(process);
let root: string | undefined;
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function alive(pid: number): boolean {
  try {
    realKill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function firstLine(stream: Readable): Promise<string> {
  let text = "";
  for await (const chunk of stream) {
    text += String(chunk);
    const newline = text.indexOf("\n");
    if (newline >= 0) return text.slice(0, newline);
  }
  return text;
}

describe("checking a failed process-tree proof again", () => {
  it("fails while a recorded member survives SIGKILL and passes once it has exited", async () => {
    if (process.platform === "win32") return;
    root = mkdtempSync(join(tmpdir(), "process-tree-recheck-"));
    const fifo = join(root, "disk");
    execFileSync("mkfifo", [fifo]);
    // The leader starts the stand-in in its own session (so a group signal
    // misses it, as one tracked only by process table identity) and idles.
    const standInSource = "require('node:fs').readFileSync(process.argv[1]); process.exit(0)";
    const leaderSource =
      "const c = require('node:child_process').spawn(process.execPath, " +
      `['-e', ${JSON.stringify(standInSource)}, ${JSON.stringify(fifo)}], { detached: true, stdio: 'ignore' });` +
      "process.stdout.write(String(c.pid) + '\\n'); setInterval(() => {}, 1000);";
    const leader: ChildProcessByStdio<null, Readable, null> = spawn(
      process.execPath,
      ["-e", leaderSource],
      { detached: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    cleanups.push(() => {
      try { realKill(-leader.pid!, "SIGKILL"); } catch { /* already gone */ }
    });
    const standInPid = Number(await firstLine(leader.stdout));
    expect(standInPid).toBeGreaterThan(1);
    cleanups.push(() => {
      if (alive(standInPid)) realKill(standInPid, "SIGKILL");
    });

    // It accepted every signal but cannot act on one until its read returns,
    // like a process blocked in uninterruptible disk I/O.
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (Math.abs(pid) === standInPid && signal !== 0 && signal !== undefined) return true;
      return realKill(pid, signal);
    }) as typeof process.kill);

    await expect(
      terminateProcessTreeAndReport(leader, { label: "probe", terminateGraceMs: 50, killGraceMs: 100 }),
    ).rejects.toThrow(new RegExp(`probe tree survived forced shutdown .*live descendants: ${standInPid}`, "u"));
    expect(liveProcessTreeDescendants(leader)).toEqual([standInPid]);
    expect(processTreeCleanupRecheckable(leader)).toBe(true);

    // Checked again while it still runs: still not proven.
    await expect(
      terminateProcessTreeAndReport(leader, { label: "probe", terminateGraceMs: 0, killGraceMs: 0 }),
    ).rejects.toThrow(/survived forced shutdown/u);

    // The read returns and it exits.
    closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    const deadline = Date.now() + 5_000;
    while (alive(standInPid) && Date.now() < deadline) await delay(20);
    expect(alive(standInPid)).toBe(false);

    await expect(
      terminateProcessTreeAndReport(leader, { label: "probe", terminateGraceMs: 0, killGraceMs: 0 }),
    ).resolves.toMatchObject({ residualProcessesTerminated: false });
    expect(liveProcessTreeDescendants(leader)).toEqual([]);
  }, 20_000);
});

describe("waiting for a process tree to exit", () => {
  it("polls fast at first and backs off during a long wait", async () => {
    vi.useFakeTimers();
    let polls = 0;
    // No pid: the liveness check reads only the exit state, once per poll.
    const child = {
      pid: undefined,
      get exitCode() {
        polls += 1;
        return null;
      },
      signalCode: null,
    };
    let settled: boolean | undefined;
    void waitForProcessTreeExit(child, 10_000).then((result) => {
      settled = result;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    // A tree that exits within a second is still seen within ~20 ms.
    expect(polls).toBeGreaterThanOrEqual(40);
    const fastPolls = polls;
    await vi.advanceTimersByTimeAsync(8_900);
    expect(settled).toBeUndefined();
    await vi.advanceTimersByTimeAsync(200);
    expect(settled).toBe(false);
    // On Darwin each poll runs `ps`; at the fast rate the whole wait would
    // have taken about 500 of them.
    expect(polls - fastPolls).toBeLessThanOrEqual(40);
  });
});
