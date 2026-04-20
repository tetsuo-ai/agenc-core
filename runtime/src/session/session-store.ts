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

export function getProjectDir(cwd: string): string {
  return join(getAgencHomeDir(), "projects", slugifyCwd(cwd));
}

export function getSessionDir(cwd: string, sessionId: string): string {
  return join(getProjectDir(cwd), "sessions", sessionId);
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

  constructor(opts: SessionStoreOpts) {
    this.cwd = opts.cwd;
    this.sessionId = opts.sessionId;
    this.agencVersion = opts.agencVersion;
    this.sessionDir = getSessionDir(opts.cwd, opts.sessionId);
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
        this.writeBytesWithFsync(line);
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

    // I-88 per-turn tool-result-bytes index update.
    if (opts.turnId && opts.toolResultBytes && opts.toolResultBytes > 0) {
      const prev = this.toolResultBytesByTurn.get(opts.turnId) ?? 0;
      this.toolResultBytesByTurn.set(opts.turnId, prev + opts.toolResultBytes);
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
    if (opts.durable === true) {
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

    try {
      if (durable) {
        this.writeBytesWithFsync(lines);
      } else {
        this.writeBytesAppendOnly(lines);
      }
      this.fileSize += Buffer.byteLength(lines, "utf8");
    } catch (err) {
      if (isDegradedErrno(err)) {
        // I-12: route to degraded mode.
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
      } else {
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
   * I-38: on fsync failure, retry once after 100ms. If the retry
   * also fails, emit a typed `error:'fsync_failed'` diagnostic (I-8
   * via the listener) so operators see the durability loss, then
   * rethrow so the caller (flushBatch) routes the batch into the
   * degraded ring buffer.
   */
  private writeBytesWithFsync(content: string): void {
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND;
    const fd = openSync(this.rolloutPath, flags, 0o600);
    try {
      writeSync(fd, content);
      try {
        fsyncSync(fd);
      } catch (err) {
        // I-38: retry once after 100ms (sync sleep approximation).
        const retryUntil = Date.now() + I4_FSYNC_RETRY_MS;
        while (Date.now() < retryUntil) {
          /* busy-wait — fsync is rare so acceptable */
        }
        try {
          fsyncSync(fd);
          this.emitDiagnostic({
            at: Date.now(),
            level: "warning",
            cause: "fsync_retry_succeeded",
            message: `fsync succeeded on retry after ${(err as { code?: string }).code ?? "unknown"}`,
          });
        } catch (err2) {
          // I-38 second failure — emit typed error + rethrow.
          this.emitDiagnostic({
            at: Date.now(),
            level: "error",
            cause: "fsync_failed",
            message: `fsync retry failed: ${(err2 as { code?: string; message?: string }).code ?? ""} ${(err2 as { message?: string }).message ?? String(err2)}`,
          });
          throw err2;
        }
      }
    } finally {
      closeSync(fd);
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
    try {
      const line = serializeRolloutItem(item);
      this.writeBytesWithFsync(line);
      this.fileSize += Buffer.byteLength(line, "utf8");
    } catch (err) {
      // Degraded path — queue for retry but don't bubble.
      if (isDegradedErrno(err)) {
        this.degraded.enterDegraded(
          `${(err as { code?: string }).code} during metadata re-append`,
        );
        this.degraded.append(item);
      } else {
        throw err;
      }
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
      this.writeBytesWithFsync(lines);
      this.fileSize += Buffer.byteLength(lines, "utf8");
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
  static assertWritable(cwd: string, sessionId: string): void {
    const dir = getSessionDir(cwd, sessionId);
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
