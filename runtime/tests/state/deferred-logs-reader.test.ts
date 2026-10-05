import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  openStateDatabasePathReader, openStateDatabaseReader, openStateDatabases,
  resolveStateDatabasePaths, StateSqliteReader,
} from "../../src/state/sqlite-driver.js";

let root = "";
let options: { cwd: string; agencHome: string; deferLogs: true };
const readers: StateSqliteReader[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-state-reader-"));
  options = { cwd: join(root, "project"), agencHome: join(root, "home"), deferLogs: true };
  mkdirSync(options.cwd);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const reader of readers.splice(0)) reader.close();
  rmSync(root, { recursive: true, force: true });
});
function seed() {
  const writer = openStateDatabases(options);
  writer.close();
  return resolveStateDatabasePaths(options);
}

describe("read-only state with deferred logs", () => {
  it("reads state without creating logs, modifying state or accepting writes", () => {
    const paths = seed();
    const before = readFileSync(paths.stateDbPath);
    const reader = openStateDatabaseReader(options);
    readers.push(reader);
    expect(reader.state.readonly).toBe(true);
    expect(reader.state.pragma("query_only", { simple: true })).toBe(1);
    expect(reader.prepareState("SELECT count(*) AS n FROM run_journal_bindings").get()).toEqual({ n: 0 });
    expect(() => reader.prepareState("CREATE TABLE forbidden (id TEXT)").run()).toThrow();
    expect(existsSync(paths.logsDbPath)).toBe(false);
    reader.close();
    reader.close();
    expect(existsSync(paths.logsDbPath)).toBe(false);
    expect(readFileSync(paths.stateDbPath)).toEqual(before);
    expect(() => reader.logs).toThrow("closed state reader");
  });

  it("keeps default readers eager and closes state when logs are missing", () => {
    const paths = seed();
    const close = Database.prototype.close;
    let closed: Database.Database | undefined;
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) {
      if (this.name === paths.stateDbPath) closed = this;
      return close.call(this);
    });
    expect(() => openStateDatabasePathReader(paths)).toThrow();
    expect(closed).toBeDefined();
    expect(closed?.open).toBe(false);
    expect(existsSync(paths.logsDbPath)).toBe(false);
  });

  it("requires an existing state database even when logs are deferred", () => {
    const paths = resolveStateDatabasePaths(options);
    mkdirSync(paths.projectDir, { recursive: true });
    expect(() => new StateSqliteReader(paths, { deferLogs: true })).toThrow();
    expect(existsSync(paths.stateDbPath)).toBe(false);
    expect(existsSync(paths.logsDbPath)).toBe(false);
  });

  it("fails actual missing logs reads without creating a file and can retry after a writer creates it", () => {
    const paths = seed();
    const reader = openStateDatabasePathReader(paths, { deferLogs: true });
    readers.push(reader);
    expect(() => reader.prepareLogs("SELECT count(*) FROM logs")).toThrow();
    expect(existsSync(paths.logsDbPath)).toBe(false);
    expect(reader.state.open).toBe(true);
    const writer = openStateDatabases(options);
    try { writer.prepareLogs("INSERT INTO logs (timestamp, level, message) VALUES (?, ?, ?)").run("now", "info", "written"); }
    finally { writer.close(); }
    expect(reader.prepareLogs("SELECT count(*) AS n FROM logs").get()).toEqual({ n: 1 });
    expect(reader.logs.readonly).toBe(true);
    expect(reader.logs.pragma("query_only", { simple: true })).toBe(1);
    expect(() => reader.prepareLogs("DELETE FROM logs").run()).toThrow();
    const logs = reader.logs;
    reader.close();
    expect(logs.open).toBe(false);
  });

  it("does not hide corrupt logs when they are actually requested", () => {
    const paths = seed();
    writeFileSync(paths.logsDbPath, "corrupt logs");
    const reader = openStateDatabasePathReader(paths, { deferLogs: true });
    readers.push(reader);
    expect(reader.prepareState("SELECT 1 AS n").get()).toEqual({ n: 1 });
    expect(() => reader.prepareLogs("SELECT count(*) FROM logs").get()).toThrow();
    reader.close();
    expect(readFileSync(paths.logsDbPath, "utf8")).toBe("corrupt logs");
  });

  it("closes a failed first-use logs handle and retries with read-only configuration", () => {
    const writer = openStateDatabases({ ...options, deferLogs: false });
    writer.close();
    const paths = resolveStateDatabasePaths(options);
    const reader = openStateDatabasePathReader(paths, { deferLogs: true });
    readers.push(reader);
    const pragma = Database.prototype.pragma;
    let failed: Database.Database | undefined;
    const fault = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, sql, config) {
      if (this.name === paths.logsDbPath) { failed = this; throw new Error("read-only logs configuration failed"); }
      return pragma.call(this, sql, config);
    });
    expect(() => reader.logs).toThrow("read-only logs configuration failed");
    expect(failed?.open).toBe(false);
    expect(reader.state.open).toBe(true);
    fault.mockRestore();
    expect(reader.prepareLogs("SELECT count(*) AS n FROM logs").get()).toEqual({ n: 0 });
    expect(reader.logs.readonly).toBe(true);
  });
});
