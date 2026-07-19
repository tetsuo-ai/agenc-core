/**
 * Session on-disk store — owns the rollout JSONL file, its fsync
 * guarantees, flock acquisition, atomic write-then-rename, and the
 * per-turn `toolResultBytes` index used by compaction.
 *
 * On-disk layout (per `docs/plan/agenc runtime-inventory.md §8`):
 *
 *   ~/.agenc/projects/<slug>/
 *     sessions/<sessionId>/
 *       rollout-<timestamp>-<id>.jsonl     # append-only event log
 *       rollout-<timestamp>-<id>.jsonl.lock  # flock holder PID + nsid
 *       index.json                         # event-log byte offsets (I-88)
 *
 * Invariants enforced here:
 *   I-4  (fsync at turn commit) — `append({durable:true})` flushes
 *        + fsyncs before returning.
 *   I-12 (ENOSPC/EROFS/EACCES/EIO) — wraps writes with errno branch;
 *        on disk failure, routes to degraded mode.
 *   I-23 (concurrent-session flock) — first-append acquires an
 *        advisory lock on the rollout sidecar lockfile via an atomic
 *        link-based handoff (tmp create + `link(tmp, lock)` — atomic
 *        even over NFS) and stores `{pid, startNs}` so the holder's
 *        identity survives PID reuse. Live-PID reclaim is refused
 *        unconditionally; EWOULDBLOCK → SessionLockedError.
 *   I-24 (atomic write-then-rename) — whole-file rewrites (session
 *        metadata re-append after compaction, schema migrations,
 *        checkpoint-style flushes) go through `rewriteAtomically()`:
 *        write `<file>.tmp`, fsync the tmp, `rename()` over the live
 *        file, fsync the parent directory. Incremental event batches
 *        stay O(1) via `O_APPEND + fsync` (with I-38 retry) plus
 *        `truncateCorruptTail()` crash recovery — appending into a
 *        growing JSONL file cannot use write-then-rename without
 *        rereading the entire prefix on every batch.
 *   I-27 (monotonic seq) — events carry `seq`; the store asserts
 *        monotonicity on append.
 *   I-38 (fsync failure retry + degraded) — fsync retry once after
 *        100ms; second failure → degraded mode.
 *   I-49 (schema version stamped) — SessionMetaLine carries
 *        `rolloutSchemaVersion`; open-time version check hard-fails
 *        on forward mismatch.
 *   I-83 (batch suspend detection) — batch open captures monotonicMs;
 *        on flush, if gap > 10s, emit warning + sentinel marker.
 *   I-88 (toolResultBytes index) — per-turn size tally maintained on
 *        each event-log append.
 *
 * @module
 */

import {
  accessSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { monotonicMs } from "./_deps/utils.js";
import {
  ROLLOUT_SCHEMA_VERSION,
  type Event,
  type EventSeq,
  type SessionMetaLine,
  isDurableEvent,
} from "./event-log.js";
import {
  parseRolloutLine,
  serializeRolloutItem,
  type RolloutItem,
} from "./rollout-item.js";
import { DegradedStore } from "./degraded-store.js";
import {
  createTrajectoryExportSink,
  type TrajectoryExportSink,
} from "./trajectory-export.js";

export const I4_FSYNC_RETRY_MS = 100;
const I83_SUSPEND_DETECTION_MS = 10_000;

// OOM: bound the per-session monotonic indices (`toolResultBytesByTurn`,
// `tokenEstimateByTurn`, `toolCallTurnIds`, `offsetsBySeq`). These are advisory
// accumulators — the rollout JSONL is the source of truth (I-25), the live
// compaction window is far smaller than the cap, and the only production readers
// tolerate a missing entry — so evicting the oldest tail (FIFO by Map insertion
// order) once a map exceeds MAX bounds both heap and the index.json snapshot
// without affecting correctness. Siblings of the already-capped `seenEventIds`
// dedup set; closes the same unbounded-per-session growth class as #946/#947.
export const MAX_SESSION_INDEX_ENTRIES = 50_000;
export const SESSION_INDEX_EVICT_BATCH = 5_000;

/**
 * index.json snapshot schema. Written atomically via tmp+rename
 * (I-24) on close and on explicit `writeIndexSnapshot()` calls.
 * Read at resume for a fast-path reconstruction hint; rollout JSONL
 * remains the source of truth per I-25.
 */
export interface IndexSnapshot {
  /** I-25 snapshotSequenceNumber — the last rollout seq this
   *  snapshot reflects. If `snapshot.seq < rollout.lastSeq`, the
   *  reader emits warning:'snapshot_behind_rollout' and falls back
   *  to full reconstruction. */
  readonly snapshotSequenceNumber: number;
  readonly fileSize: number;
  readonly rolloutPath: string;
  readonly toolResultBytesByTurn: Record<string, number>;
  readonly tokenEstimateByTurn?: Record<string, number>;
  /** Latest observed turn id for each completed tool call id. */
  readonly toolCallTurnIds?: Record<string, string>;
  /** Fast-seek byte offset per event seq. Keys are numeric seq values
   *  serialized as strings (JSON key constraint). */
  readonly offsetsBySeq: Record<string, number>;
  readonly writtenAtMs: number;
  readonly agencVersion: string;
  readonly schemaVersion: number;
}

/**
 * Read and validate the index.json snapshot. Returns null when
 * missing or malformed; callers fall back to full rollout
 * reconstruction.
 */
export function readIndexSnapshot(indexPath: string): IndexSnapshot | null {
  if (!existsSync(indexPath)) return null;
  try {
    const raw = readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw) as IndexSnapshot;
    if (typeof parsed.snapshotSequenceNumber !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Errno strings we treat as "filesystem unavailable" (I-12). Any of
 * these on a write/fsync triggers degraded mode after the I-38 retry.
 */
const DEGRADED_ERRNOS: ReadonlyArray<string> = [
  "ENOSPC",
  "EROFS",
  "EACCES",
  "EIO",
  "EDQUOT",
];

export function isDegradedErrno(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return !!code && DEGRADED_ERRNOS.includes(code);
}

/**
 * A short append failed after changing the file and the best-effort rollback
 * could not itself be made durable.  The caller must not requeue the same
 * rows: doing so could turn an uncertain partial tail into duplicate canonical
 * records.  Startup tail repair remains the recovery boundary.
 */
class AppendRollbackError extends Error {
  readonly code?: string;

  constructor(
    readonly writeError: unknown,
    readonly rollbackError: unknown,
    readonly bytesWritten: number,
    readonly appendStart: number,
  ) {
    super(
      `canonical rollout append failed after ${bytesWritten} bytes and rollback failed`,
      { cause: rollbackError },
    );
    this.name = "AppendRollbackError";
    const code =
      (writeError as { readonly code?: string } | null)?.code ??
      (rollbackError as { readonly code?: string } | null)?.code;
    if (code !== undefined) this.code = code;
  }
}

// ─────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────

export function slugifyCwd(cwd: string): string {
  const base = cwd.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${base.slice(0, 40) || "root"}-${hash}`;
}

export function getAgencHomeDir(agencHome?: string): string {
  const explicit = agencHome ?? process.env.AGENC_HOME;
  if (explicit) return explicit;
  const home = process.env.HOME;
  if (!home) {
    throw new Error("HOME unset and AGENC_HOME unset (I-52)");
  }
  return join(home, ".agenc");
}

/**
 * Default project-root markers scanned synchronously when the caller
 * does not pass an explicit list. Mirrors `DEFAULT_PROJECT_ROOT_MARKERS`
 * in `prompts/project-instructions.ts`; duplicated here to keep the
 * session-store module sync-only (no fs/promises import) and free of
 * cross-module churn during T10.
 */
export const DEFAULT_SESSION_ROOT_MARKERS: readonly string[] = [
  ".git",
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  ".hg",
];

/**
 * Synchronous ancestor walk to the nearest directory that contains one
 * of the configured project-root markers. Returns `null` when no marker
 * is found before reaching the filesystem root.
 *
 * Kept sync (unlike `findProjectRoot` in `prompts/project-instructions.ts`)
 * because `getProjectDir` and the SessionStore constructor are called
 * from synchronous init paths that cannot await. The two implementations
 * stay behaviourally equivalent: same markers list, same short-circuit
 * "first marker in first ancestor" semantics.
 */
export function findProjectRootSync(
  cwd: string,
  markers: readonly string[] = DEFAULT_SESSION_ROOT_MARKERS,
): { rootDir: string; marker: string } | null {
  if (markers.length === 0) return null;
  let currentDir = cwd;
  while (true) {
    for (const marker of markers) {
      if (existsSync(join(currentDir, marker))) {
        return { rootDir: currentDir, marker };
      }
    }
    const parent = dirname(currentDir);
    if (parent === currentDir) return null;
    currentDir = parent;
  }
}

/**
 * Resolve the slug directory for a working directory. When a project
 * root marker is found by ancestor walk, the slug is computed from the
 * ancestor root so two checkouts nested under the same `.git` root map
 * to the same `~/.agenc/projects/<slug>/` directory. Falls back to the
 * raw cwd when no marker ancestor exists.
 *
 * The markers list should come from config (`AgenCConfig.project_root_markers`).
 * Passing it explicitly (instead of reading a module-global) avoids
 * implicit coupling and keeps the function testable.
 */
export function getProjectDir(
  cwd: string,
  projectRootMarkers: readonly string[] = DEFAULT_SESSION_ROOT_MARKERS,
  agencHome?: string,
): string {
  const root = findProjectRootSync(cwd, projectRootMarkers);
  const slugInput = root ? root.rootDir : cwd;
  return join(getAgencHomeDir(agencHome), "projects", slugifyCwd(slugInput));
}

export function getSessionDir(
  cwd: string,
  sessionId: string,
  projectRootMarkers: readonly string[] = DEFAULT_SESSION_ROOT_MARKERS,
  agencHome?: string,
): string {
  return join(
    getProjectDir(cwd, projectRootMarkers, agencHome),
    "sessions",
    sessionId,
  );
}

function buildRolloutFilename(
  timestampMs: number,
  sessionId: string,
): string {
  const iso = new Date(timestampMs).toISOString().replace(/[:.]/g, "-");
  return `rollout-${iso}-${sessionId}.jsonl`;
}

// ─────────────────────────────────────────────────────────────────────
// Schema-version check (I-49)
// ─────────────────────────────────────────────────────────────────────

export class SchemaMismatchError extends Error {
  constructor(
    public readonly rolloutVersion: number,
    public readonly runtimeVersion: number,
  ) {
    super(
      `rollout schema v${rolloutVersion} is newer than runtime v${runtimeVersion} — ` +
        `please use /fork to migrate or upgrade @tetsuo-ai/runtime`,
    );
    this.name = "SchemaMismatchError";
  }
}

/**
 * Validate the first line of a rollout file is a well-formed
 * SessionMetaLine and its schemaVersion ≤ runtime version. Returns
 * the parsed meta on success. Throws `SchemaMismatchError` on forward
 * incompatibility; synthesizes a warning for backward migration (we
 * upgrade in place).
 */
export function readAndValidateSchemaVersion(
  rolloutPath: string,
): SessionMetaLine | null {
  if (!existsSync(rolloutPath)) return null;
  const stat = statSync(rolloutPath);
  if (stat.size === 0) return null;
  const fd = openSync(rolloutPath, "r");
  try {
    const headBuf = Buffer.alloc(Math.min(stat.size, 64 * 1024));
    readSync(fd, headBuf, 0, headBuf.length, 0);
    const firstLine = headBuf
      .toString("utf8")
      .split("\n")[0]
      ?.trim();
    if (!firstLine) return null;
    const parsed = parseRolloutLine(firstLine);
    if (parsed?.type !== "session_meta") return null;
    const meta = parsed.payload;
    if (meta.rolloutSchemaVersion > ROLLOUT_SCHEMA_VERSION) {
      throw new SchemaMismatchError(
        meta.rolloutSchemaVersion,
        ROLLOUT_SCHEMA_VERSION,
      );
    }
    return meta;
  } finally {
    closeSync(fd);
  }
}

function maxEventSeqInRollout(path: string): EventSeq {
  if (!existsSync(path)) return 0;
  let maxSeq: EventSeq = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = parseRolloutLine(line);
      if (parsed?.type !== "event_msg") continue;
      const seq = validEventSeq(parsed.payload.seq);
      if (seq !== undefined && seq > maxSeq) maxSeq = seq;
    } catch {
      // Tail repair runs before this scan; ignore any remaining malformed
      // row and preserve the highest valid sequence we can recover.
    }
  }
  return maxSeq;
}

function validEventSeq(value: unknown): EventSeq | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

// ─────────────────────────────────────────────────────────────────────
// Flock (I-23)
// ─────────────────────────────────────────────────────────────────────

/**
 * Lock-file contents. Stored as a single JSON object so future
 * extensions (hostname, boot-id, namespace) can be added without
 * breaking the parser. Kept compact for diagnostic cat-readability.
 */
interface LockRecord {
  readonly pid: number;
  /**
   * Monotonic/wall-clock nanosecond stamp captured at acquisition.
   * Uses `process.hrtime.bigint()` (monotonic, ns) combined with the
   * wall-clock `Date.now()` stringified start so two AgenC processes
   * with the same PID (rare but possible after PID reuse, or in CI
   * fixtures that fork child Node processes) carry distinct start
   * identifiers. The session-start identity is used ONLY for forensic
   * logging — the actual "is this lock alive" check refuses to
   * reclaim any lock whose PID is currently alive, regardless of
   * startNs value.
   */
  readonly startNs: string;
  readonly acquiredAtIso: string;
}

/**
 * Advisory per-rollout lock.
 *
 * Design choice (per I-23 task directive, Option D):
 *
 *   - Pure-JS, no native dep. Node's `fs.linkSync` is atomic on POSIX
 *     and on NFSv3+ (the canonical O_EXCL-equivalent for networked
 *     filesystems). Windows: `linkSync` errors with EPERM for cross-
 *     volume hardlinks; we fall back to `openSync(path, 'wx')` which
 *     is itself atomic on NTFS.
 *
 *   - Identity record: `{pid, startNs}`. The startNs field is a
 *     forensic aid; the liveness decision is PID-based and *refuses*
 *     to reclaim a lock whose PID is alive (`kill(pid, 0)` returns
 *     without ENOSRCH). This is strictly stronger than a pure PID
 *     sidecar: the caller cannot trick us into reclaiming a live
 *     lock by claiming to be the same process — we never check that.
 *
 *   - No `proper-lockfile` dep, no `fs-ext` native binding. Adding a
 *     dep for this was considered and rejected because (a) the
 *     advisory semantics are all we need (single AgenC process per
 *     session directory) and (b) the build story stays simpler.
 *
 * This is stronger than a plain `open(..., 'wx')` sidecar because:
 *
 *   1. The tmp+link dance is atomic on NFS where `open(O_EXCL)` is
 *      not reliable.
 *   2. Live-PID reclaim is never allowed; stale reclaim only proceeds
 *      when `kill(pid, 0)` reports ESRCH.
 *   3. The lock payload is structured so future diagnostic tools
 *      (agenc doctor) can show who is holding the rollout.
 */
export class SessionLock {
  private acquired = false;
  private readonly startNs: string;
  constructor(private readonly lockPath: string) {
    this.startNs = `${Date.now()}-${process.hrtime.bigint().toString()}`;
  }

  acquire(): void {
    if (this.acquired) return;
    mkdirSync(dirname(this.lockPath), { recursive: true });

    // Retry loop: up to 2 passes. First pass may observe a stale lock
    // and reclaim; second pass resolves the O_EXCL race if two
    // processes both observed stale-and-reclaimable simultaneously.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.tryAcquireLink()) {
        this.acquired = true;
        return;
      }
      const existing = this.readLockRecord();
      if (existing !== null) {
        // Lock file exists. Decide if we can reclaim.
        if (processIsAlive(existing.pid)) {
          throw new SessionLockedError(existing.pid, this.lockPath);
        }
        // Stale holder (PID dead). Remove and retry.
        try {
          unlinkSync(this.lockPath);
        } catch (err) {
          lastErr = err;
          // Someone else may have beaten us to the unlink; fall
          // through and retry the link.
        }
      } else {
        // No record / unreadable lockfile. Try to remove + retry.
        try {
          unlinkSync(this.lockPath);
        } catch {
          /* ignore */
        }
      }
    }
    throw lastErr instanceof Error
      ? lastErr
      : new Error(`unable to acquire session lock at ${this.lockPath}`);
  }

  /**
   * Attempt atomic tmp+link handoff. Returns true on success, false
   * if the lock file already exists (EEXIST on link, or EEXIST on the
   * wx fallback).
   */
  private tryAcquireLink(): boolean {
    const record: LockRecord = {
      pid: process.pid,
      startNs: this.startNs,
      acquiredAtIso: new Date().toISOString(),
    };
    const payload = `${JSON.stringify(record)}\n`;
    const tmpPath = `${this.lockPath}.${process.pid}.${this.startNs}.tmp`;
    // Write the tmp payload.
    try {
      const tfd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      try {
        writeSync(tfd, payload);
        fsyncSync(tfd);
      } finally {
        closeSync(tfd);
      }
    } catch (err) {
      // If the tmp already existed (very unlikely given the unique
      // pid/startNs suffix), remove and retry once.
      if ((err as { code?: string })?.code === "EEXIST") {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        const tfd = openSync(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
        try {
          writeSync(tfd, payload);
          fsyncSync(tfd);
        } finally {
          closeSync(tfd);
        }
      } else {
        throw err;
      }
    }
    // Atomic link handoff.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      linkSync(tmpPath, this.lockPath);
      // Success — unlink the tmp (the lock file is a separate inode via
      // link but shares the payload).
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      return true;
    } catch (linkErr) {
      const code = (linkErr as { code?: string })?.code;
      if (code === "EEXIST") {
        // Another process owns (or a stale lockfile remains). Caller
        // will inspect and decide to reclaim.
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        return false;
      }
      // Windows / filesystems without hardlink support (EPERM/ENOSYS):
      // fall back to the `wx` open path. This is strictly weaker but
      // still atomic on NTFS / local POSIX FSes.
      if (code === "EPERM" || code === "ENOSYS" || code === "EXDEV") {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        return this.tryAcquireWxFallback(payload);
      }
      // Unexpected — clean up and propagate.
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw linkErr;
    }
  }

  /** Fallback for filesystems without hardlink support. */
  private tryAcquireWxFallback(payload: string): boolean {
    try {
      const fd = openSync(
        this.lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      try {
        writeSync(fd, payload);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (err) {
      if ((err as { code?: string })?.code === "EEXIST") return false;
      throw err;
    }
  }

  private readLockRecord(): LockRecord | null {
    if (!existsSync(this.lockPath)) return null;
    let raw: string;
    try {
      raw = readFileSync(this.lockPath, "utf8").trim();
    } catch {
      return null;
    }
    if (raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<LockRecord>;
      if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid) && parsed.pid > 0) {
        return {
          pid: parsed.pid,
          startNs: typeof parsed.startNs === "string" ? parsed.startNs : "",
          acquiredAtIso:
            typeof parsed.acquiredAtIso === "string" ? parsed.acquiredAtIso : "",
        };
      }
      return null;
    } catch {
      // Compatibility lockfile format (pre-I-23-hardening): bare PID on a
      // single line. Parse best-effort so migrations don't strand a
      // session directory.
      const pid = Number.parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0) {
        return { pid, startNs: "", acquiredAtIso: "" };
      }
      return null;
    }
  }

  release(): void {
    if (!this.acquired) return;
    try {
      // Only remove the lock if this exact SessionLock instance still owns it.
      // PID equality alone is insufficient: two independent stores in one
      // daemon have the same PID, and one must never release the other's lease.
      const existing = this.readLockRecord();
      if (
        existing !== null &&
        existing.pid === process.pid &&
        existing.startNs === this.startNs
      ) {
        unlinkSync(this.lockPath);
      }
    } catch {
      /* best-effort */
    }
    this.acquired = false;
  }

  get isAcquired(): boolean {
    return this.acquired;
  }
}

export class SessionLockedError extends Error {
  constructor(public readonly holderPid: number, public readonly lockPath: string) {
    super(
      `session locked by pid ${holderPid} (${lockPath}) — another AgenC process owns this session`,
    );
    this.name = "SessionLockedError";
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string })?.code === "EPERM";
  }
}

// ─────────────────────────────────────────────────────────────────────
// I-24 · atomic write-then-rename helper
// ─────────────────────────────────────────────────────────────────────

/**
 * Durable whole-file replace. Used for checkpoint-style writes:
 * index.json snapshots, rollout compaction rewrites, schema
 * migrations. Incremental event-log batches DO NOT use this — see the
 * class docstring at top of file for the rationale.
 *
 * Steps:
 *   1. Write bytes to `<targetPath>.tmp` with O_EXCL so a stale tmp
 *      from a crashed sibling cannot be silently reused.
 *   2. fsync the tmp file so its contents are on disk before the
 *      rename.
 *   3. `rename(tmp, target)` — atomic on POSIX; overwrites the live
 *      file in a single inode swap.
 *   4. fsync the parent directory so the rename entry itself is
 *      durable. On ext4 (and most journalled Linux filesystems) a
 *      file fsync does NOT imply directory-entry durability — the
 *      rename is a directory operation and needs its own fsync on
 *      the parent. See agenc runtime pattern in
 *      `runtime/src/session/rollout-store.ts:238-251`
 *      (`persistThreadSpawnEdgesSnapshot`) which follows the same
 *      sequence for the thread-spawn-edges snapshot.
 *
 * On failure the tmp file is removed and the original target is left
 * intact. Caller owns diagnostic emission.
 */
export function rewriteAtomically(
  targetPath: string,
  bytes: string | Buffer,
  mode: number = 0o600,
): void {
  const tmpPath = `${targetPath}.tmp`;
  // Clear any stale tmp from a prior crash so O_EXCL can succeed.
  try {
    unlinkSync(tmpPath);
  } catch {
    /* ignore */
  }
  // Step 1 + 2: write and fsync the tmp.
  const flags =
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL;
  const fd = openSync(tmpPath, flags, mode);
  try {
    writeSync(fd, bytes as never);
    fsyncSync(fd);
  } catch (err) {
    try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  try {
    closeSync(fd);
  } catch {
    /* ignore — we already fsynced */
  }
  // Step 3: atomic rename.
  try {
    renameSync(tmpPath, targetPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }
  // Step 4: fsync the parent directory so the rename is durable.
  // Best-effort: on non-POSIX filesystems `open(dir, O_RDONLY)` may
  // fail (notably on Windows); swallow quietly because the rename
  // itself is already a durable metadata op on NTFS.
  try {
    const dirFd = openSync(dirname(targetPath), fsConstants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    /* best-effort */
  }
}

// ─────────────────────────────────────────────────────────────────────
// Tail truncation on corrupt trailing line (I-24 recovery)
// ─────────────────────────────────────────────────────────────────────

/**
 * Scan the rollout tail for a trailing partial line (crash mid-write).
 * Returns the new file size after truncation + whether truncation
 * occurred. Callers should emit a `warning:'rollout_truncated_corrupt_tail'`
 * when truncated.
 */
export function truncateCorruptTail(
  rolloutPath: string,
  repair: {
    readonly truncate?: (fd: number, length: number) => void;
    readonly sync?: (fd: number) => void;
  } = {},
): {
  readonly truncated: boolean;
  readonly newSize: number;
} {
  if (!existsSync(rolloutPath)) return { truncated: false, newSize: 0 };
  const stat = statSync(rolloutPath);
  if (stat.size === 0) return { truncated: false, newSize: 0 };
  // Read last 1MB (or file size, whichever smaller).
  const tailSize = Math.min(stat.size, 1024 * 1024);
  const fd = openSync(rolloutPath, "r+");
  try {
    const buf = Buffer.alloc(tailSize);
    readSync(fd, buf, 0, tailSize, stat.size - tailSize);
    const text = buf.toString("utf8");
    // Search for last newline.
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      // Entire tail window has no newline — file has a single
      // un-terminated line. Truncate to zero.
      (repair.truncate ?? ftruncateSync)(fd, 0);
      (repair.sync ?? fsyncSync)(fd);
      return { truncated: true, newSize: 0 };
    }
    // Check if tail after last newline is empty (normal complete file).
    const afterLastNewlineIdx = (stat.size - tailSize) + lastNewline + 1;
    if (afterLastNewlineIdx >= stat.size) {
      return { truncated: false, newSize: stat.size };
    }
    // Partial line exists after last newline — truncate.
    (repair.truncate ?? ftruncateSync)(fd, afterLastNewlineIdx);
    (repair.sync ?? fsyncSync)(fd);
    return { truncated: true, newSize: afterLastNewlineIdx };
  } finally {
    closeSync(fd);
  }
}

// ─────────────────────────────────────────────────────────────────────
// SessionStore — owns the rollout file + index + lock.
// ─────────────────────────────────────────────────────────────────────

export interface SessionStoreOpts {
  readonly cwd: string;
  readonly sessionId: string;
  readonly agencVersion: string;
  /** Whether to open existing rollout (resume) or create new. */
  readonly resume?: boolean;
  /**
   * Marker files/directories used to resolve the project root slug.
   * When provided, the store slugs from the nearest ancestor that
   * contains one of these markers so checkouts nested under the same
   * repo map to the same `~/.agenc/projects/<slug>/` dir. Falls back
   * to the default marker list (`DEFAULT_SESSION_ROOT_MARKERS`) when
   * omitted, and to the raw cwd when no marker ancestor exists.
   */
  readonly projectRootMarkers?: readonly string[];
}

export interface AppendOptions {
  /** Force I-4 fsync after this append. Overrides auto-detection. */
  readonly durable?: boolean;
  /**
   * Estimated tool-result payload bytes for I-88 index update. Phase 5
   * passes this for each tool_call_completed event.
   */
  readonly toolResultBytes?: number;
  /** Estimated tool-result tokens for I-88 parity. */
  readonly tokenEstimate?: number;
  /** Turn id for I-88 index keying. */
  readonly turnId?: string;
}

export interface CompactionIndexSnapshot {
  readonly toolResultBytesByTurn: ReadonlyMap<string, number>;
  readonly tokenEstimateByTurn?: ReadonlyMap<string, number>;
  readonly toolCallTurnIds: ReadonlyMap<string, string>;
}

/**
 * Callback surface for the SessionStore to report degraded-mode +
 * diagnostic events upward. The session layer wires this to the
 * shared EventLog so I-8 / I-38 / I-83 emissions land as typed
 * events in the rollout (after the store recovers). Before wire-up
 * diagnostics land in memory; callers can drain via `diagnostics()`.
 */
export interface SessionStoreDiagnostic {
  readonly at: number;
  readonly level: "warning" | "error";
  readonly cause: string;
  readonly message: string;
}

export class SessionStore {
  readonly cwd: string;
  readonly sessionId: string;
  readonly agencVersion: string;
  readonly sessionDir: string;
  readonly rolloutPath: string;
  readonly lockPath: string;
  readonly indexPath: string;
  private readonly lock: SessionLock;
  /** I-88 per-turn tool-result-bytes index. */
  private readonly toolResultBytesByTurn = new Map<string, number>();
  /** I-88 parity: per-turn token estimate for completed tool results. */
  private readonly tokenEstimateByTurn = new Map<string, number>();
  /** I-88 — resolve compacted tool_result blocks back to their source turns. */
  private readonly toolCallTurnIds = new Map<string, string>();
  /** I-88 (+ fast-seek) — byte offset in the rollout file where each
   *  seq'd event starts. Written to index.json on close. */
  private readonly offsetsBySeq = new Map<EventSeq, number>();
  /** Sidecar metadata last observed in a `session_meta` row. Used for
   *  metadata tail re-append after compaction. */
  private lastSessionMeta: SessionMetaLine | null = null;
  /** UUID dedup — tracks emitted `event.id`s so repeated enqueues
   *  (fork-flush, replay-merge, retries) don't double-append. */
  private readonly seenEventIds = new Set<string>();
  private lastSeqWritten: EventSeq = 0;
  private opened = false;
  private batchOpenedAtMs: number | null = null;
  /** Pending batch (flushed on 100ms tick or durable event). */
  private pending: RolloutItem[] = [];
  private readonly degraded: DegradedStore<RolloutItem>;
  private fileSize = 0;
  private closed = false;
  private readonly diagnosticsBuffer: SessionStoreDiagnostic[] = [];
  private onDiagnostic?: (d: SessionStoreDiagnostic) => void;
  /**
   * I-38 async fsync retries currently in flight. Tracked so `close()`
   * can wait for them to settle (or so tests can await completion).
   * Each entry is the Promise returned by `scheduleFsyncRetry()`.
   */
  private readonly pendingFsyncRetries = new Set<Promise<void>>();
  /**
   * Test-only seam for the I-38 async fsync retry behaviour. Since
   * `fsyncSync` is imported as a static ESM binding from `node:fs`,
   * it cannot be monkey-patched at the module level in Vitest. Tests
   * install a fake here via {@link setFsyncImplForTest} to simulate
   * transient and persistent fsync failures.
   */
  private fsyncImpl: (fd: number) => void = fsyncSync;
  private writeImpl: (
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
  ) => number = (fd, buffer, offset, length) =>
    writeSync(fd, buffer, offset, length);
  /** Exact pre-append boundary whose rollback could not be durably proven. */
  private uncertainAppendStart: number | undefined;
  private readonly trajectoryExport: TrajectoryExportSink;

  constructor(opts: SessionStoreOpts) {
    this.cwd = opts.cwd;
    this.sessionId = opts.sessionId;
    this.agencVersion = opts.agencVersion;
    this.sessionDir = getSessionDir(
      opts.cwd,
      opts.sessionId,
      opts.projectRootMarkers ?? DEFAULT_SESSION_ROOT_MARKERS,
    );
    mkdirSync(this.sessionDir, { recursive: true });
    const rolloutFilename = buildRolloutFilename(Date.now(), opts.sessionId);
    // If resuming, find the most-recent rollout in the session dir.
    if (opts.resume) {
      const existing = readdirSync(this.sessionDir)
        .filter((f) => f.startsWith("rollout-") && f.endsWith(".jsonl"))
        .sort();
      if (existing.length > 0) {
        this.rolloutPath = join(this.sessionDir, existing[existing.length - 1]!);
      } else {
        this.rolloutPath = join(this.sessionDir, rolloutFilename);
      }
    } else {
      this.rolloutPath = join(this.sessionDir, rolloutFilename);
    }
    this.lockPath = `${this.rolloutPath}.lock`;
    this.indexPath = join(this.sessionDir, "index.json");
    this.lock = new SessionLock(this.lockPath);
    this.trajectoryExport = createTrajectoryExportSink({
      sessionId: this.sessionId,
      rolloutPath: this.rolloutPath,
    });

    this.degraded = new DegradedStore<RolloutItem>({
      flushFn: async (events) => this.flushDegradedBuffer(events),
    });
  }

  /**
   * Open the store: acquire flock (I-23), validate schema version
   * (I-49), truncate corrupt tail (I-24), write the session_meta
   * line if new.
   */
  open(meta: Omit<SessionMetaLine, "rolloutSchemaVersion">): void {
    if (this.opened) return;
    this.lock.acquire();
    try {
      if (existsSync(this.rolloutPath)) {
        // Schema check + tail truncation.
        readAndValidateSchemaVersion(this.rolloutPath);
        const truncResult = truncateCorruptTail(this.rolloutPath);
        if (truncResult.truncated) {
          this.emitDiagnostic({
            at: Date.now(),
            level: "warning",
            cause: "rollout_truncated_corrupt_tail",
            message: `rollout tail truncated to ${truncResult.newSize} bytes (I-24 recovery)`,
          });
        }
        // Recovery may encounter complete rows written by a prior process whose
        // fsync failed before it died. Re-sync the surviving canonical prefix
        // under this source's exclusive lease before any caller treats those
        // bytes as durable recovery evidence.
        this.syncCanonicalFile();
        this.fileSize = statSync(this.rolloutPath).size;
        const snapshot = readIndexSnapshot(this.indexPath);
        if (snapshot && snapshot.rolloutPath === this.rolloutPath) {
          const snapshotSeq = validEventSeq(snapshot.snapshotSequenceNumber);
          if (snapshotSeq !== undefined && snapshotSeq > this.lastSeqWritten) {
            this.lastSeqWritten = snapshotSeq;
          }
          this.toolResultBytesByTurn.clear();
          for (const [turnId, bytes] of Object.entries(
            snapshot.toolResultBytesByTurn ?? {},
          )) {
            if (typeof bytes === "number" && bytes > 0) {
              this.toolResultBytesByTurn.set(turnId, bytes);
            }
          }
          this.tokenEstimateByTurn.clear();
          for (const [turnId, tokens] of Object.entries(
            snapshot.tokenEstimateByTurn ?? {},
          )) {
            if (typeof tokens === "number" && tokens > 0) {
              this.tokenEstimateByTurn.set(turnId, tokens);
            }
          }
          this.toolCallTurnIds.clear();
          for (const [toolCallId, turnId] of Object.entries(
            snapshot.toolCallTurnIds ?? {},
          )) {
            if (typeof turnId === "string" && turnId.length > 0) {
              this.toolCallTurnIds.set(toolCallId, turnId);
            }
          }
          this.offsetsBySeq.clear();
          for (const [seq, offset] of Object.entries(snapshot.offsetsBySeq ?? {})) {
            const parsedSeq = Number(seq);
            if (Number.isFinite(parsedSeq) && typeof offset === "number") {
              this.offsetsBySeq.set(parsedSeq, offset);
            }
          }
        }
        const rolloutSeq = maxEventSeqInRollout(this.rolloutPath);
        if (rolloutSeq > this.lastSeqWritten) {
          this.lastSeqWritten = rolloutSeq;
        }
      } else {
        // Fresh file — write session_meta.
        const sessionMeta: SessionMetaLine = {
          ...meta,
          rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
        };
        const item: RolloutItem = {
          type: "session_meta",
          payload: sessionMeta,
        };
        const line = serializeRolloutItem(item);
        this.writeBytesWithFsync(line, (err) => {
          // I-38: persistent fsync failure on the initial session_meta
          // write — enter degraded mode so subsequent durable appends
          // route through the ring buffer. The meta line itself is in
          // the page cache so recovery readers will usually still see
          // it; degraded mode just protects follow-on events.
          if (isDegradedErrno(err)) {
            this.degraded.enterDegraded(
              `${(err as { code?: string }).code} during session_meta write`,
            );
          }
        });
        this.fileSize = Buffer.byteLength(line, "utf8");
        this.trajectoryExport.writeItems([item]);
        this.lastSessionMeta = sessionMeta;
      }
      this.degraded.start();
      this.opened = true;
    } catch (err) {
      this.lock.release();
      throw err;
    }
  }

  /**
   * Register a callback for degraded / suspend / fsync-fail events.
   * The session layer wires this to `EventLog.emit()` so I-8 / I-38 /
   * I-83 surface as typed events. Diagnostics captured BEFORE the
   * callback is wired are replayed on registration.
   */
  setDiagnosticListener(listener: (d: SessionStoreDiagnostic) => void): void {
    this.onDiagnostic = listener;
    // Replay buffered diagnostics.
    const buffered = this.diagnosticsBuffer.splice(0);
    for (const d of buffered) listener(d);
  }

  private emitDiagnostic(d: SessionStoreDiagnostic): void {
    if (this.onDiagnostic) {
      this.onDiagnostic(d);
    } else {
      this.diagnosticsBuffer.push(d);
    }
  }

  /** Drain any buffered diagnostics. Used by tests. */
  drainBufferedDiagnostics(): SessionStoreDiagnostic[] {
    return this.diagnosticsBuffer.splice(0);
  }

  /**
   * Test-only: swap the fsync implementation used by
   * `writeBytesWithFsync` and its I-38 async retry. Kept as a named
   * seam (rather than a module-level spy) because `node:fs` ESM
   * namespace bindings are not spyable in Vitest.
   *
   * @internal
   */
  setFsyncImplForTest(impl: (fd: number) => void): void {
    this.fsyncImpl = impl;
  }

  /** @internal Test seam for short-write recovery. */
  setWriteImplForTest(
    impl: (
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
    ) => number,
  ): void {
    this.writeImpl = impl;
  }

  /**
   * Append an event. Called by Session.emit(). Durable events (per
   * isDurableEvent or explicit `opts.durable`) flush immediately +
   * fsync (I-4). Others batch until 100ms or the next durable event.
   *
   * Sequenced writes are strictly monotonic. A repeated/backward sequence is
   * a writer bug and fails closed; silently accepting it would let a caller
   * project or publish an event that the canonical rollout rejected. Events
   * WITHOUT seq (sidecar synth or replay re-entry) remain deduped by `event.id`.
   */
  append(event: Event, opts: AppendOptions = {}): boolean {
    if (!this.opened || this.closed) return false;
    // I-27: seq monotonicity check. Caller assigns via EventLog; we
    // just verify.
    if (event.seq !== undefined && event.seq <= this.lastSeqWritten) {
      throw new Error(
        `non-monotonic rollout event sequence ${event.seq}; canonical tail is ${this.lastSeqWritten}`,
      );
    }
    // UUID dedup — if we've already seen this event.id, skip. Only
    // applies to events without a seq (sidecar synth / replay); seq'd
    // events are already ordered by the EventLog monotonic counter.
    if (event.seq === undefined) {
      if (this.seenEventIds.has(event.id)) return true;
      this.seenEventIds.add(event.id);
      // Bound the dedup set — evict oldest once it grows past 10K.
      if (this.seenEventIds.size > 10_000) {
        const keys = Array.from(this.seenEventIds);
        for (let i = 0; i < 1000; i += 1) this.seenEventIds.delete(keys[i]!);
      }
    }
    if (event.seq !== undefined) this.lastSeqWritten = event.seq;

    // I-88 per-turn tool-result index update.
    const toolCompletion =
      event.msg.type === "tool_call_completed" ? event.msg.payload : undefined;
    const turnId = opts.turnId;
    const toolResultBytes =
      opts.toolResultBytes ??
      (toolCompletion
        ? measureToolResultBytesFromPayload(toolCompletion.result)
        : 0);
    const tokenEstimate =
      opts.tokenEstimate ??
      (toolCompletion
        ? estimateToolResultTokensFromPayload(toolCompletion.result)
        : 0);
    if (turnId && toolResultBytes > 0) {
      const prev = this.toolResultBytesByTurn.get(turnId) ?? 0;
      this.toolResultBytesByTurn.set(turnId, prev + toolResultBytes);
      this.boundIndexMap(this.toolResultBytesByTurn);
    }
    if (turnId && tokenEstimate > 0) {
      const prev = this.tokenEstimateByTurn.get(turnId) ?? 0;
      this.tokenEstimateByTurn.set(turnId, prev + tokenEstimate);
      this.boundIndexMap(this.tokenEstimateByTurn);
    }
    if (
      turnId &&
      toolCompletion &&
      typeof toolCompletion.callId === "string" &&
      toolCompletion.callId.length > 0
    ) {
      this.toolCallTurnIds.set(toolCompletion.callId, turnId);
      this.boundIndexMap(this.toolCallTurnIds);
    }

    const item: RolloutItem = { type: "event_msg", payload: event };

    if (this.batchOpenedAtMs === null) {
      this.batchOpenedAtMs = monotonicMs();
    }
    this.pending.push(item);

    const durable = opts.durable === true || isDurableEvent(event);
    if (durable) {
      return this.flushBatch(/*durable*/ true);
    } else if (this.pending.length >= 1024) {
      // Flush if the batch gets large to bound memory even before the
      // 100ms tick.
      return this.flushBatch(/*durable*/ false);
    }
    return true;
  }

  /**
   * Append a non-event RolloutItem (session_state / response_item /
   * compacted / turn_context). These don't carry seq so just get
   * batched and eventually flushed.
   */
  appendRollout(item: RolloutItem, opts: AppendOptions = {}): void {
    const durable =
      opts.durable === true ||
      (item.type === "event_msg" && isDurableEvent(item.payload));
    if (!this.opened || this.closed) {
      if (durable) {
        throw new Error("cannot commit durable rollout item to a closed store");
      }
      return;
    }
    if (this.batchOpenedAtMs === null) {
      this.batchOpenedAtMs = monotonicMs();
    }
    this.pending.push(item);
    if (durable && !this.flushBatch(true)) {
      throw new Error("durable rollout item was not fsync-committed");
    }
  }

  /**
   * 100ms batch flush tick — called externally by a timer owned by
   * the sidecar manager or by `append()` on durable events. Exposed
   * for tests.
   */
  flushBatch(durable: boolean): boolean {
    if (this.pending.length === 0) {
      this.batchOpenedAtMs = null;
      return true;
    }
    // I-83 suspend detection: if the batch was open for > 10s (e.g.
    // system suspend/resume gap), emit TWO marker events (warning +
    // sentinel system_resumed_from) AHEAD of the pending batch.
    // The markers are informational warnings (non-state-mutating in the
    // reducer); the queued durable response_item / session_state lines
    // that straddle the suspend window MUST be preserved and flushed,
    // not discarded — dropping them permanently loses in-flight history.
    if (
      this.batchOpenedAtMs !== null &&
      monotonicMs() - this.batchOpenedAtMs > I83_SUSPEND_DETECTION_MS
    ) {
      const durationMs = Math.round(monotonicMs() - this.batchOpenedAtMs);
      this.batchOpenedAtMs = null;
      // Prepend the two I-83 marker events so the log shows (a) the
      // operator-visible warning and (b) a structural sentinel the
      // reducer can reason about, while the original pending items
      // remain queued behind them.
      const warning: RolloutItem = {
        type: "event_msg",
        payload: {
          id: "system",
          msg: {
            type: "warning",
            payload: {
              cause: "event_log_batch_delayed",
              message: `event-log batch delayed ${durationMs}ms (I-83)`,
            },
          },
        },
      };
      // Sentinel encoded as a warning with cause=system_resumed_from
      // so it round-trips through the 24-variant EventMsg union
      // without adding a new variant.
      const sentinel: RolloutItem = {
        type: "event_msg",
        payload: {
          id: "system",
          msg: {
            type: "warning",
            payload: {
              cause: "system_resumed_from",
              message: `${durationMs}`,
            },
          },
        },
      };
      this.pending = [warning, sentinel, ...this.pending];
      this.emitDiagnostic({
        at: Date.now(),
        level: "warning",
        cause: "event_log_batch_delayed",
        message: `system_resumed_from(${durationMs}ms)`,
      });
    }

    // Record byte offsets for each event row before write so the
    // index.json snapshot + fast-seek readers can jump to a specific
    // seq without parsing the whole file.
    let offsetAccumulator = this.fileSize;
    for (const item of this.pending) {
      if (item.type === "event_msg" && item.payload.seq !== undefined) {
        this.offsetsBySeq.set(item.payload.seq, offsetAccumulator);
      }
      offsetAccumulator += Buffer.byteLength(serializeRolloutItem(item), "utf8");
    }
    this.boundIndexMap(this.offsetsBySeq);

    const lines = this.pending.map(serializeRolloutItem).join("");
    const toWrite = this.pending;
    this.pending = [];
    this.batchOpenedAtMs = null;

    // `requeue` distinguishes the failure shapes (#11):
    //   - writeSync failed before writing, or a partial append was rolled back
    //     and fsync'd: the items can be re-queued into the degraded ring buffer
    //     for a later complete re-append (requeue=true).
    //   - a partial append could not be durably rolled back: the on-disk tail
    //     is uncertain and re-append could duplicate it (requeue=false).
    //   - writeSync succeeded but fsync (+ its I-38 retry) failed: the
    //     bytes are ALREADY appended to the rollout on disk. Re-queueing
    //     them would re-serialize + re-append the same rows on degraded
    //     flush, bypassing the append()-level seq/UUID dedup and landing
    //     duplicates in the JSONL (double on resume). So we enter
    //     degraded mode WITHOUT re-queueing (requeue=false).
    const routeToDegraded = (err: unknown, requeue: boolean) => {
      if (isDegradedErrno(err)) {
        // I-12 / I-38 path: enter degraded so subsequent appends buffer
        // instead of touching the sick disk.
        this.degraded.enterDegraded(
          `${(err as { code?: string }).code} during append`,
        );
        if (requeue) {
          for (const item of toWrite) this.degraded.append(item);
        }
        this.emitDiagnostic({
          at: Date.now(),
          level: "error",
          cause: "rollout_degraded",
          message: requeue
            ? `${(err as { code?: string }).code ?? "unknown"} during append — ${toWrite.length} events queued in degraded ring buffer`
            : `${(err as { code?: string }).code ?? "unknown"} during fsync — ${toWrite.length} events already on disk, entering degraded mode without re-queue`,
        });
        return true;
      }
      return false;
    };

    let committed = true;
    try {
      if (durable) {
        // I-38: async retry on fsync failure routes to degraded via
        // the callback. The bytes were already writeSync'd by this
        // point, so we MUST NOT re-queue them (#11) — only enter
        // degraded mode.
        committed = this.writeBytesWithFsync(lines, (err) => {
          routeToDegraded(err, /*requeue*/ false);
        });
      } else {
        this.writeBytesAppendOnly(lines);
      }
      this.fileSize += Buffer.byteLength(lines, "utf8");
      this.trajectoryExport.writeItems(toWrite);
    } catch (err) {
      const safeToRequeue = !(err instanceof AppendRollbackError);
      if (!routeToDegraded(err, safeToRequeue)) {
        throw err;
      }
      committed = false;
    }
    return committed;
  }

  /**
   * Establish an explicit fsync proof for the complete canonical tail even
   * when there is no pending in-memory batch. Idempotent recovery paths call
   * this before accepting already-present journal evidence after an earlier
   * ambiguous fsync failure.
   */
  syncCanonicalTail(): void {
    if (!this.opened || this.closed) {
      throw new Error("cannot sync canonical tail on a closed store");
    }
    if (this.pending.length > 0 && !this.flushBatch(true)) {
      throw new Error("canonical rollout tail was not fsync-committed");
    }
    this.syncCanonicalFile();
  }

  private syncCanonicalFile(): void {
    const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND;
    const fd = openSync(this.rolloutPath, flags, 0o600);
    try {
      this.repairUncertainAppendTail(fd);
      this.fsyncImpl(fd);
    } finally {
      closeSync(fd);
    }
  }

  private writeBytesAppendOnly(content: string): void {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND;
    const fd = openSync(this.rolloutPath, flags, 0o600);
    try {
      this.writeAll(fd, content);
    } finally {
      closeSync(fd);
    }
  }

  /**
   * Write + fsync with I-38 retry. Used for durable events (I-4)
   * and for the session-meta header write.
   *
   * I-4: the initial `writeSync` + `fsyncSync` attempt is synchronous,
   * so durable events are persisted to the kernel and flushed before
   * returning in the happy path (fsync success).
   *
   * I-38: on fsync failure the retry is scheduled asynchronously
   * ~100ms later via `setTimeout` instead of a busy-wait loop. The
   * sync caller returns with the data already `writeSync`'d — it
   * lives in the page cache and, on most transient fsync failures,
   * will have been flushed by the kernel by the time the retry fires.
   * If the async retry succeeds we emit `fsync_retry_succeeded`; if
   * it fails we emit the typed `fsync_failed` diagnostic and invoke
   * `onRetryFailure` so the caller can route the affected items to
   * the degraded ring buffer (I-12 path).
   *
   * @param onRetryFailure Optional callback invoked from the async
   *   retry branch when the second fsync attempt also fails. Used by
   *   durable-flush callers to route items into the degraded store.
   */
  private writeBytesWithFsync(
    content: string,
    onRetryFailure?: (err: unknown) => void,
  ): boolean {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND;
    const fd = openSync(this.rolloutPath, flags, 0o600);
    let firstErr: unknown;
    try {
      this.writeAll(fd, content);
      try {
        this.fsyncImpl(fd);
      } catch (err) {
        firstErr = err;
      }
    } finally {
      closeSync(fd);
    }
    if (firstErr !== undefined) {
      // I-38: defer the retry via setTimeout so we don't pin the event
      // loop. The data is already in the OS buffer from writeSync, so
      // re-opening the file and calling fsyncSync on that fd flushes
      // the same kernel-level buffers to disk.
      this.scheduleFsyncRetry(firstErr, onRetryFailure);
      return false;
    }
    return true;
  }

  private writeAll(fd: number, content: string): void {
    this.repairUncertainAppendTail(fd);
    const bytes = Buffer.from(content, "utf8");
    const appendStart = fstatSync(fd).size;
    let offset = 0;
    try {
      while (offset < bytes.length) {
        const written = this.writeImpl(fd, bytes, offset, bytes.length - offset);
        if (
          !Number.isSafeInteger(written) ||
          written <= 0 ||
          written > bytes.length - offset
        ) {
          throw new Error(
            `short write while appending canonical rollout ${this.rolloutPath}`,
          );
        }
        offset += written;
      }
    } catch (writeError) {
      if (offset === 0) throw writeError;
      try {
        ftruncateSync(fd, appendStart);
        this.fsyncImpl(fd);
      } catch (rollbackError) {
        this.uncertainAppendStart = Math.min(
          this.uncertainAppendStart ?? appendStart,
          appendStart,
        );
        throw new AppendRollbackError(
          writeError,
          rollbackError,
          offset,
          appendStart,
        );
      }
      throw writeError;
    }
  }

  private repairUncertainAppendTail(fd: number): void {
    const boundary = this.uncertainAppendStart;
    if (boundary === undefined) return;
    ftruncateSync(fd, boundary);
    this.fsyncImpl(fd);
    this.uncertainAppendStart = undefined;
  }

  /**
   * Schedule the I-38 async retry. Kept separate so tests can stub
   * the timer shape. Returns the promise tracking the retry so
   * callers (and tests) can await it.
   */
  private scheduleFsyncRetry(
    firstErr: unknown,
    onRetryFailure?: (err: unknown) => void,
  ): Promise<void> {
    const retry = new Promise<void>((resolve) => {
      setTimeout(() => {
        let retryErr: unknown;
        try {
          const flags = fsConstants.O_WRONLY | fsConstants.O_APPEND;
          const rfd = openSync(this.rolloutPath, flags, 0o600);
          try {
            this.fsyncImpl(rfd);
          } finally {
            closeSync(rfd);
          }
        } catch (err2) {
          retryErr = err2;
        }
        if (retryErr === undefined) {
          this.emitDiagnostic({
            at: Date.now(),
            level: "warning",
            cause: "fsync_retry_succeeded",
            message: `fsync succeeded on retry after ${(firstErr as { code?: string }).code ?? "unknown"}`,
          });
        } else {
          this.emitDiagnostic({
            at: Date.now(),
            level: "error",
            cause: "fsync_failed",
            message: `fsync retry failed: ${(retryErr as { code?: string; message?: string }).code ?? ""} ${(retryErr as { message?: string }).message ?? String(retryErr)}`,
          });
          if (onRetryFailure) {
            try {
              onRetryFailure(retryErr);
            } catch {
              /* swallow — we're on the timer stack, caller owns its side effects */
            }
          }
        }
        resolve();
      }, I4_FSYNC_RETRY_MS).unref?.();
    });
    this.pendingFsyncRetries.add(retry);
    void retry.then(() => {
      this.pendingFsyncRetries.delete(retry);
    });
    return retry;
  }

  /**
   * Test + close-coordination helper: await any in-flight I-38 async
   * fsync retries. Kept internal; tests import via the class since
   * there are no external consumers of the retry lifecycle today.
   */
  async awaitPendingFsyncRetries(): Promise<void> {
    while (this.pendingFsyncRetries.size > 0) {
      await Promise.all(Array.from(this.pendingFsyncRetries));
    }
  }

  /**
   * I-24 · Write-then-rename whole-file rewrite.
   *
   * Use this for checkpoint-style rewrites of the rollout file
   * (compaction rewrites, schema migrations, metadata-at-EOF
   * snapshots). Incremental event batches MUST NOT use this path —
   * they stay on the O(1) `writeBytesWithFsync` append + fsync +
   * tail-truncation crash recovery strategy, because rewriting a
   * growing JSONL file for every batch is O(N).
   *
   * Sequence:
   *   1. Write the full new file contents to `<rolloutPath>.tmp`.
   *   2. fsync the tmp file (durable before rename).
   *   3. `fs.rename(tmp, rolloutPath)` — atomic on POSIX.
   *   4. fsync the parent directory so the rename entry itself is
   *      durable on ext4 (directory entries are not implicit in the
   *      file fsync on any Linux FS). Mirrors the pattern in
   *      `rollout-store.ts::persistThreadSpawnEdgesSnapshot` (which
   *      already calls `fsyncPath(this.store.sessionDir)` after the
   *      rename of the thread-spawn-edge snapshot).
   *
   * On failure the tmp file is removed and the live rollout is left
   * intact. Caller is responsible for diagnostic emission (we don't
   * know the semantic meaning of the rewrite here).
   *
   * Exposed as a public method so compaction and migration callers
   * outside this module can route through the same durability dance.
   */
  rewriteRolloutAtomically(bytes: string | Buffer): void {
    if (!this.opened || this.closed) {
      throw new Error("rewriteRolloutAtomically called on unopened store");
    }
    rewriteAtomically(this.rolloutPath, bytes);
    // Reset the in-memory file size + offset index so subsequent
    // appends know the new EOF. Offsets are rebuilt lazily as new
    // events are appended; any caller doing a compaction rewrite is
    // expected to also reset lastSeqWritten if needed.
    this.fileSize = typeof bytes === "string"
      ? Buffer.byteLength(bytes, "utf8")
      : bytes.byteLength;
  }

  /**
   * Re-append the session_meta line to the rollout tail. Called by
   * the AgenC compaction boundary so
   * `--resume` metadata readers that scan the last 16KB of the
   * rollout find the session metadata even after many compacts have
   * pushed the original header out of that window.
   *
   * Port of agenc `sessionStorage.ts::reAppendSessionMetadata`.
   * Idempotent; safe to call multiple times. No-op if no session_meta
   * has been written yet (shouldn't happen post-open).
   *
   * Note on I-24: this is a *tail append*, not a whole-file rewrite,
   * so it correctly uses `writeBytesWithFsync` (O_APPEND + fsync with
   * the I-38 retry path) rather than `rewriteRolloutAtomically()`.
   * Callers that want full-file atomic rewrites (e.g. compaction
   * that drops old rows) should call `rewriteRolloutAtomically()`
   * explicitly.
   */
  reAppendSessionMetadata(): void {
    if (!this.opened || this.closed || !this.lastSessionMeta) return;
    const item: RolloutItem = {
      type: "session_meta",
      payload: this.lastSessionMeta,
    };
    // See #11: writeSync-succeeded-but-fsync-failed leaves the bytes
    // already on disk, so the fsync-retry path enters degraded without
    // re-queueing; only a writeSync throw (bytes never landed) re-queues.
    const routeToDegraded = (err: unknown, requeue: boolean) => {
      if (isDegradedErrno(err)) {
        this.degraded.enterDegraded(
          `${(err as { code?: string }).code} during metadata re-append`,
        );
        if (requeue) this.degraded.append(item);
        return true;
      }
      return false;
    };
    try {
      const line = serializeRolloutItem(item);
      const committed = this.writeBytesWithFsync(line, (err) => {
        routeToDegraded(err, /*requeue*/ false);
      });
      if (!committed) {
        throw new Error("session metadata was not fsync-committed");
      }
      this.fileSize += Buffer.byteLength(line, "utf8");
      this.trajectoryExport.writeItems([item]);
    } catch (err) {
      if (!routeToDegraded(err, /*requeue*/ true)) throw err;
    }
  }

  /**
   * Callback for DegradedStore to attempt re-flush once the disk is
   * available again.
   */
  private async flushDegradedBuffer(
    events: ReadonlyArray<RolloutItem>,
  ): Promise<boolean> {
    try {
      const lines = events.map(serializeRolloutItem).join("");
      let retryFailure: unknown;
      this.writeBytesWithFsync(lines, (err) => {
        retryFailure = err;
      });
      // writeSync succeeded → the bytes are now appended to the rollout
      // file on disk (O_APPEND). Even if the subsequent fsync (+ I-38
      // retry) fails, these items are physically written. Reporting
      // drain success (true) removes them from the degraded buffer so a
      // later retry does NOT re-serialize + re-append the same rows,
      // which would duplicate them in the JSONL (#11). The fsync failure
      // still re-trips degraded mode via the retry callback, but without
      // re-queueing these already-persisted items.
      this.fileSize += Buffer.byteLength(lines, "utf8");
      this.trajectoryExport.writeItems(events);
      // Settle any deferred I-38 fsync retry before returning so the
      // fsync_failed / fsync_retry_succeeded diagnostics are observable
      // to callers (and tests) at the point the drain reports success.
      await this.awaitPendingFsyncRetries();
      void retryFailure;
      return true;
    } catch (err) {
      // writeSync threw — the bytes never reached the file. Keep the
      // items buffered (return false) so they are retried, unless the
      // error is non-degraded (then drop, as before).
      return !isDegradedErrno(err);
    }
  }

  /** I-88: read the per-turn tool-result-bytes index. */
  getToolResultBytes(turnId: string): number {
    return this.toolResultBytesByTurn.get(turnId) ?? 0;
  }

  getToolResultBytesIndexSnapshot(): ReadonlyMap<string, number> {
    return new Map(this.toolResultBytesByTurn);
  }

  getTokenEstimate(turnId: string): number {
    return this.tokenEstimateByTurn.get(turnId) ?? 0;
  }

  getTokenEstimateIndexSnapshot(): ReadonlyMap<string, number> {
    return new Map(this.tokenEstimateByTurn);
  }

  getToolCallTurnIdSnapshot(): ReadonlyMap<string, string> {
    return new Map(this.toolCallTurnIds);
  }

  getCompactionIndexSnapshot(): CompactionIndexSnapshot {
    return {
      toolResultBytesByTurn: this.getToolResultBytesIndexSnapshot(),
      tokenEstimateByTurn: this.getTokenEstimateIndexSnapshot(),
      toolCallTurnIds: this.getToolCallTurnIdSnapshot(),
    };
  }

  get isDegraded(): boolean {
    return this.degraded.isDegraded;
  }

  /** Read the rollout file fully and return the parsed items. */
  readAll(): RolloutItem[] {
    if (!existsSync(this.rolloutPath)) return [];
    const content = readFileSync(this.rolloutPath, "utf8");
    const items: RolloutItem[] = [];
    let malformed = 0;
    for (const line of content.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = parseRolloutLine(line);
        if (parsed) items.push(parsed);
      } catch {
        malformed += 1;
      }
    }
    if (malformed > 0) {
      // Intentional: caller can surface as warning.
    }
    return items;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pending.length > 0) this.flushBatch(true);
    // gaphunt3 #19: final best-effort drain of the degraded ring buffer
    // before stopping its retry timer. If the disk recovered after an
    // I-12/I-38 failure but the 30s retry tick has not yet fired, those
    // buffered durable events (turn_complete, error, context_compacted,
    // response_item) would otherwise be silently dropped on shutdown.
    // Drain + one synchronous append; on persistent failure accept the
    // loss (the disk is genuinely still unavailable).
    if (this.degraded.isDegraded) {
      const remaining = this.degraded.drain();
      if (remaining.length > 0) {
        try {
          const lines = remaining.map(serializeRolloutItem).join("");
          this.writeBytesWithFsync(lines);
          this.fileSize += Buffer.byteLength(lines, "utf8");
          this.trajectoryExport.writeItems(remaining);
        } catch (err) {
          this.emitDiagnostic({
            at: Date.now(),
            level: "error",
            cause: "rollout_degraded",
            message: `${(err as { code?: string }).code ?? "unknown"} during close drain — ${remaining.length} buffered events lost`,
          });
        }
      }
    }
    this.degraded.stop();
    // Write index snapshot atomically (I-24 tmp+rename for the
    // snapshot — the rollout body stays append-only with tail
    // truncation). I-25 says snapshot is advisory; we still emit it
    // as a reconstruction speedup.
    this.writeIndexSnapshot();
    this.trajectoryExport.close();
    this.lock.release();
  }

  /**
   * OOM: FIFO-evict the oldest entries of a monotonic per-session index Map
   * once it grows past {@link MAX_SESSION_INDEX_ENTRIES}. Map iteration is
   * insertion-ordered, so `keys()` yields oldest-first; deleting a batch keeps
   * the recent tail (the entries a `/resume` fast-seek or compaction decision
   * actually needs) and drops cold history. See the constant for why this is
   * safe (advisory index; rollout JSONL is authoritative).
   */
  private boundIndexMap<K, V>(map: Map<K, V>): void {
    if (map.size <= MAX_SESSION_INDEX_ENTRIES) return;
    // Evict down to a low-water mark (not just one fixed batch) so a single
    // bulk flush — `offsetsBySeq` sets one entry per pending event — cannot
    // leave the map above the cap, and so we don't re-trigger on the very next
    // insert. `keys()` is insertion-ordered, so this drops the coldest history.
    const target = MAX_SESSION_INDEX_ENTRIES - SESSION_INDEX_EVICT_BATCH;
    let toRemove = map.size - target;
    for (const key of map.keys()) {
      if (toRemove <= 0) break;
      map.delete(key);
      toRemove -= 1;
    }
  }

  /**
   * I-24 + I-25: write the index.json snapshot atomically.
   *
   * Routes through {@link rewriteAtomically} so the same durability
   * dance (tmp + fsync + rename + parent-dir fsync) covers both the
   * rollout-body rewrite path and the index snapshot path. On failure
   * the tmp is cleaned up and the previous snapshot is left intact;
   * I-25 guarantees rollout JSONL is the source of truth, so a stale
   * or missing snapshot is recoverable.
   */
  private writeIndexSnapshot(): void {
    const snapshot: IndexSnapshot = {
      snapshotSequenceNumber: this.lastSeqWritten,
      fileSize: this.fileSize,
      rolloutPath: this.rolloutPath,
      toolResultBytesByTurn: Object.fromEntries(this.toolResultBytesByTurn),
      tokenEstimateByTurn: Object.fromEntries(this.tokenEstimateByTurn),
      toolCallTurnIds: Object.fromEntries(this.toolCallTurnIds),
      offsetsBySeq: Object.fromEntries(
        Array.from(this.offsetsBySeq.entries()).map(([k, v]) => [String(k), v]),
      ),
      writtenAtMs: Date.now(),
      agencVersion: this.agencVersion,
      schemaVersion: ROLLOUT_SCHEMA_VERSION,
    };
    try {
      rewriteAtomically(this.indexPath, JSON.stringify(snapshot));
    } catch (err) {
      this.emitDiagnostic({
        at: Date.now(),
        level: "warning",
        cause: "snapshot_write_failed",
        message: `index.json snapshot failed: ${(err as { code?: string }).code ?? (err as { message?: string }).message ?? "unknown"}`,
      });
    }
  }

  /** Accessor for the byte-offset index (T12 `/resume` fast-seek). */
  getByteOffsetForSeq(seq: EventSeq): number | undefined {
    return this.offsetsBySeq.get(seq);
  }

  /** Verify read/write permission on the rollout dir. Call early. */
  static assertWritable(
    cwd: string,
    sessionId: string,
    projectRootMarkers: readonly string[] = DEFAULT_SESSION_ROOT_MARKERS,
  ): void {
    const dir = getSessionDir(cwd, sessionId, projectRootMarkers);
    mkdirSync(dir, { recursive: true });
    accessSync(dir, fsConstants.W_OK);
  }
}

/**
 * Periodic 100ms flush scheduler. A SidecarManager installs one per
 * SessionStore so non-durable events don't linger indefinitely when
 * no further emits arrive.
 */
export class SessionStoreFlushScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(
    private readonly store: SessionStore,
    private readonly intervalMs = 100,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try {
        this.store.flushBatch(false);
      } catch {
        /* surfaced via degraded mode */
      }
    }, this.intervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function measureToolResultBytesFromPayload(payload: unknown): number {
  if (typeof payload === "string") {
    return Buffer.byteLength(payload, "utf8");
  }
  try {
    return Buffer.byteLength(JSON.stringify(payload ?? ""), "utf8");
  } catch {
    return 0;
  }
}

function estimateToolResultTokensFromPayload(payload: unknown): number {
  const bytes = measureToolResultBytesFromPayload(payload);
  if (bytes <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(bytes / 4));
}

// ─────────────────────────────────────────────────────────────────────
// Resume picker — enumerate rollout files for the current project.
// ─────────────────────────────────────────────────────────────────────

/**
 * Summary of a single resumable session, surfaced by the TUI session
 * picker.
 *
 * Fields are intentionally minimal: the picker only needs a stable
 * identifier (`sessionId`), a sortable timestamp (`lastModified`), and
 * an optional human-readable summary so a user can pick the right
 * session at a glance.
 */
export interface ResumableSession {
  readonly sessionId: string;
  /** Path to the rollout JSONL file backing this session. */
  readonly rolloutPath: string;
  /** Path to the per-session index.json snapshot, if present. */
  readonly indexPath: string;
  /** Modification time of the rollout file in epoch ms. */
  readonly lastModified: number;
  /** File size of the rollout file in bytes. */
  readonly fileSize: number;
  /**
   * `agencVersion` recorded in the index snapshot (when one is
   * available). Useful for the picker to flag sessions written by an
   * older runtime build.
   */
  readonly agencVersion?: string;
  /**
   * A short human-readable summary to display in the picker. Today this
   * is just the rollout filename; future revisions may surface a
   * derived title once the index snapshot starts persisting one.
   */
  readonly summary: string;
  /** Schema version recorded in the snapshot, when present. */
  readonly schemaVersion?: number;
}

/**
 * Enumerate rollout files under `projectDir` and return one
 * {@link ResumableSession} per session directory. Designed for the
 * resume picker.
 *
 * Layout we walk (mirrors the on-disk layout documented at the top of
 * this file):
 *
 *   <projectDir>/sessions/<sessionId>/rollout-<ts>-<id>.jsonl
 *
 * For each session directory we pick the most recently modified
 * rollout file and synthesize a summary from the index snapshot when
 * available. Sessions that lack any rollout files are silently skipped.
 *
 * Errors reading individual session directories or rollout files are
 * swallowed — a single corrupt session must not break the picker. The
 * returned list is sorted with the most recently modified session
 * first.
 */
export function listResumableSessions(projectDir: string): ResumableSession[] {
  const sessionsDir = join(projectDir, "sessions");
  if (!existsSync(sessionsDir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return [];
  }
  const result: ResumableSession[] = [];
  for (const entry of entries) {
    const sessionDir = join(sessionsDir, entry);
    let stats;
    try {
      stats = statSync(sessionDir);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    let files: string[];
    try {
      files = readdirSync(sessionDir).filter(
        (f) => f.startsWith("rollout-") && f.endsWith(".jsonl"),
      );
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    // Pick the most recently modified rollout in the session dir.
    let pick: { name: string; mtimeMs: number; size: number } | null = null;
    for (const f of files) {
      try {
        const fStat = statSync(join(sessionDir, f));
        if (pick === null || fStat.mtimeMs > pick.mtimeMs) {
          pick = { name: f, mtimeMs: fStat.mtimeMs, size: fStat.size };
        }
      } catch {
        // Skip unreadable files; another rollout in the same session
        // may still be readable.
      }
    }
    if (pick === null) continue;

    const rolloutPath = join(sessionDir, pick.name);
    const indexPath = join(sessionDir, "index.json");
    const snapshot = readIndexSnapshot(indexPath);
    const summary = pick.name;
    const session: ResumableSession = {
      sessionId: entry,
      rolloutPath,
      indexPath,
      lastModified: pick.mtimeMs,
      fileSize: pick.size,
      summary,
      ...(snapshot?.agencVersion ? { agencVersion: snapshot.agencVersion } : {}),
      ...(snapshot?.schemaVersion !== undefined
        ? { schemaVersion: snapshot.schemaVersion }
        : {}),
    };
    result.push(session);
  }
  result.sort((a, b) => b.lastModified - a.lastModified);
  return result;
}
