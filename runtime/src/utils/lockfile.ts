/**
 * Lazy accessor for proper-lockfile.
 *
 * proper-lockfile depends on graceful-fs, which monkey-patches every fs
 * method on first require (~8ms). Static imports of proper-lockfile pull
 * this cost into the startup path even when no locking happens (e.g.
 * `--help`).
 *
 * Import this module instead of `proper-lockfile` directly. The
 * underlying package is only loaded the first time a lock function is
 * actually called.
 *
 * Verbatim port of openclaude `src/utils/lockfile.ts`.
 *
 * @module
 */

import type { CheckOptions, LockOptions, UnlockOptions } from "proper-lockfile";
import { createRequire } from "node:module";

type Lockfile = typeof import("proper-lockfile");

const requireCJS = createRequire(import.meta.url);

let cached: Lockfile | undefined;

function getLockfile(): Lockfile {
  if (!cached) {
    cached = requireCJS("proper-lockfile") as Lockfile;
  }
  return cached;
}

export function lock(
  file: string,
  options?: LockOptions,
): Promise<() => Promise<void>> {
  return getLockfile().lock(file, options);
}

export function unlock(file: string, options?: UnlockOptions): Promise<void> {
  return getLockfile().unlock(file, options);
}

export function check(file: string, options?: CheckOptions): Promise<boolean> {
  return getLockfile().check(file, options);
}
