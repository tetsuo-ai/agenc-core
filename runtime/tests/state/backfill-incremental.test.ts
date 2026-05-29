import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLLOUT_SCHEMA_VERSION } from "../session/event-log.js";
import { serializeRolloutItem } from "../session/rollout-item.js";
import { backfillRolloutFile } from "./backfill.js";
import { StateThreadRepository } from "./threads.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";

let home = "";
let cwd = "";
let originalAgencHome = "";
let driver: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-incr-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-incr-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = home;
  driver = openStateDatabases({ cwd });
});

afterEach(() => {
  vi.restoreAllMocks();
  driver.close();
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

function makeRolloutPath(): string {
  const sessionDir = join(driver.projectDir, "sessions", "thread-1");
  mkdirSync(sessionDir, { recursive: true });
  return join(sessionDir, "rollout-2026-04-29T00-00-00-000Z-thread-1.jsonl");
}

const META = serializeRolloutItem({
  type: "session_meta",
  payload: {
    sessionId: "thread-1",
    timestamp: "2026-04-29T00:00:00.000Z",
    cwd: "/tmp/work",
    originator: "test",
    agencVersion: "0.2.0",
    rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
    model: "grok-4",
    modelProvider: "xai",
  },
});

function itemLine(n: number): string {
  return serializeRolloutItem({
    type: "response_item",
    payload: { role: "user", content: `msg-${n}` },
  });
}

function rowCount(): number {
  return (
    driver
      .prepareState<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM thread_rollout_items",
      )
      .get()?.count ?? -1
  );
}

describe("backfillRolloutFile incremental append", () => {
  it("does not re-INSERT all prior rows on each append", () => {
    const rolloutPath = makeRolloutPath();
    const threads = new StateThreadRepository(driver);

    // Spy on the two index code paths so we can prove only the appended tail
    // is INSERTed after the first full index.
    const replaceSpy = vi.spyOn(threads, "replaceRolloutItems");
    const appendSpy = vi.spyOn(threads, "appendRolloutItems");

    // Initial file: session_meta + 1 item => 2 rows, full reconcile.
    writeFileSync(rolloutPath, META + itemLine(0));
    expect(backfillRolloutFile({ rolloutPath, threads })).toEqual({
      itemsIndexed: 2,
    });
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(0);
    expect(rowCount()).toBe(2);

    // N sequential appends. Each must take the incremental path and only
    // index the single new line — never a full reconcile, never re-touching
    // the prior rows.
    const N = 8;
    for (let i = 1; i <= N; i += 1) {
      appendFileSync(rolloutPath, itemLine(i));
      const result = backfillRolloutFile({ rolloutPath, threads });
      // Work is bounded per append: exactly one new item indexed.
      expect(result).toEqual({ itemsIndexed: 1 });
    }

    // Full reconcile ran exactly once (the initial index); every append used
    // the incremental path.
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(appendSpy).toHaveBeenCalledTimes(N);
    for (const call of appendSpy.mock.calls) {
      expect(call[0]?.items.length).toBe(1);
    }

    // Final indexed state is still complete and correctly ordered.
    expect(rowCount()).toBe(2 + N);
    const rows = driver
      .prepareState<[], { line_number: number; item_index: number }>(
        "SELECT line_number, item_index FROM thread_rollout_items ORDER BY item_index",
      )
      .all();
    expect(rows.map((r) => r.item_index)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    // Line numbers are unique and strictly increasing (no collisions/dupes).
    const lineNumbers = rows.map((r) => r.line_number);
    expect(new Set(lineNumbers).size).toBe(lineNumbers.length);
    expect([...lineNumbers].sort((a, b) => a - b)).toEqual(lineNumbers);
  });

  it("skips re-indexing entirely when the file is unchanged", () => {
    const rolloutPath = makeRolloutPath();
    const threads = new StateThreadRepository(driver);
    writeFileSync(rolloutPath, META + itemLine(0));
    backfillRolloutFile({ rolloutPath, threads });

    const replaceSpy = vi.spyOn(threads, "replaceRolloutItems");
    const appendSpy = vi.spyOn(threads, "appendRolloutItems");

    // Re-indexing an untouched file must be a no-op: neither path runs.
    expect(backfillRolloutFile({ rolloutPath, threads })).toEqual({
      itemsIndexed: 0,
    });
    expect(replaceSpy).not.toHaveBeenCalled();
    expect(appendSpy).not.toHaveBeenCalled();
    expect(rowCount()).toBe(2);
  });

  it("produces the same final state as a full re-index", () => {
    const rolloutPath = makeRolloutPath();
    const incremental = new StateThreadRepository(driver);
    writeFileSync(rolloutPath, META + itemLine(0));
    backfillRolloutFile({ rolloutPath, threads: incremental });
    for (let i = 1; i <= 5; i += 1) {
      appendFileSync(rolloutPath, itemLine(i));
      backfillRolloutFile({ rolloutPath, threads: incremental });
    }

    const incrementalRows = driver
      .prepareState<
        [],
        { line_number: number; item_index: number; payload_json: string }
      >(
        "SELECT line_number, item_index, payload_json FROM thread_rollout_items ORDER BY item_index",
      )
      .all();

    // Force a full reconcile by clearing the receipt, then re-index from
    // scratch; the resulting rows must match the incrementally-built ones.
    driver
      .prepareState<[string]>("DELETE FROM backfill_files WHERE source_path = ?")
      .run(rolloutPath);
    backfillRolloutFile({ rolloutPath, threads: incremental });

    const fullRows = driver
      .prepareState<
        [],
        { line_number: number; item_index: number; payload_json: string }
      >(
        "SELECT line_number, item_index, payload_json FROM thread_rollout_items ORDER BY item_index",
      )
      .all();

    expect(incrementalRows).toEqual(fullRows);
    expect(fullRows.length).toBe(7);
  });

  it("carries updatedAt forward on appends that contain no session_meta", () => {
    const rolloutPath = makeRolloutPath();
    const threads = new StateThreadRepository(driver);
    writeFileSync(rolloutPath, META + itemLine(0));
    backfillRolloutFile({ rolloutPath, threads });

    // The full reconcile seeds updatedAt from the session_meta timestamp.
    const initial = threads.getThread("thread-1");
    expect(initial?.updatedAt).toBe("2026-04-29T00:00:00.000Z");

    // An appended tail without a session_meta line must not advance updatedAt
    // to the file mtime; it carries the prior value forward so a later full
    // reconcile (which also reads it from meta) does not make it jump back.
    appendFileSync(rolloutPath, itemLine(1));
    backfillRolloutFile({ rolloutPath, threads });
    expect(threads.getThread("thread-1")?.updatedAt).toBe(
      "2026-04-29T00:00:00.000Z",
    );

    // Forcing a full reconcile produces the same updatedAt: no jump.
    driver
      .prepareState<[string]>("DELETE FROM backfill_files WHERE source_path = ?")
      .run(rolloutPath);
    backfillRolloutFile({ rolloutPath, threads });
    expect(threads.getThread("thread-1")?.updatedAt).toBe(
      "2026-04-29T00:00:00.000Z",
    );
  });

  it("falls back to a full reconcile when the file shrinks (rewrite)", () => {
    const rolloutPath = makeRolloutPath();
    const threads = new StateThreadRepository(driver);
    writeFileSync(rolloutPath, META + itemLine(0) + itemLine(1) + itemLine(2));
    backfillRolloutFile({ rolloutPath, threads });
    expect(rowCount()).toBe(4);

    const replaceSpy = vi.spyOn(threads, "replaceRolloutItems");
    // Truncating/rewriting to fewer lines must trigger a full reconcile so the
    // stale rows are dropped.
    writeFileSync(rolloutPath, META + itemLine(9));
    backfillRolloutFile({ rolloutPath, threads });
    expect(replaceSpy).toHaveBeenCalledTimes(1);
    expect(rowCount()).toBe(2);
  });
});
