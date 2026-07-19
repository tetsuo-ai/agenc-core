/**
 * Regression: a single corrupt interior line in a rollout JSONL file must
 * NOT abort the whole reconstruction/backfill. `parseRolloutLine` calls
 * `JSON.parse` which throws on malformed JSON; the call sites in
 * thread-store/store.ts (loadHistory → readRolloutItems),
 * agents/thread-manager.ts (readRolloutHistory) and state/backfill.ts
 * (reindexWholeRolloutFile + indexAppendedTail) now wrap the call in a
 * try/catch that skips the corrupt line and continues — matching the guard
 * already present in session/session-store.ts (maxEventSeqInRollout).
 */
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ROLLOUT_SCHEMA_VERSION } from "../session/event-log.js";
import { serializeRolloutItem } from "../session/rollout-item.js";
import { RolloutStore } from "../session/rollout-store.js";
import { FileThreadStore } from "../thread-store/store.js";
import { readRolloutHistory } from "../agents/thread-manager.js";
import { backfillProjectRollouts, backfillRolloutFile } from "./backfill.js";
import { openStateDatabases, type StateSqliteDriver } from "./sqlite-driver.js";
import { StateThreadRepository } from "./threads.js";

let home = "";
let cwd = "";
let originalAgencHome = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-rpg-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-rpg-cwd-"));
  mkdirSync(join(cwd, ".git"));
  originalAgencHome = process.env.AGENC_HOME ?? "";
  process.env.AGENC_HOME = home;
});

afterEach(() => {
  if (originalAgencHome) process.env.AGENC_HOME = originalAgencHome;
  else delete process.env.AGENC_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

/** Insert a syntactically-corrupt JSON line between the first and last good
 *  lines of a rollout file, returning the rollout path. */
function corruptInteriorLine(rolloutPath: string): void {
  const lines = readFileSync(rolloutPath, "utf8").split(/\r?\n/).filter(
    (l) => l.trim().length > 0,
  );
  expect(lines.length).toBeGreaterThanOrEqual(2);
  const corrupt = '{"type":"response_item","payload":{ NOT VALID JSON';
  // Splice the corrupt line in as an interior line (after the first row).
  const rebuilt = [lines[0], corrupt, ...lines.slice(1)];
  writeFileSync(rolloutPath, rebuilt.join("\n") + "\n");
}

describe("rollout parse guards — corrupt interior line", () => {
  it("readRolloutHistory (thread-manager) skips the corrupt line and recovers the rest", () => {
    const meta = serializeRolloutItem({
      type: "session_meta",
      payload: {
        sessionId: "t1",
        timestamp: "2026-04-29T00:00:00.000Z",
        cwd,
        originator: "test",
        agencVersion: "0.2.0",
        rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
        model: "test-model",
        modelProvider: "test-provider",
      },
    });
    const good = serializeRolloutItem({
      type: "response_item",
      payload: { role: "user", content: "alpha", id: "a" },
    });
    const corrupt = '{"type":"response_item","payload":{ NOT VALID JSON\n';
    const rolloutPath = join(cwd, "rollout-hist.jsonl");
    // Order: meta, CORRUPT (interior), good — the good row follows the bad one.
    writeFileSync(rolloutPath, meta + corrupt + good);

    const history = readRolloutHistory(rolloutPath);

    // The corrupt interior line is dropped, but the meta and the trailing
    // good response_item that follows it are both recovered.
    expect(history.some((i) => i.type === "session_meta")).toBe(true);
    expect(
      history.some(
        (i) => i.type === "response_item" && i.payload.id === "a",
      ),
    ).toBe(true);
  });

  it("FileThreadStore.loadHistory skips the corrupt line and recovers the rest", () => {
    const rollout = new RolloutStore({
      cwd,
      sessionId: "disk-thread",
      agencVersion: "0.2.0",
    });
    rollout.open({
      sessionId: "disk-thread",
      timestamp: new Date().toISOString(),
      cwd,
      originator: "test",
      agencVersion: "0.2.0",
      model: "test-model",
      modelProvider: "test-provider",
    });
    const rolloutPath = rollout.rolloutPath;
    try {
      const store = new FileThreadStore({ cwd });
      store.createThread({ threadId: "disk-thread", rolloutStore: rollout });
      store.appendItems({
        threadId: "disk-thread",
        items: [{ type: "response_item", payload: { role: "user", content: "alpha", id: "a" } }],
      });
      store.shutdownThread("disk-thread");
      rollout.close();

      // Inject a corrupt interior line into the on-disk rollout.
      corruptInteriorLine(rolloutPath);

      const store2 = new FileThreadStore({ cwd });
      const history = store2.loadHistory({
        threadId: "disk-thread",
        includeArchived: false,
      });

      // The good response_item survives the corrupt interior line.
      expect(
        history.items.some(
          (i) => i.type === "response_item" && i.payload.id === "a",
        ),
      ).toBe(true);
    } finally {
      try {
        rollout.close();
      } catch {
        /* already closed */
      }
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("backfill skips the corrupt line and indexes the surrounding rows", () => {
    const driver: StateSqliteDriver = openStateDatabases({ cwd });
    try {
      const sessionDir = join(driver.projectDir, "sessions", "bf-thread");
      mkdirSync(sessionDir, { recursive: true });
      const rolloutPath = join(
        sessionDir,
        "rollout-2026-04-29T00-00-00-000Z-bf-thread.jsonl",
      );
      const meta = serializeRolloutItem({
        type: "session_meta",
        payload: {
          sessionId: "bf-thread",
          timestamp: "2026-04-29T00:00:00.000Z",
          cwd,
          originator: "test",
          agencVersion: "0.2.0",
          rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
          model: "grok-4",
          modelProvider: "xai",
        },
      });
      const corrupt = '{"type":"response_item","payload":{ NOT VALID JSON\n';
      const good = serializeRolloutItem({
        type: "response_item",
        payload: { role: "user", content: "alpha", id: "a" },
      });
      // meta, CORRUPT (interior), good.
      writeFileSync(rolloutPath, meta + corrupt + good);

      const result = backfillProjectRollouts({
        projectDir: driver.projectDir,
        driver,
      });

      // One file scanned/indexed; the two valid rows indexed, corrupt skipped.
      expect(result.filesIndexed).toBe(1);
      expect(result.itemsIndexed).toBe(2);
      expect(
        driver
          .prepareState<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_rollout_items",
          )
          .get()?.count,
      ).toBe(2);
    } finally {
      driver.close();
    }
  });

  it("backfill refuses to index a complete JSON object without its newline commit boundary", () => {
    const driver: StateSqliteDriver = openStateDatabases({ cwd });
    try {
      const sessionDir = join(driver.projectDir, "sessions", "unterminated-full");
      mkdirSync(sessionDir, { recursive: true });
      const rolloutPath = join(
        sessionDir,
        "rollout-2026-04-29T00-00-00-000Z-unterminated-full.jsonl",
      );
      const completeLine = serializeRolloutItem({
        type: "response_item",
        payload: { role: "user", content: "not committed" },
      });
      writeFileSync(rolloutPath, completeLine.slice(0, -1));

      expect(() =>
        backfillProjectRollouts({ projectDir: driver.projectDir, driver }),
      ).toThrow(/unterminated canonical rollout/);
      expect(
        driver
          .prepareState<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_rollout_items",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      driver.close();
    }
  });

  it("incremental backfill leaves an unterminated appended record unprojected", () => {
    const driver: StateSqliteDriver = openStateDatabases({ cwd });
    try {
      const sessionDir = join(driver.projectDir, "sessions", "unterminated-tail");
      mkdirSync(sessionDir, { recursive: true });
      const rolloutPath = join(
        sessionDir,
        "rollout-2026-04-29T00-00-00-000Z-unterminated-tail.jsonl",
      );
      writeFileSync(
        rolloutPath,
        serializeRolloutItem({
          type: "response_item",
          payload: { role: "user", content: "committed" },
        }),
      );
      expect(
        backfillProjectRollouts({ projectDir: driver.projectDir, driver }),
      ).toMatchObject({ itemsIndexed: 1 });

      const appended = serializeRolloutItem({
        type: "response_item",
        payload: { role: "assistant", content: "not committed" },
      });
      appendFileSync(rolloutPath, appended.slice(0, -1));

      expect(() =>
        backfillProjectRollouts({ projectDir: driver.projectDir, driver }),
      ).toThrow(/unterminated canonical rollout/);
      expect(
        driver
          .prepareState<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_rollout_items",
          )
          .get()?.count,
      ).toBe(1);
    } finally {
      driver.close();
    }
  });

  it("bounds full and incremental reads to the captured file size", () => {
    const driver: StateSqliteDriver = openStateDatabases({ cwd });
    try {
      const sessionDir = join(driver.projectDir, "sessions", "bounded-snapshot");
      mkdirSync(sessionDir, { recursive: true });
      const rolloutPath = join(
        sessionDir,
        "rollout-2026-04-29T00-00-00-000Z-bounded-snapshot.jsonl",
      );
      const rows = ["one", "two", "three", "four"].map((content) =>
        serializeRolloutItem({
          type: "response_item",
          payload: { role: "user", content },
        }),
      );
      writeFileSync(rolloutPath, rows[0]);
      const firstSnapshotSize = statSync(rolloutPath).size;
      const threads = new StateThreadRepository(driver);
      const readReceipt = threads.getBackfillFile.bind(threads);
      const fullRace = vi
        .spyOn(threads, "getBackfillFile")
        .mockImplementationOnce((path) => {
          appendFileSync(rolloutPath, rows[1]);
          return readReceipt(path);
        });
      expect(
        backfillRolloutFile({ rolloutPath, threads }),
      ).toMatchObject({ itemsIndexed: 1 });
      fullRace.mockRestore();
      expect(threads.getBackfillFile(rolloutPath)).toMatchObject({
        size: firstSnapshotSize,
        itemCount: 1,
      });
      expect(backfillRolloutFile({ rolloutPath, threads })).toMatchObject({
        itemsIndexed: 1,
      });

      appendFileSync(rolloutPath, rows[2]);
      const thirdSnapshotSize = statSync(rolloutPath).size;
      const incrementalRace = vi
        .spyOn(threads, "getBackfillFile")
        .mockImplementationOnce((path) => {
          const receipt = readReceipt(path);
          appendFileSync(rolloutPath, rows[3]);
          return receipt;
        });
      expect(backfillRolloutFile({ rolloutPath, threads })).toMatchObject({
        itemsIndexed: 1,
      });
      incrementalRace.mockRestore();
      expect(threads.getBackfillFile(rolloutPath)).toMatchObject({
        size: thirdSnapshotSize,
        itemCount: 3,
      });
      expect(backfillRolloutFile({ rolloutPath, threads })).toMatchObject({
        itemsIndexed: 1,
      });
      expect(
        driver
          .prepareState<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_rollout_items",
          )
          .get()?.count,
      ).toBe(4);
    } finally {
      vi.restoreAllMocks();
      driver.close();
    }
  });

  it("fails closed when the rollout path is replaced after snapshot open", () => {
    const driver: StateSqliteDriver = openStateDatabases({ cwd });
    try {
      const sessionDir = join(driver.projectDir, "sessions", "replaced-snapshot");
      mkdirSync(sessionDir, { recursive: true });
      const rolloutPath = join(
        sessionDir,
        "rollout-2026-04-29T00-00-00-000Z-replaced-snapshot.jsonl",
      );
      const original = serializeRolloutItem({
        type: "response_item",
        payload: { role: "user", content: "original" },
      });
      const replacement = serializeRolloutItem({
        type: "response_item",
        payload: { role: "user", content: "replacement" },
      });
      writeFileSync(rolloutPath, original);
      const threads = new StateThreadRepository(driver);
      const aside = `${rolloutPath}.replaced`;
      const receipt = vi
        .spyOn(threads, "getBackfillFile")
        .mockImplementationOnce(() => {
          renameSync(rolloutPath, aside);
          writeFileSync(rolloutPath, replacement);
          return undefined;
        });

      expect(() => backfillRolloutFile({ rolloutPath, threads })).toThrow(
        /changed while capturing a bounded projection snapshot/,
      );
      receipt.mockRestore();
      expect(
        driver
          .prepareState<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_rollout_items",
          )
          .get()?.count,
      ).toBe(0);
    } finally {
      vi.restoreAllMocks();
      driver.close();
    }
  });

  it("rolls back a full projection when the path is replaced during its DB write", () => {
    const driver: StateSqliteDriver = openStateDatabases({ cwd });
    try {
      const sessionDir = join(driver.projectDir, "sessions", "replaced-full-commit");
      mkdirSync(sessionDir, { recursive: true });
      const rolloutPath = join(
        sessionDir,
        "rollout-2026-04-29T00-00-00-000Z-replaced-full-commit.jsonl",
      );
      const original = serializeRolloutItem({
        type: "response_item",
        payload: { role: "user", content: "original" },
      });
      const replacement = serializeRolloutItem({
        type: "response_item",
        payload: { role: "user", content: "replacement" },
      });
      writeFileSync(rolloutPath, original);
      const threads = new StateThreadRepository(driver);
      const replace = threads.replaceRolloutItems.bind(threads);
      const aside = `${rolloutPath}.during-full-commit`;
      vi.spyOn(threads, "replaceRolloutItems").mockImplementationOnce((params) => {
        replace(params);
        renameSync(rolloutPath, aside);
        writeFileSync(rolloutPath, replacement);
      });

      expect(() => backfillRolloutFile({ rolloutPath, threads })).toThrow(
        /changed while capturing a bounded projection snapshot/,
      );
      expect(
        driver
          .prepareState<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_rollout_items",
          )
          .get()?.count,
      ).toBe(0);
      expect(threads.getBackfillFile(rolloutPath)).toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      driver.close();
    }
  });

  it("rolls back an incremental projection when the path is replaced during its DB write", () => {
    const driver: StateSqliteDriver = openStateDatabases({ cwd });
    try {
      const sessionDir = join(driver.projectDir, "sessions", "replaced-tail-commit");
      mkdirSync(sessionDir, { recursive: true });
      const rolloutPath = join(
        sessionDir,
        "rollout-2026-04-29T00-00-00-000Z-replaced-tail-commit.jsonl",
      );
      const first = serializeRolloutItem({
        type: "response_item",
        payload: { role: "user", content: "first" },
      });
      const second = serializeRolloutItem({
        type: "response_item",
        payload: { role: "assistant", content: "second" },
      });
      writeFileSync(rolloutPath, first);
      const threads = new StateThreadRepository(driver);
      backfillRolloutFile({ rolloutPath, threads });
      const receiptBefore = threads.getBackfillFile(rolloutPath);
      appendFileSync(rolloutPath, second);
      const append = threads.appendRolloutItems.bind(threads);
      const aside = `${rolloutPath}.during-tail-commit`;
      vi.spyOn(threads, "appendRolloutItems").mockImplementationOnce((params) => {
        append(params);
        renameSync(rolloutPath, aside);
        writeFileSync(rolloutPath, first);
      });

      expect(() => backfillRolloutFile({ rolloutPath, threads })).toThrow(
        /changed while capturing a bounded projection snapshot/,
      );
      expect(
        driver
          .prepareState<[], { count: number }>(
            "SELECT COUNT(*) AS count FROM thread_rollout_items",
          )
          .get()?.count,
      ).toBe(1);
      expect(threads.getBackfillFile(rolloutPath)).toEqual(receiptBefore);
    } finally {
      vi.restoreAllMocks();
      driver.close();
    }
  });
});
