import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openStateDatabasePaths, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { StateMigrationError, StateSchemaMismatchError } from "../../src/state/errors.js";

let root: string;
const drivers: StateSqliteDriver[] = [];
function paths() {
  return { projectDir: root, stateDbPath: join(root, "state.sqlite"), logsDbPath: join(root, "logs.sqlite") };
}
function open(deferLogs = false): StateSqliteDriver {
  const driver = openStateDatabasePaths(paths(), undefined, { deferLogs });
  drivers.push(driver);
  return driver;
}
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agenc-logs-initialization-")); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const driver of drivers.splice(0)) driver.close();
  rmSync(root, { recursive: true, force: true });
});

describe("atomic FULL logs initialization", () => {
  it.each([false, true])("rolls back the migration table and DDL, closes and retries (deferred=%s)", (deferred) => {
    const lazy = deferred ? open(true) : undefined;
    lazy?.state.exec("CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('keep')");
    const exec = Database.prototype.exec;
    let failed: Database.Database | undefined;
    let state: Database.Database | undefined;
    const fault = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql) {
      if (this.name === paths().stateDbPath) state = this;
      const result = exec.call(this, sql);
      if (this.name === paths().logsDbPath && sql.includes("CREATE TABLE IF NOT EXISTS logs")) {
        expect(this.inTransaction).toBe(true);
        expect(this.pragma("synchronous", { simple: true })).toBe(2);
        failed = this;
        throw new Error("fault after logs DDL");
      }
      return result;
    });
    expect(() => lazy === undefined ? open() : lazy.logs).toThrow(StateMigrationError);
    expect(failed?.open).toBe(false);
    if (lazy === undefined) expect(state?.open).toBe(false);
    else {
      expect(lazy.state.open).toBe(true);
      expect(lazy.state.prepare("SELECT value FROM preserved").get()).toEqual({ value: "keep" });
    }
    fault.mockRestore();
    const raw = new Database(paths().logsDbPath);
    try { expect(raw.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]); }
    finally { raw.close(); }
    const ready = lazy ?? open();
    expect(ready.logs.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
    expect(ready.logs.pragma("synchronous", { simple: true })).toBe(2);
    ready.logs.prepare("INSERT INTO logs(timestamp, level, message) VALUES (?, ?, ?)")
      .run("2026-10-04T00:00:00Z", "warning", "preserved warning");
    ready.close();
    expect(open().logs.prepare("SELECT level, message FROM logs").all())
      .toEqual([{ level: "warning", message: "preserved warning" }]);
  });

  it.each([false, true])("preserves the forward-version guard and existing rows (deferred=%s)", (deferred) => {
    const seed = open();
    seed.logs.exec("INSERT INTO schema_migrations(version, name) VALUES (9999, 'future')");
    seed.close();
    const lazy = deferred ? open(true) : undefined;
    expect(() => lazy === undefined ? open() : lazy.logs).toThrow(StateSchemaMismatchError);
    const raw = new Database(paths().logsDbPath);
    try {
      expect(raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all())
        .toEqual([{ version: 1 }, { version: 9999 }]);
    } finally { raw.close(); }
  });
});
