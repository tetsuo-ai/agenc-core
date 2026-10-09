import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, openStateDatabasePaths, type StateDatabasePaths } from "./sqlite-driver.js";
import { STATE_DB_MIGRATIONS } from "./migrations/index.js";
import { tryInitializeFreshStateSchema } from "./fresh-state-schema.js";
import { FRESH_STATE_SCHEMA_SQL } from "./fresh-state-schema.generated.js";

let root: string;
const connections: Database.Database[] = [];
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "agenc-fresh-schema-")); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of connections.splice(0)) if (db.open) db.close();
  rmSync(root, { recursive: true, force: true });
});
function database(path = ":memory:") {
  const db = new Database(path); connections.push(db);
  db.pragma("foreign_keys = ON");
  return db;
}
function paths(): StateDatabasePaths {
  const projectDir = join(root, "project");
  return { projectDir, stateDbPath: join(projectDir, "state.sqlite"), logsDbPath: join(projectDir, "logs.sqlite") };
}
function initialize(db: Database.Database) {
  db.exec("BEGIN IMMEDIATE");
  expect(tryInitializeFreshStateSchema(db)).toBe(true);
  db.exec("COMMIT");
}
const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
function schema(db: Database.Database) {
  const objects = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name").all() as { type: string; name: string }[];
  return {
    objects,
    tables: objects.filter((row) => row.type === "table").map(({ name }) => ({
      name, columns: db.pragma(`table_xinfo(${quote(name)})`),
      foreignKeys: db.pragma(`foreign_key_list(${quote(name)})`),
      // seq is creation/list order, not an index constraint or priority.
      indexes: (db.pragma(`index_list(${quote(name)})`) as Record<string, unknown>[])
        .map(({ seq: _seq, ...index }) => index).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    })),
    indexes: objects.filter((row) => row.type === "index").map(({ name }) => ({ name, columns: db.pragma(`index_xinfo(${quote(name)})`) })),
  };
}

describe("direct fresh state schema", () => {
  it("matches every legacy schema object, constraint, index, seed and migration record", () => {
    const start = Date.now();
    const legacy = database(); const fresh = database();
    applyMigrations(legacy, STATE_DB_MIGRATIONS); initialize(fresh);
    expect(schema(fresh)).toEqual(schema(legacy));
    for (const { name } of legacy.prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").all() as { name: string }[]) {
      const rows = (db: Database.Database) => (db.prepare(`SELECT * FROM ${quote(name)}`).all() as Record<string, unknown>[]).map((row) => {
        const normalized = { ...row };
        for (const column of Object.keys(row)) {
          const clock = name === "schema_migrations" && column === "applied_at"
            ? Date.parse(String(row[column]))
            : name === "csv_storage_quota" && column === "updated_at" ? Number(row[column]) * 1000
              : name === "csv_job_supervisor_state" && column === "updated_at_ms" ? Number(row[column]) : undefined;
          if (clock !== undefined) {
            expect(clock).toBeGreaterThanOrEqual(start - 1000);
            expect(clock).toBeLessThanOrEqual(Date.now());
            normalized[column] = "<generated now>";
          }
        }
        return normalized;
      });
      expect(rows(fresh), name).toEqual(rows(legacy));
    }
    expect(fresh.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(fresh.pragma("foreign_key_check")).toEqual([]);
    const identities = fresh.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all();
    expect(identities).toEqual(STATE_DB_MIGRATIONS.map(({ version, name }) => ({ version, name })));
    // The next normal open/migration must not repeat or rewrite any old row.
    const before = fresh.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    applyMigrations(fresh, STATE_DB_MIGRATIONS);
    expect(fresh.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(before);
  });

  it("retains both connection-local migration functions and their validation", () => {
    const legacy = database(); const fresh = database();
    applyMigrations(legacy, STATE_DB_MIGRATIONS); initialize(fresh);
    const sql = "SELECT agenc_csv_legacy_identity_json('job', 0, '[\"name\"]', '{\"name\":\"Ada\"}') AS identity, agenc_csv_sha256_text('test') AS digest";
    expect(fresh.prepare(sql).get()).toEqual(legacy.prepare(sql).get());
    const functions = (db: Database.Database) => (db.pragma("function_list") as { name: string }[])
      .filter((row) => row.name.startsWith("agenc_csv_"));
    expect(functions(fresh)).toEqual(functions(legacy));
    for (const db of [legacy, fresh]) {
      expect(() => db.prepare("SELECT agenc_csv_sha256_text(42)").get()).toThrow("legacy CSV digest input is not text");
      expect(() => db.prepare("SELECT agenc_csv_legacy_identity_json('job', -1, '[]', '{}')").get()).toThrow("legacy CSV identity input is invalid");
    }
  });

  it("enforces durable effect identity, foreign keys and unknown-outcome constraints", () => {
    const db = database(); initialize(db);
    db.prepare("INSERT INTO run_lifecycle_epochs (run_id, epoch, opened_at) VALUES ('run', 1, 'now')").run();
    const effect = db.prepare(`INSERT INTO run_effects (
      run_id, step_id, epoch, session_id, call_id, tool_name, recovery_category,
      idempotency_key, intent_digest, intent_event_id, intent_sequence, intent_at,
      effect_format_version, minimum_reader_runtime
    ) VALUES (?, 'step', 1, 'run', 'call', 'read', 'idempotent', 'key', 'digest', 'event', 1, 'now', 2, '0.14.0')`);
    expect(() => effect.run("missing")).toThrow();
    effect.run("run");
    db.exec("UPDATE run_effects SET outcome='unknown_outcome', result_event_id='unknown', result_sequence=2, unknown_reason='forced_shutdown', completed_at='later', review_status='pending'");
    expect(() => db.exec("UPDATE run_effects SET idempotency_key='changed'")).toThrow();
    expect(() => db.exec("DELETE FROM run_lifecycle_epochs WHERE run_id='run'")).toThrow();
    expect(db.prepare("SELECT outcome, idempotency_key FROM run_effects").get()).toEqual({ outcome: "unknown_outcome", idempotency_key: "key" });
  });

  it.each([
    "CREATE TABLE unexpected (id INTEGER)",
    "CREATE VIEW unexpected AS SELECT 1 AS value",
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT)",
    "CREATE TABLE removed (id INTEGER); DROP TABLE removed",
    "PRAGMA user_version = 99", "PRAGMA application_id = 99",
  ])("leaves existing or unexplained state to the original path: %s", (sql) => {
    const db = database(); db.exec(sql);
    const before = schema(db); db.exec("BEGIN IMMEDIATE");
    expect(tryInitializeFreshStateSchema(db)).toBe(false);
    db.exec("COMMIT"); expect(schema(db)).toEqual(before);
  });

  it("requires the caller's transaction and rolls partial DDL back to its savepoint", () => {
    const path = join(root, "fault.sqlite"); const db = database(path);
    expect(() => tryInitializeFreshStateSchema(db)).toThrow("writer reservation");
    db.exec("BEGIN IMMEDIATE");
    const exec = db.exec.bind(db);
    const fault = vi.spyOn(db, "exec").mockImplementation((sql) => {
      if (sql === FRESH_STATE_SCHEMA_SQL) { exec("CREATE TABLE interrupted (id INTEGER)"); throw new Error("injected write failure"); }
      return exec(sql);
    });
    expect(() => tryInitializeFreshStateSchema(db)).toThrow("fresh state schema initialization failed");
    expect(db.inTransaction).toBe(true);
    expect(db.prepare("SELECT name FROM sqlite_schema").all()).toEqual([]);
    fault.mockRestore(); db.exec("COMMIT"); db.close();
    const reopened = database(path); initialize(reopened);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: STATE_DB_MIGRATIONS.length });
  });

  it("uses the batch in the driver and closes both connections after initialization failure", () => {
    const p = paths(); const original = Database.prototype.exec;
    const closed: Database.Database[] = [];
    const close = Database.prototype.close;
    vi.spyOn(Database.prototype, "close").mockImplementation(function (this: Database.Database) { closed.push(this); return close.call(this); });
    const fault = vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql) {
      if (sql === FRESH_STATE_SCHEMA_SQL) { original.call(this, "CREATE TABLE interrupted (id INTEGER)"); throw new Error("injected constructor failure"); }
      return original.call(this, sql);
    });
    expect(() => openStateDatabasePaths(p)).toThrow("fresh state schema initialization failed");
    expect(closed).toHaveLength(2); expect(closed.every((db) => !db.open)).toBe(true);
    fault.mockRestore();
    const driver = openStateDatabasePaths(p);
    try {
      expect(driver.state.pragma("journal_mode", { simple: true })).toBe("wal");
      expect(driver.state.pragma("synchronous", { simple: true })).toBe(2);
      expect(driver.state.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(driver.state.pragma("auto_vacuum", { simple: true })).toBe(2);
      expect(driver.logs.pragma("auto_vacuum", { simple: true })).toBe(0);
    } finally { driver.close(); }
  });

  it("opens state and logs independently without rewriting existing durable records", () => {
    const p = paths(); const first = openStateDatabasePaths(p);
    first.state.exec("INSERT INTO run_lifecycle_epochs (run_id, epoch, opened_at) VALUES ('preserved', 1, 'now')");
    const records = first.state.prepare("SELECT * FROM schema_migrations").all(); first.close();
    unlinkSync(p.logsDbPath);
    const second = openStateDatabasePaths(p);
    try {
      expect(second.state.prepare("SELECT * FROM schema_migrations").all()).toEqual(records);
      expect(second.state.prepare("SELECT run_id FROM run_lifecycle_epochs").get()).toEqual({ run_id: "preserved" });
      expect(second.logs.prepare("SELECT version FROM schema_migrations").all()).toEqual([{ version: 1 }]);
    } finally { second.close(); }
  });

  it("serializes two real processes opening the same fresh project", async () => {
    const p = paths(); mkdirSync(p.projectDir);
    const source = pathToFileURL(resolve("src/state/sqlite-driver.ts")).href;
    const code = `import { openStateDatabasePaths } from ${JSON.stringify(source)};
      process.send('ready'); process.once('message', () => {
        const driver = openStateDatabasePaths(JSON.parse(process.argv[1]));
        driver.state.prepare('INSERT INTO run_lifecycle_epochs (run_id, epoch, opened_at) VALUES (?, 1, ?)').run(process.argv[2], 'now');
        driver.close(); process.disconnect();
      });`;
    const children = ["one", "two"].map((id) => spawn(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", code, JSON.stringify(p), id],
      { stdio: ["ignore", "pipe", "pipe", "ipc"] }));
    try {
      const exits = children.map((child) => new Promise<void>((resolveExit, reject) => {
        let stderr = ""; child.stderr!.on("data", (data) => { stderr += data; });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`first-open child ${code}: ${stderr}`)));
      }));
      // Readiness failure must not leave a rejected exit promise unobserved.
      for (const exit of exits) void exit.catch(() => {});
      await Promise.all(children.map((child) => new Promise<void>((ready, reject) => {
        child.once("message", () => ready()); child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`child exited before readiness: ${code}`)));
      })));
      children.forEach((child) => child.send("open")); await Promise.all(exits);
      const db = database(p.stateDbPath);
      expect(db.prepare("SELECT run_id FROM run_lifecycle_epochs ORDER BY run_id").all()).toEqual([{ run_id: "one" }, { run_id: "two" }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toEqual({ n: STATE_DB_MIGRATIONS.length });
      expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally { for (const child of children) if (child.exitCode === null) child.kill(); }
  }, 30_000);
});
