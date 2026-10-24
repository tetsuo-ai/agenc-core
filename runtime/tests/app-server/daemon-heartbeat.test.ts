import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENC_DAEMON_HEARTBEAT_FRESH_MS,
  claimAbandonedDaemonHeartbeat,
  describeAbandonedDaemonExit,
  describeClaimedDaemonExit,
  describeDaemonHeartbeat,
  describeUnboundDaemonHeartbeat,
  installAgenCDaemonHeartbeat,
  isDaemonHeartbeatFresh,
  readAgenCDaemonHeartbeat,
  reportLastDaemonHeartbeat,
  resolveAgenCDaemonHeartbeatPath,
  resolveAgenCDaemonPreviousHeartbeatPath,
} from "../../src/app-server/daemon-heartbeat.js";

// #2199: a daemon that dies in a way no handler can see leaves its last
// heartbeat behind, and `status` reports it beside "stopped".

let home = "";
let path = "";
const proc = {
  pid: 4242,
  memoryUsage: () => ({ rss: 600 * 1_048_576, heapUsed: 250 * 1_048_576 }),
  uptime: () => 1_620,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T12:39:00.000Z"));
  home = mkdtempSync(join(tmpdir(), "agenc-heartbeat-"));
  path = resolveAgenCDaemonHeartbeatPath(home);
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

describe("daemon heartbeat", () => {
  // #2225: the replacement daemon's heartbeat while it recovers, before its identity is published.
  const unbound = {
    pid: 149,
    beat: 45,
    at: "2026-09-06T12:38:57.000Z",
    uptimeS: 225,
    rssMb: 950,
    heapUsedMb: 700,
    eventLoopLagMs: 12,
  };

  // #2225: a daemon that is beating but has not published its identity is
  // reported as alive and not yet bound, not as indeterminate.
  it("treats a heartbeat within three intervals as fresh and older ones as stale", () => {
    const sent = Date.parse(unbound.at);
    const heartbeat = unbound;
    expect(isDaemonHeartbeatFresh(heartbeat, sent)).toBe(true);
    expect(isDaemonHeartbeatFresh(heartbeat, sent + AGENC_DAEMON_HEARTBEAT_FRESH_MS)).toBe(true);
    expect(isDaemonHeartbeatFresh(heartbeat, sent + AGENC_DAEMON_HEARTBEAT_FRESH_MS + 1)).toBe(false);
    // A clock that runs behind the writer must not turn a live daemon stale.
    expect(isDaemonHeartbeatFresh(heartbeat, sent - 60_000)).toBe(true);
  });

  it("describes an unbound daemon with its pid, the pending identity and its vitals", () => {
    const text = describeUnboundDaemonHeartbeat(unbound, Date.parse("2026-09-06T12:39:00.000Z"));
    expect(text.split("\n").filter(Boolean)).toEqual([
      "AgenC daemon alive but not yet bound (pid 149)",
      "  identity: not published yet (still starting, or the runtime record was removed); lifecycle commands wait for it",
      "  heartbeat: 3 s ago, rss 950 MB, heap 700 MB, event-loop lag 12 ms, up 4 min",
    ]);
  });

  it("writes a beat at once and on every interval, with pid, memory and lag", async () => {
    const dispose = installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc });
    try {
      expect(readAgenCDaemonHeartbeat(path)).toMatchObject({
        pid: 4242,
        beat: 1,
        rssMb: 600,
        heapUsedMb: 250,
        uptimeS: 1_620,
        eventLoopLagMs: 0,
      });
      vi.advanceTimersByTime(1_000);
      await dispose.idle();
      vi.advanceTimersByTime(1_000);
      await dispose.idle();
      const third = readAgenCDaemonHeartbeat(path);
      expect(third?.beat).toBe(3);
      expect(third?.at).toBe("2026-09-06T12:39:02.000Z");
    } finally {
      dispose();
    }
  });

  it("measures a late tick as event-loop lag", async () => {
    let drift = 0;
    const dispose = installAgenCDaemonHeartbeat({
      path,
      intervalMs: 1_000,
      proc,
      now: () => Date.now() + drift,
    });
    try {
      drift = 700; // the loop was busy; this tick observes the clock 700 ms late
      vi.advanceTimersByTime(1_000);
      await dispose.idle();
      expect(readAgenCDaemonHeartbeat(path)?.eventLoopLagMs).toBe(700);
    } finally {
      dispose();
    }
  });

  // og: the interval beat's fsyncs used to run on the event loop, so a slow
  // disk stalled every request the daemon served for the length of an fsync.
  it("writes interval beats off the event loop", async () => {
    const dispose = installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc });
    try {
      vi.advanceTimersByTime(1_000);
      // The tick returned before anything was written: the file still holds
      // the first beat until the thread-pool write completes.
      expect(readAgenCDaemonHeartbeat(path)?.beat).toBe(1);
      await dispose.idle();
      expect(readAgenCDaemonHeartbeat(path)?.beat).toBe(2);
    } finally {
      dispose();
    }
  });

  it("skips a tick while the previous beat is still being written", async () => {
    const dispose = installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc });
    try {
      vi.advanceTimersByTime(1_000);
      vi.advanceTimersByTime(1_000);
      await dispose.idle();
      expect(readAgenCDaemonHeartbeat(path)?.beat).toBe(2);
      vi.advanceTimersByTime(1_000);
      await dispose.idle();
      expect(readAgenCDaemonHeartbeat(path)?.beat).toBe(3);
    } finally {
      dispose();
    }
  });

  it("publishes nothing for a beat still in flight when it stops", async () => {
    const errors: unknown[] = [];
    const dispose = installAgenCDaemonHeartbeat({
      path, intervalMs: 1_000, proc, onError: (error) => errors.push(error),
    });
    vi.advanceTimersByTime(1_000);
    dispose();
    expect(existsSync(path)).toBe(false);
    await dispose.idle();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(home).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("removes its own file on a clean stop and leaves another process's alone", () => {
    const dispose = installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc });
    dispose();
    expect(existsSync(path)).toBe(false);
    writeFileSync(path, JSON.stringify({ ...readOrSample(), pid: 99 }));
    const disposeAgain = installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc });
    // The install overwrote the file with pid 4242; a later foreign write survives the disposer.
    writeFileSync(path, JSON.stringify({ ...readOrSample(), pid: 99 }));
    disposeAgain();
    expect(readAgenCDaemonHeartbeat(path)?.pid).toBe(99);
  });

  it("rejects a malformed file", () => {
    writeFileSync(path, "{not json");
    expect(readAgenCDaemonHeartbeat(path)).toBeNull();
    writeFileSync(path, JSON.stringify({ pid: "4242", beat: 1, at: "x" }));
    expect(readAgenCDaemonHeartbeat(path)).toBeNull();
  });

  it("reports the vanished daemon's last heartbeat for its pid only", () => {
    installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc })();
    writeFileSync(path, `${JSON.stringify(readOrSample())}\n`);
    vi.setSystemTime(new Date("2026-09-06T12:39:45.000Z"));
    const lines: string[] = [];
    const io = { stderr: { write: (text: string) => lines.push(text) } };
    expect(reportLastDaemonHeartbeat(io, path, 4242)).toBe(true);
    expect(lines[0]).toContain("pid 4242");
    expect(lines[0]).toContain("45 s ago");
    expect(lines[0]).toContain("rss 600 MB");
    expect(lines[0]).toContain("event-loop lag 0 ms");
    expect(lines[0]).toContain("up 27 min");
    expect(reportLastDaemonHeartbeat(io, path, 1)).toBe(false);
    expect(reportLastDaemonHeartbeat(io, path, null)).toBe(true);
    expect(lines).toHaveLength(2);
  });

  // #2199: the replacement's first beat used to overwrite the record of the
  // exit it was replacing, three seconds after it happened.
  describe("the heartbeat of the daemon this one replaced", () => {
    it("keeps a dead daemon's heartbeat where the next beat cannot reach it", () => {
      const previousPath = resolveAgenCDaemonPreviousHeartbeatPath(home);
      writeFileSync(path, JSON.stringify({ ...readOrSample(), pid: 79303 }));
      const claimed = claimAbandonedDaemonHeartbeat({
        path,
        previousPath,
        pid: proc.pid,
        isPidRunning: () => false,
      });
      expect(claimed?.heartbeat.pid).toBe(79303);
      expect(claimed?.keptPath).toBe(previousPath);
      expect(existsSync(path)).toBe(false);
      const dispose = installAgenCDaemonHeartbeat({ path, intervalMs: 1_000, proc });
      try {
        expect(readAgenCDaemonHeartbeat(path)?.pid).toBe(proc.pid);
        expect(readAgenCDaemonHeartbeat(previousPath)?.pid).toBe(79303);
      } finally {
        dispose();
      }
      // A clean stop removes this daemon's beat, never the kept exit.
      expect(readAgenCDaemonHeartbeat(previousPath)?.pid).toBe(79303);
    });

    it("describes the exit with the dead pid, the age and its last vitals", () => {
      expect(
        describeAbandonedDaemonExit(
          { ...readOrSample(), pid: 79303 },
          Date.parse("2026-09-06T12:39:45.000Z"),
        ),
      ).toBe(
        "the previous daemon (pid 79303) exited without recording a reason; " +
          "its last heartbeat was at 2026-09-06T12:39:00.000Z, 45 s ago: " +
          "rss 600 MB, heap 250 MB, event-loop lag 0 ms, up 27 min",
      );
    });

    it("leaves a live daemon's heartbeat, its own, and an absent one alone", () => {
      const previousPath = resolveAgenCDaemonPreviousHeartbeatPath(home);
      const claim = (isPidRunning: (pid: number) => boolean) =>
        claimAbandonedDaemonHeartbeat({ path, previousPath, pid: proc.pid, isPidRunning });
      expect(claim(() => false)).toBeNull(); // no heartbeat on disk
      // A takeover starts beside a running daemon: its file is still in use.
      writeFileSync(path, JSON.stringify({ ...readOrSample(), pid: 79303 }));
      expect(claim((pid) => pid === 79303)).toBeNull();
      expect(readAgenCDaemonHeartbeat(path)?.pid).toBe(79303);
      // A restart that reuses this process's own pid has nothing to report.
      writeFileSync(path, JSON.stringify(readOrSample()));
      expect(claim(() => false)).toBeNull();
      expect(existsSync(previousPath)).toBe(false);
    });

    it("does not report an exit a racing daemon already claimed", () => {
      const claimed = claimAbandonedDaemonHeartbeat({
        path,
        // An unwritable directory stands in for the rename another starting
        // daemon won: the file is gone from under this one either way.
        previousPath: join(home, "missing-dir", "daemon-heartbeat.prev.json"),
        pid: proc.pid,
        isPidRunning: () => false,
      });
      expect(claimed).toBeNull();
      writeFileSync(path, JSON.stringify({ ...readOrSample(), pid: 79303 }));
      const stillOnDisk = claimAbandonedDaemonHeartbeat({
        path,
        previousPath: join(home, "missing-dir", "daemon-heartbeat.prev.json"),
        pid: proc.pid,
        isPidRunning: () => false,
      });
      // The rename failed but the evidence is still there and about to be
      // overwritten, so it is reported rather than lost in silence.
      expect(stillOnDisk?.heartbeat.pid).toBe(79303);
      expect(stillOnDisk?.keptPath).toBeNull();
    });

    // The line used to name the kept file whether or not the keep worked, so
    // an operator whose `.prev.json` could not be written was sent to a path
    // holding nothing.
    it("names the kept file only when the heartbeat was kept", () => {
      const heartbeat = { ...readOrSample(), pid: 79303 };
      const nowMs = Date.parse("2026-09-06T12:39:45.000Z");
      expect(
        describeClaimedDaemonExit({ heartbeat, keptPath: "/tmp/kept.json" }, nowMs),
      ).toBe(`${describeAbandonedDaemonExit(heartbeat, nowMs)}; kept at /tmp/kept.json`);
      expect(describeClaimedDaemonExit({ heartbeat, keptPath: null }, nowMs)).toBe(
        `${describeAbandonedDaemonExit(heartbeat, nowMs)}; ` +
          "it could not be kept, so this line is all that is left of it",
      );
    });

    // Nothing expires the kept record: it is still being read when its age has
    // run into days, where raw seconds say nothing.
    it("writes the age of a long-kept exit the way it writes uptime", () => {
      const heartbeat = { ...readOrSample(), pid: 79303 };
      const at = Date.parse(heartbeat.at);
      const ageIn = (ms: number) =>
        describeAbandonedDaemonExit(heartbeat, at + ms).match(/at \S+, (.+) ago:/)?.[1];
      expect(ageIn(45_000)).toBe("45 s");
      expect(ageIn(95_000)).toBe("1 min");
      expect(ageIn(3 * 3_600_000 + 20 * 60_000)).toBe("3 h 20 min");
      expect(ageIn(2 * 3_600_000)).toBe("2 h");
      expect(ageIn(31 * 86_400_000)).toBe("31 d");
      expect(ageIn(31 * 86_400_000 + 5 * 3_600_000)).toBe("31 d 5 h");
    });
  });

  it("describes long uptimes in hours", () => {
    const text = describeDaemonHeartbeat(
      { ...readOrSample(), uptimeS: 2 * 3600 + 5 * 60 },
      Date.parse("2026-09-06T12:39:00.000Z"),
    );
    expect(text).toContain("up 2 h 5 min");
  });
});

function readOrSample() {
  return {
    pid: 4242,
    beat: 7,
    at: "2026-09-06T12:39:00.000Z",
    uptimeS: 1_620,
    rssMb: 600,
    heapUsedMb: 250,
    eventLoopLagMs: 0,
  };
}
