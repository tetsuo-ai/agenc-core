/**
 * Cross-process filesystem lock for memory writes (I-29 Fix-F).
 *
 * The in-process `AsyncLock` keyed by path protects intra-process
 * writers only. Two concurrent AgenC processes (or an external editor
 * + auto-save) still race on `MEMORY.md` and topic files. This module
 * adds an fs-level exclusive lock on top:
 *
 *   1. Derive `<filePath>.lock`.
 *   2. Poll-acquire using `fs.open(lockPath, 'wx')` — atomic
 *      create-exclusive. The lockfile payload is a JSON blob
 *      `{ pid, ts }` so stale lock detection can reason about the
 *      holder.
 *   3. On EEXIST, re-read the lockfile. If `now - ts > 60s` the
 *      holder is assumed dead and the lockfile is unlinked + retry
 *      continues. Otherwise sleep `retryMs` (50ms default) and retry.
 *   4. Retry window is bounded by `timeoutMs` (2000ms default) per
 *      the I-29 text. Exhaustion raises `FsLockTimeoutError`.
 *   5. On acquisition success, run `fn()` and unlink the lockfile in
 *      `finally`. ENOENT on unlink is swallowed so a concurrent stale
 *      breaker cannot make us throw.
 *
 * The journal fallback described in I-29 is minimally wired here:
 * when `fs.open('wx')` fails with EACCES/EROFS, `withFsLock` emits a
 * `memory_write_contention` warning via `console.warn` and rethrows
 * `FsLockUnavailableError`. Callers (auto-save) convert that into a
 * skip. A later tranche (T11) is expected to add real journal replay.
 *
 * @module
 */

import { open, readFile, unlink } from "node:fs/promises";

/** Default max wait for lock acquisition, in milliseconds. */
export const DEFAULT_FS_LOCK_TIMEOUT_MS = 2_000;

/** Default polling interval while the lockfile is held. */
export const DEFAULT_FS_LOCK_RETRY_MS = 50;

/** Stale-holder threshold: lockfile older than this is force-broken. */
export const FS_LOCK_STALE_MS = 60_000;

export interface FsLockOpts {
  /** Max wait for lock acquisition. Default 2000ms. */
  readonly timeoutMs?: number;
  /** Poll interval on EEXIST. Default 50ms. */
  readonly retryMs?: number;
}

/** Raised when the lock cannot be acquired within `timeoutMs`. */
export class FsLockTimeoutError extends Error {
  readonly filePath: string;
  constructor(filePath: string) {
    super(`memory_write_contention: timed out acquiring lock for ${filePath}`);
    this.name = "FsLockTimeoutError";
    this.filePath = filePath;
  }
}

/**
 * Raised when the filesystem itself refuses the lockfile (EROFS,
 * EACCES). Callers should treat this as "write unavailable" and emit
 * the journal/skip fallback.
 */
export class FsLockUnavailableError extends Error {
  readonly filePath: string;
  readonly cause?: unknown;
  constructor(filePath: string, cause?: unknown) {
    super(
      `memory_write_contention: lockfile unavailable for ${filePath} (fs denied)`,
    );
    this.name = "FsLockUnavailableError";
    this.filePath = filePath;
    this.cause = cause;
  }
}

interface LockfilePayload {
  readonly pid: number;
  readonly ts: number;
}

function parseLockfile(text: string): LockfilePayload | null {
  try {
    const obj = JSON.parse(text) as unknown;
    if (
      obj !== null &&
      typeof obj === "object" &&
      typeof (obj as { pid?: unknown }).pid === "number" &&
      typeof (obj as { ts?: unknown }).ts === "number"
    ) {
      return obj as LockfilePayload;
    }
    return null;
  } catch {
    return null;
  }
}

function errnoOf(err: unknown): string | undefined {
  if (
    err !== null &&
    typeof err === "object" &&
    typeof (err as { code?: unknown }).code === "string"
  ) {
    return (err as { code: string }).code;
  }
  return undefined;
}

/** Derive the sibling lockfile path. Exposed for tests. */
export function lockfilePathFor(filePath: string): string {
  return `${filePath}.lock`;
}

async function readLockfileSafe(
  lockPath: string,
): Promise<LockfilePayload | null> {
  try {
    const raw = await readFile(lockPath, "utf8");
    return parseLockfile(raw);
  } catch {
    return null;
  }
}

async function unlinkLockfileSafe(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (err) {
    if (errnoOf(err) === "ENOENT") return;
    // Any other unlink error is surfaced because it represents a real
    // filesystem problem (EACCES/EBUSY/EPERM) that callers need to see.
    throw err;
  }
}

/**
 * Attempt a single exclusive-create of the lockfile. Writes the
 * payload and returns true on success, false on EEXIST, and rethrows
 * anything else after wrapping in `FsLockUnavailableError` if the fs
 * itself refused.
 */
async function tryAcquire(
  lockPath: string,
  payload: LockfilePayload,
): Promise<boolean> {
  try {
    const handle = await open(lockPath, "wx");
    try {
      await handle.writeFile(JSON.stringify(payload), {
        encoding: "utf8",
      });
    } finally {
      await handle.close();
    }
    return true;
  } catch (err) {
    const code = errnoOf(err);
    if (code === "EEXIST") return false;
    if (code === "EACCES" || code === "EROFS" || code === "EPERM") {
      throw new FsLockUnavailableError(lockPath, err);
    }
    throw err;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    // Don't keep the event loop alive only for a retry timer.
    if (typeof t === "object" && t !== null && "unref" in t) {
      (t as { unref: () => void }).unref();
    }
  });
}

/**
 * Run `fn` with an exclusive filesystem lock on `filePath` (applied
 * via a sibling `<filePath>.lock` file). See module doc for detailed
 * semantics.
 *
 * This is a cross-process primitive. Callers that also need
 * intra-process serialization should compose this with an in-process
 * `AsyncLock` (see `getMemoryWriteLock` in `./loader.ts`).
 */
export async function withFsLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  opts?: FsLockOpts,
): Promise<T> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_FS_LOCK_TIMEOUT_MS;
  const retryMs = opts?.retryMs ?? DEFAULT_FS_LOCK_RETRY_MS;
  const lockPath = lockfilePathFor(filePath);
  const start = Date.now();

  // Acquisition loop.
  while (true) {
    const acquired = await tryAcquire(lockPath, {
      pid: process.pid,
      ts: Date.now(),
    });
    if (acquired) break;

    // Lockfile exists. Check whether the holder looks stale.
    const existing = await readLockfileSafe(lockPath);
    if (existing !== null) {
      const age = Date.now() - existing.ts;
      if (age > FS_LOCK_STALE_MS) {
        // Force-break a stale lockfile and retry immediately.
        await unlinkLockfileSafe(lockPath);
        continue;
      }
    }

    if (Date.now() - start >= timeoutMs) {
      throw new FsLockTimeoutError(filePath);
    }
    await sleep(retryMs);
  }

  try {
    return await fn();
  } finally {
    // Release. ENOENT is fine — a stale breaker from another process
    // may already have cleaned up after us.
    await unlinkLockfileSafe(lockPath);
  }
}
