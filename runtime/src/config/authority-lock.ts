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
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const release = lockfile.lockSync(target, syncOptions(target));
  try {
    return operation();
  } finally {
    release();
  }
}

/**
 * Acquire a deterministic set of configuration/source locks. Sorting prevents
 * two migrations with overlapping path sets from deadlocking.
 */
export async function acquireConfigAuthorityLocks(
  paths: readonly string[],
): Promise<() => Promise<void>> {
  const targets = canonicalLockTargets(paths);
  const releases: Array<() => Promise<void>> = [];
  try {
    for (const target of targets) {
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      releases.push(await lockfile.lock(target, options(target)));
    }
  } catch (error) {
    await Promise.allSettled(releases.reverse().map((release) => release()));
    throw error;
  }
  return async (): Promise<void> => {
    const results = await Promise.allSettled(
      releases.reverse().map((release) => release()),
    );
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "Failed to release configuration authority locks");
    }
  };
}
