import { withOneShotWriteScope } from "../durability/one-shot-durability.js";
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

import { isUnsupportedDirectorySync } from "../utils/durable-atomic-file.js";

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
  /** Cached owner hint; the active writer and persisted session link are rechecked. */
  readonly oneShotRunId?: string;
  readonly updateRunLastSnapshotAt?: boolean;
  readonly replayOnStartup?: boolean;
  readonly verifyExisting?: boolean;
  /**
   * Written inside a running turn (turn-scoped durability): the staged
   * intent, its rename, the SQLite commit and the intent's removal complete
   * in order without waiting on fsync, which survives the process dying. The
   * turn boundary flushes. An intent left for startup replay after a failed
   * commit is still synced.
   */
  readonly deferSync?: boolean;
}

export interface PendingSessionSnapshotWrite {
  readonly path: string;
  readonly directory: string;
  readonly record: SessionSnapshotWriteRecord;
  readonly updateRunLastSnapshotAt: boolean;
  readonly replayOnStartup: boolean;
  readonly verifyExisting: boolean;
}

interface SessionSnapshotWriteFile {
  readonly format: typeof SNAPSHOT_WRITE_FORMAT;
  readonly schemaVersion: typeof SNAPSHOT_WRITE_SCHEMA_VERSION;
  readonly replayOnStartup: boolean;
  readonly updateRunLastSnapshotAt: boolean;
  readonly verifyExisting?: boolean;
  readonly record: SessionSnapshotWriteRecord;
}

export function writeSessionSnapshotAtomically(
  driver: StateSqliteDriver,
  record: SessionSnapshotWriteRecord,
  options: SessionSnapshotAtomicWriteOptions = {},
): void {
  if (options.verifyExisting && driver.state.inTransaction) {
    throw new Error("retryable snapshot writes require their own transaction");
  }
  const runId = options.oneShotRunId;
  // This is an auxiliary snapshot of an explicitly active relaxed print run.
  // Its canonical active marker already refuses recovery after a crash, and
  // the existing close/promote seal checkpoints this same project's SQLite
  // WAL before publishing success. Keep the write visible now, but avoid a
  // second filesystem intent journal and its three per-snapshot syncs.
  // Existing staged retries, foreign owners/scopes and full/resumed sessions
  // retain the original durable staging path.
  if (runId !== undefined && driver.isRelaxedOneShotRun(runId) &&
      driver.prepareState<[string], { agent_id: string }>(
        "SELECT agent_id FROM session_agent_links WHERE session_id = ?",
      ).get(record.sessionId)?.agent_id === runId &&
      !existsSync(pendingSnapshotPath(driver.projectDir, record))) {
    const pending = describeSessionSnapshotWrite(driver.projectDir, record, options);
    withOneShotWriteScope(driver.projectDir, runId, () => driver.transaction(() => {
      insertPendingSessionSnapshotWrite(driver.state, pending, options.verifyExisting ? "verify" : "strict");
      updateRunLastSnapshotAt(driver.state, pending);
    }));
    return;
  }
  const deferSync = options.deferSync === true;
  const pending = stageSessionSnapshotWrite(driver.projectDir, record, options);
  const mode = options.verifyExisting ? "verify" : "strict";
  try {
    if (deferSync) {
      // Through the driver, so the commit takes its turn-scoped durability.
      driver.transaction(() => commitPendingSessionSnapshotWrite(driver.state, pending, mode));
    } else {
      commitPendingSessionSnapshotWrite(driver.state, pending, mode);
    }
  } catch (error) {
    if (!pending.replayOnStartup) removePendingSessionSnapshotWrite(pending, deferSync);
    else if (deferSync) {
      try {
        syncStagedSessionSnapshotWrite(pending);
      } catch {
        // The commit failure is what the caller has to see; the intent is
        // still written for a replay after a process crash.
      }
    }
    throw error;
  }
  removePendingSessionSnapshotWrite(pending, deferSync);
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
    try {
      const pending = readPendingSessionSnapshotWrite(directory, path);
      if (!pending.replayOnStartup) {
        removePendingSessionSnapshotWrite(pending);
        continue;
      }
      commitPendingSessionSnapshotWrite(db, pending, pending.verifyExisting ? "verify" : "idempotent");
      removePendingSessionSnapshotWrite(pending);
    } catch {
      // A torn or otherwise corrupt pending write (ENOSPC, power loss,
      // bit-flip) must not brick every state-DB open. Quarantine the bad
      // file to a `.corrupt` sidecar and continue replaying the rest.
      quarantineCorruptPendingSnapshotWrite(directory, path);
    }
  }
}

function quarantineCorruptPendingSnapshotWrite(
  directory: string,
  path: string,
): void {
  const target = `${path}.corrupt`;
  try {
    renameSync(path, target);
    fsyncDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    // If quarantine itself fails (e.g. a sidecar already exists), drop the
    // file outright so it cannot block subsequent opens.
    try {
      unlinkSync(path);
      fsyncDirectory(directory);
    } catch (unlinkError) {
      if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") {
        throw unlinkError;
      }
    }
  }
}

export function stageSessionSnapshotWrite(
  projectDir: string,
  record: SessionSnapshotWriteRecord,
  options: SessionSnapshotAtomicWriteOptions = {},
): PendingSessionSnapshotWrite {
  const pending = describeSessionSnapshotWrite(projectDir, record, options);
  const payload: SessionSnapshotWriteFile = {
    format: SNAPSHOT_WRITE_FORMAT,
    schemaVersion: SNAPSHOT_WRITE_SCHEMA_VERSION,
    replayOnStartup: pending.replayOnStartup,
    updateRunLastSnapshotAt: pending.updateRunLastSnapshotAt,
    ...(pending.verifyExisting ? { verifyExisting: true } : {}),
    record,
  };
  atomicWriteFile(
    pending.directory,
    pending.path,
    `${JSON.stringify(payload)}\n`,
    options.deferSync !== true,
  );
  return pending;
}

/** Make a staged intent that startup must replay survive power loss too. */
function syncStagedSessionSnapshotWrite(pending: PendingSessionSnapshotWrite): void {
  const fd = openSync(pending.path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(pending.directory);
}

function describeSessionSnapshotWrite(
  projectDir: string,
  record: SessionSnapshotWriteRecord,
  options: SessionSnapshotAtomicWriteOptions,
): PendingSessionSnapshotWrite {
  return {
    path: pendingSnapshotPath(projectDir, record),
    directory: pendingSnapshotDirectory(projectDir),
    record,
    updateRunLastSnapshotAt: options.updateRunLastSnapshotAt === true,
    replayOnStartup: options.replayOnStartup === true,
    verifyExisting: options.verifyExisting === true,
  };
}

function commitPendingSessionSnapshotWrite(
  db: SqliteDatabase,
  pending: PendingSessionSnapshotWrite,
  mode: "strict" | "idempotent" | "verify",
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
  mode: "strict" | "idempotent" | "verify",
): void {
  if (mode === "verify") {
    const existing = db.prepare<[string, string], {
      conversation_json: string;
      tool_state_json: string;
      mcp_connection_state_json: string;
    }>(
      `SELECT conversation_json, tool_state_json, mcp_connection_state_json
       FROM session_state_snapshots WHERE session_id = ? AND snapshot_at = ?`,
    ).get(pending.record.sessionId, pending.record.snapshotAt);
    if (existing !== undefined) {
      if (
        existing.conversation_json !== pending.record.conversationJson ||
        existing.tool_state_json !== pending.record.toolStateJson ||
        existing.mcp_connection_state_json !== pending.record.mcpConnectionStateJson
      ) {
        throw new Error("snapshot retry conflicts with the persisted payload");
      }
      return;
    }
  }
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
  deferSync = false,
): void {
  try {
    unlinkSync(pending.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return;
  }
  if (!deferSync) fsyncDirectory(pending.directory);
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
    verifyExisting: file.verifyExisting === true,
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
    verifyExisting: file.verifyExisting === undefined
      ? false : expectBoolean(file.verifyExisting, "verifyExisting"),
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
  sync = true,
): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const tmpPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(tmpPath, "wx", 0o600);
    writeFileSync(fd, contents, "utf8");
    if (sync) fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmpPath, targetPath);
    if (sync) fsyncDirectory(directory);
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
    // Snapshot writes historically tolerate EPERM on POSIX filesystems too.
    if (!isUnsupportedDirectorySync(error) &&
        (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
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
