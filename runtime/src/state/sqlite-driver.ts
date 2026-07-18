import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import {
  DEFAULT_SESSION_ROOT_MARKERS,
  getProjectDir,
} from "../session/session-store.js";
import { StateMigrationError, StateSchemaMismatchError } from "./errors.js";
import {
  LOGS_DB_MIGRATIONS,
  STATE_DB_MIGRATIONS,
  type SqlMigration,
} from "./migrations/index.js";
import { AGENT_ROLE_WORKSPACE_PROVENANCE_SCHEMA_VERSION } from "./migrations/012_agent_role_workspace_provenance.js";
import { replayAtomicSessionSnapshotWrites } from "./atomic-snapshot-writes.js";

export interface OpenStateDatabaseOptions {
  readonly cwd: string;
  readonly agencHome?: string;
  readonly projectRootMarkers?: readonly string[];
}

export interface StateDatabasePaths {
  readonly projectDir: string;
  readonly stateDbPath: string;
  readonly logsDbPath: string;
}

export const STATE_DATABASE_FILENAME = "agenc-state_1.sqlite";
export const LOGS_DATABASE_FILENAME = "agenc-logs_1.sqlite";
export const STATE_PRE_V12_BACKUP_FILENAME = "agenc-state_1.pre-v12.sqlite";

export type SqliteDatabase = BetterSqlite3.Database;
export type SqliteStatement<
  Params extends unknown[] = unknown[],
  Row = unknown,
> = BetterSqlite3.Statement<Params, Row>;

export class StateSqliteDriver {
  readonly projectDir: string;
  readonly stateDbPath: string;
  readonly logsDbPath: string;
  readonly state: SqliteDatabase;
  readonly logs: SqliteDatabase;

  constructor(paths: StateDatabasePaths) {
    this.projectDir = paths.projectDir;
    this.stateDbPath = paths.stateDbPath;
    this.logsDbPath = paths.logsDbPath;
    const state = new Database(paths.stateDbPath);
    let logs: SqliteDatabase | undefined;
    try {
      logs = new Database(paths.logsDbPath);
      configureDatabase(state);
      configureDatabase(logs);
      applyStateMigrations(state, paths);
      applyMigrations(logs, LOGS_DB_MIGRATIONS);
      replayAtomicSessionSnapshotWrites(state, this.projectDir);
    } catch (error) {
      if (state.open) state.close();
      if (logs?.open) logs.close();
      throw error;
    }
    this.state = state;
    this.logs = logs;
  }

  prepareState<Params extends unknown[] = unknown[], Row = unknown>(
    sql: string,
  ): SqliteStatement<Params, Row> {
    return this.state.prepare<Params, Row>(sql);
  }

  prepareLogs<Params extends unknown[] = unknown[], Row = unknown>(
    sql: string,
  ): SqliteStatement<Params, Row> {
    return this.logs.prepare<Params, Row>(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.state.transaction(fn)();
  }

  /**
   * BEGIN IMMEDIATE transaction: acquires the write lock before the first
   * read, so a read-then-write sequence (e.g. an admission-gate check
   * followed by the gated INSERT) cannot interleave with another process's
   * commit between the check and the write. Nested calls degrade to a
   * savepoint inside the outer transaction (better-sqlite3 semantics).
   */
  transactionImmediate<T>(fn: () => T): T {
    return this.state.transaction(fn).immediate();
  }

  logsTransaction<T>(fn: () => T): T {
    return this.logs.transaction(fn)();
  }

  close(): void {
    if (this.state.open) this.state.close();
    if (this.logs.open) this.logs.close();
  }
}

export class StateSqliteReader {
  readonly projectDir: string;
  readonly stateDbPath: string;
  readonly logsDbPath: string;
  readonly state: SqliteDatabase;
  readonly logs: SqliteDatabase;

  constructor(paths: StateDatabasePaths) {
    this.projectDir = paths.projectDir;
    this.stateDbPath = paths.stateDbPath;
    this.logsDbPath = paths.logsDbPath;
    this.state = new Database(paths.stateDbPath, {
      readonly: true,
      fileMustExist: true,
    });
    this.logs = new Database(paths.logsDbPath, {
      readonly: true,
      fileMustExist: true,
    });
    configureReadOnlyDatabase(this.state);
    configureReadOnlyDatabase(this.logs);
  }

  prepareState<Params extends unknown[] = unknown[], Row = unknown>(
    sql: string,
  ): SqliteStatement<Params, Row> {
    return this.state.prepare<Params, Row>(sql);
  }

  prepareLogs<Params extends unknown[] = unknown[], Row = unknown>(
    sql: string,
  ): SqliteStatement<Params, Row> {
    return this.logs.prepare<Params, Row>(sql);
  }

  close(): void {
    if (this.state.open) this.state.close();
    if (this.logs.open) this.logs.close();
  }
}

export function resolveStateDatabasePaths(
  options: OpenStateDatabaseOptions,
): StateDatabasePaths {
  const projectDir = getProjectDir(
    options.cwd,
    options.projectRootMarkers ?? DEFAULT_SESSION_ROOT_MARKERS,
    options.agencHome,
  );
  return {
    projectDir,
    stateDbPath: join(projectDir, STATE_DATABASE_FILENAME),
    logsDbPath: join(projectDir, LOGS_DATABASE_FILENAME),
  };
}

export function openStateDatabases(
  options: OpenStateDatabaseOptions,
): StateSqliteDriver {
  const paths = resolveStateDatabasePaths(options);
  return openStateDatabasePaths(paths);
}

export function openStateDatabasePaths(
  paths: StateDatabasePaths,
): StateSqliteDriver {
  mkdirSync(paths.projectDir, { recursive: true, mode: 0o700 });
  return new StateSqliteDriver(paths);
}

export function openStateDatabaseReader(
  options: OpenStateDatabaseOptions,
): StateSqliteReader {
  const paths = resolveStateDatabasePaths(options);
  return openStateDatabasePathReader(paths);
}

export function openStateDatabasePathReader(
  paths: StateDatabasePaths,
): StateSqliteReader {
  return new StateSqliteReader(paths);
}

export function discoverStateDatabasePaths(
  agencHome: string,
): StateDatabasePaths[] {
  const projectsDir = join(agencHome, "projects");
  let entries: Dirent[];
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const projectDir = join(projectsDir, entry.name);
      return {
        projectDir,
        stateDbPath: join(projectDir, STATE_DATABASE_FILENAME),
        logsDbPath: join(projectDir, LOGS_DATABASE_FILENAME),
      };
    })
    .filter((paths) => existsSync(paths.stateDbPath));
}

function configureDatabase(db: SqliteDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = MEMORY");
}

function configureReadOnlyDatabase(db: SqliteDatabase): void {
  db.pragma("query_only = ON");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = MEMORY");
}

function applyStateMigrations(
  db: SqliteDatabase,
  paths: StateDatabasePaths,
): void {
  // Acquire the writer reservation before inspecting the schema. Otherwise a
  // concurrently starting v11 process can initialize/populate the file after
  // an existence/version check and make us migrate it without a backup.
  db.exec("BEGIN IMMEDIATE");
  try {
    if (
      hasUserStateTables(db) &&
      maxAppliedMigrationVersion(db) <
        AGENT_ROLE_WORKSPACE_PROVENANCE_SCHEMA_VERSION
    ) {
      createPreV12StateBackupLocked(paths);
    }
    applyMigrations(db, STATE_DB_MIGRATIONS);
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function createPreV12StateBackupLocked(paths: StateDatabasePaths): void {
  const backupPath = join(paths.projectDir, STATE_PRE_V12_BACKUP_FILENAME);
  const tempPath = `${backupPath}.${process.pid}.${randomUUID()}.tmp`;
  let snapshotSource: SqliteDatabase | undefined;
  try {
    // VACUUM INTO runs on a second connection because the primary connection
    // intentionally holds BEGIN IMMEDIATE. The lock prevents all source
    // writers while SQLite itself produces a transactionally consistent file.
    snapshotSource = new Database(paths.stateDbPath);
    snapshotSource.pragma("busy_timeout = 5000");
    snapshotSource.exec(`VACUUM main INTO ${sqliteStringLiteral(tempPath)}`);
    snapshotSource.close();
    snapshotSource = undefined;

    chmodSync(tempPath, 0o600);
    validatePreV12StateBackup(tempPath);
    fsyncFile(tempPath);

    // Refresh a stale artifact from an earlier failed attempt while the source
    // write lock is still held. A crash before publication leaves v11 intact;
    // a crash after publication leaves a fresh, fsynced rollback artifact.
    try {
      unlinkSync(backupPath);
      fsyncDirectory(paths.projectDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    linkSync(tempPath, backupPath);
    fsyncDirectory(paths.projectDir);
  } finally {
    if (snapshotSource?.open) snapshotSource.close();
    try {
      unlinkSync(tempPath);
      fsyncDirectory(paths.projectDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function hasUserStateTables(db: SqliteDatabase): boolean {
  const row = db
    .prepare<[], { count: number }>(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name <> 'schema_migrations'`,
    )
    .get();
  return (row?.count ?? 0) > 0;
}

function maxAppliedMigrationVersion(db: SqliteDatabase): number {
  const table = db
    .prepare<[], { name: string }>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = 'schema_migrations'`,
    )
    .get();
  if (!table) return 0;
  return (
    db
      .prepare<[], { version: number | null }>(
        "SELECT MAX(version) AS version FROM schema_migrations",
      )
      .get()?.version ?? 0
  );
}

function validatePreV12StateBackup(path: string): void {
  const backup = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const integrity = backup
      .prepare<[], { integrity_check: string }>("PRAGMA integrity_check")
      .all();
    if (
      integrity.length !== 1 ||
      integrity[0]?.integrity_check.toLowerCase() !== "ok"
    ) {
      throw new Error(`state backup failed integrity check: ${path}`);
    }
    if (
      maxAppliedMigrationVersion(backup) >=
      AGENT_ROLE_WORKSPACE_PROVENANCE_SCHEMA_VERSION
    ) {
      throw new Error(`state backup is not a pre-v12 database: ${path}`);
    }
  } finally {
    backup.close();
  }
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function applyMigrations(
  db: SqliteDatabase,
  migrations: readonly SqlMigration[],
): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
`);
  const appliedRows = db
    .prepare<[], { version: number }>("SELECT version FROM schema_migrations")
    .all();
  const applied = new Set(
    appliedRows.map((row: { version: number }) => row.version),
  );

  // Forward-version guard: an older runtime opening a DB migrated by a newer
  // runtime must refuse rather than corrupt it. Known migrations are skipped
  // when already applied, so without this check a higher applied version would
  // silently slip through.
  const maxApplied = appliedRows.reduce(
    (max, row) => (row.version > max ? row.version : max),
    0,
  );
  const maxKnown = migrations.reduce(
    (max, migration) => (migration.version > max ? migration.version : max),
    0,
  );
  if (maxApplied > maxKnown) {
    throw new StateSchemaMismatchError(maxApplied, maxKnown);
  }

  const insert = db.prepare<[number, string]>(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  const migrate = () => {
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      try {
        if (migration.sql !== undefined) db.exec(migration.sql);
        migration.apply?.(db);
        insert.run(migration.version, migration.name);
      } catch (cause) {
        throw new StateMigrationError(
          `state migration ${migration.version} failed`,
          { cause },
        );
      }
    }
  };
  // better-sqlite3 implements nested transactions with a savepoint. Keep the
  // savepoint even when a caller already owns an outer transaction so a caught
  // migration error cannot leave partial DDL/data for that caller to commit.
  db.transaction(migrate)();
}
