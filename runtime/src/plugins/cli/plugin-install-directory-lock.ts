import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isRecord } from "../../utils/record.js";

const PLUGIN_INSTALL_OPS_DIR = ".plugin-install-ops";
const DIRECTORY_LOCK_POLL_MS = 20;
const MAX_LOCK_BYTES = 4096;
const RECLAIM_GUARD_SUFFIX = ".reclaim";
const DEFAULT_RECLAIM_GUARD_STALE_MS = 60_000;
const MAX_RECLAIM_KEY_DEPTH = 4;
const RECLAIM_KEY_HASH = /^[0-9a-f]{64}$/u;

// This lock does not provide unconditional mutual exclusion.
//
// Publish writes a finished owner record into a unique temp file and link()s
// it onto the lock path. The canonical path is therefore never a live
// holder's half-written file. Empty, partial, symlink, directory, FIFO, and
// other non-owner entries are not deleted: after the reclaim guard confirms
// the same entry is still there, acquisition throws and leaves it for manual
// recovery. An unexpected directory is never removed.
//
// Release unlinks only after two reads of this process's owner bytes, and
// drops the nonce only after a later read shows those bytes are gone. A
// failed unlink keeps the nonce, and release() can be retried. Overlapping
// release attempts run one at a time. acquiredAtMs is not a lock timeout;
// age never expires a live owner. A read error is not proof that an owner
// is dead.
//
// Removal. The bytes of a dead guard or dead removal key name one key,
// `<lock>.reclaim-<sha256>`. Only the process that link-publishes that key
// may remove the file, and it does so only while it still holds the key.
// Removal renames the entry to a private claim, reads that claim through one
// fd, and unlinks the claim only when the bytes and dev/ino are the ones
// judged dead. Any other captured inode is linked back onto its path. If that
// link finds a file already there, that file has not been confirmed while the
// removal lease is held: it is renamed aside and unlinked, and the captured
// inode is linked back. A file that lands after the dead inode is unlinked is
// left in place; its publisher confirms only after the lease is gone. The
// dead install lock is removed the same way by the single holder of
// `<lock>.reclaim`, which is the removal lease for that lock. A publisher
// believes it holds a path only after a later read shows its own bytes and
// dev/ino and no live removal lease for that path. A try-lock that sees a
// lease drops its unconfirmed file and reports busy. A blocking acquire keeps
// the file and polls until the lease is gone.
//
// Residuals:
// - Young dead guard or young dead removal key. try-lock reports the
//   directory busy, so recovery skips it, and a blocking acquire polls until
//   the file is 60s old.
// - More than 4 nested dead removal keys. Reclaim reports busy and leaves them.
// - Foreign pid reuse. A dead owner's pid can belong to an unrelated live
//   process. The lock or guard looks live until that process exits.
// - Other pid namespace. kill(pid, 0) only sees this namespace. A holder in
//   another namespace can look dead, and EPERM is treated as live.
// - Same-async-context re-entry. A nested call on the same key runs the body
//   without taking another lock.
// - Path key. realpath of an existing destination and realpath(parent)+basename
//   of a missing final component can name two locks for one directory.
// - Uninstall holds this lock only around removing the install directory.
//   Config, data, and catalog cleanup run after the lock is released.
// - A non-participant can unlink a lock, or replace a tree, between a check
//   and a removal.
// - link fails closed on filesystems without hard links (FAT, exFAT, some
//   SMB). Windows was not run.
const heldDirectoryLockNonces = new Set<string>();
const heldGuardNonces = new Set<string>();
const lockContext = new AsyncLocalStorage<ReadonlySet<string>>();

let directoryLockWaitHook: (() => void | Promise<void>) | undefined;
let reclaimGuardStaleMs = DEFAULT_RECLAIM_GUARD_STALE_MS;

export class PluginInstallDirectoryLockCorruptError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`plugin install directory lock requires manual recovery: ${path}`);
    this.name = "PluginInstallDirectoryLockCorruptError";
    this.path = path;
  }
}

/** Body already finished. The lock file may still be held by this process. */
export class PluginInstallDirectoryLockReleaseError extends Error {
  readonly operationCompleted: true;

  constructor(cause: unknown) {
    super(
      `plugin install directory lock cleanup failed after the locked operation completed: ${errorMessage(cause)}`,
      { cause },
    );
    this.name = "PluginInstallDirectoryLockReleaseError";
    this.operationCompleted = true;
  }
}

export type PluginInstallDirectoryLockReclaimPhase = "stale-observed" | "reclaim-settled";

export interface PluginInstallDirectoryLockGuardRemoveEvent {
  readonly guardPath: string;
  readonly seenText: string;
}

export interface PluginInstallDirectoryLockLockRemoveEvent {
  readonly lockPath: string;
  readonly seenText: string;
}

export interface PluginInstallDirectoryLockReclaimEvent {
  readonly phase: PluginInstallDirectoryLockReclaimPhase;
  readonly lockDir: string;
  readonly seenText: string;
}

export type PluginInstallDirectoryLockPublishPhase = "staging-ready" | "before-release-remove";

export interface PluginInstallDirectoryLockPublishEvent {
  readonly phase: PluginInstallDirectoryLockPublishPhase;
  readonly lockDir: string;
}

let reclaimHook: ((event: PluginInstallDirectoryLockReclaimEvent) => Promise<void>) | undefined;
let beforeGuardRemoveHook:
  ((event: PluginInstallDirectoryLockGuardRemoveEvent) => Promise<void>) | undefined;
let beforeLockRemoveHook:
  ((event: PluginInstallDirectoryLockLockRemoveEvent) => Promise<void>) | undefined;
let publishHook: ((event: PluginInstallDirectoryLockPublishEvent) => Promise<void>) | undefined;

export interface PluginInstallDirectoryLock {
  release(): Promise<void>;
}

interface OwnerRecord {
  readonly pid: number;
  readonly nonce?: string;
  readonly acquiredAtMs?: number;
}

type ExistingLockAction = "retry" | "busy" | "wait";
type ReclaimOutcome = "removed" | "busy" | "changed";
type GuardInspection = "absent" | "busy" | "reclaimable" | "corrupt";
type LockStat = Awaited<ReturnType<typeof lstat>>;
interface EntryIdentity {
  readonly text: string;
  readonly dev: LockStat["dev"];
  readonly ino: LockStat["ino"];
}

type LockPathClass =
  | { readonly kind: "lock"; readonly lockPath: string }
  | { readonly kind: "guard"; readonly lockPath: string }
  | { readonly kind: "key"; readonly lockPath: string }
  | { readonly kind: "other" };

type LockRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable" }
  | {
    readonly kind: "bytes";
    readonly text: string;
    readonly dev: LockStat["dev"];
    readonly ino: LockStat["ino"];
    readonly mtimeMs: number;
  };

/** Fires when a blocking acquire sees a live holder and is about to wait. */
export function setPluginInstallDirectoryLockWaitHook(
  hook: (() => void | Promise<void>) | undefined,
): void {
  directoryLockWaitHook = hook;
}

/** Test seam. Production leaves this unset. */
export function setPluginInstallDirectoryLockReclaimHook(
  hook: ((event: PluginInstallDirectoryLockReclaimEvent) => Promise<void>) | undefined,
): void {
  reclaimHook = hook;
}

/**
 * Test seam. Runs after the removal-key holder has re-read the dead guard
 * and before it renames that guard aside. Production leaves this unset.
 */
export function setPluginInstallDirectoryLockBeforeGuardRemoveHook(
  hook: ((event: PluginInstallDirectoryLockGuardRemoveEvent) => Promise<void>) | undefined,
): void {
  beforeGuardRemoveHook = hook;
}

/**
 * Test seam. Runs after a reclaim guard holder has re-read the dead install
 * lock and before that lock is claimed. Production leaves this unset.
 */
export function setPluginInstallDirectoryLockBeforeLockRemoveHook(
  hook: ((event: PluginInstallDirectoryLockLockRemoveEvent) => Promise<void>) | undefined,
): void {
  beforeLockRemoveHook = hook;
}

/**
 * Test seam. `staging-ready` runs after the temp file is durable and before
 * link. `before-release-remove` runs while this process still holds the nonce
 * and the lock bytes are still ours, before unlink.
 */
export function setPluginInstallDirectoryLockPublishHook(
  hook: ((event: PluginInstallDirectoryLockPublishEvent) => Promise<void>) | undefined,
): void {
  publishHook = hook;
}

/** Test seam for the crashed-guard age bound. `undefined` restores 60s. */
export function setPluginInstallDirectoryLockGuardStaleMs(ms: number | undefined): void {
  if (ms !== undefined && (!Number.isFinite(ms) || ms < 0)) {
    throw new Error("plugin install directory lock guard bound must be a non-negative finite number");
  }
  reclaimGuardStaleMs = ms ?? DEFAULT_RECLAIM_GUARD_STALE_MS;
}

export async function pluginInstallDirectoryLockDirectory(destination: string): Promise<string> {
  return lockFilePath(await pluginInstallDirectoryLockKey(destination));
}

export async function withPluginInstallDirectoryLock<T>(
  destination: string,
  body: () => Promise<T>,
): Promise<T> {
  const key = await pluginInstallDirectoryLockKey(destination);
  const current = lockContext.getStore();
  if (current?.has(key) === true) return body();
  const hold = await acquire(key, true);
  const next = new Set(current);
  next.add(key);
  let bodyResult!: T;
  let bodyError: unknown;
  let bodyOk = false;
  try {
    bodyResult = await lockContext.run(next, body);
    bodyOk = true;
  } catch (error) {
    bodyError = error;
  }
  try {
    await hold.release();
  } catch (cleanupError) {
    if (!bodyOk) throw bodyError;
    throw new PluginInstallDirectoryLockReleaseError(cleanupError);
  }
  if (!bodyOk) throw bodyError;
  return bodyResult;
}

/** One attempt. A live holder, including this process, is busy: callers skip. */
export async function tryPluginInstallDirectoryLock(
  destination: string,
): Promise<PluginInstallDirectoryLock | undefined> {
  return acquire(await pluginInstallDirectoryLockKey(destination), false);
}

async function acquire(key: string, block: true): Promise<PluginInstallDirectoryLock>;
async function acquire(key: string, block: false): Promise<PluginInstallDirectoryLock | undefined>;
async function acquire(key: string, block: boolean): Promise<PluginInstallDirectoryLock | undefined> {
  for (let attempt = 0; block || attempt < 3; attempt += 1) {
    const lockPath = await prepareLockFile(key);
    const created = await holdLinkedFile(lockPath, heldDirectoryLockNonces, block, async () => {
      await emitPublish({ phase: "staging-ready", lockDir: lockPath });
    }, async () => {
      await emitPublish({ phase: "before-release-remove", lockDir: lockPath });
    });
    if (created !== undefined) return created;
    const action = await classifyExisting(lockPath, block);
    switch (action) {
      case "retry":
        continue;
      case "busy":
      case "wait":
        if (!block) return undefined;
        await directoryLockWaitHook?.();
        await delay(DIRECTORY_LOCK_POLL_MS);
        continue;
      default: {
        const exhaustive: never = action;
        throw new Error(`unhandled install directory lock action: ${String(exhaustive)}`);
      }
    }
  }
  return undefined;
}

async function classifyExisting(lockPath: string, block: boolean): Promise<ExistingLockAction> {
  const info = await lstatIfPresent(lockPath);
  if (info === undefined) return "retry";
  if (info.isSymbolicLink() || !info.isFile()) {
    return rejectUnownedEntry(lockPath, info, undefined, block);
  }
  const read = await readLockBytes(lockPath);
  switch (read.kind) {
    case "absent":
      return "retry";
    case "unreadable":
      return rejectUnownedEntry(lockPath, info, undefined, block);
    case "bytes": {
      const parsed = parseOwner(read.text);
      if (parsed === undefined) return rejectUnownedEntry(lockPath, info, read.text, block);
      if (holderIsLive(parsed, heldDirectoryLockNonces)) return "busy";
      const outcome = await reclaimStaleLock(lockPath, read.text, block);
      return outcome === "removed" ? "retry" : "wait";
    }
    default: {
      const exhaustive: never = read;
      throw new Error(`unhandled lock read: ${String(exhaustive)}`);
    }
  }
}

async function holdLinkedFile(
  path: string,
  nonces: Set<string>,
  block: boolean,
  beforeLink?: () => Promise<void>,
  beforeUnlink?: () => Promise<void>,
): Promise<PluginInstallDirectoryLock | undefined> {
  const nonce = randomUUID();
  const body = ownerText(process.pid, nonce, Date.now());
  nonces.add(nonce);
  let published = false;
  try {
    const linked = await linkNewFile(path, body, tempPath(path, nonce), beforeLink);
    if (!linked.linked) return undefined;
    let confirmed = false;
    try {
      confirmed = await confirmOrCleanup(path, body, linked.dev, linked.ino, block);
    } catch (error) {
      await unlinkOwned(path, body).catch(ignoreMissing);
      throw error;
    }
    if (!confirmed) return undefined;
    published = true;
    let released = false;
    let tail: Promise<void> = Promise.resolve();
    return {
      async release(): Promise<void> {
        const attempt = tail.then(async () => {
          if (released) return;
          await unlinkOwned(path, body, beforeUnlink);
          const after = await readLockBytes(path);
          switch (after.kind) {
            case "absent":
              break;
            case "unreadable":
              throw new Error(`plugin install directory lock release could not confirm removal: ${path}`);
            case "bytes":
              if (after.text === body) {
                throw new Error(`plugin install directory lock still present after release: ${path}`);
              }
              break;
            default: {
              const exhaustive: never = after;
              throw new Error(`unhandled lock read: ${String(exhaustive)}`);
            }
          }
          nonces.delete(nonce);
          released = true;
        });
        tail = attempt.then(() => undefined, () => undefined);
        await attempt;
      },
    };
  } finally {
    if (!published) nonces.delete(nonce);
  }
}

async function linkNewFile(
  target: string,
  body: string,
  temp: string,
  beforeLink?: () => Promise<void>,
): Promise<
  | { readonly linked: false }
  | { readonly linked: true; readonly dev: LockStat["dev"]; readonly ino: LockStat["ino"] }
> {
  let created = false;
  try {
    const handle = await open(temp, "wx", 0o600);
    created = true;
    let identity: { readonly dev: LockStat["dev"]; readonly ino: LockStat["ino"] } | undefined;
    try {
      await handle.writeFile(body);
      await handle.sync().catch((error: unknown) => {
        const code = codeOf(error);
        if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EISDIR" && code !== "EBADF") throw error;
      });
      const info = await handle.stat();
      identity = { dev: info.dev, ino: info.ino };
    } finally {
      await handle.close();
    }
    if (identity === undefined) return { linked: false };
    await beforeLink?.();
    await link(temp, target);
    return { linked: true, dev: identity.dev, ino: identity.ino };
  } catch (error) {
    if (codeOf(error) === "EEXIST" || codeOf(error) === "ENOENT") return { linked: false };
    throw error;
  } finally {
    if (created) await unlink(temp).catch(ignoreMissing);
  }
}

async function unlinkOwned(path: string, body: string, beforeUnlink?: () => Promise<void>): Promise<void> {
  const first = await readLockBytes(path);
  if (first.kind !== "bytes" || first.text !== body) return;
  await beforeUnlink?.();
  const second = await readLockBytes(path);
  if (second.kind !== "bytes" || second.text !== body) return;
  await unlink(path).catch(ignoreMissing);
}

async function reclaimStaleLock(
  lockPath: string,
  seenText: string,
  block: boolean,
): Promise<ReclaimOutcome> {
  return withReclaimGuard(
    lockPath,
    seenText,
    block,
    () => removeStaleLockIfUnchanged(lockPath, seenText),
  );
}

async function rejectUnownedEntry(
  lockPath: string,
  seen: LockStat,
  seenText: string | undefined,
  block: boolean,
): Promise<ExistingLockAction> {
  const outcome = await withReclaimGuard(lockPath, seenText ?? "", block, () =>
    confirmUnownedUnchanged(lockPath, seen, seenText));
  switch (outcome) {
    case "removed":
      return "retry";
    case "changed":
    case "busy":
      return "wait";
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unhandled install directory lock reclaim outcome: ${String(exhaustive)}`);
    }
  }
}

async function withReclaimGuard(
  lockPath: string,
  seenText: string,
  block: boolean,
  remove: () => Promise<ReclaimOutcome>,
): Promise<ReclaimOutcome> {
  await reclaimHook?.({ phase: "stale-observed", lockDir: lockPath, seenText });
  const guard = await acquireReclaimGuard(lockPath, block);
  if (guard === "busy") {
    await reclaimHook?.({ phase: "reclaim-settled", lockDir: lockPath, seenText });
    return "busy";
  }
  let outcome: ReclaimOutcome;
  try {
    outcome = await remove();
  } finally {
    await guard.release();
  }
  await reclaimHook?.({ phase: "reclaim-settled", lockDir: lockPath, seenText });
  return outcome;
}

async function confirmUnownedUnchanged(
  lockPath: string,
  seen: LockStat,
  seenText: string | undefined,
): Promise<ReclaimOutcome> {
  for (let check = 0; check < 2; check += 1) {
    const current = await lstatIfPresent(lockPath);
    if (current === undefined) return "removed";
    if (!sameIdentity(current, seen) || !sameEntryKind(current, seen)) return "changed";
    if (current.isSymbolicLink() || !current.isFile()) continue;
    const read = await readLockBytes(lockPath);
    switch (read.kind) {
      case "absent":
        return "removed";
      case "unreadable":
        if (seenText !== undefined) return "changed";
        break;
      case "bytes":
        if (read.text !== seenText) return "changed";
        break;
      default: {
        const exhaustive: never = read;
        throw new Error(`unhandled lock read: ${String(exhaustive)}`);
      }
    }
  }
  throw new PluginInstallDirectoryLockCorruptError(lockPath);
}

async function removeStaleLockIfUnchanged(lockPath: string, seenText: string): Promise<ReclaimOutcome> {
  let expected: EntryIdentity | undefined;
  for (let check = 0; check < 2; check += 1) {
    const read = await readLockBytes(lockPath);
    switch (read.kind) {
      case "absent":
        return "removed";
      case "unreadable":
        return "changed";
      case "bytes":
        if (read.text !== seenText || holderIsLive(parseOwner(read.text), heldDirectoryLockNonces)) {
          return "changed";
        }
        if (expected !== undefined && !sameCaptured(read, expected)) return "changed";
        expected = { text: read.text, dev: read.dev, ino: read.ino };
        break;
      default: {
        const exhaustive: never = read;
        throw new Error(`unhandled lock read: ${String(exhaustive)}`);
      }
    }
  }
  if (expected === undefined) return "changed";
  await beforeLockRemoveHook?.({ lockPath, seenText });
  const after = await readLockBytes(lockPath);
  if (after.kind === "absent") return "removed";
  if (after.kind !== "bytes" || !sameCaptured(after, expected)) return "changed";
  if (holderIsLive(parseOwner(after.text), heldDirectoryLockNonces)) return "changed";
  return await claimAndRemove(lockPath, expected) ? "removed" : "changed";
}

async function acquireReclaimGuard(
  lockPath: string,
  block: boolean,
): Promise<PluginInstallDirectoryLock | "busy"> {
  const guardPath = `${lockPath}${RECLAIM_GUARD_SUFFIX}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = await holdLinkedFile(guardPath, heldGuardNonces, block);
    if (created !== undefined) return created;
    const state = await inspectGuard(guardPath);
    switch (state) {
      case "absent":
        continue;
      case "reclaimable":
        if (!await removeStaleGuard(lockPath, guardPath, block)) return "busy";
        continue;
      case "busy":
        return "busy";
      case "corrupt":
        throw new PluginInstallDirectoryLockCorruptError(guardPath);
      default: {
        const exhaustive: never = state;
        throw new Error(`unhandled install directory lock guard state: ${String(exhaustive)}`);
      }
    }
  }
  return "busy";
}

async function inspectGuard(guardPath: string): Promise<GuardInspection> {
  const info = await lstatIfPresent(guardPath);
  if (info === undefined) return "absent";
  if (info.isSymbolicLink() || !info.isFile()) return "corrupt";
  const read = await readLockBytes(guardPath);
  switch (read.kind) {
    case "absent":
      return "absent";
    case "unreadable":
      return "corrupt";
    case "bytes":
      return guardRecordState(read.text, read.mtimeMs);
    default: {
      const exhaustive: never = read;
      throw new Error(`unhandled lock read: ${String(exhaustive)}`);
    }
  }
}

async function removeStaleGuard(lockPath: string, guardPath: string, block: boolean): Promise<boolean> {
  const seen = await readDeadEntry(guardPath);
  return seen !== undefined && removeDeadEntry(lockPath, guardPath, seen, 0, block);
}

/** Removes `path` only while this process holds the key named by its bytes. */
async function removeDeadEntry(
  lockPath: string,
  path: string,
  seen: EntryIdentity,
  depth: number,
  block: boolean,
): Promise<boolean> {
  const keyPath = reclaimKeyPath(lockPath, seen.text);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const key = await holdLinkedFile(keyPath, heldGuardNonces, block);
    if (key !== undefined) return removeUnderKey(lockPath, key, path, seen);
    const blocker = await inspectGuard(keyPath);
    switch (blocker) {
      case "absent":
        continue;
      case "busy":
        return false;
      case "corrupt":
        throw new PluginInstallDirectoryLockCorruptError(keyPath);
      case "reclaimable":
        if (depth >= MAX_RECLAIM_KEY_DEPTH || !await removeDeadKey(lockPath, keyPath, depth, block)) {
          return false;
        }
        continue;
      default: {
        const exhaustive: never = blocker;
        throw new Error(`unhandled install directory lock guard state: ${String(exhaustive)}`);
      }
    }
  }
  return false;
}

async function removeDeadKey(
  lockPath: string,
  keyPath: string,
  depth: number,
  block: boolean,
): Promise<boolean> {
  const seen = await readDeadEntry(keyPath);
  return seen !== undefined && removeDeadEntry(lockPath, keyPath, seen, depth + 1, block);
}

async function removeUnderKey(
  lockPath: string,
  key: PluginInstallDirectoryLock,
  path: string,
  seen: EntryIdentity,
): Promise<boolean> {
  let removed = false;
  try {
    removed = await removeSeenEntry(lockPath, path, seen);
  } finally {
    await key.release();
  }
  return removed;
}

async function removeSeenEntry(lockPath: string, path: string, seen: EntryIdentity): Promise<boolean> {
  const read = await readLockBytes(path);
  if (read.kind === "absent") return true;
  if (read.kind !== "bytes" || !sameCaptured(read, seen)) return false;
  if (path === `${lockPath}${RECLAIM_GUARD_SUFFIX}`) {
    await beforeGuardRemoveHook?.({ guardPath: path, seenText: seen.text });
    const after = await readLockBytes(path);
    if (after.kind === "absent") return true;
    if (after.kind !== "bytes" || !sameCaptured(after, seen)) return false;
  }
  return claimAndRemove(path, seen);
}

/**
 * Renames `path` to a private name, then reads that file through one fd.
 * The claim is unlinked only when it is `expected`. Any other captured inode
 * is linked back. An entry that landed on `path` in the meantime is not a
 * confirmed hold while the caller still owns the removal lease: it is moved
 * aside and unlinked so the captured inode is the only canonical name.
 */
async function claimAndRemove(path: string, expected: EntryIdentity): Promise<boolean> {
  const claim = `${path}.claim-${randomUUID()}`;
  try {
    await rename(path, claim);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return true;
    throw error;
  }
  const got = await readLockBytes(claim);
  if (got.kind === "bytes" && sameCaptured(got, expected)) {
    await unlink(claim).catch(ignoreMissing);
    return true;
  }
  await restoreClaim(path, claim);
  return false;
}

async function restoreClaim(path: string, claim: string): Promise<void> {
  for (;;) {
    try {
      await link(claim, path);
      await unlink(claim).catch(ignoreMissing);
      return;
    } catch (error) {
      if (codeOf(error) !== "EEXIST") throw error;
    }
    const intruder = `${path}.claim-${randomUUID()}`;
    try {
      await rename(path, intruder);
    } catch (error) {
      if (codeOf(error) === "ENOENT") continue;
      throw error;
    }
    await unlink(intruder).catch(ignoreMissing);
  }
}

async function readDeadEntry(path: string): Promise<EntryIdentity | undefined> {
  const read = await readLockBytes(path);
  if (read.kind !== "bytes" || guardRecordState(read.text, read.mtimeMs) !== "reclaimable") return undefined;
  return { text: read.text, dev: read.dev, ino: read.ino };
}

function reclaimKeyPath(lockPath: string, text: string): string {
  return `${lockPath}${RECLAIM_GUARD_SUFFIX}-${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function sameCaptured(got: EntryIdentity, expected: EntryIdentity): boolean {
  return got.text === expected.text && got.dev === expected.dev && got.ino === expected.ino;
}

function guardRecordState(text: string, mtimeMs: number): GuardInspection {
  const parsed = parseOwner(text);
  if (parsed === undefined) return "corrupt";
  if (holderIsLive(parsed, heldGuardNonces)) return "busy";
  const recordedAt = parsed.acquiredAtMs ?? mtimeMs;
  return Date.now() - recordedAt >= reclaimGuardStaleMs ? "reclaimable" : "busy";
}

async function emitPublish(event: PluginInstallDirectoryLockPublishEvent): Promise<void> {
  await publishHook?.(event);
}

function epochMs(mtimeMs: number | bigint): number {
  return typeof mtimeMs === "bigint" ? Number(mtimeMs) : mtimeMs;
}

function ownerText(pid: number, nonce: string, acquiredAtMs: number): string {
  return `${JSON.stringify({ pid, nonce, acquiredAtMs })}\n`;
}

function tempPath(target: string, nonce: string): string {
  return `${target}.tmp-${process.pid}-${nonce}`;
}

async function confirmOrCleanup(
  path: string,
  body: string,
  dev: LockStat["dev"],
  ino: LockStat["ino"],
  block: boolean,
): Promise<boolean> {
  const identity: EntryIdentity = { text: body, dev, ino };
  for (;;) {
    if (await publicationConfirmed(path, identity)) return true;
    if (await removalLeaseBlocks(path, body)) {
      if (!block) {
        await unlinkOwned(path, body);
        return false;
      }
      if (!(await canonicalMatches(path, identity))) return false;
      await delay(DIRECTORY_LOCK_POLL_MS);
      continue;
    }
    if (await canonicalMatches(path, identity)) {
      await delay(DIRECTORY_LOCK_POLL_MS);
      continue;
    }
    return false;
  }
}

async function publicationConfirmed(path: string, identity: EntryIdentity): Promise<boolean> {
  if (!(await canonicalMatches(path, identity))) return false;
  if (await removalLeaseBlocks(path, identity.text)) return false;
  return canonicalMatches(path, identity);
}

async function canonicalMatches(path: string, identity: EntryIdentity): Promise<boolean> {
  const read = await readLockBytes(path);
  return read.kind === "bytes" && sameCaptured(read, identity);
}

async function removalLeaseBlocks(path: string, body: string): Promise<boolean> {
  const classified = classifyLockPath(path);
  switch (classified.kind) {
    case "lock":
      return (await inspectGuard(`${path}${RECLAIM_GUARD_SUFFIX}`)) === "busy";
    case "guard":
      return liveReclaimKeyBlocks(classified.lockPath);
    case "key":
      return keyRemovalBlocks(classified.lockPath, path, body);
    case "other":
      return false;
    default: {
      const exhaustive: never = classified;
      throw new Error(`unhandled lock path class: ${String(exhaustive)}`);
    }
  }
}

function classifyLockPath(path: string): LockPathClass {
  const key = /^(.*\.lock)\.reclaim-([0-9a-f]{64})$/u.exec(path);
  if (key?.[1] !== undefined && key[2] !== undefined && RECLAIM_KEY_HASH.test(key[2])) {
    return { kind: "key", lockPath: key[1] };
  }
  const guard = /^(.*\.lock)\.reclaim$/u.exec(path);
  if (guard?.[1] !== undefined) return { kind: "guard", lockPath: guard[1] };
  if (path.endsWith(".lock")) return { kind: "lock", lockPath: path };
  return { kind: "other" };
}

async function keyRemovalBlocks(lockPath: string, path: string, body: string): Promise<boolean> {
  const remover = reclaimKeyPath(lockPath, body);
  if (remover === path) return false;
  return (await inspectGuard(remover)) === "busy";
}

async function liveReclaimKeyBlocks(lockPath: string): Promise<boolean> {
  const dir = dirname(lockPath);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
  const prefix = `${basename(lockPath)}${RECLAIM_GUARD_SUFFIX}-`;
  for (const name of names) {
    if (!name.startsWith(prefix) || !RECLAIM_KEY_HASH.test(name.slice(prefix.length))) continue;
    if ((await inspectGuard(join(dir, name))) === "busy") return true;
  }
  return false;
}

async function readLockBytes(path: string): Promise<LockRead> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // win32 has no O_NOFOLLOW. O_NONBLOCK is absent there too; where it exists
    // it keeps a FIFO swapped in after lstat from blocking in open.
    const follow = constants.O_NOFOLLOW ?? 0;
    const nonblock = constants.O_NONBLOCK ?? 0;
    handle = await open(path, constants.O_RDONLY | follow | nonblock);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_LOCK_BYTES) return { kind: "unreadable" };
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    return {
      kind: "bytes",
      text: buffer.toString("utf8"),
      dev: info.dev,
      ino: info.ino,
      mtimeMs: epochMs(info.mtimeMs),
    };
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return { kind: "absent" };
    if (
      code === "ELOOP"
      || code === "EISDIR"
      || code === "ENOTDIR"
      || code === "ENXIO"
      || code === "EAGAIN"
    ) return { kind: "unreadable" };
    throw error;
  } finally {
    await handle?.close();
  }
}

function parseOwner(text: string | undefined): OwnerRecord | undefined {
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || !Number.isInteger(raw.pid) || (raw.pid as number) < 1) return undefined;
  const nonce = typeof raw.nonce === "string" && raw.nonce !== "" ? raw.nonce : undefined;
  const acquiredAtMs = typeof raw.acquiredAtMs === "number" && Number.isFinite(raw.acquiredAtMs)
    ? raw.acquiredAtMs
    : undefined;
  return {
    pid: raw.pid as number,
    ...(nonce === undefined ? {} : { nonce }),
    ...(acquiredAtMs === undefined ? {} : { acquiredAtMs }),
  };
}

function holderIsLive(parsed: OwnerRecord | undefined, nonces: ReadonlySet<string>): boolean {
  if (parsed === undefined) return false;
  if (parsed.pid === process.pid) return parsed.nonce !== undefined && nonces.has(parsed.nonce);
  return pidIsLive(parsed.pid);
}

function pidIsLive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) === "EPERM";
  }
}

function sameIdentity(current: LockStat, seen: LockStat): boolean {
  return current.dev === seen.dev && current.ino === seen.ino;
}

function sameEntryKind(current: LockStat, seen: LockStat): boolean {
  return current.isSymbolicLink() === seen.isSymbolicLink()
    && current.isFile() === seen.isFile()
    && current.isDirectory() === seen.isDirectory()
    && current.isFIFO() === seen.isFIFO()
    && current.isSocket() === seen.isSocket()
    && current.isBlockDevice() === seen.isBlockDevice()
    && current.isCharacterDevice() === seen.isCharacterDevice();
}

async function lstatIfPresent(path: string): Promise<LockStat | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return undefined;
    throw error;
  }
}

async function pluginInstallDirectoryLockKey(destination: string): Promise<string> {
  const resolved = resolve(destination);
  try {
    return await realpath(resolved);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
    let parent = dirname(resolved);
    try {
      parent = await realpath(parent);
    } catch (parentError) {
      if (codeOf(parentError) !== "ENOENT") throw parentError;
    }
    return join(parent, basename(resolved));
  }
}

function lockFilePath(key: string): string {
  const digest = createHash("sha256").update(key, "utf8").digest("hex");
  return join(dirname(key), PLUGIN_INSTALL_OPS_DIR, `install-dir-${digest}.lock`);
}

async function prepareLockFile(key: string): Promise<string> {
  const opsDir = join(dirname(key), PLUGIN_INSTALL_OPS_DIR);
  await mkdir(opsDir, { recursive: true, mode: 0o700 });
  const info = await lstat(opsDir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`plugin install directory lock cannot use ${opsDir}`);
  }
  return lockFilePath(key);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function ignoreMissing(error: unknown): void {
  if (codeOf(error) !== "ENOENT") throw error;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}
