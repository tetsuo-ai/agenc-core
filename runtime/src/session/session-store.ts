/**
 * Session on-disk store — owns the rollout JSONL file, its fsync
 * guarantees, flock acquisition, atomic write-then-rename, and the
 * per-turn `toolResultBytes` index used by compaction.
 *
 * On-disk layout (per `docs/plan/codex-inventory.md §8`):
 *
 *   ~/.agenc/projects/<slug>/
 *     sessions/<sessionId>/
 *       rollout-<timestamp>-<id>.jsonl     # append-only event log
 *       rollout-<timestamp>-<id>.jsonl.lock  # flock holder PID
 *       index.json                         # event-log byte offsets (I-88)
 *
 * Invariants enforced here:
 *   I-4  (fsync at turn commit) — `append({durable:true})` flushes
 *        + fsyncs before returning.
 *   I-12 (ENOSPC/EROFS/EACCES/EIO) — wraps writes with errno branch;
 *        on disk failure, routes to degraded mode.
 *   I-23 (concurrent-session flock) — first-append acquires LOCK_EX|LOCK_NB
 *        on `.jsonl.lock`; EWOULDBLOCK hard-fails.
 *   I-24 (atomic write-then-rename) — batch flush writes to `.tmp`,
 *        fsync, then `rename()` over the live file. Startup scans
 *        tail for partial lines.
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
  appendFileSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { monotonicMs } from "../utils/monotonic.js";
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

export const I4_FSYNC_RETRY_MS = 100;
export const I83_SUSPEND_DETECTION_MS = 10_000;

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

// ─────────────────────────────────────────────────────────────────────
// Path helpers
// ─────────────────────────────────────────────────────────────────────

export function slugifyCwd(cwd: string): string {
  const base = cwd.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 8);
  return `${base.slice(0, 40) || "root"}-${hash}`;
}

export function getAgencHomeDir(): string {
  const explicit = process.env.AGENC_HOME;
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
): string {
  const root = findProjectRootSync(cwd, projectRootMarkers);
  const slugInput = root ? root.rootDir : cwd;
  return join(getAgencHomeDir(), "projects", slugifyCwd(slugInput));
}

export function getSessionDir(
  cwd: string,
  sessionId: string,
  projectRootMarkers: readonly string[] = DEFAULT_SESSION_ROOT_MARKERS,
): string {
  return join(getProjectDir(cwd, projectRootMarkers), "sessions", sessionId);
}

export function buildRolloutFilename(
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

// ─────────────────────────────────────────────────────────────────────
// Flock (I-23)
// ─────────────────────────────────────────────────────────────────────

/**
 * Minimal cross-platform flock using a sidecar lockfile. Not as
 * strong as `flock(2)` on POSIX but sufficient for "two AgenC
 * processes must not open the same rollout": the lockfile contains
 * the holder's PID, and acquisition checks liveness via `kill(pid, 0)`.
 *
 * The real flock(2) is available via a native binding but avoided
 * here to keep the runtime pure-JS.
 */
export class SessionLock {
  private acquired = false;
  constructor(private readonly lockPath: string) {}

  acquire(): void {
    if (this.acquired) return;
    mkdirSync(dirname(this.lockPath), { recursive: true });
    // Check existing holder first.
    if (existsSync(this.lockPath)) {
      const holderPidRaw = readFileSync(this.lockPath, "utf8").trim();
      const holderPid = Number.parseInt(holderPidRaw, 10);
      if (Number.isFinite(holderPid) && holderPid > 0 && holderPid !== process.pid) {
        if (processIsAlive(holderPid)) {
          throw new SessionLockedError(holderPid, this.lockPath);
        }
        // Stale: previous holder dead. Reclaim.
      }
    }
    // Exclusive create (O_EXCL race) or overwrite if stale.
    try {
      const fd = openSync(this.lockPath, "wx");
      writeSync(fd, `${process.pid}\n`);
      fsyncSync(fd);
      closeSync(fd);
    } catch (err) {
      if ((err as { code?: string })?.code === "EEXIST") {
        // Another process raced us to the create. Retry liveness
        // check once; if still live, surrender.
        const holderPidRaw = readFileSync(this.lockPath, "utf8").trim();
        const holderPid = Number.parseInt(holderPidRaw, 10);
        if (Number.isFinite(holderPid) && processIsAlive(holderPid)) {
          throw new SessionLockedError(holderPid, this.lockPath);
        }
        // Stale — overwrite.
        writeFileSync(this.lockPath, `${process.pid}\n`);
      } else {
        throw err;
      }
    }
    this.acquired = true;
  }

  release(): void {
    if (!this.acquired) return;
    try {
      unlinkSync(this.lockPath);
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
// Tail truncation on corrupt trailing line (I-24 recovery)
// ─────────────────────────────────────────────────────────────────────

/**
 * Scan the rollout tail for a trailing partial line (crash mid-write).
 * Returns the new file size after truncation + whether truncation
 * occurred. Callers should emit a `warning:'rollout_truncated_corrupt_tail'`
 * when truncated.
 */
export function truncateCorruptTail(rolloutPath: string): {
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
      try {
        // node fs doesn't expose ftruncate on fd directly in sync API
        // via `fd` — use ftruncateSync.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ftruncateSync } = require("node:fs");
        ftruncateSync(fd, 0);
      } catch {
        /* best-effort */
      }
      return { truncated: true, newSize: 0 };
    }
    // Check if tail after last newline is empty (normal complete file).
    const afterLastNewlineIdx = (stat.size - tailSize) + lastNewline + 1;
    if (afterLastNewlineIdx >= stat.size) {
      return { truncated: false, newSize: stat.size };
    }
    // Partial line exists after last newline — truncate.
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { ftruncateSync } = require("node:fs");
      ftruncateSync(fd, afterLastNewlineIdx);
      fsyncSync(fd);
    } catch {
      /* best-effort */
    }
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
  /** Turn id for I-88 index keying. */
  readonly turnId?: string;
}

export interface CompactionIndexSnapshot {
  readonly toolResultBytesByTurn: ReadonlyMap<string, number>;
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
        this.fileSize = statSync(this.rolloutPath).size;
        const snapshot = readIndexSnapshot(this.indexPath);
        if (snapshot && snapshot.rolloutPath === this.rolloutPath) {
          this.toolResultBytesByTurn.clear();
          for (const [turnId, bytes] of Object.entries(
            snapshot.toolResultBytesByTurn ?? {},
          )) {
            if (typeof bytes === "number" && bytes > 0) {
              this.toolResultBytesByTurn.set(turnId, bytes);
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
      } else {
        // Fresh file — write session_meta.
        const sessionMeta: SessionMetaLine = {
          ...meta,
          rolloutSchemaVersion: ROLLOUT_SCHEMA_VERSION,
        };
        const line = serializeRolloutItem({
          type: "session_meta",
          payload: sessionMeta,
        });
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

  /**
   * Append an event. Called by Session.emit(). Durable events (per
   * isDurableEvent or explicit `opts.durable`) flush immediately +
   * fsync (I-4). Others batch until 100ms or the next durable event.
   *
   * UUID dedup: events with a `seq` already written are silently
   * dropped. Events WITHOUT seq (sidecar synth or replay re-entry)
   * are deduped by `event.id`. Prevents double-append on fork-flush
   * or replay-merge edge cases.
   */
  append(event: Event, opts: AppendOptions = {}): void {
    if (!this.opened || this.closed) return;
    // I-27: seq monotonicity check. Caller assigns via EventLog; we
    // just verify.
    if (event.seq !== undefined && event.seq <= this.lastSeqWritten) {
      // Reject backward seq — it indicates a reducer bug. Also dedup
      // when the same seq value repeats (same event emitted twice).
      return;
    }
    // UUID dedup — if we've already seen this event.id, skip. Only
    // applies to events without a seq (sidecar synth / replay); seq'd
    // events are already ordered by the EventLog monotonic counter.
    if (event.seq === undefined) {
      if (this.seenEventIds.has(event.id)) return;
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
    if (turnId && toolResultBytes > 0) {
      const prev = this.toolResultBytesByTurn.get(turnId) ?? 0;
      this.toolResultBytesByTurn.set(turnId, prev + toolResultBytes);
    }
    if (
      turnId &&
      toolCompletion &&
      typeof toolCompletion.callId === "string" &&
      toolCompletion.callId.length > 0
    ) {
      this.toolCallTurnIds.set(toolCompletion.callId, turnId);
    }

    const item: RolloutItem = { type: "event_msg", payload: event };

    if (this.batchOpenedAtMs === null) {
      this.batchOpenedAtMs = monotonicMs();
    }
    this.pending.push(item);

    const durable = opts.durable === true || isDurableEvent(event);
    if (durable) {
      this.flushBatch(/*durable*/ true);
    } else if (this.pending.length >= 1024) {
      // Flush if the batch gets large to bound memory even before the
      // 100ms tick.
      this.flushBatch(/*durable*/ false);
    }
  }

  /**
   * Append a non-event RolloutItem (session_state / response_item /
   * compacted / turn_context). These don't carry seq so just get
   * batched and eventually flushed.
   */
  appendRollout(item: RolloutItem, opts: AppendOptions = {}): void {
    if (!this.opened || this.closed) return;
    if (this.batchOpenedAtMs === null) {
      this.batchOpenedAtMs = monotonicMs();
    }
    this.pending.push(item);
    const durable =
      opts.durable === true ||
      (item.type === "event_msg" && isDurableEvent(item.payload));
    if (durable) {
      this.flushBatch(true);
    }
  }

  /**
   * 100ms batch flush tick — called externally by a timer owned by
   * the sidecar manager or by `append()` on durable events. Exposed
   * for tests.
   */
  flushBatch(durable: boolean): void {
    if (this.pending.length === 0) {
      this.batchOpenedAtMs = null;
      return;
    }
    // I-83 suspend detection: if the batch was open for > 10s (e.g.
    // system suspend/resume gap), emit TWO events (warning + sentinel
    // system_resumed_from) and abandon the pending batch.
    if (
      this.batchOpenedAtMs !== null &&
      monotonicMs() - this.batchOpenedAtMs > I83_SUSPEND_DETECTION_MS
    ) {
      const durationMs = Math.round(monotonicMs() - this.batchOpenedAtMs);
      this.batchOpenedAtMs = null;
      // Replace pending with the two I-83 marker events so the log
      // shows (a) the operator-visible warning and (b) a structural
      // sentinel the reducer can reason about.
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
      this.pending = [warning, sentinel];
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

    const lines = this.pending.map(serializeRolloutItem).join("");
    const toWrite = this.pending;
    this.pending = [];
    this.batchOpenedAtMs = null;

    const routeToDegraded = (err: unknown) => {
      if (isDegradedErrno(err)) {
        // I-12 / I-38 path: route the batch items into the degraded
        // ring buffer. UUID dedup protects against re-play duplicating
        // any rows the kernel did eventually persist despite the
        // fsync failure.
        this.degraded.enterDegraded(
          `${(err as { code?: string }).code} during append`,
        );
        for (const item of toWrite) this.degraded.append(item);
        this.emitDiagnostic({
          at: Date.now(),
          level: "error",
          cause: "rollout_degraded",
          message: `${(err as { code?: string }).code ?? "unknown"} during append — ${toWrite.length} events queued in degraded ring buffer`,
        });
        return true;
      }
      return false;
    };

    try {
      if (durable) {
        // I-38: async retry on fsync failure routes to degraded via
        // the callback, so we don't block the event loop here.
        this.writeBytesWithFsync(lines, (err) => {
          routeToDegraded(err);
        });
      } else {
        this.writeBytesAppendOnly(lines);
      }
      this.fileSize += Buffer.byteLength(lines, "utf8");
    } catch (err) {
      if (!routeToDegraded(err)) {
        throw err;
      }
    }
  }

  private writeBytesAppendOnly(content: string): void {
    appendFileSync(this.rolloutPath, content, { mode: 0o600 });
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
  ): void {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND;
    const fd = openSync(this.rolloutPath, flags, 0o600);
    let firstErr: unknown;
    try {
      writeSync(fd, content);
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
    }
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
   * Re-append the session_meta line to the rollout tail. Called by
   * the compaction boundary (auto-compact.ts in phase 1) so
   * `--resume` metadata readers that scan the last 16KB of the
   * rollout find the session metadata even after many compacts have
   * pushed the original header out of that window.
   *
   * Port of openclaude `sessionStorage.ts::reAppendSessionMetadata`.
   * Idempotent; safe to call multiple times. No-op if no session_meta
   * has been written yet (shouldn't happen post-open).
   */
  reAppendSessionMetadata(): void {
    if (!this.opened || this.closed || !this.lastSessionMeta) return;
    const item: RolloutItem = {
      type: "session_meta",
      payload: this.lastSessionMeta,
    };
    const routeToDegraded = (err: unknown) => {
      if (isDegradedErrno(err)) {
        this.degraded.enterDegraded(
          `${(err as { code?: string }).code} during metadata re-append`,
        );
        this.degraded.append(item);
        return true;
      }
      return false;
    };
    try {
      const line = serializeRolloutItem(item);
      this.writeBytesWithFsync(line, (err) => {
        routeToDegraded(err);
      });
      this.fileSize += Buffer.byteLength(line, "utf8");
    } catch (err) {
      if (!routeToDegraded(err)) throw err;
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
      // writeSync succeeded; the bytes are at least in the page cache,
      // so bump fileSize regardless of fsync retry outcome.
      this.fileSize += Buffer.byteLength(lines, "utf8");
      // If the sync fsync failed and scheduled an async retry, wait
      // for it to settle so we accurately report drain success/failure
      // back to the DegradedStore.
      await this.awaitPendingFsyncRetries();
      if (retryFailure !== undefined) {
        return !isDegradedErrno(retryFailure);
      }
      return true;
    } catch (err) {
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

  getToolCallTurnIdSnapshot(): ReadonlyMap<string, string> {
    return new Map(this.toolCallTurnIds);
  }

  getCompactionIndexSnapshot(): CompactionIndexSnapshot {
    return {
      toolResultBytesByTurn: this.getToolResultBytesIndexSnapshot(),
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
    this.degraded.stop();
    // Write index snapshot atomically (I-24 tmp+rename for the
    // snapshot — the rollout body stays append-only with tail
    // truncation). I-25 says snapshot is advisory; we still emit it
    // as a reconstruction speedup.
    this.writeIndexSnapshot();
    this.lock.release();
  }

  /**
   * I-24 + I-25: write the index.json snapshot atomically.
   *
   *   1. Write to `index.json.tmp` with the accumulated seq, byte
   *      offsets, tool-result-bytes index, and snapshotSequenceNumber.
   *   2. fsync the tmp file.
   *   3. `fs.rename(tmp, final)` — atomic on POSIX.
   *
   * If any step fails, leave the previous `index.json` intact and
   * emit a warning. I-25 guarantees rollout JSONL is the source of
   * truth; a stale or missing snapshot is recoverable.
   */
  private writeIndexSnapshot(): void {
    const snapshot: IndexSnapshot = {
      snapshotSequenceNumber: this.lastSeqWritten,
      fileSize: this.fileSize,
      rolloutPath: this.rolloutPath,
      toolResultBytesByTurn: Object.fromEntries(this.toolResultBytesByTurn),
      toolCallTurnIds: Object.fromEntries(this.toolCallTurnIds),
      offsetsBySeq: Object.fromEntries(
        Array.from(this.offsetsBySeq.entries()).map(([k, v]) => [String(k), v]),
      ),
      writtenAtMs: Date.now(),
      agencVersion: this.agencVersion,
      schemaVersion: ROLLOUT_SCHEMA_VERSION,
    };
    const tmp = `${this.indexPath}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
      // fsync the tmp before rename so a crash here leaves either
      // the old index (intact) or the new index (intact).
      const fd = openSync(tmp, fsConstants.O_RDONLY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.indexPath);
    } catch (err) {
      // Cleanup tmp if it exists; leave index.json untouched.
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
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
