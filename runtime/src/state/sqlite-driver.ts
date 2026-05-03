import { existsSync, mkdirSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import {
  DEFAULT_SESSION_ROOT_MARKERS,
  getProjectDir,
} from "../session/session-store.js";
import { StateMigrationError } from "./errors.js";
import {
  LOGS_DB_MIGRATIONS,
  STATE_DB_MIGRATIONS,
  type SqlMigration,
} from "./migrations/index.js";
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
    this.state = new Database(paths.stateDbPath);
    this.logs = new Database(paths.logsDbPath);
    configureDatabase(this.state);
    configureDatabase(this.logs);
    applyMigrations(this.state, STATE_DB_MIGRATIONS);
    applyMigrations(this.logs, LOGS_DB_MIGRATIONS);
    replayAtomicSessionSnapshotWrites(this.state, this.projectDir);
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

export function configureDatabase(db: SqliteDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = MEMORY");
}

export function configureReadOnlyDatabase(db: SqliteDatabase): void {
  db.pragma("query_only = ON");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("temp_store = MEMORY");
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
  const insert = db.prepare<[number, string]>(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  const migrate = db.transaction(() => {
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
  });
  migrate();
}
