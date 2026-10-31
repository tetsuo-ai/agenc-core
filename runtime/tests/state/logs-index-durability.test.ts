/**
 * The error-log index copies the JSONL error log for diagnostics; no recovery,
 * gate, budget or effect decision reads it. Each entry commits at NORMAL
 * (observational) instead of paying an fsync on the path of the turn whose
 * warning it records, and the logs connection returns to FULL.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStateDatabasePaths, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { LogsRepository } from "../../src/state/logs.js";

let root: string;
const drivers: StateSqliteDriver[] = [];
function open(deferLogs = false): StateSqliteDriver {
  const driver = openStateDatabasePaths({ projectDir: root, stateDbPath: join(root, "state.sqlite"),
    logsDbPath: join(root, "logs.sqlite") }, undefined, { deferLogs });
  drivers.push(driver);
  return driver;
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agenc-logs-durability-")); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0)) driver.close();
  rmSync(root, { recursive: true, force: true });
});

describe("error-log index durability", () => {
  it.each([false, true])("indexes a warning at NORMAL and restores FULL (deferred logs=%s)", (deferLogs) => {
    const driver = open(deferLogs);
    const levels: unknown[] = [];
    const prepare = driver.prepareLogs.bind(driver);
    vi.spyOn(driver, "prepareLogs").mockImplementation(((sql: string) => {
      if (/^\s*INSERT INTO logs/.test(sql)) levels.push(driver.logs.pragma("synchronous", { simple: true }));
      return prepare(sql);
    }) as typeof driver.prepareLogs);
    new LogsRepository(driver).append({ timestamp: "2026-10-31T00:00:00.000Z", level: "warning", scope: "runtime",
      threadId: "session", eventType: "memory_extraction_skipped", message: "deferred by eligible-turn cadence" });
    expect(levels).toEqual([1]);
    expect(driver.logs.pragma("synchronous", { simple: true })).toBe(2);
    // Committed: another connection reads it.
    const reader = open();
    expect(reader.logs.prepare("SELECT level, event_type, message FROM logs").all()).toEqual([
      { level: "warning", event_type: "memory_extraction_skipped", message: "deferred by eligible-turn cadence" },
    ]);
  });

  it("keeps state commits FULL after a relaxed index entry", () => {
    const driver = open();
    new LogsRepository(driver).append({ timestamp: "2026-10-31T00:00:00.000Z", level: "warning", message: "w" });
    expect(driver.state.pragma("synchronous", { simple: true })).toBe(2);
    expect(driver.logs.pragma("synchronous", { simple: true })).toBe(2);
    driver.transactionImmediate(() => {
      expect(driver.state.pragma("synchronous", { simple: true })).toBe(2);
    });
  });
});
