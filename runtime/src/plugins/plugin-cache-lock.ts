import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import { getErrnoCode, isENOENT } from "../utils/errors.js";
import { isRecord } from "../utils/record.js";

/** Heartbeat validity. Covers the 120s plugin process/download budget plus slack. */
export const PLUGIN_CACHE_LOCK_LEASE_TTL_MS = 150_000;
/** How long a waiter polls before giving up. Independent of lease duration. */
export const PLUGIN_CACHE_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const PLUGIN_CACHE_LOCK_HEARTBEAT_INTERVAL_MS = 30_000;
const PLUGIN_CACHE_LOCK_INCOMPLETE_GRACE_MS = 1_000;
const PLUGIN_CACHE_LOCK_POLL_INTERVAL_MS = 100;

const OWNER_FILE_PREFIX = "owner.";
const OWNER_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;

export interface PluginCacheLockHooks {
  readonly nowMs?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly createOwnerToken?: () => string;
  readonly pid?: number;
  readonly isProcessAlive?: (pid: number) => boolean;
  readonly leaseTtlMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly pollIntervalMs?: number;
  readonly incompleteGraceMs?: number;
  /** Test seam: runs inside lease persistence, before the owner file is written. */
  readonly beforeWriteLease?: () => Promise<void>;
}

export interface PluginCacheLockHandle {
  readonly ownerToken: string;
  refresh(): Promise<void>;
  release(): Promise<void>;
}

interface LockIdentity {
  readonly dev: number;
  readonly ino: number;
}

interface OwnerLease {
  readonly fileName: string;
  readonly ownerToken: string;
  readonly pid: number;
  readonly heartbeatAtMs: number;
}

interface ResolvedLockHooks {
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly createOwnerToken: () => string;
  readonly pid: number;
  readonly isProcessAlive: (pid: number) => boolean;
  readonly leaseTtlMs: number;
  readonly acquireTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly pollIntervalMs: number;
  readonly incompleteGraceMs: number;
  readonly beforeWriteLease?: () => Promise<void>;
}

export function pluginCacheLockDirectory(cacheRoot: string): string {
  return `${cacheRoot}.lock`;
}

export async function withPluginCacheLock<T>(
  cacheRoot: string,
  fn: () => Promise<T>,
  hooks: PluginCacheLockHooks = {},
): Promise<T> {
  const resolved = resolveHooks(hooks);
  const lock = await acquirePluginCacheLock(cacheRoot, hooks);
  const timer = setInterval(() => {
    void lock.refresh().catch((error: unknown) => {
      noteHeartbeatFailure(error);
    });
  }, resolved.heartbeatIntervalMs);
  timer.unref();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    await lock.release();
  }
}

export async function acquirePluginCacheLock(
  cacheRoot: string,
  hooks: PluginCacheLockHooks = {},
): Promise<PluginCacheLockHandle> {
  const resolved = resolveHooks(hooks);
  const lockDir = pluginCacheLockDirectory(cacheRoot);
  const ownerToken = assertSafeOwnerToken(resolved.createOwnerToken());
  const startedAt = resolved.nowMs();
  await mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });

  for (;;) {
    const handle = await tryAcquire(lockDir, ownerToken, resolved);
    if (handle !== undefined) return handle;
    await reclaimExpiredOwners(lockDir, resolved);
    const retried = await tryAcquire(lockDir, ownerToken, resolved);
    if (retried !== undefined) return retried;
    if (resolved.nowMs() - startedAt >= resolved.acquireTimeoutMs) {
      throw await lockWaitError(cacheRoot, lockDir);
    }
    await resolved.sleep(resolved.pollIntervalMs);
  }
}

function resolveHooks(hooks: PluginCacheLockHooks): ResolvedLockHooks {
  return {
    nowMs: hooks.nowMs ?? Date.now,
    sleep: hooks.sleep ?? defaultSleep,
    createOwnerToken: hooks.createOwnerToken ?? randomUUID,
    pid: hooks.pid ?? process.pid,
    isProcessAlive: hooks.isProcessAlive ?? defaultIsProcessAlive,
    leaseTtlMs: hooks.leaseTtlMs ?? PLUGIN_CACHE_LOCK_LEASE_TTL_MS,
    acquireTimeoutMs: hooks.acquireTimeoutMs ?? PLUGIN_CACHE_LOCK_ACQUIRE_TIMEOUT_MS,
    heartbeatIntervalMs: hooks.heartbeatIntervalMs ?? PLUGIN_CACHE_LOCK_HEARTBEAT_INTERVAL_MS,
    pollIntervalMs: hooks.pollIntervalMs ?? PLUGIN_CACHE_LOCK_POLL_INTERVAL_MS,
    incompleteGraceMs: hooks.incompleteGraceMs ?? PLUGIN_CACHE_LOCK_INCOMPLETE_GRACE_MS,
    beforeWriteLease: hooks.beforeWriteLease,
  };
}

function noteHeartbeatFailure(error: unknown): void {
  // A failed heartbeat must not reject the daemon. The lease stays at its last
  // successful write. A live pid is not reclaimed when the heartbeat goes stale.
  const detail = error instanceof Error ? error.message : "unknown heartbeat failure";
  console.error(`plugin cache lock heartbeat failed: ${detail}`);
}

async function lockWaitError(cacheRoot: string, lockDir: string): Promise<Error> {
  const entries = await readLockEntries(lockDir);
  if (entries !== undefined && entries.length > 0) {
    return new Error(
      `timed out waiting for plugin cache lock: ${cacheRoot}. The lock directory ${lockDir} still holds an entry that was not reclaimed; remove it manually if the owner is gone.`,
    );
  }
  return new Error(`timed out waiting for plugin cache lock: ${cacheRoot}`);
}

async function tryAcquire(
  lockDir: string,
  ownerToken: string,
  hooks: ResolvedLockHooks,
): Promise<PluginCacheLockHandle | undefined> {
  const identity = await tryCreateLockDir(lockDir);
  if (identity === undefined) return undefined;
  try {
    await writeOwnerLease(lockDir, {
      ownerToken,
      pid: hooks.pid,
      heartbeatAtMs: hooks.nowMs(),
    }, hooks);
  } catch (error) {
    await unlink(ownerFilePath(lockDir, ownerToken)).catch(() => {});
    await rmdir(lockDir).catch(() => {});
    if (isENOENT(error)) return undefined;
    throw error;
  }
  if (!await leaseIsExclusive(lockDir, ownerToken, identity)) {
    await unlink(ownerFilePath(lockDir, ownerToken)).catch(() => {});
    return undefined;
  }
  return createHandle(lockDir, ownerToken, identity, hooks);
}

function createHandle(
  lockDir: string,
  ownerToken: string,
  identity: LockIdentity,
  hooks: ResolvedLockHooks,
): PluginCacheLockHandle {
  let refreshTail: Promise<void> = Promise.resolve();
  let released = false;

  const persistRefresh = async (): Promise<void> => {
    if (released) return;
    if (!await lockIdentityMatches(lockDir, identity)) return;
    if (!await ownerFileExists(lockDir, ownerToken)) return;
    if (released) return;
    await writeOwnerLease(lockDir, {
      ownerToken,
      pid: hooks.pid,
      heartbeatAtMs: hooks.nowMs(),
    }, hooks);
    if (released || !await lockIdentityMatches(lockDir, identity)) {
      await unlink(ownerFilePath(lockDir, ownerToken)).catch(() => {});
    }
  };

  return {
    ownerToken,
    refresh: () => {
      const continueRefresh = (): Promise<void> | undefined => (
        released ? undefined : persistRefresh()
      );
      const run = refreshTail.then(continueRefresh, continueRefresh);
      refreshTail = run.then(() => undefined, () => undefined);
      return run;
    },
    release: async () => {
      released = true;
      await refreshTail;
      if (!await lockIdentityMatches(lockDir, identity)) return;
      await unlink(ownerFilePath(lockDir, ownerToken)).catch(() => {});
      await rmdir(lockDir).catch(() => {});
    },
  };
}

async function tryCreateLockDir(lockDir: string): Promise<LockIdentity | undefined> {
  try {
    await mkdir(lockDir, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (getErrnoCode(error) !== "EEXIST") throw error;
    return undefined;
  }
  return readLockIdentity(lockDir);
}

async function leaseIsExclusive(
  lockDir: string,
  ownerToken: string,
  identity: LockIdentity,
): Promise<boolean> {
  if (!await lockIdentityMatches(lockDir, identity)) return false;
  const entries = await readLockEntries(lockDir);
  if (entries === undefined) return false;
  const ownFile = `${OWNER_FILE_PREFIX}${ownerToken}`;
  const competing = entries.some((entry) => entry !== ownFile && !entry.endsWith(".tmp"));
  return !competing && await lockIdentityMatches(lockDir, identity);
}

async function reclaimExpiredOwners(
  lockDir: string,
  hooks: ResolvedLockHooks,
): Promise<void> {
  if (!await isRealLockDirectory(lockDir)) return;
  const entries = await readLockEntries(lockDir);
  if (entries === undefined) return;
  if (entries.length === 0) {
    await reclaimIncompleteLockDir(lockDir, hooks);
    return;
  }

  const now = hooks.nowMs();
  for (const entry of entries) {
    if (entry.endsWith(".tmp")) {
      if (await deadOwnerTempIsStale(lockDir, entry, now, hooks)) {
        await unlinkLockEntry(lockDir, entry);
      }
      continue;
    }
    let info;
    try {
      info = await lstat(join(lockDir, entry));
    } catch {
      continue;
    }
    if (!info.isFile()) continue;
    let lease: OwnerLease | undefined;
    try {
      lease = await readOwnerLease(lockDir, entry);
    } catch {
      continue;
    }
    if (lease === undefined || !ownerLeaseIsReclaimable(lease, now, hooks)) continue;
    let current: OwnerLease | undefined;
    try {
      current = await readOwnerLease(lockDir, lease.fileName);
    } catch {
      continue;
    }
    if (current === undefined || !ownerLeaseIsReclaimable(current, hooks.nowMs(), hooks)) continue;
    await unlinkLockEntry(lockDir, current.fileName);
  }
  if (!await isRealLockDirectory(lockDir)) return;
  await rmdir(lockDir).catch(() => {});
}

async function unlinkLockEntry(lockDir: string, name: string): Promise<void> {
  if (!await isRealLockDirectory(lockDir)) return;
  await unlink(join(lockDir, name)).catch(() => {});
}

async function isRealLockDirectory(lockDir: string): Promise<boolean> {
  try {
    const info = await lstat(lockDir);
    return info.isDirectory();
  } catch (error) {
    if (isENOENT(error)) return false;
    throw error;
  }
}

async function reclaimIncompleteLockDir(
  lockDir: string,
  hooks: ResolvedLockHooks,
): Promise<void> {
  let lockStat;
  try {
    lockStat = await lstat(lockDir);
  } catch (error) {
    if (isENOENT(error)) return;
    throw error;
  }
  if (!lockStat.isDirectory()) return;
  if (hooks.nowMs() - lockStat.mtimeMs < hooks.incompleteGraceMs) return;
  await rmdir(lockDir).catch(() => {});
}

function pidIsDefinitelyDead(pid: number, hooks: ResolvedLockHooks): boolean {
  return isLockOwnerPid(pid) && !hooks.isProcessAlive(pid);
}

function ownerLeaseIsReclaimable(
  lease: OwnerLease,
  nowMs: number,
  hooks: ResolvedLockHooks,
): boolean {
  return pidIsDefinitelyDead(lease.pid, hooks) &&
    nowMs - lease.heartbeatAtMs >= hooks.leaseTtlMs;
}

async function deadOwnerTempIsStale(
  lockDir: string,
  fileName: string,
  nowMs: number,
  hooks: ResolvedLockHooks,
): Promise<boolean> {
  const pid = pidFromOwnerTemp(fileName);
  if (pid === undefined || !pidIsDefinitelyDead(pid, hooks)) return false;
  return await fileAgeMs(lockDir, fileName, nowMs) >= hooks.leaseTtlMs;
}

function pidFromOwnerTemp(fileName: string): number | undefined {
  const match = /^owner\.(.+)\.(\d+)\.tmp$/u.exec(fileName);
  if (match === null || !OWNER_TOKEN_PATTERN.test(match[1] ?? "")) return undefined;
  const pid = Number(match[2]);
  return isLockOwnerPid(pid) ? pid : undefined;
}

function isLockOwnerPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0;
}

async function writeOwnerLease(
  lockDir: string,
  lease: Pick<OwnerLease, "ownerToken" | "pid" | "heartbeatAtMs">,
  hooks: ResolvedLockHooks,
): Promise<void> {
  await hooks.beforeWriteLease?.();
  const dest = ownerFilePath(lockDir, lease.ownerToken);
  const temp = `${dest}.${lease.pid}.tmp`;
  const body = `${JSON.stringify({
    ownerToken: lease.ownerToken,
    pid: lease.pid,
    heartbeatAtMs: lease.heartbeatAtMs,
  })}\n`;
  try {
    await writeFile(temp, body, { mode: 0o600 });
    await rename(temp, dest);
  } catch (error) {
    await unlink(temp).catch(() => {});
    throw error;
  }
}

async function readOwnerLease(
  lockDir: string,
  fileName: string,
): Promise<OwnerLease | undefined> {
  const ownerToken = ownerTokenFromFileName(fileName);
  if (ownerToken === undefined) return undefined;
  let raw: string;
  try {
    raw = await readFile(join(lockDir, fileName), "utf8");
  } catch (error) {
    if (isENOENT(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (parsed.ownerToken !== ownerToken) return undefined;
  if (!isLockOwnerPid(parsed.pid as number)) return undefined;
  if (!Number.isInteger(parsed.heartbeatAtMs)) return undefined;
  return {
    fileName,
    ownerToken,
    pid: parsed.pid as number,
    heartbeatAtMs: parsed.heartbeatAtMs as number,
  };
}

function ownerTokenFromFileName(fileName: string): string | undefined {
  if (!fileName.startsWith(OWNER_FILE_PREFIX)) return undefined;
  const ownerToken = fileName.slice(OWNER_FILE_PREFIX.length);
  return OWNER_TOKEN_PATTERN.test(ownerToken) ? ownerToken : undefined;
}

function ownerFilePath(lockDir: string, ownerToken: string): string {
  return join(lockDir, `${OWNER_FILE_PREFIX}${ownerToken}`);
}

function assertSafeOwnerToken(ownerToken: string): string {
  if (!OWNER_TOKEN_PATTERN.test(ownerToken)) {
    throw new Error("plugin cache lock owner token must be a filesystem-safe identifier");
  }
  return ownerToken;
}

async function ownerFileExists(lockDir: string, ownerToken: string): Promise<boolean> {
  try {
    await lstat(ownerFilePath(lockDir, ownerToken));
    return true;
  } catch (error) {
    if (isENOENT(error)) return false;
    throw error;
  }
}

async function readLockEntries(lockDir: string): Promise<string[] | undefined> {
  try {
    return await readdir(lockDir);
  } catch (error) {
    if (isENOENT(error)) return undefined;
    throw error;
  }
}

async function readLockIdentity(lockDir: string): Promise<LockIdentity | undefined> {
  try {
    const lockStat = await lstat(lockDir);
    if (!lockStat.isDirectory()) return undefined;
    return { dev: lockStat.dev, ino: lockStat.ino };
  } catch (error) {
    if (isENOENT(error)) return undefined;
    throw error;
  }
}

async function lockIdentityMatches(
  lockDir: string,
  identity: LockIdentity,
): Promise<boolean> {
  const current = await readLockIdentity(lockDir);
  return current !== undefined && current.dev === identity.dev && current.ino === identity.ino;
}

async function fileAgeMs(lockDir: string, fileName: string, nowMs: number): Promise<number> {
  try {
    const fileStat = await lstat(join(lockDir, fileName));
    return nowMs - fileStat.mtimeMs;
  } catch (error) {
    if (isENOENT(error)) return Number.POSITIVE_INFINITY;
    throw error;
  }
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!isLockOwnerPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrnoCode(error) !== "ESRCH";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
