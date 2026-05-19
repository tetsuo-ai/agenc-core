import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openStateDatabaseReader,
  openStateDatabases,
  type StateSqliteDriver,
  type StateSqliteReader,
} from "./sqlite-driver.js";

let home = "";
let cwd = "";
let writer: StateSqliteDriver;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-concurrent-state-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-concurrent-state-cwd-"));
  mkdirSync(join(cwd, ".git"));
  writer = openStateDatabases({ cwd, agencHome: home });
});

afterEach(() => {
  writer.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe("StateSqliteReader", () => {
  it("allows multiple read-only clients while the writer continues committing", () => {
    insertRun("run-1", "running");
    const readerA = openStateDatabaseReader({ cwd, agencHome: home });
    const readerB = openStateDatabaseReader({ cwd, agencHome: home });
    try {
      expect(readRunIds(readerA)).toEqual(["run-1"]);
      expect(readRunIds(readerB)).toEqual(["run-1"]);

      insertRun("run-2", "stopped");

      expect(readRunIds(readerA)).toEqual(["run-1", "run-2"]);
      expect(readRunIds(readerB)).toEqual(["run-1", "run-2"]);
      expect(readLogCount(readerA)).toBe(0);
    } finally {
      readerA.close();
      readerB.close();
    }
  });

  it("keeps an open read transaction stable while the writer commits", () => {
    insertRun("run-1", "running");
    const readerA = openStateDatabaseReader({ cwd, agencHome: home });
    const readerB = openStateDatabaseReader({ cwd, agencHome: home });
    try {
      const readTransaction = readerA.state.transaction(() => {
        expect(readRunIds(readerA)).toEqual(["run-1"]);
        expect(() => insertRun("run-2", "stopped")).not.toThrow();
        expect(readRunIds(readerA)).toEqual(["run-1"]);
      });

      expect(() => readTransaction()).not.toThrow();
      expect(readRunIds(readerA)).toEqual(["run-1", "run-2"]);
      expect(readRunIds(readerB)).toEqual(["run-1", "run-2"]);
    } finally {
      readerA.close();
      readerB.close();
    }
  });

  it("rejects accidental writes through client read handles", () => {
    const reader = openStateDatabaseReader({ cwd, agencHome: home });
    try {
      expect(() =>
        reader
          .prepareState(
            `INSERT INTO agent_runs (
              id,
              objective,
              status,
              started_at,
              last_active_at
            ) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(
            "run-readonly",
            "read only",
            "running",
            "2026-05-01T00:00:00.000Z",
            "2026-05-01T00:00:00.000Z",
          ),
      ).toThrow();
      expect(readRunIds(writer)).toEqual([]);
    } finally {
      reader.close();
    }
  });
});

function insertRun(id: string, status: string): void {
  writer
    .prepareState(
      `INSERT INTO agent_runs (
        id,
        objective,
        status,
        started_at,
        last_active_at
      ) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      "concurrent read",
      status,
      "2026-05-01T00:00:00.000Z",
      "2026-05-01T00:00:00.000Z",
    );
}

function readRunIds(
  driver: Pick<StateSqliteDriver | StateSqliteReader, "prepareState">,
): string[] {
  return driver
    .prepareState<[], { id: string }>(
      "SELECT id FROM agent_runs ORDER BY id ASC",
    )
    .all()
    .map((row) => row.id);
}

function readLogCount(reader: StateSqliteReader): number {
  return (
    reader
      .prepareLogs<[], { count: number }>(
        "SELECT COUNT(*) AS count FROM logs",
      )
      .get()?.count ?? 0
  );
}
