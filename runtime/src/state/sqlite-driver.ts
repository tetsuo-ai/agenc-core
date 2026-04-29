import { mkdirSync } from "node:fs";
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
} from "./migrations.js";

export interface OpenStateDatabaseOptions {
  readonly cwd: string;
  readonly projectRootMarkers?: readonly string[];
}

export interface StateDatabasePaths {
  readonly projectDir: string;
  readonly stateDbPath: string;
  readonly logsDbPath: string;
}

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

export function resolveStateDatabasePaths(
  options: OpenStateDatabaseOptions,
): StateDatabasePaths {
  const projectDir = getProjectDir(
    options.cwd,
    options.projectRootMarkers ?? DEFAULT_SESSION_ROOT_MARKERS,
  );
  return {
    projectDir,
    stateDbPath: join(projectDir, "agenc-state_1.sqlite"),
    logsDbPath: join(projectDir, "agenc-logs_1.sqlite"),
  };
}

export function openStateDatabases(
  options: OpenStateDatabaseOptions,
): StateSqliteDriver {
  const paths = resolveStateDatabasePaths(options);
  mkdirSync(paths.projectDir, { recursive: true, mode: 0o700 });
  return new StateSqliteDriver(paths);
}

export function configureDatabase(db: SqliteDatabase): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL");
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
  const applied = new Set(appliedRows.map((row) => row.version));
  const insert = db.prepare<[number, string]>(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  const migrate = db.transaction(() => {
    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      try {
        db.exec(migration.sql);
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
