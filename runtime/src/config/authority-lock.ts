import { mkdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import * as lockfile from "../utils/lockfile.js";

const LOCK_SUFFIX = ".agenc-config-authority.lock";

const LOCK_OPTIONS = Object.freeze({
  realpath: false,
  stale: 30_000,
  retries: Object.freeze({
    retries: 20,
    factor: 1.35,
    minTimeout: 10,
    maxTimeout: 250,
    randomize: true,
  }),
});

/**
 * proper-lockfile's synchronous API cannot retry. Without a wait here, a
 * synchronous reader fails with ELOCKED ("Lock file is already being held")
 * whenever another process holds the lock for its own read or atomic write,
 * for example a daemon that is still shutting down or a CLI command. Such a
 * holder releases within milliseconds, so the caller sleeps in short steps up
 * to this budget, the same order as the asynchronous retry policy above.
 */
const SYNC_LOCK_WAIT_MS = 2_000;
const SYNC_LOCK_FIRST_RETRY_MS = 5;
const SYNC_LOCK_MAX_RETRY_MS = 100;

/**
 * Targets this process is acquiring or holding right now, with a count per
 * target. A holder in this process can only release once the current
 * synchronous call returns, so a synchronous caller that finds the lock held
 * here fails at once, as before, instead of sleeping on its own event loop.
 */
const heldInThisProcess = new Map<string, number>();

function noteHeldInThisProcess(target: string): () => void {
  heldInThisProcess.set(target, (heldInThisProcess.get(target) ?? 0) + 1);
  let noted = true;
  return () => {
    if (!noted) return;
    noted = false;
    const remaining = (heldInThisProcess.get(target) ?? 1) - 1;
    if (remaining > 0) heldInThisProcess.set(target, remaining);
    else heldInThisProcess.delete(target);
  };
}

const SYNC_SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(SYNC_SLEEP_CELL, 0, 0, ms);
}

function isHeldLockError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === "ELOCKED"
  );
}

export interface ConfigAuthoritySyncLockOptions {
  /** How long to wait for a holder in another process. Tests shorten it. */
  readonly waitMs?: number;
}

/**
 * Acquire one target synchronously. A holder in another process is waited
 * for, up to the budget; a holder in this process, or a lock still held when
 * the budget runs out, fails with the ELOCKED error proper-lockfile raised.
 */
function acquireConfigAuthorityLockSync(
  target: string,
  waitMs: number,
): () => void {
  const deadline = Date.now() + waitMs;
  let retryMs = SYNC_LOCK_FIRST_RETRY_MS;
  for (;;) {
    try {
      return lockfile.lockSync(target, syncOptions(target));
    } catch (error) {
      if (!isHeldLockError(error) || heldInThisProcess.has(target)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      sleepSync(Math.min(retryMs, remaining));
      retryMs = Math.min(retryMs * 2, SYNC_LOCK_MAX_RETRY_MS);
    }
  }
}

export interface ConfigAuthorityReleaseOutcome {
  readonly postOperationReleaseErrors: readonly Error[];
}

export type ConfigAuthorityOperationOutcome<T> =
  | {
      readonly status: "succeeded";
      readonly value: T;
      readonly postOperationReleaseErrors: readonly Error[];
    }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly postOperationReleaseErrors: readonly Error[];
    };

function asReleaseError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function frozenReleaseErrors(errors: readonly Error[]): readonly Error[] {
  return Object.freeze([...errors]);
}

/**
 * Preserve the primary operation error while retaining cleanup diagnostics.
 * Callers must rethrow the same value; a release failure is never allowed to
 * replace an error from the protected operation.
 */
export function attachConfigAuthorityReleaseErrors(
  error: unknown,
  releaseErrors: readonly Error[],
): void {
  if (releaseErrors.length === 0) return;
  try {
    if (
      (typeof error !== "object" && typeof error !== "function") ||
      error === null ||
      !Object.isExtensible(error)
    ) {
      return;
    }
    Object.defineProperty(error, "postOperationReleaseErrors", {
      configurable: true,
      value: frozenReleaseErrors(releaseErrors),
    });
  } catch {
    // The exact primary failure remains authoritative even when it is sealed.
  }
}

function reportUnhandledReleaseErrors(errors: readonly Error[]): void {
  if (errors.length === 0) return;
  try {
    process.emitWarning(
      new AggregateError(
        errors,
        "Configuration authority operation completed, but its lock release failed",
      ),
      { code: "AGENC_CONFIG_AUTHORITY_RELEASE" },
    );
  } catch {
    // Reporting must never turn completed publication into apparent failure.
  }
}

function canonicalLockTargets(paths: readonly string[]): readonly string[] {
  return Object.freeze(
    [...new Set(paths.map((path) => resolve(path)))].sort((left, right) =>
      left < right ? -1 : left > right ? 1 : 0
    ),
  );
}

function options(path: string): Parameters<typeof lockfile.lock>[1] {
  return {
    ...LOCK_OPTIONS,
    lockfilePath: `${path}${LOCK_SUFFIX}`,
  };
}

function syncOptions(path: string): Parameters<typeof lockfile.lockSync>[1] {
  return {
    realpath: false,
    stale: LOCK_OPTIONS.stale,
    lockfilePath: `${path}${LOCK_SUFFIX}`,
  };
}

/**
 * Serialize every canonical configuration writer on the resolved target.
 * Migration uses the multi-path form below, so ordinary updates and a cutover
 * cannot pass one another between their read and atomic rename.
 */
export function withConfigAuthorityLockSync<T>(
  path: string,
  operation: () => T,
): T {
  const outcome = runWithConfigAuthorityLockSync(path, operation);
  if (outcome.status === "failed") throw outcome.error;
  reportUnhandledReleaseErrors(outcome.postOperationReleaseErrors);
  return outcome.value;
}

/**
 * Run one synchronous authority operation and keep operation completion
 * separate from lock-release diagnostics. The rename/journal owner decides
 * whether the completed value represents a durable commit.
 */
export function runWithConfigAuthorityLockSync<T>(
  path: string,
  operation: () => T,
  options: ConfigAuthoritySyncLockOptions = {},
): ConfigAuthorityOperationOutcome<T> {
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const release = acquireConfigAuthorityLockSync(
    target,
    options.waitMs ?? SYNC_LOCK_WAIT_MS,
  );
  const forget = noteHeldInThisProcess(target);
  let value: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    value = operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const releaseErrors: Error[] = [];
  try {
    release();
  } catch (error) {
    releaseErrors.push(asReleaseError(error));
  } finally {
    forget();
  }
  const postOperationReleaseErrors = frozenReleaseErrors(releaseErrors);
  if (operationFailed) {
    attachConfigAuthorityReleaseErrors(
      operationError,
      postOperationReleaseErrors,
    );
    return Object.freeze({
      status: "failed",
      error: operationError,
      postOperationReleaseErrors,
    });
  }
  return Object.freeze({
    status: "succeeded",
    value: value!,
    postOperationReleaseErrors,
  });
}

/**
 * Acquire a deterministic set of configuration/source locks. Sorting prevents
 * two migrations with overlapping path sets from deadlocking.
 */
export async function acquireConfigAuthorityLocks(
  paths: readonly string[],
): Promise<() => Promise<ConfigAuthorityReleaseOutcome>> {
  const targets = canonicalLockTargets(paths);
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const target of targets) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      // Noted before the attempt: the lock directory can appear on disk before
      // this await resumes, and a synchronous caller in this process must not
      // sleep on it.
      const forget = noteHeldInThisProcess(target);
      let release: () => Promise<void>;
      try {
        release = await lockfile.lock(target, options(target));
      } catch (error) {
        forget();
        throw error;
      }
      releases.push(async () => {
        try {
          await release();
        } finally {
          forget();
        }
      });
    }
  } catch (error) {
    const cleanup = await Promise.allSettled(
      [...releases]
        .reverse()
        .map((release) => Promise.resolve().then(() => release())),
    );
    attachConfigAuthorityReleaseErrors(
      error,
      cleanup
        .filter((result): result is PromiseRejectedResult =>
          result.status === "rejected"
        )
        .map((result) => asReleaseError(result.reason)),
    );
    throw error;
  }
  return async (): Promise<ConfigAuthorityReleaseOutcome> => {
    const results = await Promise.allSettled(
      [...releases]
        .reverse()
        .map((release) => Promise.resolve().then(() => release())),
    );
    const failures = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) => asReleaseError(result.reason));
    return Object.freeze({
      postOperationReleaseErrors: frozenReleaseErrors(failures),
    });
  };
}

/**
 * Async counterpart to runWithConfigAuthorityLockSync. Acquiring authority is
 * pre-operation and may throw. Once the callback starts, its exact result or
 * failure is kept separate from every release diagnostic.
 */
export async function runWithConfigAuthorityLocks<T>(
  paths: readonly string[],
  operation: () => T | Promise<T>,
): Promise<ConfigAuthorityOperationOutcome<T>> {
  const release = await acquireConfigAuthorityLocks(paths);
  let value: T;
  let operationFailed = false;
  let operationError: unknown;
  try {
    value = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  let releaseErrors: readonly Error[];
  try {
    releaseErrors = (await release()).postOperationReleaseErrors;
  } catch (error) {
    // Keep this contract stable even if an injected or alternate lock backend
    // violates acquireConfigAuthorityLocks' non-throwing release contract.
    releaseErrors = Object.freeze([asReleaseError(error)]);
  }
  const postOperationReleaseErrors = frozenReleaseErrors(releaseErrors);
  if (operationFailed) {
    attachConfigAuthorityReleaseErrors(
      operationError,
      postOperationReleaseErrors,
    );
    return Object.freeze({
      status: "failed",
      error: operationError,
      postOperationReleaseErrors,
    });
  }
  return Object.freeze({
    status: "succeeded",
    value: value!,
    postOperationReleaseErrors,
  });
}
