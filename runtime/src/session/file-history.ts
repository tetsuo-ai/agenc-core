/**
 * File-history sidecar — per-message snapshots of edited files with
 * versioned backups.
 *
 * Hand-port of agenc `src/utils/fileHistory.ts` (1,115 LOC). The
 * AgenC implementation is tightly coupled to React-hook-style
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

import type { Stats } from "node:fs";
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
import { monotonicMs } from "./_deps/utils.js";
import { DegradedStore } from "./degraded-store.js";
import type { Event } from "./event-log.js";
import type { RolloutItem } from "./rollout-item.js";
import { isDegradedErrno } from "./session-store.js";
import type { Sidecar } from "./sidecar.js";

const MAX_SNAPSHOTS = 100;

export type BackupFileName = string | null;

export interface FileHistoryBackup {
  readonly backupFileName: BackupFileName;
  readonly version: number;
  readonly backupTimeMs: number;
  /** Per-snapshot diff stats against the previous version. Undefined
   *  on v1 (no prior version to diff against) and when the file was
   *  newly created (backupFileName === null). */
  readonly diffStats?: DiffStats;
}

/**
 * Port of agenc `DiffStats` + `computeDiffStats`. Counts line-
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
    for (const line of priorLines) priorSet.set(line, (priorSet.get(line) ?? 0) + 1);
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

  constructor(opts: FileHistoryOptions) {
    this.projectDir = opts.projectDir;
    this.historyDir = join(opts.projectDir, "file-history");
    this.maxSnapshots = opts.maxSnapshots ?? MAX_SNAPSHOTS;
    this.enabled = opts.enabled !== false;
    this.onDiagnostic = opts.onDiagnostic;
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
          message: `${(err as { code?: string }).code} — deferred trackEdit for ${filePath}`,
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
    const filesChanged: string[] = [];
    let aggInsertions = 0;
    let aggDeletions = 0;

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
    if (!this.enabled) return [];
    try {
      return await fileHistoryRewind(this.state, messageId);
    } catch (err) {
      this.emitDiagnostic({
        cause: "file_history_restore_failed",
        message:
          err instanceof Error ? err.message : String(err),
      });
      throw err;
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
  async previewRewind(messageId: string): Promise<FileHistoryRewindPreview | null> {
    if (!this.enabled) return null;
    const target = findSnapshotByMessageId(this.state, messageId);
    if (!target) return null;
    const filesChanged: string[] = [];
    const perFile: Record<string, DiffStats> = {};
    let insertions = 0;
    let deletions = 0;
    for (const trackingPath of this.state.trackedFiles) {
      const targetBackup = target.trackedFileBackups[trackingPath];
      const origin = targetBackup ?? getOriginBackup(this.state, trackingPath);
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
}

const DEFAULT_EDIT_TOOL_NAMES: ReadonlyArray<string> = [
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "apply_patch",
];

const APPLY_PATCH_FILE_MARKERS = [
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
  private lastEditStartedAtMs: number | null = null;

  constructor(opts: FileHistorySidecarOpts) {
    this.history = opts.fileHistory;
    this.editToolNames = opts.editToolNames ?? DEFAULT_EDIT_TOOL_NAMES;
  }

  async start(): Promise<void> {
    // Nothing to do — FileHistory is lazy-initialized.
  }

  async stop(): Promise<void> {
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

  getSnapshotState(): FileHistoryState {
    return this.history.getState();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Session-resume surface — module-level helpers
//
// Port of agenc `utils/fileHistory.ts` lines 347-397, 399-408,
// 414-484, 494-531, 600-634, 888-917, 922-1046. The AgenC port reuses
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
 * Locate the first (earliest) tracked backup for `trackingPath` across
 * the snapshot log, used when rewinding to a target where the file has
 * not yet been tracked. Returns `null` when v1 recorded that the file
 * did not exist, or `undefined` when no v1 entry can be found at all
 * (the latter is a hard "unknown origin" and callers must not touch
 * the file).
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
 * Port of agenc `checkOriginFileChanged` (fileHistory.ts:600-634).
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
 * Port of agenc `fileHistoryCanRestore` (fileHistory.ts:399-408).
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
 * Port of agenc `fileHistoryRewind` (fileHistory.ts:347-397).
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
        } catch {
          /* already absent */
        }
        continue;
      }
      if (await checkOriginFileChanged(trackingPath, origin.backupFileName)) {
        const contents = await readFile(origin.backupFileName);
        await writeFile(trackingPath, contents);
        changed.push(trackingPath);
      }
    } catch {
      /* best-effort — leave file untouched */
    }
  }
  return changed;
}

/**
 * Port of agenc `fileHistoryGetDiffStats` (fileHistory.ts:414-484),
 * generalized to diff between two snapshot points. When `fromMessageId`
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
 * Port of agenc `fileHistoryHasAnyChanges` (fileHistory.ts:494-531)
 * specialized to "any edit ever recorded" — true iff at least one
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
 * Port of agenc `fileHistoryRestoreStateFromLog` (fileHistory.ts:
 * 888-917). Rebuild `FileHistoryState` by walking the rollout items
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
      | { readonly type?: string; readonly snapshot?: unknown }
      | undefined;
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
 * Port of agenc `copyFileHistoryForResume` (fileHistory.ts:922-
 * 1046). AgenC snapshots carry absolute backup paths, so resuming a
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
          ? { insertions: backup.diffStats.insertions, deletions: backup.diffStats.deletions }
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
