/**
 * File-history sidecar — per-message snapshots of edited files with
 * versioned backups.
 *
 * Hand-port of openclaude `src/utils/fileHistory.ts` (1,115 LOC). The
 * openclaude implementation is tightly coupled to React-hook-style
 * state updaters + global session state. This AgenC port preserves
 * the on-disk format + data shapes but restructures around
 * `SessionStore` + `SidecarManager`.
 *
 * Invariants wired here:
 *   I-28 (file-history LRU eviction) — snapshots capped at
 *        `MAX_SNAPSHOTS=100`; on cap, evict oldest + emit one-shot
 *        `warning:'file_history_cap_reached'`; expose
 *        `isFileHistoryComplete: false` on snapshot metadata.
 *   I-43 (per-sidecar isolation) — disk failures route into the
 *        sidecar's local `DegradedStore`; errors emit as sidecar
 *        diagnostics rather than throwing.
 *
 * On-disk layout:
 *
 *   ~/.agenc/projects/<slug>/file-history/
 *     <pathHash>/
 *       v1                              # original contents
 *       v2                              # after first edit
 *       v3                              # etc
 *
 * `pathHash` is a short hex digest of the absolute file path. The
 * backup files are content-addressable within a tracked file (same
 * hash → same content), so parallel edits to the same path never
 * corrupt each other.
 *
 * @module
 */

import {
  copyFile,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { monotonicMs } from "../utils/monotonic.js";
import type { Event } from "./event-log.js";
import type { Sidecar } from "./sidecar.js";

export const MAX_SNAPSHOTS = 100;

export type BackupFileName = string | null;

export interface FileHistoryBackup {
  readonly backupFileName: BackupFileName;
  readonly version: number;
  readonly backupTimeMs: number;
}

export interface FileHistorySnapshot {
  /** Message UUID this snapshot is associated with. */
  readonly messageId: string;
  /** Map of tracked file path → its most-recent backup metadata. */
  readonly trackedFileBackups: Readonly<Record<string, FileHistoryBackup>>;
  readonly timestampMs: number;
}

export interface FileHistoryState {
  readonly snapshots: ReadonlyArray<FileHistorySnapshot>;
  readonly trackedFiles: ReadonlySet<string>;
  /** Monotonic counter — incremented on every snapshot even when
   *  evicted. Used as an activity signal. */
  readonly snapshotSequence: number;
  /** I-28: flipped to `false` the first time the LRU evicts an
   *  older snapshot. Callers surface this to the TUI so partial
   *  history is visible. */
  readonly isFileHistoryComplete: boolean;
  /** I-28: when `isFileHistoryComplete=false`, number of evictions so far. */
  readonly evictedCount: number;
}

function emptyFileHistoryState(): FileHistoryState {
  return {
    snapshots: [],
    trackedFiles: new Set<string>(),
    snapshotSequence: 0,
    isFileHistoryComplete: true,
    evictedCount: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Path hashing (content-addressable backup dir per tracked file)
// ─────────────────────────────────────────────────────────────────────

function pathHash(absPath: string): string {
  return createHash("sha256").update(absPath).digest("hex").slice(0, 16);
}

// ─────────────────────────────────────────────────────────────────────
// FileHistory
// ─────────────────────────────────────────────────────────────────────

export interface FileHistoryOptions {
  readonly projectDir: string;
  readonly maxSnapshots?: number;
  readonly enabled?: boolean;
  readonly onDiagnostic?: (d: {
    readonly cause: string;
    readonly message: string;
  }) => void;
}

/**
 * Core file-history engine. Methods `trackEdit` + `makeSnapshot` are
 * the primary API — `trackEdit(absPath, messageId)` BEFORE a file edit
 * captures v1; `makeSnapshot(messageId)` AFTER the edit captures the
 * subsequent version and appends a snapshot record.
 */
export class FileHistory {
  readonly projectDir: string;
  readonly historyDir: string;
  readonly maxSnapshots: number;
  readonly enabled: boolean;
  private state: FileHistoryState = emptyFileHistoryState();
  private readonly onDiagnostic?: (d: {
    cause: string;
    message: string;
  }) => void;
  private evictionWarningEmitted = false;

  constructor(opts: FileHistoryOptions) {
    this.projectDir = opts.projectDir;
    this.historyDir = join(opts.projectDir, "file-history");
    this.maxSnapshots = opts.maxSnapshots ?? MAX_SNAPSHOTS;
    this.enabled = opts.enabled !== false;
    this.onDiagnostic = opts.onDiagnostic;
  }

  getState(): FileHistoryState {
    return this.state;
  }

  /**
   * Call BEFORE a file edit so the current contents are preserved as
   * v1 (or the current-max-version+1) in the backup store. Idempotent
   * within the same messageId/snapshot.
   */
  async trackEdit(filePath: string, messageId: string): Promise<void> {
    if (!this.enabled) return;
    const mostRecent = this.state.snapshots.at(-1);
    if (mostRecent && mostRecent.trackedFileBackups[filePath]) {
      // Already tracked in the current snapshot.
      return;
    }
    let backup: FileHistoryBackup;
    try {
      backup = await this.createBackup(filePath, 1);
    } catch (err) {
      this.emitDiagnostic({
        cause: "file_history_track_failed",
        message:
          err instanceof Error
            ? `trackEdit ${filePath}: ${err.message}`
            : String(err),
      });
      return;
    }
    // Ensure there's at least one snapshot to attach the backup to.
    const updatedSnapshots: FileHistorySnapshot[] = [...this.state.snapshots];
    if (updatedSnapshots.length === 0) {
      updatedSnapshots.push({
        messageId,
        trackedFileBackups: {},
        timestampMs: Date.now(),
      });
    }
    const last = updatedSnapshots.at(-1)!;
    const updatedLast: FileHistorySnapshot = {
      messageId: last.messageId,
      trackedFileBackups: { ...last.trackedFileBackups, [filePath]: backup },
      timestampMs: last.timestampMs,
    };
    updatedSnapshots[updatedSnapshots.length - 1] = updatedLast;
    const updatedTracked = new Set(this.state.trackedFiles);
    updatedTracked.add(filePath);
    this.state = {
      ...this.state,
      snapshots: updatedSnapshots,
      trackedFiles: updatedTracked,
    };
  }

  /**
   * Append a new snapshot row keyed by messageId. Call AFTER tool
   * calls finish for the iteration. Back up any tracked file whose
   * mtime changed since the last snapshot.
   *
   * I-28 LRU eviction applies here: when snapshots exceed
   * `maxSnapshots`, evict the oldest and flip `isFileHistoryComplete=false`.
   */
  async makeSnapshot(messageId: string): Promise<void> {
    if (!this.enabled) return;
    const mostRecent = this.state.snapshots.at(-1);
    const trackedFileBackups: Record<string, FileHistoryBackup> = {};

    for (const trackingPath of this.state.trackedFiles) {
      try {
        const latest = mostRecent?.trackedFileBackups[trackingPath];
        const nextVersion = latest ? latest.version + 1 : 1;
        let fileExists = true;
        try {
          await stat(trackingPath);
        } catch {
          fileExists = false;
        }
        if (!fileExists) {
          trackedFileBackups[trackingPath] = {
            backupFileName: null,
            version: nextVersion,
            backupTimeMs: Date.now(),
          };
          continue;
        }
        trackedFileBackups[trackingPath] = await this.createBackup(
          trackingPath,
          nextVersion,
        );
      } catch (err) {
        this.emitDiagnostic({
          cause: "file_history_snapshot_failed",
          message:
            err instanceof Error
              ? `snapshot ${trackingPath}: ${err.message}`
              : String(err),
        });
      }
    }

    const snapshot: FileHistorySnapshot = {
      messageId,
      trackedFileBackups,
      timestampMs: Date.now(),
    };
    const nextSnapshots = [...this.state.snapshots, snapshot];
    let evicted = this.state.evictedCount;
    let complete = this.state.isFileHistoryComplete;
    if (nextSnapshots.length > this.maxSnapshots) {
      const overflow = nextSnapshots.length - this.maxSnapshots;
      nextSnapshots.splice(0, overflow);
      evicted += overflow;
      complete = false;
      if (!this.evictionWarningEmitted) {
        this.evictionWarningEmitted = true;
        this.emitDiagnostic({
          cause: "file_history_cap_reached",
          message: `file-history LRU cap ${this.maxSnapshots} reached — evicting oldest snapshots (isFileHistoryComplete=false)`,
        });
      }
    }
    this.state = {
      snapshots: nextSnapshots,
      trackedFiles: this.state.trackedFiles,
      snapshotSequence: this.state.snapshotSequence + 1,
      isFileHistoryComplete: complete,
      evictedCount: evicted,
    };
  }

  /**
   * Restore a tracked file to its state at `messageId`.
   * Returns the list of files restored.
   */
  async restoreToMessage(messageId: string): Promise<ReadonlyArray<string>> {
    if (!this.enabled) return [];
    let target: FileHistorySnapshot | undefined;
    for (let i = this.state.snapshots.length - 1; i >= 0; i -= 1) {
      const s = this.state.snapshots[i];
      if (s && s.messageId === messageId) {
        target = s;
        break;
      }
    }
    if (!target) return [];
    const restored: string[] = [];
    for (const [trackingPath, backup] of Object.entries(
      target.trackedFileBackups,
    )) {
      try {
        if (backup.backupFileName === null) {
          // File did not exist at snapshot time — remove it if it
          // exists now.
          try {
            await rm(trackingPath);
          } catch {
            /* already gone */
          }
          restored.push(trackingPath);
          continue;
        }
        const backupPath = this.backupFilePath(trackingPath, backup);
        const contents = await readFile(backupPath, "utf8");
        await writeFile(trackingPath, contents);
        restored.push(trackingPath);
      } catch (err) {
        this.emitDiagnostic({
          cause: "file_history_restore_failed",
          message:
            err instanceof Error
              ? `restore ${trackingPath}: ${err.message}`
              : String(err),
        });
      }
    }
    return restored;
  }

  /** Clear all tracked files + backups. Used on `/clear` or session end. */
  async clear(): Promise<void> {
    this.state = emptyFileHistoryState();
    try {
      await rm(this.historyDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Private
  // ───────────────────────────────────────────────────────────────────

  private backupFilePath(trackingPath: string, backup: FileHistoryBackup): string {
    return join(this.historyDir, pathHash(trackingPath), `v${backup.version}`);
  }

  private async createBackup(
    filePath: string,
    version: number,
  ): Promise<FileHistoryBackup> {
    try {
      await stat(filePath);
    } catch {
      return {
        backupFileName: null,
        version,
        backupTimeMs: Date.now(),
      };
    }
    const backupDir = join(this.historyDir, pathHash(filePath));
    await mkdir(backupDir, { recursive: true });
    const backupFileName = join(backupDir, `v${version}`);
    await copyFile(filePath, backupFileName);
    return {
      backupFileName,
      version,
      backupTimeMs: Date.now(),
    };
  }

  private emitDiagnostic(d: { cause: string; message: string }): void {
    this.onDiagnostic?.(d);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Sidecar wrapper — subscribes to event log and hooks file-edit tool
// calls into the history.
// ─────────────────────────────────────────────────────────────────────

export interface FileHistorySidecarOpts {
  readonly fileHistory: FileHistory;
  /** Tool names that mutate files. Defaults to AgenC's system.editFile
   *  + system.writeFile. T7 wires per-tool concurrency classes; this
   *  sidecar picks based on tool name prefix match. */
  readonly editToolNames?: ReadonlyArray<string>;
}

const DEFAULT_EDIT_TOOL_NAMES: ReadonlyArray<string> = [
  "system.editFile",
  "system.writeFile",
];

export class FileHistorySidecar implements Sidecar {
  readonly name = "file-history";
  private readonly history: FileHistory;
  private readonly editToolNames: ReadonlyArray<string>;
  private lastEditStartedAtMs: number | null = null;

  constructor(opts: FileHistorySidecarOpts) {
    this.history = opts.fileHistory;
    this.editToolNames = opts.editToolNames ?? DEFAULT_EDIT_TOOL_NAMES;
  }

  async start(): Promise<void> {
    // Nothing to do — FileHistory is lazy-initialized.
  }

  async stop(): Promise<void> {
    // Don't clear; session resume reads this.
  }

  isDegraded(): boolean {
    return false;
  }

  onEvent(event: Event): void {
    const msg = event.msg;
    if (msg.type === "tool_call_started") {
      if (this.editToolNames.includes(msg.payload.toolName)) {
        this.lastEditStartedAtMs = monotonicMs();
        const args = this.tryParseArgs(msg.payload.args);
        const filePath = args?.path ?? args?.filePath;
        if (typeof filePath === "string") {
          void this.history.trackEdit(filePath, event.id);
        }
      }
    } else if (msg.type === "tool_call_completed") {
      if (this.lastEditStartedAtMs !== null) {
        this.lastEditStartedAtMs = null;
        void this.history.makeSnapshot(event.id);
      }
    } else if (msg.type === "turn_complete") {
      void this.history.makeSnapshot(`turn-${event.id}`);
    }
  }

  private tryParseArgs(raw: string): Record<string, unknown> | null {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  getSnapshotState(): FileHistoryState {
    return this.history.getState();
  }
}
