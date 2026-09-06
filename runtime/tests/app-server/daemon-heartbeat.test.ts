import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  describeDaemonHeartbeat,
  installAgenCDaemonHeartbeat,
  readAgenCDaemonHeartbeat,
  reportLastDaemonHeartbeat,
  resolveAgenCDaemonHeartbeatPath,
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
  it("writes a beat at once and on every interval, with pid, memory and lag", () => {
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
      vi.advanceTimersByTime(2_000);
      const third = readAgenCDaemonHeartbeat(path);
      expect(third?.beat).toBe(3);
      expect(third?.at).toBe("2026-09-06T12:39:02.000Z");
    } finally {
      dispose();
    }
  });

  it("measures a late tick as event-loop lag", () => {
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
      expect(readAgenCDaemonHeartbeat(path)?.eventLoopLagMs).toBe(700);
    } finally {
      dispose();
    }
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
