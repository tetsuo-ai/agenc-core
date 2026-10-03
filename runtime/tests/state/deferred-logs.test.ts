import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStateDatabasePaths, type StateSqliteDriver } from "../../src/state/sqlite-driver.js";
import { FileThreadStore } from "../../src/thread-store/store.js";

describe("state-only logs deferral", () => {
  const homes: string[] = [];
  const drivers: StateSqliteDriver[] = [];
  function paths() {
    const projectDir = mkdtempSync(join(tmpdir(), "agenc-deferred-logs-"));
    homes.push(projectDir);
    return { projectDir, stateDbPath: join(projectDir, "state.sqlite"), logsDbPath: join(projectDir, "logs.sqlite") };
  }
  function open(p = paths()) {
    const driver = openStateDatabasePaths(p, { deferLogs: true });
    drivers.push(driver);
    return driver;
  }
  afterEach(() => {
    vi.restoreAllMocks();
    for (const driver of drivers.splice(0)) driver.close();
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  it("keeps state initialization and writes eager without opening unused logs", () => {
    const driver = open();
    expect(driver.state.pragma("synchronous", { simple: true })).toBe(2);
    expect(driver.state.pragma("journal_mode", { simple: true })).toBe("wal");
    driver.transactionImmediate(() => driver.prepareState("SELECT 1").get());
    expect(existsSync(driver.logsDbPath)).toBe(false);
    driver.close();
    expect(existsSync(driver.logsDbPath)).toBe(false);
    expect(() => driver.logs).toThrow("closed state driver");
  });

  it("configures and migrates logs before the first prepared statement", () => {
    const driver = open();
    expect(driver.prepareLogs("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
    expect(driver.logs.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(driver.logs.pragma("synchronous", { simple: true })).toBe(2);
    expect(driver.logs.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(driver.prepareLogs("SELECT 1")).toBe(driver.prepareLogs("SELECT 1"));
    const logs = driver.logs;
    driver.close();
    expect(logs.open).toBe(false);
  });

  it("initializes logs before a logs transaction", () => {
    const driver = open();
    driver.logsTransaction(() => {
      expect(driver.logs.inTransaction).toBe(true);
      expect(driver.logs.pragma("synchronous", { simple: true })).toBe(2);
      expect(driver.prepareLogs("SELECT count(*) AS n FROM logs").get()).toEqual({ n: 0 });
    });
  });

  it("closes a failed logs initializer and retries without losing state", () => {
    const driver = open();
    const original = Database.prototype.pragma;
    let failed: Database.Database | undefined;
    const fault = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, sql, options) {
      if (this.name === driver.logsDbPath) { failed = this; throw new Error("logs initialization failed"); }
      return original.call(this, sql, options);
    });
    expect(() => driver.logs).toThrow("logs initialization failed");
    expect(failed?.open).toBe(false);
    expect(driver.state.open).toBe(true);
    fault.mockRestore();
    expect(driver.prepareLogs("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
  });

  it("keeps eager logs initialization for callers that did not opt in", () => {
    const p = paths();
    const driver = openStateDatabasePaths(p);
    drivers.push(driver);
    expect(existsSync(p.logsDbPath)).toBe(true);
  });

  it("lets the session thread store remain state-only through close", () => {
    const p = paths();
    const store = new FileThreadStore({ projectDir: p.projectDir, deferLogs: true });
    try { expect(existsSync(join(p.projectDir, "agenc-logs_1.sqlite"))).toBe(false); }
    finally { store.close(); }
    expect(existsSync(join(p.projectDir, "agenc-logs_1.sqlite"))).toBe(false);
  });
});
