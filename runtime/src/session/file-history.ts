/**
 * File-history sidecar — per-message snapshots of edited files with
 * versioned backups.
 *
 * Structured around `SessionStore` + `SidecarManager` rather than
 * React-hook-style state updaters or global session state.
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
 *     session-<sessionHash>/            # one directory per conversation
 *       snapshots.json                  # published snapshot index
 *       <pathHash>/                     # one directory per tracked file
 *         v1-<uuid>                     # contents when first tracked
 *         v2-<uuid>                     # contents after a later change
 *
 * `sessionHash` and `pathHash` are the first 16 hex digits of the
 * SHA-256 of the session id and of the absolute file path. An engine
 * created without a session id writes no index and keeps the
 * `<pathHash>` directories directly under `file-history/`.
 *
 * Backups are not content-addressed. Every backup is a new file with a
 * unique name (`v<version>-<uuid>`) that is never written again, and a
 * snapshot entry names its backup by absolute path. A snapshot copies
 * only the files whose content changed since their latest backup; for
 * an unchanged file it repeats the previous entry, so consecutive
 * snapshots can share one backup file.
 *
 * A backup is deleted once no retained snapshot names it. Eviction at
 * the cap collects the backups that only evicted snapshots named; they
 * are unlinked after the index that no longer lists them is on disk,
 * and not while a rewind or preview is reading. Nothing lists or sweeps
 * the directory, so a backup orphaned by a crash stays until the whole
 * `session-<sessionHash>` directory goes: session retention
 * (`state/pruning.ts`) removes it together with the session.
 *
 * @module
 */

import { createReadStream, type Stats } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { syncDirectory } from "../utils/durable-atomic-file.js";
import { collectShellWorkspaceMutationTargets } from "../llm/shell-write-policy.js";
import { monotonicMs } from "./_deps/utils.js";
import { DegradedStore } from "./degraded-store.js";
import type { Event } from "./event-log.js";
import { fileHistorySessionDirName } from "./file-history-paths.js";
import type { RolloutItem } from "./rollout-item.js";
import { isDegradedErrno } from "./session-store.js";
import type { Sidecar } from "./sidecar.js";

const MAX_SNAPSHOTS = 100;

/** File name of a backup, as `createBackup` writes it: `v<version>-<uuid>`. */
const BACKUP_FILE_NAME = /^v\d+-[0-9a-f-]{36}$/;

export type BackupFileName = string | null;

export interface FileHistoryBackup {
  readonly backupFileName: BackupFileName;
  readonly version: number;
  readonly backupTimeMs: number;
  /** Per-snapshot diff stats against the previous version. Undefined
   *  on v1 (no prior version to diff against), when the file was
   *  newly created (backupFileName === null), and when the entry
   *  repeats the previous snapshot's backup because the file did not
   *  change. */
  readonly diffStats?: DiffStats;
}

/**
 * `DiffStats` + `computeDiffStats`. Counts line-
 * level insertions/deletions relative to the previous version of the
 * same tracked file.
 */
export interface DiffStats {
  readonly insertions: number;
  readonly deletions: number;
}

export interface FileHistorySnapshot {
  /** Message UUID this snapshot is associated with. */
  readonly messageId: string;
  /** Map of tracked file path → its most-recent backup metadata. */
  readonly trackedFileBackups: Readonly<Record<string, FileHistoryBackup>>;
  readonly timestampMs: number;
  /** Aggregate diff stats across every tracked file in this snapshot. */
  readonly aggregateDiffStats?: DiffStats & {
    readonly filesChanged: ReadonlyArray<string>;
  };
}

/** Result of `FileHistory.previewRewind` — the dry-run of a restore. */
export interface FileHistoryRewindPreview {
  readonly filesChanged: ReadonlyArray<string>;
  readonly insertions: number;
  readonly deletions: number;
  readonly perFile: Readonly<Record<string, DiffStats>>;
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

/** Content of one backup file: its SHA-256 (hex) and its size in bytes. */
interface BackupDigest {
  readonly sha256: string;
  readonly size: number;
}

/**
 * SHA-256 (hex) of a file's bytes. The file is read as a stream, so
 * memory use stays fixed and there is no size limit. Returns `null` on
 * any error. Only pass regular files: opening a FIFO can block forever.
 */
export async function sha256OfFile(filePath: string): Promise<string | null> {
  try {
    const hash = createHash("sha256");
    const chunks: AsyncIterable<Buffer> = createReadStream(filePath);
    for await (const chunk of chunks) hash.update(chunk);
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  // Trailing non-newline-terminated line still counts.
  if (text.charCodeAt(text.length - 1) !== 10) count += 1;
  return count;
}

/**
 * Compute per-line insertions/deletions between two strings. Uses
 * a simplified Myers-style diff: compute the length of the longest
 * common subsequence (LCS) of lines, then
 *   insertions = newLines − LCS
 *   deletions  = oldLines − LCS
 *
 * O(n*m) — acceptable for typical file sizes; large files (>10K lines)
 * get a cheaper line-hash comparison fallback.
 */
export function computeDiffStats(prior: string, current: string): DiffStats {
  const priorLines = prior.split("\n");
  const currentLines = current.split("\n");
  const n = priorLines.length;
  const m = currentLines.length;
  if (n === 0 && m === 0) return { insertions: 0, deletions: 0 };
  if (n === 0) return { insertions: m, deletions: 0 };
  if (m === 0) return { insertions: 0, deletions: n };

  // Fast-path: large files — approximate via line-hash set diff.
  if (n > 10_000 || m > 10_000) {
    const priorSet = new Map<string, number>();
    for (const line of priorLines)
      priorSet.set(line, (priorSet.get(line) ?? 0) + 1);
    let common = 0;
    for (const line of currentLines) {
      const count = priorSet.get(line) ?? 0;
      if (count > 0) {
        common += 1;
        priorSet.set(line, count - 1);
      }
    }
    return {
      insertions: Math.max(0, m - common),
      deletions: Math.max(0, n - common),
    };
  }

  // LCS via rolling DP.
  let prev = new Array<number>(m + 1).fill(0);
  let curr = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      if (priorLines[i - 1] === currentLines[j - 1]) {
        curr[j] = (prev[j - 1] ?? 0) + 1;
      } else {
        curr[j] = Math.max(prev[j] ?? 0, curr[j - 1] ?? 0);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }
  const lcs = prev[m] ?? 0;
  return {
    insertions: Math.max(0, m - lcs),
    deletions: Math.max(0, n - lcs),
  };
}

// ─────────────────────────────────────────────────────────────────────
// FileHistory
// ─────────────────────────────────────────────────────────────────────

export interface FileHistoryOptions {
  readonly projectDir: string;
  /** Isolate durable backups and their snapshot index by conversation. */
  readonly sessionId?: string;
  readonly maxSnapshots?: number;
  readonly enabled?: boolean;
  /** Serialize journal diagnostics with canonical compaction. */
  readonly withCanonicalBackgroundWork?: <T>(work: () => T | Promise<T>) => Promise<T>;
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
/**
 * Deferred backup entry — tracked when disk is full so the operation
 * can retry when disk returns.
 */
interface DeferredBackup {
  readonly filePath: string;
  readonly messageId: string;
  readonly isTrackEdit: boolean;
}

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
  /** I-43: per-sidecar DegradedStore for failed snapshots. */
  private readonly degraded: DegradedStore<DeferredBackup>;
  private readonly statePath: string | undefined;
  private pending: Promise<void> = Promise.resolve();
  private pendingDiagnostics: Promise<void> = Promise.resolve();
  private readonly withCanonicalBackgroundWork: FileHistoryOptions["withCanonicalBackgroundWork"];
  /**
   * Digest of each backup this engine copied or read back, keyed by
   * `backupFileName`. Lets a snapshot tell that a file still equals its
   * latest backup without reading the backup again. Never persisted: after
   * a reload `digestFor` recomputes an entry from the backup file.
   */
  private readonly backupDigests = new Map<string, BackupDigest>();
  /**
   * True while the index on disk may not match the state: set when the
   * state changes and when an index write fails, cleared when one
   * succeeds. A `trackEdits` that changed nothing skips the index write
   * only while this is clear. Only `indexWritten` clears it, and it empties
   * `awaitingDurableIndex` in the same step, so the flag also stays set for
   * as long as a deletion waits for the index.
   */
  private needsPersist = false;
  /**
   * Backups that only evicted snapshots named. The index on disk may still
   * list those snapshots, and a reload would then need the files, so they
   * wait here until an index write succeeds.
   */
  private readonly awaitingDurableIndex = new Set<string>();
  /**
   * Backups that neither the state nor the index on disk names any more.
   * A deletion pass unlinks them as soon as no reader is active.
   */
  private readonly deletable = new Set<string>();
  /**
   * Rewinds and previews in flight. Each works from the state it read when
   * it started, which can name backups evicted since, so nothing is
   * unlinked while this is above zero.
   */
  private activeReaders = 0;
  private pruneFailureReported = false;

  constructor(opts: FileHistoryOptions) {
    this.projectDir = opts.projectDir;
    this.historyDir = opts.sessionId === undefined
      ? join(opts.projectDir, "file-history")
      : join(opts.projectDir, "file-history", fileHistorySessionDirName(opts.sessionId));
    this.statePath = opts.sessionId === undefined ? undefined : join(this.historyDir, "snapshots.json");
    this.maxSnapshots = opts.maxSnapshots ?? MAX_SNAPSHOTS;
    this.enabled = opts.enabled !== false;
    this.onDiagnostic = opts.onDiagnostic;
    this.withCanonicalBackgroundWork = opts.withCanonicalBackgroundWork;
    this.degraded = new DegradedStore<DeferredBackup>({
      capacity: 500,
      flushFn: async (entries) => this.replayDegraded(entries),
    });
    this.degraded.start();
  }

  isDegraded(): boolean {
    return this.degraded.isDegraded;
  }

  stop(): void {
    this.degraded.stop();
  }

  getState(): FileHistoryState {
    return this.state;
  }

  /** Load only this conversation's published index, before subscribing to events. */
  async loadFromDisk(): Promise<void> {
    if (this.statePath === undefined) return;
    try {
      const raw = JSON.parse(await readFile(this.statePath, "utf8"));
      if (raw.version !== 1 || !Array.isArray(raw.snapshots) ||
          raw.snapshots.length > this.maxSnapshots ||
          !Number.isSafeInteger(raw.snapshotSequence) || raw.snapshotSequence < 0 ||
          !Number.isSafeInteger(raw.evictedCount) || raw.evictedCount < 0 ||
          typeof raw.isFileHistoryComplete !== "boolean") throw new Error("Invalid file-history index");
      const trackedFiles = new Set<string>();
      for (const snapshot of raw.snapshots) {
        if (!isPersistedSnapshot(snapshot)) throw new Error("Invalid file-history snapshot");
        for (const [filePath, backup] of Object.entries(snapshot.trackedFileBackups)) {
          if (resolve(filePath) !== filePath || !backup ||
              !Number.isSafeInteger(backup.version) || backup.version < 1 ||
              !Number.isFinite(backup.backupTimeMs) ||
              (backup.backupFileName !== null &&
               (typeof backup.backupFileName !== "string" ||
                resolve(backup.backupFileName) !== backup.backupFileName ||
                !backup.backupFileName.startsWith(`${this.historyDir}${sep}`)))) {
            throw new Error("Invalid file-history backup");
          }
          trackedFiles.add(filePath);
        }
      }
      this.state = { snapshots: raw.snapshots, trackedFiles,
        snapshotSequence: raw.snapshotSequence, evictedCount: raw.evictedCount,
        isFileHistoryComplete: raw.isFileHistoryComplete };
    } catch (err) {
      if ((err as { code?: string }).code !== "ENOENT") {
        this.emitDiagnostic({ cause: "file_history_load_failed", message: String(err) });
      }
    }
  }

  async flush(): Promise<void> {
    await this.pending;
    await this.pendingDiagnostics;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.then(operation);
    this.pending = next.catch((err: unknown) => {
      this.emitDiagnostic({ cause: "file_history_save_failed", message: String(err) });
    });
    return this.pending;
  }

  private runCanonicalWork<T>(work: () => T | Promise<T>): Promise<T> {
    return this.withCanonicalBackgroundWork === undefined
      ? Promise.resolve().then(work)
      : this.withCanonicalBackgroundWork(work);
  }

  private async persistState(): Promise<void> {
    if (this.statePath === undefined) {
      // No index on disk, so nothing on disk can lag behind the state.
      this.indexWritten();
      return;
    }
    // Stays set unless every step below succeeds, so that the next queued
    // operation retries a failed index write even when it changes nothing.
    this.needsPersist = true;
    await mkdir(this.historyDir, { recursive: true });
    const tmp = `${this.statePath}.${randomUUID()}.tmp`;
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ version: 1, ...this.state,
          trackedFiles: undefined }));
        await handle.sync();
      } finally { await handle.close(); }
      await rename(tmp, this.statePath);
      await syncDirectory(this.historyDir);
    } finally { await rm(tmp, { force: true }); }
    this.indexWritten();
  }

  /**
   * The index on disk matches the state. The snapshots it lists are the
   * retained ones, so a backup that only evicted snapshots named is named
   * by nothing any more and may be deleted.
   */
  private indexWritten(): void {
    this.needsPersist = false;
    for (const backupFileName of this.awaitingDurableIndex) {
      this.deletable.add(backupFileName);
    }
    this.awaitingDurableIndex.clear();
  }

  /**
   * End of a queued operation that owes an index write: write the index
   * and then delete the backups it no longer lists. A failed write rejects
   * before the deletion pass, so those backups stay where they are.
   */
  private async persistAndPrune(): Promise<void> {
    await this.persistState();
    await this.deleteUnreferencedBackups();
  }

  /**
   * Call BEFORE a file edit so the file's current contents are kept as
   * its origin: a version 1 backup attached to the most recent snapshot
   * (a first snapshot keyed by `messageId` is created when there is
   * none). A file that does not exist is recorded as absent, with no
   * backup. A path that already has an entry in the most recent snapshot
   * is left alone, so repeating the call is a no-op.
   */
  trackEdit(filePath: string, messageId: string): Promise<void> {
    return this.trackEdits([filePath], messageId);
  }

  /**
   * `trackEdit` for every path in `paths`, in order, as ONE queued
   * operation, so nothing else on the queue runs between them. The index
   * is written at most once, after the last path, and only when the state
   * changed or an earlier index write is still owed.
   */
  async trackEdits(paths: readonly string[], messageId: string): Promise<void> {
    return this.enqueue(async () => {
      for (const filePath of paths) {
        if (await this.trackEditNow(filePath, messageId)) this.needsPersist = true;
      }
      if (this.needsPersist) await this.persistAndPrune();
    });
  }

  /** Returns whether the state changed. */
  private async trackEditNow(filePath: string, messageId: string): Promise<boolean> {
    if (!this.enabled) return false;
    const mostRecent = this.state.snapshots.at(-1);
    if (mostRecent && mostRecent.trackedFileBackups[filePath]) {
      // Already tracked in the current snapshot.
      return false;
    }
    let backup: FileHistoryBackup;
    try {
      backup = await this.createBackup(filePath, 1);
    } catch (err) {
      // I-12 / I-43: disk-exhaustion errors route to the per-sidecar
      // degraded store; non-disk errors surface as diagnostics but
      // don't retry.
      if (isDegradedErrno(err)) {
        this.degraded.enterDegraded(
          `${(err as { code?: string }).code} during trackEdit`,
        );
        this.degraded.append({ filePath, messageId, isTrackEdit: true });
        this.emitDiagnostic({
          cause: "file_history_degraded",
          message: `${(err as { code?: string }).code}: deferred trackEdit for ${filePath}`,
        });
      } else {
        this.emitDiagnostic({
          cause: "file_history_track_failed",
          message:
            err instanceof Error
              ? `trackEdit ${filePath}: ${err.message}`
              : String(err),
        });
      }
      return false;
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
    return true;
  }

  /**
   * Append a new snapshot row keyed by messageId, with one entry per
   * tracked file. Call AFTER tool calls finish for the iteration. A
   * file whose content still equals its latest backup (same size and
   * SHA-256) repeats that backup's entry and is not copied again. A
   * changed file gets a new backup with the next version, plus diff
   * stats. A file that is gone gets an entry without a backup. A file
   * whose backup fails is reported as `file_history_snapshot_failed`
   * and has no entry in this snapshot.
   *
   * I-28 LRU eviction applies here: when snapshots exceed
   * `maxSnapshots`, evict the oldest and flip `isFileHistoryComplete=false`.
   * The backups that only evicted snapshots named are deleted once the
   * index without those snapshots is on disk and no rewind or preview is
   * reading.
   */
  async makeSnapshot(messageId: string): Promise<void> {
    return this.enqueue(async () => {
      this.collectUnreferencedBackups(await this.makeSnapshotNow(messageId));
      await this.persistAndPrune();
    });
  }

  /** Returns the snapshots the cap evicted, oldest first. */
  private async makeSnapshotNow(
    messageId: string,
  ): Promise<ReadonlyArray<FileHistorySnapshot>> {
    if (!this.enabled) return [];
    const mostRecent = this.state.snapshots.at(-1);
    const trackedFileBackups: Record<string, FileHistoryBackup> = {};
    const filesChanged: string[] = [];
    let aggInsertions = 0;
    let aggDeletions = 0;

    for (const trackingPath of this.state.trackedFiles) {
      try {
        const latest = mostRecent?.trackedFileBackups[trackingPath];
        const nextVersion = latest ? latest.version + 1 : 1;
        // Any stat failure counts as "the file is gone".
        const sourceStats = await safeStat(trackingPath);
        if (sourceStats === null) {
          if (latest !== undefined && latest.backupFileName === null) {
            // Still missing: the latest entry already says so. Keep it.
            trackedFileBackups[trackingPath] = latest;
            continue;
          }
          // Treat deletion as "all lines removed".
          let priorLines = 0;
          if (latest?.backupFileName) {
            try {
              const prior = await readFile(latest.backupFileName, "utf8");
              priorLines = countLines(prior);
            } catch {
              /* best-effort */
            }
          }
          const diffStats: DiffStats = { insertions: 0, deletions: priorLines };
          trackedFileBackups[trackingPath] = {
            backupFileName: null,
            version: nextVersion,
            backupTimeMs: Date.now(),
            diffStats,
          };
          aggInsertions += diffStats.insertions;
          aggDeletions += diffStats.deletions;
          if (priorLines > 0) filesChanged.push(trackingPath);
          continue;
        }
        if (
          latest !== undefined &&
          latest.backupFileName !== null &&
          sourceStats.isFile() &&
          (await this.matchesBackup(
            trackingPath,
            sourceStats.size,
            latest.backupFileName,
          ))
        ) {
          // Unchanged since its latest backup: share that backup instead
          // of copying the file again. No copy, no diff.
          trackedFileBackups[trackingPath] = {
            backupFileName: latest.backupFileName,
            version: latest.version,
            backupTimeMs: latest.backupTimeMs,
          };
          continue;
        }
        const backup = await this.createBackup(trackingPath, nextVersion);
        // Compute diff stats against the previous version.
        let diffStats: DiffStats | undefined;
        if (latest?.backupFileName && backup.backupFileName) {
          try {
            const [prior, curr] = await Promise.all([
              readFile(latest.backupFileName, "utf8"),
              readFile(backup.backupFileName, "utf8"),
            ]);
            diffStats = computeDiffStats(prior, curr);
            if (
              diffStats &&
              (diffStats.insertions > 0 || diffStats.deletions > 0)
            ) {
              filesChanged.push(trackingPath);
              aggInsertions += diffStats.insertions;
              aggDeletions += diffStats.deletions;
            }
          } catch {
            /* best-effort */
          }
        } else if (backup.backupFileName && !latest) {
          // Newly tracked file — count all lines as insertions.
          try {
            const curr = await readFile(backup.backupFileName, "utf8");
            diffStats = { insertions: countLines(curr), deletions: 0 };
            aggInsertions += diffStats.insertions;
            filesChanged.push(trackingPath);
          } catch {
            /* best-effort */
          }
        }
        trackedFileBackups[trackingPath] = diffStats
          ? { ...backup, diffStats }
          : backup;
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
      aggregateDiffStats:
        filesChanged.length > 0
          ? {
              insertions: aggInsertions,
              deletions: aggDeletions,
              filesChanged,
            }
          : undefined,
    };
    const nextSnapshots = [...this.state.snapshots, snapshot];
    let evictedSnapshots: FileHistorySnapshot[] = [];
    let evicted = this.state.evictedCount;
    let complete = this.state.isFileHistoryComplete;
    if (nextSnapshots.length > this.maxSnapshots) {
      const overflow = nextSnapshots.length - this.maxSnapshots;
      evictedSnapshots = nextSnapshots.splice(0, overflow);
      evicted += overflow;
      complete = false;
      if (!this.evictionWarningEmitted) {
        this.evictionWarningEmitted = true;
        this.emitDiagnostic({
          cause: "file_history_cap_reached",
          message: `file-history LRU cap ${this.maxSnapshots} reached: evicting oldest snapshots (isFileHistoryComplete=false)`,
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
    this.needsPersist = true;
    return evictedSnapshots;
  }

  /**
   * Rewind every tracked file on disk to its state at the snapshot
   * identified by `messageId`. Files first tracked AFTER that snapshot
   * are restored to their v1 (origin) contents — rewinding to "before
   * message X" must also undo edits to files whose first edit happened
   * after X. Returns the list of files that changed on disk.
   *
   * Canonical restore entrypoint — delegates to the module-level
   * `fileHistoryRewind`, which owns the origin-fallback semantics.
   */
  async rewindToMessage(messageId: string): Promise<ReadonlyArray<string>> {
    await this.flush();
    if (!this.enabled) return [];
    const state = this.acquireReader();
    try {
      return await fileHistoryRewind(state, messageId);
    } catch (err) {
      this.emitDiagnostic({
        cause: "file_history_restore_failed",
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      this.releaseReader();
    }
  }

  /** True when a snapshot keyed by `messageId` exists. */
  hasSnapshotFor(messageId: string): boolean {
    return findSnapshotByMessageId(this.state, messageId) !== undefined;
  }

  /**
   * Dry-run of `rewindToMessage`: report which files would change on
   * disk (and line-level diff stats vs their current contents) without
   * touching anything. Returns `null` when no snapshot exists for
   * `messageId`.
   */
  async previewRewind(
    messageId: string,
  ): Promise<FileHistoryRewindPreview | null> {
    await this.flush();
    if (!this.enabled) return null;
    const state = this.acquireReader();
    try {
      const target = findSnapshotByMessageId(state, messageId);
      if (!target) return null;
      const filesChanged: string[] = [];
      const perFile: Record<string, DiffStats> = {};
      let insertions = 0;
      let deletions = 0;
      for (const trackingPath of state.trackedFiles) {
        const targetBackup = target.trackedFileBackups[trackingPath];
        const origin = targetBackup ?? getOriginBackup(state, trackingPath);
        if (origin === undefined) continue;
        try {
          const diskContent = await readFileOrEmpty(trackingPath);
          const targetContent =
            origin.backupFileName === null
              ? ""
              : await readFileOrEmpty(origin.backupFileName);
          if (diskContent === targetContent) continue;
          const stats = computeDiffStats(diskContent, targetContent);
          filesChanged.push(trackingPath);
          perFile[trackingPath] = stats;
          insertions += stats.insertions;
          deletions += stats.deletions;
        } catch {
          /* best-effort — unreadable files are skipped */
        }
      }
      return { filesChanged, insertions, deletions, perFile };
    } finally {
      this.releaseReader();
    }
  }

  // ───────────────────────────────────────────────────────────────────
  // Private
  // ───────────────────────────────────────────────────────────────────

  /**
   * Start of a rewind or preview: counts the reader and hands it the state
   * in one synchronous step, so no deletion pass can start between the two.
   * Always paired with `releaseReader` in a `finally`.
   */
  private acquireReader(): FileHistoryState {
    this.activeReaders += 1;
    return this.state;
  }

  /**
   * End of a rewind or preview. After the last one, a deletion pass is
   * queued for the backups that waited for it. It is queued here, before
   * the reader's own promise resolves, so a caller that awaits the reader
   * and then `flush()` finds those backups gone.
   */
  private releaseReader(): void {
    this.activeReaders -= 1;
    if (this.activeReaders === 0 && this.deletable.size > 0) {
      void this.enqueue(() => this.deleteUnreferencedBackups());
    }
  }

  /**
   * After an eviction: a backup that an evicted snapshot named and that no
   * retained snapshot names is of no further use to this engine. It still
   * has to outlive the index on disk that lists it, so it goes to
   * `awaitingDurableIndex` first. Names are compared as strings. An
   * unchanged file repeats its entry in every snapshot, so one backup can
   * belong to many snapshots, and a file's origin (version 1) backup stays
   * for as long as any retained snapshot names it.
   */
  private collectUnreferencedBackups(
    evicted: ReadonlyArray<FileHistorySnapshot>,
  ): void {
    const unreferenced = new Set<string>();
    for (const snapshot of evicted) {
      for (const backup of Object.values(snapshot.trackedFileBackups)) {
        if (backup.backupFileName !== null) unreferenced.add(backup.backupFileName);
      }
    }
    for (const snapshot of this.state.snapshots) {
      if (unreferenced.size === 0) return;
      for (const backup of Object.values(snapshot.trackedFileBackups)) {
        if (backup.backupFileName !== null) unreferenced.delete(backup.backupFileName);
      }
    }
    for (const backupFileName of unreferenced) {
      this.awaitingDurableIndex.add(backupFileName);
    }
  }

  /**
   * Deletion pass: unlink every backup in `deletable`, and the directory of
   * a tracked path once its last backup is gone. Runs on the queue, after an
   * index write that succeeded and again when the last reader finishes. It
   * does nothing while a reader is active; the end of that reader queues
   * the next pass. Every path leaves the set here whatever happens to it: a
   * failed unlink is reported (once per engine) and not retried.
   */
  private async deleteUnreferencedBackups(): Promise<void> {
    if (this.activeReaders > 0) return;
    const backups = [...this.deletable];
    this.deletable.clear();
    for (const backupFileName of backups) {
      // No snapshot names it, so no file is compared against it again.
      this.backupDigests.delete(backupFileName);
      if (!this.isBackupPath(backupFileName)) continue;
      try {
        await unlink(backupFileName);
      } catch (err) {
        const failure = err as NodeJS.ErrnoException;
        // A backup that is already gone needs no deleting.
        if (failure.code !== "ENOENT") {
          this.reportPruneFailure(backupFileName, failure);
          continue;
        }
      }
      const backupDir = dirname(backupFileName);
      try {
        await rmdir(backupDir);
      } catch (err) {
        const failure = err as NodeJS.ErrnoException;
        // Not empty: the tracked path still has backups in use.
        if (failure.code !== "ENOTEMPTY" && failure.code !== "ENOENT") {
          this.reportPruneFailure(backupDir, failure);
        }
      }
    }
  }

  /**
   * True for `<historyDir>/<directory>/v<version>-<uuid>` in exactly that
   * spelling, which is how `createBackup` names a backup. A deletion pass
   * unlinks nothing else: an index loaded from disk may name any path below
   * the history directory, the index itself included. The path is rebuilt
   * rather than taken apart with `dirname`, which only splits text and would
   * accept `<historyDir>/../v1-...` as two levels below the history
   * directory.
   */
  private isBackupPath(path: string): boolean {
    const name = basename(path);
    return (
      BACKUP_FILE_NAME.test(name) &&
      join(this.historyDir, basename(dirname(path)), name) === path
    );
  }

  /** One `file_history_prune_failed` per engine; later failures are silent. */
  private reportPruneFailure(path: string, failure: NodeJS.ErrnoException): void {
    if (this.pruneFailureReported) return;
    this.pruneFailureReported = true;
    this.emitDiagnostic({
      cause: "file_history_prune_failed",
      message: `prune ${path}: ${failure.message}`,
    });
  }

  private async createBackup(
    filePath: string,
    version: number,
  ): Promise<FileHistoryBackup> {
    let sourceStats: Stats;
    try {
      sourceStats = await stat(filePath);
    } catch {
      return {
        backupFileName: null,
        version,
        backupTimeMs: Date.now(),
      };
    }
    // Opening a FIFO, socket or device can block forever, which would stall
    // every later queued operation. A directory still reaches copyFile and
    // fails there with EISDIR, as it always did.
    if (!sourceStats.isFile() && !sourceStats.isDirectory()) {
      throw new Error("not a regular file");
    }
    const backupDir = join(this.historyDir, pathHash(filePath));
    await mkdir(backupDir, { recursive: true });
    // Published snapshots must never point at a file overwritten by a later
    // snapshot, rewind, or another engine. Version is logical, not a filename.
    const backupFileName = join(backupDir, `v${version}-${randomUUID()}`);
    await copyFile(filePath, backupFileName);
    // Remember what was copied. A failed stat or hash keeps the backup and
    // stores nothing; the next snapshot then tries again.
    await this.digestFor(backupFileName);
    return {
      backupFileName,
      version,
      backupTimeMs: Date.now(),
    };
  }

  /**
   * Digest of a backup file: the cached one, or one computed from the file
   * (stat plus hash) and then cached. Returns `null` when the backup is
   * missing, is not a regular file or cannot be read.
   */
  private async digestFor(backupFileName: string): Promise<BackupDigest | null> {
    const cached = this.backupDigests.get(backupFileName);
    if (cached !== undefined) return cached;
    const backupStats = await safeStat(backupFileName);
    if (backupStats === null || !backupStats.isFile()) return null;
    const sha256 = await sha256OfFile(backupFileName);
    if (sha256 === null) return null;
    const digest: BackupDigest = { sha256, size: backupStats.size };
    this.backupDigests.set(backupFileName, digest);
    return digest;
  }

  /**
   * True when the regular file at `sourcePath` (`sourceSize` bytes) still
   * has the content of the backup `backupFileName`, so a snapshot can
   * share that backup. Any check that fails or cannot be made means
   * "changed", and the caller takes a fresh backup.
   */
  private async matchesBackup(
    sourcePath: string,
    sourceSize: number,
    backupFileName: string,
  ): Promise<boolean> {
    const digest = await this.digestFor(backupFileName);
    if (digest === null || sourceSize !== digest.size) return false;
    // The digest may be older than the file it describes. One stat keeps a
    // backup that was truncated or deleted since from being shared again.
    const backupStats = await safeStat(backupFileName);
    if (backupStats === null || backupStats.size !== digest.size) return false;
    return (await sha256OfFile(sourcePath)) === digest.sha256;
  }

  private emitDiagnostic(d: { cause: string; message: string }): void {
    if (this.withCanonicalBackgroundWork === undefined) {
      this.onDiagnostic?.(d);
      return;
    }
    // Filesystem backups keep their existing scheduling. Only publication
    // writes the parent journal, so defer it until the canonical owner is free.
    this.pendingDiagnostics = this.pendingDiagnostics.then(() =>
      this.runCanonicalWork(() => { this.onDiagnostic?.(d); })).catch(() => {});
    // Diagnostics are best-effort. A failed delivery must not poison later
    // publications or prevent restore, preview, or stop from draining.
  }

  /**
   * I-43 replay — DegradedStore calls this periodically when it
   * thinks disk may have returned. Re-issues each deferred track /
   * snapshot op; on success returns true so the store exits degraded
   * mode.
   */
  private async replayDegraded(
    entries: ReadonlyArray<DeferredBackup>,
  ): Promise<boolean> {
    for (const entry of entries) {
      try {
        if (entry.isTrackEdit) {
          await this.trackEdit(entry.filePath, entry.messageId);
        }
      } catch (err) {
        if (isDegradedErrno(err)) return false;
      }
    }
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Sidecar wrapper — subscribes to event log and hooks file-edit tool
// calls into the history.
// ─────────────────────────────────────────────────────────────────────

export interface FileHistorySidecarOpts {
  readonly fileHistory: FileHistory;
  /** Tool names that mutate files. Defaults to AgenC's first-class
   *  Edit + Write tools. T7 wires per-tool concurrency classes; this
   *  sidecar picks based on tool name prefix match. */
  readonly editToolNames?: ReadonlyArray<string>;
  /**
   * Workspace root used to resolve the files a shell command removes or
   * moves (`rm`, `rmdir`, `unlink`, `mv`), so they are backed up before the
   * command runs the way Edit and Write targets are. Without it shell
   * deletions are not tracked.
   */
  readonly workspaceRoot?: string;
}

const DEFAULT_EDIT_TOOL_NAMES: ReadonlyArray<string> = [
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "apply_patch",
];

/**
 * Shell tools whose command text names the files they delete, and where each
 * one keeps its command line and working directory in its args.
 */
const SHELL_TOOL_ARG_KEYS: Readonly<
  Record<string, { readonly command: string; readonly cwd: string }>
> = {
  exec_command: { command: "cmd", cwd: "workdir" },
  "system.bash": { command: "command", cwd: "cwd" },
};

const APPLY_PATCH_FILE_MARKERS = [
  "*** Move to: ",
  "*** Add File: ",
  "*** Delete File: ",
  "*** Update File: ",
] as const;

/**
 * Extract the file path(s) a mutating tool call touches from its raw
 * JSON args. The live tool schemas use `file_path` (Edit / MultiEdit /
 * Write) and `notebook_path` (NotebookEdit); `path`/`filePath` are kept
 * for legacy callers. `apply_patch` carries a multi-file patch payload
 * in `input` — its hunk headers name every touched file.
 */
function extractEditedFilePaths(
  args: Record<string, unknown> | null,
): ReadonlyArray<string> {
  if (args === null) return [];
  const single =
    args.file_path ?? args.notebook_path ?? args.path ?? args.filePath;
  if (typeof single === "string" && single.length > 0) return [single];
  if (typeof args.input === "string") {
    const paths: string[] = [];
    for (const line of args.input.split("\n")) {
      for (const marker of APPLY_PATCH_FILE_MARKERS) {
        if (line.startsWith(marker)) {
          const path = line.slice(marker.length).trim();
          if (path.length > 0) paths.push(path);
        }
      }
    }
    return paths;
  }
  return [];
}

export class FileHistorySidecar implements Sidecar {
  readonly name = "file-history";
  private readonly history: FileHistory;
  private readonly editToolNames: ReadonlyArray<string>;
  private readonly workspaceRoot: string | undefined;
  private lastEditStartedAtMs: number | null = null;

  constructor(opts: FileHistorySidecarOpts) {
    this.history = opts.fileHistory;
    this.editToolNames = opts.editToolNames ?? DEFAULT_EDIT_TOOL_NAMES;
    this.workspaceRoot = opts.workspaceRoot;
  }

  async start(): Promise<void> {
    // Nothing to do — FileHistory is lazy-initialized.
  }

  async stop(): Promise<void> {
    await this.history.flush();
    this.history.stop();
  }

  isDegraded(): boolean {
    return this.history.isDegraded();
  }

  onEvent(event: Event): void {
    const msg = event.msg;
    if (msg.type === "tool_call_started") {
      if (this.editToolNames.includes(msg.payload.toolName)) {
        this.lastEditStartedAtMs = monotonicMs();
        const args = this.tryParseArgs(msg.payload.args);
        for (const filePath of extractEditedFilePaths(args)) {
          // Daemon cwd is AGENC_HOME, while tool paths are relative to the
          // session workspace. Backups and restores must use the tool path.
          void this.history.trackEdit(this.workspaceRoot === undefined
            ? filePath : resolve(this.workspaceRoot, filePath), event.id);
        }
      } else {
        const deleted = this.shellDeletionPaths(
          msg.payload.toolName,
          this.tryParseArgs(msg.payload.args),
        );
        if (deleted.length > 0) {
          this.lastEditStartedAtMs = monotonicMs();
          void this.trackShellDeletions(deleted, event.id);
        }
      }
    } else if (msg.type === "tool_call_completed") {
      if (this.lastEditStartedAtMs !== null) {
        this.lastEditStartedAtMs = null;
        void this.history.makeSnapshot(event.id);
      }
    } else if (msg.type === "turn_complete") {
      void this.history.makeSnapshot(`turn-${event.id}`);
    } else if (msg.type === "user_message") {
      // Barrier snapshot: capture the tracked files' state at the
      // moment a user message arrives, keyed by the event id that
      // `runTurn` also stamps into the seed LLMMessage's
      // `runtimeOnly.userMessageId`. Conversation rewind restores to
      // this barrier — "the files as they were before you sent this
      // message". Tool execution starts only after a full sampling
      // round-trip, so the async backup always wins the race.
      void this.history.makeSnapshot(event.id);
    }
  }

  private tryParseArgs(raw: string): Record<string, unknown> | null {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * Workspace files a shell tool call is about to remove or move. Resolved
   * against the call's working directory under the sidecar's workspace root;
   * empty when the root is unknown or the tool is not a shell.
   */
  private shellDeletionPaths(
    toolName: string,
    args: Record<string, unknown> | null,
  ): ReadonlyArray<string> {
    const keys = SHELL_TOOL_ARG_KEYS[toolName];
    if (keys === undefined || this.workspaceRoot === undefined || args === null) {
      return [];
    }
    const command = args[keys.command];
    if (typeof command !== "string" || command.trim().length === 0) return [];
    const cwd = args[keys.cwd];
    return collectShellWorkspaceMutationTargets({
      toolName,
      args: {
        command,
        ...(Array.isArray(args.args) ? { args: args.args } : {}),
        ...(typeof cwd === "string" ? { cwd } : {}),
      },
      workspaceRoot: this.workspaceRoot,
    });
  }

  /**
   * Back up the regular files among `paths` before the shell removes them.
   * Directories and missing paths have no content to preserve; a later
   * snapshot records the removal itself, as it does for any tracked file.
   */
  private async trackShellDeletions(
    paths: ReadonlyArray<string>,
    messageId: string,
  ): Promise<void> {
    for (const filePath of paths) {
      let isDirectory = false;
      try {
        isDirectory = (await stat(filePath)).isDirectory();
      } catch {
        // Missing paths must be tracked so rewind removes new shell files.
      }
      if (!isDirectory) await this.history.trackEdit(filePath, messageId);
    }
  }

  getSnapshotState(): FileHistoryState {
    return this.history.getState();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Session-resume surface — module-level helpers
//
// These helpers reuse
// the existing FileHistory on-disk layout (`backupFileName` is the
// absolute path to the backup artifact under `projectDir/file-history/
// <pathHash>/v<N>`), so a snapshot carries the fully-resolved backup
// path and these helpers can operate without knowing `projectDir`.
// ─────────────────────────────────────────────────────────────────────

function findSnapshotByMessageId(
  state: FileHistoryState,
  messageId: string,
): FileHistorySnapshot | undefined {
  for (let i = state.snapshots.length - 1; i >= 0; i -= 1) {
    const snap = state.snapshots[i];
    if (snap && snap.messageId === messageId) return snap;
  }
  return undefined;
}

/**
 * Locate the origin entry for `trackingPath`: the earliest version 1
 * entry in the snapshot log, used when rewinding to a target where the
 * file has not yet been tracked. A file that did not exist at tracking
 * time still has an origin entry; its `backupFileName` is `null`.
 * Returns `undefined` when no version 1 entry can be found at all (a
 * hard "unknown origin": callers must not touch the file).
 */
function getOriginBackup(
  state: FileHistoryState,
  trackingPath: string,
): FileHistoryBackup | null | undefined {
  for (const snapshot of state.snapshots) {
    const backup = snapshot.trackedFileBackups[trackingPath];
    if (backup !== undefined && backup.version === 1) {
      return backup;
    }
  }
  return undefined;
}

async function safeStat(filePath: string): Promise<Stats | null> {
  try {
    return await stat(filePath);
  } catch {
    return null;
  }
}

/** Read a file as utf8; missing/unreadable files read as empty ("did not exist"). */
async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function hashFileContent(filePath: string): Promise<string | null> {
  try {
    const buf = await readFile(filePath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Hash-compares current disk state to the recorded origin (v1) backup.
 * Returns `true` when the file differs (including presence mismatch)
 * or when `backupFileName` is `null` but the file exists on disk.
 */
export async function checkOriginFileChanged(
  filePath: string,
  backupFileName: BackupFileName,
): Promise<boolean> {
  const originStats = await safeStat(filePath);

  if (backupFileName === null) {
    // Origin recorded "file did not exist" — any presence now counts
    // as change.
    return originStats !== null;
  }

  const backupStats = await safeStat(backupFileName);
  // Presence mismatch between disk and backup ⇒ changed.
  if ((originStats === null) !== (backupStats === null)) return true;
  if (originStats === null || backupStats === null) return false;
  if (originStats.size !== backupStats.size) return true;

  const [originHash, backupHash] = await Promise.all([
    hashFileContent(filePath),
    hashFileContent(backupFileName),
  ]);
  if (originHash === null || backupHash === null) return true;
  return originHash !== backupHash;
}

/**
 * Returns `true` when a snapshot for `messageId` exists AND every
 * tracked file in that snapshot has a reachable backup on disk (i.e.
 * the backup files themselves have not been garbage-collected).
 */
export async function fileHistoryCanRestore(
  state: FileHistoryState,
  messageId: string,
): Promise<boolean> {
  const snap = findSnapshotByMessageId(state, messageId);
  if (!snap) return false;
  for (const backup of Object.values(snap.trackedFileBackups)) {
    if (backup.backupFileName === null) continue;
    const s = await safeStat(backup.backupFileName);
    if (s === null) return false;
  }
  return true;
}

/**
 * Rewind the tracked files on disk to the snapshot identified by
 * `messageId`. Returns the list of files that changed. Throws when
 * the snapshot does not exist so callers can surface a clear error.
 */
export async function fileHistoryRewind(
  state: FileHistoryState,
  messageId: string,
): Promise<ReadonlyArray<string>> {
  const target = findSnapshotByMessageId(state, messageId);
  if (!target) {
    throw new Error(
      `FileHistory: Snapshot for messageId=${messageId} not found`,
    );
  }
  const changed: string[] = [];
  for (const trackingPath of state.trackedFiles) {
    const targetBackup = target.trackedFileBackups[trackingPath];
    const origin = targetBackup ?? getOriginBackup(state, trackingPath);
    if (origin === undefined) continue;

    try {
      if (origin.backupFileName === null) {
        // Target said "file did not exist" — delete if present.
        try {
          await rm(trackingPath);
          changed.push(trackingPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        continue;
      }
      if (await checkOriginFileChanged(trackingPath, origin.backupFileName)) {
        const contents = await readFile(origin.backupFileName);
        await writeFile(trackingPath, contents);
        changed.push(trackingPath);
      }
    } catch {
      // Rewind is best-effort: a path that cannot be restored is skipped.
    }
  }
  return changed;
}

/**
 * Diff between two snapshot points. When `fromMessageId`
 * is omitted, diffs against the first recorded snapshot (the origin).
 * Returns per-file insertions/deletions plus an aggregate.
 */
export async function fileHistoryGetDiffStats(
  state: FileHistoryState,
  fromMessageId: string | undefined,
  toMessageId: string,
): Promise<{
  readonly filesChanged: ReadonlyArray<string>;
  readonly insertions: number;
  readonly deletions: number;
  readonly perFile: Readonly<Record<string, DiffStats>>;
}> {
  const toSnap = findSnapshotByMessageId(state, toMessageId);
  if (!toSnap) {
    return { filesChanged: [], insertions: 0, deletions: 0, perFile: {} };
  }
  const fromSnap =
    fromMessageId !== undefined
      ? findSnapshotByMessageId(state, fromMessageId)
      : state.snapshots[0];

  const perFile: Record<string, DiffStats> = {};
  const filesChanged: string[] = [];
  let insertions = 0;
  let deletions = 0;

  const tracked = new Set<string>([
    ...Object.keys(toSnap.trackedFileBackups),
    ...(fromSnap ? Object.keys(fromSnap.trackedFileBackups) : []),
  ]);

  for (const trackingPath of tracked) {
    const fromBackup = fromSnap?.trackedFileBackups[trackingPath];
    const toBackup = toSnap.trackedFileBackups[trackingPath];
    try {
      const fromContent =
        fromBackup?.backupFileName !== undefined &&
        fromBackup.backupFileName !== null
          ? await readFile(fromBackup.backupFileName, "utf8")
          : "";
      const toContent =
        toBackup?.backupFileName !== undefined &&
        toBackup.backupFileName !== null
          ? await readFile(toBackup.backupFileName, "utf8")
          : "";
      if (fromContent === toContent) continue;
      const stats = computeDiffStats(fromContent, toContent);
      if (stats.insertions === 0 && stats.deletions === 0) continue;
      perFile[trackingPath] = stats;
      filesChanged.push(trackingPath);
      insertions += stats.insertions;
      deletions += stats.deletions;
    } catch {
      /* best-effort */
    }
  }

  return { filesChanged, insertions, deletions, perFile };
}

/**
 * "Any edit ever recorded": true iff at least one
 * tracked-file backup exists across the snapshot log. Complements the
 * disk-vs-snapshot variant exposed via the `FileHistory` class.
 */
export function fileHistoryHasAnyChanges(state: FileHistoryState): boolean {
  if (state.trackedFiles.size > 0) return true;
  for (const snap of state.snapshots) {
    if (Object.keys(snap.trackedFileBackups).length > 0) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
// Rollout persistence — session_state carries a file-history block.
//
// Emission side (writer) lives with the session-store; this module
// owns the parser. We duck-type the payload shape so older rollouts
// without the block are simply returned as an empty state.
// ─────────────────────────────────────────────────────────────────────

interface PersistedBackup {
  readonly backupFileName: BackupFileName;
  readonly version: number;
  readonly backupTimeMs: number;
  readonly diffStats?: DiffStats;
}

interface PersistedSnapshot {
  readonly messageId: string;
  readonly trackedFileBackups: Record<string, PersistedBackup>;
  readonly timestampMs: number;
  readonly aggregateDiffStats?: DiffStats & {
    readonly filesChanged: ReadonlyArray<string>;
  };
}

function isPersistedSnapshot(value: unknown): value is PersistedSnapshot {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.messageId === "string" &&
    typeof obj.timestampMs === "number" &&
    obj.trackedFileBackups !== null &&
    typeof obj.trackedFileBackups === "object"
  );
}

/**
 * Rebuild `FileHistoryState` by walking the rollout items
 * and collecting any `event_msg` payload whose `msg.type ===
 * "file_history_snapshot"` carries a `PersistedSnapshot`. Unknown or
 * malformed payloads are skipped (I-26 forward-compat posture).
 */
export function fileHistoryRestoreStateFromLog(
  rolloutItems: ReadonlyArray<RolloutItem>,
): FileHistoryState {
  const snapshots: FileHistorySnapshot[] = [];
  const trackedFiles = new Set<string>();

  for (const item of rolloutItems) {
    if (item.type !== "event_msg") continue;
    const payload = item.payload as Event | undefined;
    const msg = payload?.msg as
      { readonly type?: string; readonly snapshot?: unknown } | undefined;
    if (!msg || msg.type !== "file_history_snapshot") continue;
    const candidate = msg.snapshot;
    if (!isPersistedSnapshot(candidate)) continue;

    const trackedFileBackups: Record<string, FileHistoryBackup> = {};
    for (const [path, backup] of Object.entries(candidate.trackedFileBackups)) {
      trackedFiles.add(path);
      trackedFileBackups[path] = {
        backupFileName: backup.backupFileName,
        version: backup.version,
        backupTimeMs: backup.backupTimeMs,
        diffStats: backup.diffStats,
      };
    }
    snapshots.push({
      messageId: candidate.messageId,
      trackedFileBackups,
      timestampMs: candidate.timestampMs,
      aggregateDiffStats: candidate.aggregateDiffStats,
    });
  }

  return {
    snapshots,
    trackedFiles,
    snapshotSequence: snapshots.length,
    isFileHistoryComplete: true,
    evictedCount: 0,
  };
}

/**
 * AgenC snapshots carry absolute backup paths, so resuming a
 * session does not require per-session backup-dir migration: the new
 * session can read the existing backup artifacts directly. This helper
 * therefore reduces to a structural deep clone of the state so the
 * resumed session gets its own mutable copy isolated from the prior
 * session's in-memory state.
 */
export function copyFileHistoryForResume(
  state: FileHistoryState,
): FileHistoryState {
  const snapshots: FileHistorySnapshot[] = state.snapshots.map((snap) => {
    const trackedFileBackups: Record<string, FileHistoryBackup> = {};
    for (const [path, backup] of Object.entries(snap.trackedFileBackups)) {
      trackedFileBackups[path] = {
        backupFileName: backup.backupFileName,
        version: backup.version,
        backupTimeMs: backup.backupTimeMs,
        diffStats: backup.diffStats
          ? {
              insertions: backup.diffStats.insertions,
              deletions: backup.diffStats.deletions,
            }
          : undefined,
      };
    }
    return {
      messageId: snap.messageId,
      trackedFileBackups,
      timestampMs: snap.timestampMs,
      aggregateDiffStats: snap.aggregateDiffStats
        ? {
            insertions: snap.aggregateDiffStats.insertions,
            deletions: snap.aggregateDiffStats.deletions,
            filesChanged: [...snap.aggregateDiffStats.filesChanged],
          }
        : undefined,
    };
  });
  return {
    snapshots,
    trackedFiles: new Set(state.trackedFiles),
    snapshotSequence: state.snapshotSequence,
    isFileHistoryComplete: state.isFileHistoryComplete,
    evictedCount: state.evictedCount,
  };
}
