import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  HEAP_WARN_RATIO,
  RECENT_SNAPSHOT_NOTICE_MS,
  SNAPSHOTS_TO_KEEP,
  classifyHeapPressure,
  isSnapshotFileName,
  newestSnapshot,
  oomSnapshotDir,
  pruneSnapshots,
  recentOomSnapshotNotice,
  startHeapWatchdog,
} from "../../src/services/heapWatchdog/heapWatchdog.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-heapwd-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Write a snapshot-looking file with a controlled mtime. */
function writeSnap(dir: string, name: string, mtime: Date): string {
  const path = join(dir, name);
  writeFileSync(path, "x");
  utimesSync(path, mtime, mtime);
  return path;
}

describe("classifyHeapPressure", () => {
  it("maps ratios onto normal/warn", () => {
    expect(classifyHeapPressure(0, 1000)).toBe("normal");
    expect(classifyHeapPressure(HEAP_WARN_RATIO * 1000 - 1, 1000)).toBe(
      "normal",
    );
    expect(classifyHeapPressure(HEAP_WARN_RATIO * 1000, 1000)).toBe("warn");
  });

  it("treats a missing limit as normal", () => {
    expect(classifyHeapPressure(500, 0)).toBe("normal");
  });
});

describe("snapshot housekeeping", () => {
  it("recognizes V8 near-heap-limit snapshot names", () => {
    expect(isSnapshotFileName("Heap.20260714.231306.18573.0.001.heapsnapshot")).toBe(true);
    expect(isSnapshotFileName("daemon.log")).toBe(false);
  });

  it("pruneSnapshots keeps only the newest N by mtime", () => {
    const dir = oomSnapshotDir(home);
    mkdirSync(dir, { recursive: true });
    const names = [1, 2, 3, 4].map((d) => `Heap.2026010${d}.0.1.0.00${d}.heapsnapshot`);
    names.forEach((name, i) =>
      writeSnap(dir, name, new Date(Date.UTC(2026, 0, i + 1))),
    );
    writeFileSync(join(dir, "unrelated.txt"), "keep me");
    pruneSnapshots(dir, SNAPSHOTS_TO_KEEP);
    const left = readdirSync(dir).sort();
    expect(left).toContain("unrelated.txt");
    expect(left.filter(isSnapshotFileName).sort()).toEqual(
      names.slice(-SNAPSHOTS_TO_KEEP).sort(),
    );
  });

  it("newestSnapshot returns the most recent by mtime", () => {
    const dir = oomSnapshotDir(home);
    mkdirSync(dir, { recursive: true });
    writeSnap(dir, "Heap.a.heapsnapshot", new Date(Date.UTC(2026, 0, 1)));
    const newer = writeSnap(
      dir,
      "Heap.b.heapsnapshot",
      new Date(Date.UTC(2026, 0, 2)),
    );
    expect(newestSnapshot(home)?.path).toBe(newer);
  });
});

describe("recentOomSnapshotNotice", () => {
  it("returns null with no snapshots", () => {
    expect(recentOomSnapshotNotice(home)).toBeNull();
  });

  it("mentions a fresh snapshot and goes quiet once it ages out", () => {
    const dir = oomSnapshotDir(home);
    mkdirSync(dir, { recursive: true });
    const mtime = new Date();
    const path = writeSnap(dir, "Heap.now.heapsnapshot", mtime);
    const notice = recentOomSnapshotNotice(home, mtime.getTime() + 60_000);
    expect(notice).toContain(path);
    expect(
      recentOomSnapshotNotice(
        home,
        mtime.getTime() + RECENT_SNAPSHOT_NOTICE_MS + 60_000,
      ),
    ).toBeNull();
  });
});

describe("startHeapWatchdog", () => {
  it("warns once per crossing and resets on recovery", () => {
    const warns: string[] = [];
    let used = 0;
    const wd = startHeapWatchdog({
      agencHome: home,
      warn: (m) => warns.push(m),
      heapStats: () => ({ usedBytes: used, limitBytes: 1000 }),
      intervalMs: 60_000,
    });
    expect(wd.checkOnce()).toBe("normal");
    used = 800; // warn zone
    expect(wd.checkOnce()).toBe("warn");
    expect(wd.checkOnce()).toBe("warn");
    expect(warns.filter((w) => w.includes("heap usage high"))).toHaveLength(1);
    used = 100; // recover
    expect(wd.checkOnce()).toBe("normal");
    used = 800; // cross again → warn again
    wd.checkOnce();
    expect(warns.filter((w) => w.includes("heap usage high"))).toHaveLength(2);
    wd.stop();
  });

  it("prunes accumulated snapshots at start", () => {
    const dir = oomSnapshotDir(home);
    mkdirSync(dir, { recursive: true });
    for (let d = 1; d <= 5; d++) {
      writeSnap(
        dir,
        `Heap.2026010${d}.heapsnapshot`,
        new Date(Date.UTC(2026, 0, d)),
      );
    }
    const wd = startHeapWatchdog({
      agencHome: home,
      warn: () => {},
      heapStats: () => ({ usedBytes: 0, limitBytes: 1000 }),
      intervalMs: 60_000,
    });
    wd.stop();
    expect(readdirSync(dir).filter(isSnapshotFileName).length).toBe(
      SNAPSHOTS_TO_KEEP,
    );
  });

  it("survives throwing stats", () => {
    const wd = startHeapWatchdog({
      agencHome: home,
      warn: () => {},
      heapStats: () => {
        throw new Error("boom");
      },
      intervalMs: 60_000,
    });
    expect(() => wd.checkOnce()).not.toThrow();
    wd.stop();
  });
});
