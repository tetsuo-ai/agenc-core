import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StateSchemaMismatchError } from "./errors.js";
import {
  applyMigrations,
  openStateDatabases,
  resolveStateDatabasePaths,
  STATE_PRE_V12_BACKUP_FILENAME,
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
      ).toBe(14);
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
});
