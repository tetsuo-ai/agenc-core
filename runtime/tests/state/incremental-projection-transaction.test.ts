import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStateDatabases, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { StateThreadRepository } from "../../src/state/threads.js";

type Projection = Parameters<StateThreadRepository["appendRolloutProjection"]>[0];
const threadId = "projection-thread";
const sourcePath = "/canonical/rollout-projection-thread.jsonl";
const createdAt = "2026-10-01T00:00:00.000Z";
const updatedAt = "2026-10-02T00:00:00.000Z";
const fallbackTimestamp = "2026-10-03T00:00:00.000Z";
let root: string;
let driver: StateSqliteDriver;
let baseline: StateSqliteDriver;
let connections: StateSqliteDriver[];

function open(name: string): StateSqliteDriver {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  const result = openStateDatabases({ cwd, agencHome: join(root, "home") });
  connections.push(result);
  return result;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-incremental-projection-"));
  connections = [];
  driver = open("actual");
  baseline = open("baseline");
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of connections.toReversed()) connection.close();
  rmSync(root, { recursive: true, force: true });
});

function seed(db: StateSqliteDriver): StateThreadRepository {
  const threads = new StateThreadRepository(db);
  threads.upsertThread({
    threadId, createdAt, updatedAt, rolloutPath: sourcePath,
    name: "User name", model: "User model", modelProvider: "provider",
    memoryMode: "enabled", cwd: "/workspace", source: { type: "cli" },
  });
  threads.replaceRolloutItems({
    threadId, sourcePath, mtimeMs: 1, size: 10, sha256: "a".repeat(64), lineCount: 2,
    items: [{ lineNumber: 1, byteOffset: 0, itemIndex: 0, itemType: "response_item",
      payloadJson: '{"role":"user","content":"prefix"}', lineHash: "b".repeat(64) }],
    canonicalMarker: { epoch: "test", size: 10, mtimeMs: 1,
      sha256: "a".repeat(64), dev: "1", ino: "2" },
  });
  db.prepareState("UPDATE threads SET originator = 'retained-originator' WHERE thread_id = ?").run(threadId);
  return threads;
}

function projection(overrides: Partial<Projection> = {}): Projection {
  return {
    threadId, sourcePath, mtimeMs: 2, size: 30, sha256: "a".repeat(64),
    lineCount: 4, totalItemCount: 3,
    items: [2, 3].map((lineNumber) => ({
      lineNumber, byteOffset: (lineNumber - 1) * 10, itemIndex: lineNumber - 1,
      itemType: "event_msg", eventVersion: 1, eventId: `event-${lineNumber}`,
      eventSeq: lineNumber, payloadJson: JSON.stringify({ id: `event-${lineNumber}` }),
      lineHash: String(lineNumber).repeat(64),
    })),
    threadMetadata: { fallbackTimestamp }, validateCanonical: () => {},
    ...overrides,
  };
}

/** The previous public composition, retained here as a semantic oracle. */
function oldRoute(threads: StateThreadRepository, params: Projection): void {
  threads.commitRolloutProjection(() => {
    const prior = threads.getThread(params.threadId);
    const meta = params.threadMetadata;
    threads.mergeThread({
      threadId: params.threadId,
      createdAt: meta.createdAt ?? prior?.createdAt ?? meta.fallbackTimestamp,
      updatedAt: meta.updatedAt ?? prior?.updatedAt ?? meta.fallbackTimestamp,
      cwd: meta.cwd, source: meta.source, model: meta.model,
      modelProvider: meta.modelProvider, memoryMode: meta.memoryMode,
      ...(meta.archived === true
        ? { archivedAt: meta.fallbackTimestamp, archivedRolloutPath: params.sourcePath }
        : { rolloutPath: params.sourcePath }),
    }, { replaceArchiveState: meta.archived !== undefined });
    threads.appendRolloutItems(params);
  }, params.validateCanonical);
}

function snapshot(db: StateSqliteDriver, exact = false): Record<string, unknown> {
  return Object.fromEntries(["threads", "thread_rollout_items", "backfill_files", "rollout_receipts"].map((table) => [
    table,
    db.prepareState<[], Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY rowid`).all().map((row) =>
      exact ? row : Object.fromEntries(Object.entries(row).filter(([key]) =>
        key !== "id" && key !== "imported_at"))),
  ]));
}

function sameAsOld(params: Projection, prepare?: (db: StateSqliteDriver) => void): void {
  const expected = seed(baseline);
  const actual = seed(driver);
  prepare?.(baseline);
  prepare?.(driver);
  oldRoute(expected, params);
  actual.appendRolloutProjection(params);
  expect(snapshot(driver)).toEqual(snapshot(baseline));
  expect(actual.getCanonicalProjectionMarker(params.sourcePath)).toBeUndefined();
}

describe("atomic incremental rollout projection", () => {
  it("matches the previous composition and retains the incremental digest", () => {
    sameAsOld(projection());
    const threads = new StateThreadRepository(driver);
    expect(threads.getThread(threadId)).toMatchObject({ createdAt, updatedAt });
    expect(threads.getBackfillFile(sourcePath)?.sha256).toBe("a".repeat(64));
  });

  it("reads current metadata once inside its only transaction and skips an identical upsert", () => {
    const threads = seed(driver);
    const immediate = vi.spyOn(driver, "transactionImmediate");
    const nested = vi.spyOn(driver, "transaction");
    const prepare = vi.spyOn(driver, "prepareState");
    const validate = vi.fn(() => expect(driver.state.inTransaction).toBe(true));
    threads.appendRolloutProjection(projection({ validateCanonical: validate }));
    const statements = prepare.mock.calls.map(([sql]) => sql);
    expect(immediate).toHaveBeenCalledTimes(1);
    expect(nested).not.toHaveBeenCalled();
    expect(statements.filter((sql) => /FROM threads\s+WHERE thread_id/.test(sql))).toHaveLength(1);
    expect(statements.filter((sql) => /INSERT INTO threads\s*\(/.test(sql))).toHaveLength(0);
    expect(validate).toHaveBeenCalledOnce();
    expect(driver.state.inTransaction).toBe(false);
  });

  it.each([
    { source: "not json", memory: "enabled" },
    { source: '{ "type" : "cli" }', memory: "enabled" },
    { source: '{"type":"cli"}', memory: "invalid" },
    { source: "null", memory: null },
    { source: null, memory: "disabled" },
  ])("preserves source/memory normalization for $source and $memory", ({ source, memory }) => {
    sameAsOld(projection(), (db) => {
      db.prepareState("UPDATE threads SET source_json = ?, memory_mode = ? WHERE thread_id = ?")
        .run(source, memory, threadId);
    });
  });

  it("updates metadata and the source path when their persisted columns change", () => {
    sameAsOld(projection({
      sourcePath: `${sourcePath}.relocated`,
      threadMetadata: { fallbackTimestamp, createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: fallbackTimestamp, cwd: "/changed", source: { type: "app-server" },
        model: "meta-model", modelProvider: "meta-provider", memoryMode: "disabled" },
    }));
    expect(new StateThreadRepository(driver).getThread(threadId)).toMatchObject({
      name: "User name", model: "meta-model", updatedAt: fallbackTimestamp,
      rolloutPath: `${sourcePath}.relocated`,
    });
  });

  it("creates a missing thread with the captured fallback timestamp", () => {
    const params = projection({ threadId: "new-thread", sourcePath: "/canonical/new.jsonl" });
    oldRoute(new StateThreadRepository(baseline), params);
    new StateThreadRepository(driver).appendRolloutProjection(params);
    expect(snapshot(driver)).toEqual(snapshot(baseline));
    expect(new StateThreadRepository(driver).getThread("new-thread")).toMatchObject({
      createdAt: fallbackTimestamp, updatedAt: fallbackTimestamp,
    });
  });

  for (const archived of [undefined, false, true]) {
    for (const pendingCleanup of [false, true]) {
      it(`preserves archive=${String(archived)} and pending cleanup=${pendingCleanup}`, () => {
        sameAsOld(projection({ threadMetadata: { fallbackTimestamp, archived } }), (db) => {
          db.prepareState(`UPDATE threads SET archived_at = ?, archived_rollout_path = ?,
            archive_cleanup_generation = ? WHERE thread_id = ?`)
            .run(pendingCleanup ? null : createdAt, "/archive/old.jsonl", "generation-1", threadId);
        });
      });
    }
  }

  it("reads another connection's committed metadata and archive changes afresh", () => {
    const threads = seed(driver);
    threads.appendRolloutProjection(projection());
    const external = open("actual");
    const other = new StateThreadRepository(external);
    other.upsertThread({ ...other.getThread(threadId)!, name: "External name", model: "External model",
      source: { type: "app-server" }, archivedAt: fallbackTimestamp,
      archivedRolloutPath: "/archive/external.jsonl", archiveCleanupGeneration: "external-generation" });
    const changed = other.getThread(threadId);
    threads.appendRolloutProjection(projection({
      items: [], mtimeMs: 3, lineCount: 4, totalItemCount: 3,
    }));
    expect(threads.getThread(threadId)).toEqual(changed);
  });

  it.each(["row", "receipt", "validation"] as const)("rolls back all derived writes on %s failure", (failure) => {
    const threads = seed(driver);
    const before = snapshot(driver, true);
    if (failure === "row") {
      driver.state.exec(`CREATE TEMP TRIGGER fail_projection BEFORE INSERT ON thread_rollout_items
        WHEN NEW.line_number = 3 BEGIN SELECT RAISE(ABORT, 'injected row failure'); END`);
    } else if (failure === "receipt") {
      driver.state.exec(`CREATE TEMP TRIGGER fail_projection BEFORE INSERT ON rollout_receipts
        BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`);
    }
    const params = projection({
      threadMetadata: { fallbackTimestamp, model: "rolled-back model" },
      validateCanonical: () => {
        if (failure === "validation") throw new Error("injected validation failure");
      },
    });
    expect(() => threads.appendRolloutProjection(params)).toThrow(/injected/);
    expect(snapshot(driver, true)).toEqual(before);
    if (failure !== "validation") driver.state.exec("DROP TRIGGER fail_projection");
    threads.appendRolloutProjection({ ...params, validateCanonical: () => {} });
    expect(new StateThreadRepository(driver).getThread(threadId)?.model).toBe("rolled-back model");
    expect(driver.prepareState<[], { n: number }>("SELECT count(*) AS n FROM thread_rollout_items").get()?.n).toBe(3);
    expect(threads.getCanonicalProjectionMarker(sourcePath)).toBeUndefined();
  });

  it("keeps its entire projection invisible to a second connection until final validation returns", () => {
    const threads = seed(driver);
    const external = open("actual");
    const before = snapshot(external, true);
    threads.appendRolloutProjection(projection({
      threadMetadata: { fallbackTimestamp, model: "committed model" },
      validateCanonical: () => {
        expect(snapshot(external, true)).toEqual(before);
        expect(new StateThreadRepository(driver).getThread(threadId)?.model).toBe("committed model");
      },
    }));
    expect(new StateThreadRepository(external).getThread(threadId)?.model).toBe("committed model");
    expect(new StateThreadRepository(external).getBackfillFile(sourcePath)?.itemCount).toBe(3);
  });

  it("keeps the public append savepoint when an outer caller catches its failure", () => {
    const threads = seed(driver);
    const before = snapshot(driver, true);
    driver.state.exec(`CREATE TEMP TRIGGER fail_projection BEFORE INSERT ON thread_rollout_items
      WHEN NEW.line_number = 3 BEGIN SELECT RAISE(ABORT, 'injected row failure'); END`);
    driver.transactionImmediate(() => {
      expect(() => threads.appendRolloutItems(projection())).toThrow(/injected row failure/);
      threads.upsertThread({ threadId: "unrelated", createdAt, updatedAt, name: "committed after catch" });
    });
    expect(new StateThreadRepository(driver).getThread("unrelated")?.name).toBe("committed after catch");
    const after = snapshot(driver, true);
    expect(after.thread_rollout_items).toEqual(before.thread_rollout_items);
    expect(after.backfill_files).toEqual(before.backfill_files);
    expect(after.rollout_receipts).toEqual(before.rollout_receipts);
  });
});
