import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateSchemaMismatchError } from "./errors.js";
import {
  applyMigrations,
  openStateDatabases,
  PREPARED_STATEMENT_CACHE_LIMIT,
  reclaimStateFreePages,
  resolveStateDatabasePaths,
  STATE_PRE_V15_BACKUP_FILENAME,
  STATE_PRE_V12_BACKUP_FILENAME,
  STATE_PRE_V17_BACKUP_FILENAME,
  STATE_PRE_V19_BACKUP_FILENAME,
} from "./sqlite-driver.js";
import { STATE_DB_MIGRATIONS } from "./migrations/index.js";

let home = "";
let cwd = "";
let originalAgencHome = "";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agenc-state-home-"));
  cwd = mkdtempSync(join(tmpdir(), "agenc-state-cwd-"));
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

describe("openStateDatabases", () => {
  it("upgrades a populated v34 effect table for idempotent unknown outcomes", () => {
    const paths = resolveStateDatabasePaths({ cwd });
    mkdirSync(paths.projectDir, { recursive: true, mode: 0o700 });
    const raw = new Database(paths.stateDbPath);
    try {
      applyMigrations(raw, STATE_DB_MIGRATIONS.filter((migration) => migration.version < 35));
      raw.prepare("INSERT INTO run_lifecycle_epochs (run_id, epoch, opened_at) VALUES (?, ?, ?)")
        .run("upgrade-run", 1, "2026-09-24T00:00:00.000Z");
      raw.prepare(`INSERT INTO run_effects (
        run_id, step_id, epoch, session_id, call_id, tool_name,
        recovery_category, idempotency_key, intent_digest, intent_event_id,
        intent_sequence, intent_at, effect_format_version, minimum_reader_runtime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        "upgrade-run", "tool:turn:call", 1, "upgrade-run", "call", "read",
        "idempotent", "sha256:key", "sha256:intent", "intent-event", 1,
        "2026-09-24T00:00:00.000Z", 2, "0.14.0",
      );
    } finally { raw.close(); }
    const driver = openStateDatabases({ cwd });
    try {
      driver.prepareState(`UPDATE run_effects SET
        outcome = 'unknown_outcome', result_event_id = 'unknown-event',
        result_sequence = 2, unknown_reason = 'forced_shutdown',
        completed_at = '2026-09-24T00:00:01.000Z', review_status = 'pending'
        WHERE run_id = 'upgrade-run' AND step_id = 'tool:turn:call'`).run();
      expect(driver.prepareState<[], { outcome: string; idempotency_key: string }>(
        "SELECT outcome, idempotency_key FROM run_effects WHERE run_id = 'upgrade-run'",
      ).get()).toEqual({ outcome: "unknown_outcome", idempotency_key: "sha256:key" });
      expect(() => driver.prepareState(
        "UPDATE run_effects SET idempotency_key = 'changed' WHERE run_id = 'upgrade-run'",
      ).run()).toThrow();
    } finally { driver.close(); }
  });

  it("creates project-scoped state and logs databases with migrations", () => {
    const driver = openStateDatabases({ cwd });
    try {
      expect(driver.stateDbPath).toContain("agenc-state_1.sqlite");
      expect(driver.logsDbPath).toContain("agenc-logs_1.sqlite");
      expect(
        driver
          .prepareState<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'",
          )
          .get()?.name,
      ).toBe("threads");
      const agentRunColumns = driver
        .prepareState<[], { name: string }>("PRAGMA table_info(agent_runs)")
        .all()
        .map((column) => column.name);
      expect(agentRunColumns).toEqual([
        "id",
        "objective",
        "status",
        "started_at",
        "last_active_at",
        "current_session_id",
        "created_by_client",
        "last_snapshot_at",
        "metadata_json",
      ]);
      const snapshotColumns = driver
        .prepareState<[], { name: string; notnull: number; pk: number }>(
          "PRAGMA table_info(session_state_snapshots)",
        )
        .all();
      expect(snapshotColumns.map((column) => column.name)).toEqual([
        "session_id",
        "snapshot_at",
        "conversation_json",
        "tool_state_json",
        "mcp_connection_state_json",
      ]);
      expect(
        snapshotColumns.find((column) => column.name === "session_id"),
      ).toMatchObject({ notnull: 1, pk: 1 });
      expect(
        snapshotColumns.find((column) => column.name === "snapshot_at"),
      ).toMatchObject({ notnull: 1, pk: 2 });
      const toolCallColumns = driver
        .prepareState<[], { name: string; notnull: number; pk: number }>(
          "PRAGMA table_info(in_flight_tool_calls)",
        )
        .all();
      expect(toolCallColumns.map((column) => column.name)).toEqual([
        "session_id",
        "tool_call_id",
        "tool_name",
        "args_json",
        "status",
        "output_partial",
        "started_at",
        "output_log_path",
        "output_log_bytes",
        "recovery_category",
      ]);
      expect(
        toolCallColumns.find((column) => column.name === "session_id"),
      ).toMatchObject({ notnull: 1, pk: 1 });
      expect(
        toolCallColumns.find((column) => column.name === "tool_call_id"),
      ).toMatchObject({ notnull: 1, pk: 2 });
      expect(
        driver
          .prepareLogs<[], { name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'logs'",
          )
          .get()?.name,
      ).toBe("logs");
    } finally {
      driver.close();
    }
  });

  it("refuses to open a DB migrated by a newer runtime (forward-version guard)", () => {
    // Create the DB with the current runtime, then seed a future migration
    // version row as if a newer runtime had migrated it.
    const driver = openStateDatabases({ cwd });
    driver.close();

    const paths = resolveStateDatabasePaths({ cwd });
    const raw = new Database(paths.stateDbPath);
    try {
      raw
        .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
        .run(9999, "from_a_newer_runtime");
    } finally {
      raw.close();
    }

    expect(() => openStateDatabases({ cwd })).toThrow(StateSchemaMismatchError);
  });

  it("creates a verified pre-v12 backup that an older runtime can restore", () => {
    const paths = resolveStateDatabasePaths({ cwd });
    mkdirSync(paths.projectDir, { recursive: true, mode: 0o700 });
    const raw = new Database(paths.stateDbPath);
    try {
      applyMigrations(
        raw,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version < 12),
      );
      const insertEdge = raw.prepare(
        `INSERT INTO thread_spawn_edges (
          child_thread_id, parent_thread_id, parent_path, metadata_json, status
        ) VALUES (?, ?, ?, ?, ?)`,
      );
      insertEdge.run(
        "backup-child",
        "backup-root",
        "/root",
        JSON.stringify({
          agentId: "backup-child",
          agentPath: "/root/backup-child",
          agentRole: "reviewer",
          agentRoleWorkspaceId: cwd,
          depth: 1,
        }),
        "open",
      );

      // Model a prior upgrade attempt that published a backup but died before
      // committing v12. State can continue changing under v11; the next
      // attempt must refresh, not trust, this now-stale artifact.
      const staleBackupPath = join(
        paths.projectDir,
        STATE_PRE_V12_BACKUP_FILENAME,
      );
      raw.exec(`VACUUM main INTO '${staleBackupPath.replaceAll("'", "''")}'`);
      insertEdge.run(
        "after-stale-backup",
        "backup-root",
        "/root",
        JSON.stringify({
          agentId: "after-stale-backup",
          agentPath: "/root/after-stale-backup",
          agentRole: "reviewer",
          agentRoleWorkspaceId: cwd,
          depth: 1,
        }),
        "open",
      );
    } finally {
      raw.close();
    }

    const driver = openStateDatabases({ cwd });
    try {
      expect(
        driver
          .prepareState<[], { version: number }>(
            "SELECT MAX(version) AS version FROM schema_migrations",
          )
          .get()?.version,
      ).toBe(STATE_DB_MIGRATIONS.at(-1)?.version);
    } finally {
      driver.close();
    }

    const backupPath = join(paths.projectDir, STATE_PRE_V12_BACKUP_FILENAME);
    expect(existsSync(backupPath)).toBe(true);
    const backup = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        backup
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 11 });
      expect(
        backup
          .prepare("PRAGMA table_info(thread_spawn_edges)")
          .all()
          .some(
            (column) =>
              (column as { name?: unknown }).name === "agent_role_workspace_id",
          ),
      ).toBe(false);
      expect(
        backup
          .prepare(
            `SELECT parent_thread_id, metadata_json, status
             FROM thread_spawn_edges
             WHERE child_thread_id = ?`,
          )
          .get("backup-child"),
      ).toMatchObject({
        parent_thread_id: "backup-root",
        status: "open",
      });
      expect(
        backup
          .prepare(
            "SELECT child_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?",
          )
          .get("after-stale-backup"),
      ).toEqual({ child_thread_id: "after-stale-backup" });
      expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      backup.close();
    }

    const restoredPath = join(paths.projectDir, "restored-pre-v12.sqlite");
    copyFileSync(backupPath, restoredPath);
    const restored = new Database(restoredPath);
    try {
      expect(() =>
        applyMigrations(
          restored,
          STATE_DB_MIGRATIONS.filter((migration) => migration.version < 12),
        ),
      ).not.toThrow();
      expect(
        restored
          .prepare(
            "SELECT child_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?",
          )
          .get("backup-child"),
      ).toEqual({ child_thread_id: "backup-child" });
      expect(
        restored
          .prepare(
            "SELECT child_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?",
          )
          .get("after-stale-backup"),
      ).toEqual({ child_thread_id: "after-stale-backup" });
    } finally {
      restored.close();
    }
  });

  it("decides the pre-v12 backup under the writer lock with a v11 connection open", () => {
    const paths = resolveStateDatabasePaths({ cwd });
    mkdirSync(paths.projectDir, { recursive: true, mode: 0o700 });
    const v11 = new Database(paths.stateDbPath);
    try {
      applyMigrations(
        v11,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version < 12),
      );
      v11
        .prepare(
          `INSERT INTO thread_spawn_edges (
          child_thread_id, parent_thread_id, parent_path, metadata_json, status
        ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "concurrent-child",
          "root-1",
          "/root",
          JSON.stringify({
            agentId: "concurrent-child",
            agentPath: "/root/concurrent",
            agentRole: "default",
            depth: 1,
          }),
          "open",
        );

      const upgraded = openStateDatabases({ cwd });
      upgraded.close();

      const backup = new Database(
        join(paths.projectDir, STATE_PRE_V12_BACKUP_FILENAME),
        { readonly: true, fileMustExist: true },
      );
      try {
        expect(
          backup
            .prepare(
              "SELECT child_thread_id FROM thread_spawn_edges WHERE child_thread_id = ?",
            )
            .get("concurrent-child"),
        ).toEqual({ child_thread_id: "concurrent-child" });
        expect(
          backup
            .prepare("SELECT MAX(version) AS version FROM schema_migrations")
            .get(),
        ).toEqual({ version: 11 });
      } finally {
        backup.close();
      }
    } finally {
      v11.close();
    }
  });

  it("creates a verified pre-v15 backup before installing durable run state", () => {
    const paths = resolveStateDatabasePaths({ cwd });
    mkdirSync(paths.projectDir, { recursive: true, mode: 0o700 });
    const v14 = new Database(paths.stateDbPath);
    try {
      applyMigrations(
        v14,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version < 15),
      );
      v14.prepare(
        `INSERT INTO agent_runs (
           id, objective, status, started_at, last_active_at
         ) VALUES (?, ?, ?, ?, ?)`,
      ).run(
        "run-before-v15",
        "preserve me",
        "running",
        "2026-07-18T00:00:00.000Z",
        "2026-07-18T00:00:01.000Z",
      );
    } finally {
      v14.close();
    }

    const upgraded = openStateDatabases({ cwd });
    upgraded.close();

    const backupPath = join(
      paths.projectDir,
      STATE_PRE_V15_BACKUP_FILENAME,
    );
    expect(existsSync(backupPath)).toBe(true);
    const backup = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        backup
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 14 });
      expect(
        backup
          .prepare(
            "SELECT objective FROM agent_runs WHERE id = 'run-before-v15'",
          )
          .get(),
      ).toEqual({ objective: "preserve me" });
      expect(
        backup
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'run_terminal_results'`,
          )
          .get(),
      ).toBeUndefined();
      expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      backup.close();
    }

    const restoredPath = join(paths.projectDir, "restored-pre-v15.sqlite");
    copyFileSync(backupPath, restoredPath);
    const restored = new Database(restoredPath);
    try {
      expect(() =>
        applyMigrations(
          restored,
          STATE_DB_MIGRATIONS.filter((migration) => migration.version < 15),
        ),
      ).not.toThrow();
      expect(
        restored
          .prepare("SELECT objective FROM agent_runs WHERE id = ?")
          .get("run-before-v15"),
      ).toEqual({ objective: "preserve me" });
    } finally {
      restored.close();
    }
  });

  it("creates a restorable pre-v17 backup before the effect evidence cutover", () => {
    const paths = resolveStateDatabasePaths({ cwd });
    mkdirSync(paths.projectDir, { recursive: true, mode: 0o700 });
    const v16 = new Database(paths.stateDbPath);
    try {
      applyMigrations(
        v16,
        STATE_DB_MIGRATIONS.filter((migration) => migration.version < 17),
      );
      v16.prepare(
        `INSERT INTO run_lifecycle_epochs (run_id, epoch, opened_at)
         VALUES ('pre-v17-run', 1, '2026-07-18T00:00:00.000Z')`,
      ).run();
    } finally {
      v16.close();
    }

    const upgraded = openStateDatabases({ cwd });
    upgraded.close();

    const backupPath = join(
      paths.projectDir,
      STATE_PRE_V17_BACKUP_FILENAME,
    );
    expect(existsSync(backupPath)).toBe(true);
    const backup = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        backup
          .prepare("SELECT MAX(version) AS version FROM schema_migrations")
          .get(),
      ).toEqual({ version: 16 });
      expect(
        backup
          .prepare(
            "SELECT run_id FROM run_lifecycle_epochs WHERE run_id = 'pre-v17-run'",
          )
          .get(),
      ).toEqual({ run_id: "pre-v17-run" });
      expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      backup.close();
    }
  });

  it("backs up current-main state when migration 20 precedes missing migration 19", () => {
    const paths = seedCurrentMainStateWithoutMigration19();

    const upgraded = openStateDatabases({ cwd });
    try {
      expect(
        upgraded
          .prepareState<[number], { version: number }>(
            "SELECT version FROM schema_migrations WHERE version = ?",
          )
          .get(19),
      ).toEqual({ version: 19 });
    } finally {
      upgraded.close();
    }

    const backupPath = join(
      paths.projectDir,
      STATE_PRE_V19_BACKUP_FILENAME,
    );
    expect(existsSync(backupPath)).toBe(true);
    const backup = new Database(backupPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        backup
          .prepare(
            "SELECT version FROM schema_migrations WHERE version IN (19, 20) ORDER BY version",
          )
          .all(),
      ).toEqual([{ version: 20 }]);
      expect(
        backup
          .prepare("PRAGMA table_info(csv_agent_jobs)")
          .all()
          .some(
            (column) => (column as { name?: unknown }).name === "import_state",
          ),
      ).toBe(false);
      expect(
        backup
          .prepare(
            `SELECT name FROM sqlite_master
             WHERE type = 'table' AND name = 'tool_pair_projection_runs'`,
          )
          .get(),
      ).toEqual({ name: "tool_pair_projection_runs" });
      expect(
        backup
          .prepare("SELECT instruction FROM csv_agent_jobs WHERE id = ?")
          .get("pre-v19-job"),
      ).toEqual({ instruction: "preserve pre-v19 state" });
      expect(backup.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
    } finally {
      backup.close();
    }
  });

  it("blocks migration 19 when its mandatory backup cannot be published", () => {
    const paths = seedCurrentMainStateWithoutMigration19();
    mkdirSync(join(paths.projectDir, STATE_PRE_V19_BACKUP_FILENAME));

    expect(() => openStateDatabases({ cwd })).toThrow();

    const unmigrated = new Database(paths.stateDbPath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        unmigrated
          .prepare(
            "SELECT version FROM schema_migrations WHERE version IN (19, 20) ORDER BY version",
          )
          .all(),
      ).toEqual([{ version: 20 }]);
      expect(
        unmigrated
          .prepare("PRAGMA table_info(csv_agent_jobs)")
          .all()
          .some(
            (column) => (column as { name?: unknown }).name === "import_state",
          ),
      ).toBe(false);
      expect(
        unmigrated
          .prepare("SELECT instruction FROM csv_agent_jobs WHERE id = ?")
          .get("pre-v19-job"),
      ).toEqual({ instruction: "preserve pre-v19 state" });
    } finally {
      unmigrated.close();
    }
  });
});

function seedCurrentMainStateWithoutMigration19(): ReturnType<
  typeof resolveStateDatabasePaths
> {
  const paths = resolveStateDatabasePaths({ cwd });
  mkdirSync(paths.projectDir, { recursive: true, mode: 0o700 });
  const raw = new Database(paths.stateDbPath);
  try {
    applyMigrations(
      raw,
      STATE_DB_MIGRATIONS.filter(
        (migration) => migration.version !== 19 && migration.version !== 21,
      ),
    );
    raw
      .prepare(
        `INSERT INTO csv_agent_jobs (
           id, name, status, instruction, input_headers_json, input_csv_path,
           output_csv_path, auto_export, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "pre-v19-job",
        "pre-v19 backup contract",
        "pending",
        "preserve pre-v19 state",
        JSON.stringify(["value"]),
        "/input.csv",
        "/output.csv",
        0,
        1,
        1,
      );
  } finally {
    raw.close();
  }
  return paths;
}

describe("free-page reclaim", () => {
  const PAGE = 4096;
  function fillAndEmpty(db: Database.Database, rows: number): void {
    db.exec("CREATE TABLE IF NOT EXISTS scratch (id INTEGER PRIMARY KEY, blob BLOB NOT NULL)");
    const insert = db.prepare("INSERT INTO scratch (blob) VALUES (?)");
    const payload = Buffer.alloc(PAGE - 64, 1);
    db.transaction(() => {
      for (let index = 0; index < rows; index += 1) insert.run(payload);
    })();
    db.exec("DELETE FROM scratch");
  }
  const freePages = (db: Database.Database): number =>
    Number(db.pragma("freelist_count", { simple: true }));
  const autoVacuum = (db: Database.Database): number =>
    Number(db.pragma("auto_vacuum", { simple: true }));

  it("creates a fresh state database with incremental auto-vacuum", () => {
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      expect(autoVacuum(driver.state)).toBe(2);
    } finally {
      driver.close();
    }
  });

  it("returns free pages of an incremental database in bounded steps", () => {
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      fillAndEmpty(driver.state, 3_000);
      const before = freePages(driver.state);
      expect(before).toBeGreaterThan(1_000);
      const report = driver.reclaimFreePages({ maxPages: 100 });
      expect(report.mode).toBe("incremental");
      expect(report.freePagesBefore).toBe(before);
      expect(before - report.freePagesAfter).toBeGreaterThan(0);
      expect(before - report.freePagesAfter).toBeLessThanOrEqual(100);
      expect(freePages(driver.state)).toBe(report.freePagesAfter);
    } finally {
      driver.close();
    }
  });

  it("rewrites a legacy database once when most of it is free, then it is incremental", () => {
    const paths = resolveStateDatabasePaths({ cwd, agencHome: home });
    mkdirSync(paths.projectDir, { recursive: true });
    const legacy = new Database(paths.stateDbPath);
    fillAndEmpty(legacy, 4_000);
    expect(autoVacuum(legacy)).toBe(0);
    expect(freePages(legacy)).toBeGreaterThan(3_000);
    legacy.close();
    const sizeBefore = statSync(paths.stateDbPath).size;

    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      // Existing tables: the fresh-database pragma must not have been applied.
      expect(autoVacuum(driver.state)).toBe(0);
      const declined = driver.reclaimFreePages();
      expect(declined).toMatchObject({ mode: "none", reason: "full-vacuum-not-allowed" });
      const report = driver.reclaimFreePages({
        allowFullVacuum: true,
        fullVacuumMinFreeBytes: 1024 * 1024,
      });
      expect(report.mode).toBe("full");
      expect(report.freePagesAfter).toBe(0);
      expect(autoVacuum(driver.state)).toBe(2);
      // The rebuild spilled to disk and the connection is back on its memory temp store.
      expect(Number(driver.state.pragma("temp_store", { simple: true }))).toBe(2);
      expect(statSync(paths.stateDbPath).size).toBeLessThan(sizeBefore / 2);
      // From now on the periodic path works without a full vacuum.
      fillAndEmpty(driver.state, 500);
      expect(driver.reclaimFreePages({ maxPages: 50 }).mode).toBe("incremental");
    } finally {
      driver.close();
    }
  });

  it("leaves a legacy database alone below the free-space threshold and reports why", () => {
    const paths = resolveStateDatabasePaths({ cwd, agencHome: home });
    mkdirSync(paths.projectDir, { recursive: true });
    const legacy = new Database(paths.stateDbPath);
    legacy.exec("CREATE TABLE keep (id INTEGER PRIMARY KEY, blob BLOB NOT NULL)");
    const insert = legacy.prepare("INSERT INTO keep (blob) VALUES (?)");
    for (let index = 0; index < 400; index += 1) insert.run(Buffer.alloc(PAGE - 64, 2));
    fillAndEmpty(legacy, 20);
    expect(freePages(legacy)).toBeGreaterThan(0);
    const report = reclaimStateFreePages(legacy, { allowFullVacuum: true });
    expect(report).toMatchObject({ mode: "none", reason: "below-threshold" });
    expect(freePages(legacy)).toBe(report.freePagesBefore);
    legacy.close();
  });

  it("reports nothing to do when the file has no free pages", () => {
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      driver.reclaimFreePages({ maxPages: 100_000 });
      expect(driver.reclaimFreePages()).toMatchObject({ mode: "none", reason: "no-free-pages" });
    } finally {
      driver.close();
    }
  });
});

describe("prepared statement reuse", () => {
  it("compiles each SQL text once and keeps results per call", () => {
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      driver.state.exec("CREATE TABLE reuse_probe (id INTEGER PRIMARY KEY, label TEXT NOT NULL)");
      const insertSql = "INSERT INTO reuse_probe (id, label) VALUES (?, ?)";
      const insert = driver.prepareState<[number, string]>(insertSql);
      insert.run(1, "one");
      expect(driver.prepareState(insertSql)).toBe(insert);
      driver.prepareState<[number, string]>(insertSql).run(2, "two");

      const selectSql = "SELECT label FROM reuse_probe WHERE id = ?";
      expect(
        driver.prepareState<[number], { label: string }>(selectSql).get(1)?.label,
      ).toBe("one");
      expect(
        driver.prepareState<[number], { label: string }>(selectSql).get(2)?.label,
      ).toBe("two");
      expect(driver.prepareLogs("SELECT 1")).toBe(driver.prepareLogs("SELECT 1"));
    } finally {
      driver.close();
    }
  });

  it("hands a statement that is still iterating to nobody else", () => {
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      driver.state.exec("CREATE TABLE iterate_probe (id INTEGER PRIMARY KEY)");
      driver.state.exec("INSERT INTO iterate_probe (id) VALUES (1), (2), (3)");
      const sql = "SELECT id FROM iterate_probe ORDER BY id";
      const outer = driver.prepareState<[], { id: number }>(sql);
      const seen: number[][] = [];
      for (const row of outer.iterate()) {
        const inner = driver.prepareState<[], { id: number }>(sql);
        expect(inner).not.toBe(outer);
        seen.push([row.id, inner.all().length]);
      }
      expect(seen).toEqual([
        [1, 3],
        [2, 3],
        [3, 3],
      ]);
      // Idle again once the iteration finished: reused, not recompiled.
      expect(driver.prepareState(sql)).toBe(outer);
    } finally {
      driver.close();
    }
  });

  it("keeps at most PREPARED_STATEMENT_CACHE_LIMIT texts, dropping the least recent", () => {
    const driver = openStateDatabases({ cwd, agencHome: home });
    try {
      const sqlFor = (index: number): string => `SELECT ${index} AS value`;
      const first = driver.prepareState(sqlFor(0));
      const second = driver.prepareState(sqlFor(1));
      for (let index = 2; index < PREPARED_STATEMENT_CACHE_LIMIT; index += 1) {
        driver.prepareState(sqlFor(index));
      }
      // Touch the first text so the second one is now the least recent.
      expect(driver.prepareState(sqlFor(0))).toBe(first);
      driver.prepareState(sqlFor(PREPARED_STATEMENT_CACHE_LIMIT));
      expect(driver.prepareState(sqlFor(0))).toBe(first);
      expect(driver.prepareState(sqlFor(1))).not.toBe(second);
    } finally {
      driver.close();
    }
  });

  it("fails like a fresh prepare once the connection is closed", () => {
    const driver = openStateDatabases({ cwd, agencHome: home });
    const sql = "SELECT 1 AS value";
    driver.prepareState(sql).get();
    driver.close();
    expect(() => driver.prepareState(sql).get()).toThrow(
      "The database connection is not open",
    );
  });
});
