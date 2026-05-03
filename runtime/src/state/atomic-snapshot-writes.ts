import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import type { SqliteDatabase, StateSqliteDriver } from "./sqlite-driver.js";

const PENDING_SNAPSHOT_DIR = "session_state_snapshots.pending";
const SNAPSHOT_WRITE_FORMAT = "agenc.session_state_snapshot_write";
const SNAPSHOT_WRITE_SCHEMA_VERSION = 1;

export interface SessionSnapshotWriteRecord {
  readonly sessionId: string;
  readonly snapshotAt: string;
  readonly conversationJson: string;
  readonly toolStateJson: string;
  readonly mcpConnectionStateJson: string;
}

export interface SessionSnapshotAtomicWriteOptions {
  readonly updateRunLastSnapshotAt?: boolean;
  readonly replayOnStartup?: boolean;
}

export interface PendingSessionSnapshotWrite {
  readonly path: string;
  readonly directory: string;
  readonly record: SessionSnapshotWriteRecord;
  readonly updateRunLastSnapshotAt: boolean;
  readonly replayOnStartup: boolean;
}

interface SessionSnapshotWriteFile {
  readonly format: typeof SNAPSHOT_WRITE_FORMAT;
  readonly schemaVersion: typeof SNAPSHOT_WRITE_SCHEMA_VERSION;
  readonly replayOnStartup: boolean;
  readonly updateRunLastSnapshotAt: boolean;
  readonly record: SessionSnapshotWriteRecord;
}

export function writeSessionSnapshotAtomically(
  driver: StateSqliteDriver,
  record: SessionSnapshotWriteRecord,
  options: SessionSnapshotAtomicWriteOptions = {},
): void {
  const pending = stageSessionSnapshotWrite(driver.projectDir, record, options);
  try {
    commitPendingSessionSnapshotWrite(driver.state, pending, "strict");
  } catch (error) {
    if (!pending.replayOnStartup) removePendingSessionSnapshotWrite(pending);
    throw error;
  }
  removePendingSessionSnapshotWrite(pending);
}

export function replayAtomicSessionSnapshotWrites(
  db: SqliteDatabase,
  projectDir: string,
): void {
  const directory = pendingSnapshotDirectory(projectDir);
  if (!existsSync(directory)) return;

  const files = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => join(directory, entry.name))
    .sort();

  for (const path of files) {
    const pending = readPendingSessionSnapshotWrite(directory, path);
    if (!pending.replayOnStartup) {
      removePendingSessionSnapshotWrite(pending);
      continue;
    }
    commitPendingSessionSnapshotWrite(db, pending, "idempotent");
    removePendingSessionSnapshotWrite(pending);
  }
}

export function stageSessionSnapshotWrite(
  projectDir: string,
  record: SessionSnapshotWriteRecord,
  options: SessionSnapshotAtomicWriteOptions = {},
): PendingSessionSnapshotWrite {
  const pending: PendingSessionSnapshotWrite = {
    path: pendingSnapshotPath(projectDir, record),
    directory: pendingSnapshotDirectory(projectDir),
    record,
    updateRunLastSnapshotAt: options.updateRunLastSnapshotAt === true,
    replayOnStartup: options.replayOnStartup === true,
  };
  const payload: SessionSnapshotWriteFile = {
    format: SNAPSHOT_WRITE_FORMAT,
    schemaVersion: SNAPSHOT_WRITE_SCHEMA_VERSION,
    replayOnStartup: pending.replayOnStartup,
    updateRunLastSnapshotAt: pending.updateRunLastSnapshotAt,
    record,
  };
  atomicWriteFile(pending.directory, pending.path, `${JSON.stringify(payload)}\n`);
  return pending;
}

function commitPendingSessionSnapshotWrite(
  db: SqliteDatabase,
  pending: PendingSessionSnapshotWrite,
  mode: "strict" | "idempotent",
): void {
  const commit = (): void => {
    insertPendingSessionSnapshotWrite(db, pending, mode);
    updateRunLastSnapshotAt(db, pending);
  };
  if (db.inTransaction) {
    commit();
    return;
  }
  db.transaction(commit)();
}

function insertPendingSessionSnapshotWrite(
  db: SqliteDatabase,
  pending: PendingSessionSnapshotWrite,
  mode: "strict" | "idempotent",
): void {
  const onConflict =
    mode === "idempotent"
      ? `ON CONFLICT(session_id, snapshot_at) DO UPDATE SET
           conversation_json = excluded.conversation_json,
           tool_state_json = excluded.tool_state_json,
           mcp_connection_state_json = excluded.mcp_connection_state_json`
      : "";
  db.prepare(
    `INSERT INTO session_state_snapshots (
      session_id,
      snapshot_at,
      conversation_json,
      tool_state_json,
      mcp_connection_state_json
    ) VALUES (?, ?, ?, ?, ?)
    ${onConflict}`,
  ).run(
    pending.record.sessionId,
    pending.record.snapshotAt,
    pending.record.conversationJson,
    pending.record.toolStateJson,
    pending.record.mcpConnectionStateJson,
  );
}

function updateRunLastSnapshotAt(
  db: SqliteDatabase,
  pending: PendingSessionSnapshotWrite,
): void {
  if (!pending.updateRunLastSnapshotAt) return;
  db.prepare(
    `UPDATE agent_runs
     SET last_snapshot_at = ?
     WHERE current_session_id = ?
       AND (last_snapshot_at IS NULL OR last_snapshot_at < ?)`,
  ).run(
    pending.record.snapshotAt,
    pending.record.sessionId,
    pending.record.snapshotAt,
  );
}

function removePendingSessionSnapshotWrite(
  pending: PendingSessionSnapshotWrite,
): void {
  try {
    unlinkSync(pending.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  fsyncDirectory(pending.directory);
}

function readPendingSessionSnapshotWrite(
  directory: string,
  path: string,
): PendingSessionSnapshotWrite {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const file = expectSnapshotWriteFile(raw, basename(path));
  return {
    path,
    directory,
    record: file.record,
    updateRunLastSnapshotAt: file.updateRunLastSnapshotAt,
    replayOnStartup: file.replayOnStartup,
  };
}

function expectSnapshotWriteFile(
  value: unknown,
  label: string,
): SessionSnapshotWriteFile {
  const file = expectObject(value, label);
  if (file.format !== SNAPSHOT_WRITE_FORMAT) {
    throw new Error(`pending snapshot write ${label} has invalid format`);
  }
  if (file.schemaVersion !== SNAPSHOT_WRITE_SCHEMA_VERSION) {
    throw new Error(`pending snapshot write ${label} has invalid schema version`);
  }
  return {
    format: SNAPSHOT_WRITE_FORMAT,
    schemaVersion: SNAPSHOT_WRITE_SCHEMA_VERSION,
    replayOnStartup: expectBoolean(file.replayOnStartup, "replayOnStartup"),
    updateRunLastSnapshotAt: expectBoolean(
      file.updateRunLastSnapshotAt,
      "updateRunLastSnapshotAt",
    ),
    record: expectSnapshotRecord(file.record, "record"),
  };
}

function expectSnapshotRecord(
  value: unknown,
  label: string,
): SessionSnapshotWriteRecord {
  const record = expectObject(value, label);
  return {
    sessionId: expectString(record.sessionId, "record.sessionId"),
    snapshotAt: expectString(record.snapshotAt, "record.snapshotAt"),
    conversationJson: expectString(
      record.conversationJson,
      "record.conversationJson",
    ),
    toolStateJson: expectString(record.toolStateJson, "record.toolStateJson"),
    mcpConnectionStateJson: expectString(
      record.mcpConnectionStateJson,
      "record.mcpConnectionStateJson",
    ),
  };
}

function atomicWriteFile(
  directory: string,
  targetPath: string,
  contents: string,
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, targetPath);
    fsyncDirectory(directory);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmpPath);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw unlinkError;
      }
    }
    throw error;
  }
}

function fsyncDirectory(directory: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM") throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function pendingSnapshotDirectory(projectDir: string): string {
  return join(projectDir, PENDING_SNAPSHOT_DIR);
}

function pendingSnapshotPath(
  projectDir: string,
  record: SessionSnapshotWriteRecord,
): string {
  const key = `${record.sessionId}\0${record.snapshotAt}`;
  const digest = createHash("sha256").update(key).digest("hex");
  return join(pendingSnapshotDirectory(projectDir), `${digest}.json`);
}

function expectObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`pending snapshot write ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`pending snapshot write ${label} must be a non-empty string`);
  }
  return value;
}

function expectBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`pending snapshot write ${label} must be a boolean`);
  }
  return value;
}
