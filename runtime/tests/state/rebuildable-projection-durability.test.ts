import {
  appendFileSync,
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ROLLOUT_SCHEMA_VERSION } from "../../src/session/event-log.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import { backfillRolloutFile } from "../../src/state/backfill.js";
import {
  openStateDatabasePaths,
  openStateDatabases,
  type StateSqliteDriver,
} from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";

const FULL = 2;
const NORMAL = 1;
const THREAD_ID = "thread-durability";

let root: string;
let drivers: StateSqliteDriver[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-rebuildable-projection-"));
  drivers = [];
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const driver of drivers.toReversed()) driver.close();
  rmSync(root, { recursive: true, force: true });
});

function open(name = "project"): StateSqliteDriver {
  const cwd = join(root, name);
  mkdirSync(join(cwd, ".git"), { recursive: true });
  const driver = openStateDatabases({ cwd, agencHome: join(root, "home") });
  drivers.push(driver);
  return driver;
}

/** A driver over explicit database files (an image restored from disk). */
function openAt(directory: string): StateSqliteDriver {
  const driver = openStateDatabasePaths({
    projectDir: directory,
    stateDbPath: join(directory, "agenc-state_1.sqlite"),
    logsDbPath: join(directory, "agenc-logs_1.sqlite"),
  });
  drivers.push(driver);
  return driver;
}

function level(driver: StateSqliteDriver): number {
  return Number(driver.state.pragma("synchronous", { simple: true }));
}

function rolloutPath(driver: StateSqliteDriver): string {
  const directory = join(driver.projectDir, "sessions", THREAD_ID);
  mkdirSync(directory, { recursive: true });
  return join(directory, `rollout-2026-10-16T00-00-00-000Z-${THREAD_ID}.jsonl`);
}

const META = serializeRolloutItem({
  type: "session_meta",
  payload: {
    sessionId: THREAD_ID,
    timestamp: "2026-10-16T00:00:00.000Z",
    cwd: "/workspace",
    originator: "test",
    agencVersion: "0.19.0",
    rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
    model: "deepseek-v4-flash",
    modelProvider: "deepseek",
  },
});

function line(n: number): string {
  return serializeRolloutItem({
    type: "event_msg",
    payload: {
      id: `event-${n}`,
      eventId: `event-${n}`,
      seq: n,
      msg: { type: "warning", payload: { cause: "durability_test", message: `line ${n}` } },
    },
  } as never);
}

interface MirrorRow {
  readonly line_number: number;
  readonly byte_offset: number;
  readonly item_index: number;
  readonly item_type: string;
  readonly event_id: string | null;
  readonly event_seq: number | null;
  readonly payload_json: string;
  readonly line_hash: string;
}

function mirror(db: Database.Database, source: string): MirrorRow[] {
  return db
    .prepare<[string], MirrorRow>(
      `SELECT line_number, byte_offset, item_index, item_type, event_id, event_seq,
              payload_json, line_hash
       FROM thread_rollout_items WHERE source_path = ? ORDER BY line_number`,
    )
    .all(source);
}

function receipt(db: Database.Database, source: string) {
  return db
    .prepare<[string], { size: number; line_count: number; item_count: number }>(
      "SELECT size, line_count, item_count FROM backfill_files WHERE source_path = ?",
    )
    .get(source);
}

/** The projection a fresh database builds from the whole journal. */
function freshProjection(source: string): { rows: MirrorRow[]; receipt: ReturnType<typeof receipt> } {
  const scratch = open(`scratch-${Math.random().toString(36).slice(2)}`);
  backfillRolloutFile({ rolloutPath: source, threads: new StateThreadRepository(scratch) });
  return { rows: mirror(scratch.state, source), receipt: receipt(scratch.state, source) };
}

function walSize(driver: StateSqliteDriver): number {
  const wal = `${driver.stateDbPath}-wal`;
  return existsSync(wal) ? statSync(wal).size : 0;
}

/**
 * The files a power loss leaves: the database file and its WAL cut back to
 * `walBytes`, the end of the last fsynced commit. The shared-memory index is
 * not kept; SQLite rebuilds it from the WAL, as after a reboot.
 */
function powerLossImage(driver: StateSqliteDriver, walBytes: number, name: string): string {
  const image = join(root, "images", name);
  mkdirSync(image, { recursive: true });
  copyFileSync(driver.stateDbPath, join(image, "agenc-state_1.sqlite"));
  const wal = join(image, "agenc-state_1.sqlite-wal");
  copyFileSync(`${driver.stateDbPath}-wal`, wal);
  const fd = openSync(wal, "r+");
  try {
    ftruncateSync(fd, walBytes);
  } finally {
    closeSync(fd);
  }
  return image;
}

describe("rebuildable rollout projection commits", () => {
  it("commit an incremental projection at NORMAL and every other transaction at FULL", () => {
    const driver = open();
    const threads = new StateThreadRepository(driver);
    const source = rolloutPath(driver);
    writeFileSync(source, META + line(1));
    const seen: number[] = [];
    const projection = vi.spyOn(threads, "appendRolloutProjection");
    driver.transactionImmediate(() => seen.push(level(driver)));
    backfillRolloutFile({ rolloutPath: source, threads });
    expect(projection).not.toHaveBeenCalled(); // first index: full reconcile
    appendFileSync(source, line(2));
    const append = vi.spyOn(driver, "transactionImmediate");
    backfillRolloutFile({ rolloutPath: source, threads });
    expect(projection).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledWith(expect.any(Function), "rebuildable");
    driver.transactionImmediate(() => seen.push(level(driver)), "rebuildable");
    driver.transaction(() => seen.push(level(driver)));
    expect(seen).toEqual([FULL, NORMAL, FULL]);
    expect(level(driver)).toBe(FULL);
  });

  it("observe NORMAL inside the projection and FULL again after it commits or fails", () => {
    const driver = open();
    const threads = new StateThreadRepository(driver);
    const source = rolloutPath(driver);
    writeFileSync(source, META);
    backfillRolloutFile({ rolloutPath: source, threads });
    const inside: number[] = [];
    const project = (fail: boolean) =>
      threads.appendRolloutProjection({
        threadId: THREAD_ID, sourcePath: source, items: [], mtimeMs: 2, size: 1, sha256: "a".repeat(64),
        lineCount: 2, totalItemCount: 1, threadMetadata: { fallbackTimestamp: "2026-10-16T00:00:01.000Z" },
        validateCanonical: () => {
          inside.push(level(driver));
          if (fail) throw new Error("injected validation failure");
        },
      });
    project(false);
    expect(() => project(true)).toThrow("injected validation failure");
    expect(inside).toEqual([NORMAL, NORMAL]);
    expect(level(driver)).toBe(FULL);
    expect(driver.state.inTransaction).toBe(false);
  });

  it("run at the outer level when nested, and refuse a FULL transaction inside one", () => {
    const driver = open();
    const inner: number[] = [];
    driver.transactionImmediate(() => {
      driver.transactionImmediate(() => inner.push(level(driver)), "rebuildable");
    });
    expect(inner).toEqual([FULL]);
    expect(() =>
      driver.transactionImmediate(() => driver.transaction(() => undefined), "rebuildable"),
    ).toThrow("cannot nest in a relaxed transaction");
    expect(level(driver)).toBe(FULL);
  });

  it("are visible to another connection as soon as they return", () => {
    const driver = open();
    const reader = open();
    const threads = new StateThreadRepository(driver);
    const source = rolloutPath(driver);
    writeFileSync(source, META + line(1));
    backfillRolloutFile({ rolloutPath: source, threads });
    appendFileSync(source, line(2) + line(3));
    backfillRolloutFile({ rolloutPath: source, threads });
    expect(mirror(reader.state, source)).toEqual(freshProjection(source).rows);
  });

  it("stay FULL when the database is not in WAL mode", () => {
    const pragma = Database.prototype.pragma;
    vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source, options) {
      if (source === "journal_mode = WAL") return options?.simple === true ? "delete" : [{ journal_mode: "delete" }];
      return pragma.call(this, source, options as never);
    });
    const driver = open();
    vi.restoreAllMocks();
    const inside: number[] = [];
    driver.transactionImmediate(() => inside.push(level(driver)), "rebuildable");
    expect(inside).toEqual([FULL]);
  });

  it("close the connection if it cannot return to FULL", () => {
    const driver = open();
    const pragma = driver.state.pragma.bind(driver.state);
    vi.spyOn(driver.state, "pragma").mockImplementation((source, options) => {
      if (source === "synchronous = FULL") throw new Error("injected restore failure");
      return pragma(source, options as never);
    });
    expect(() => driver.transactionImmediate(() => undefined, "rebuildable")).toThrow("injected restore failure");
    expect(driver.state.open).toBe(false);
  });
});

describe("power loss after rebuildable projection commits", () => {
  it("keeps every FULL commit, drops only the projections after the last one, and backfill re-projects them", () => {
    const driver = open();
    const threads = new StateThreadRepository(driver);
    const source = rolloutPath(driver);
    writeFileSync(source, META + line(1) + line(2));
    backfillRolloutFile({ rolloutPath: source, threads }); // full reconcile: FULL
    const syncedAfterSeed = walSize(driver);
    const seeded = mirror(driver.state, source);
    for (let n = 3; n <= 8; n += 2) {
      appendFileSync(source, line(n) + line(n + 1));
      backfillRolloutFile({ rolloutPath: source, threads }); // incremental: NORMAL
    }
    expect(walSize(driver)).toBeGreaterThan(syncedAfterSeed);
    const journal = freshProjection(source);
    expect(mirror(driver.state, source)).toEqual(journal.rows);

    // Power loss before any later FULL commit: the WAL keeps only the seed.
    const lost = powerLossImage(driver, syncedAfterSeed, "before-full");
    const raw = new Database(join(lost, "agenc-state_1.sqlite"));
    try {
      expect(raw.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(mirror(raw, source)).toEqual(seeded);
      expect(receipt(raw, source)?.size).toBe(Buffer.byteLength(META + line(1) + line(2)));
    } finally {
      raw.close();
    }
    // The journal kept the lines the mirror lost; the next index re-reads them.
    const recovered = openAt(lost);
    const recoveredThreads = new StateThreadRepository(recovered);
    expect(backfillRolloutFile({ rolloutPath: source, threads: recoveredThreads })).toEqual({ itemsIndexed: 6 });
    expect(mirror(recovered.state, source)).toEqual(journal.rows);
    expect(receipt(recovered.state, source)).toEqual(journal.receipt);
    expect(recoveredThreads.getThread(THREAD_ID)).toEqual(threads.getThread(THREAD_ID));

    // A later FULL commit on any connection fsyncs the WAL up to its end,
    // including the projections committed before it.
    const other = open();
    new StateThreadRepository(other).upsertThread({
      threadId: "unrelated", createdAt: "2026-10-16T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z",
    });
    const kept = powerLossImage(driver, walSize(driver), "after-full");
    const after = new Database(join(kept, "agenc-state_1.sqlite"));
    try {
      expect(after.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(mirror(after, source)).toEqual(journal.rows);
    } finally {
      after.close();
    }
  });
});
