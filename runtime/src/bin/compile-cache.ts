/**
 * Reuse V8's compiled code across AgenC processes.
 *
 * Every `agenc` process (the CLI and the daemon it starts) parses and compiles
 * the whole runtime bundle on each start. Node's on-disk compile cache keeps
 * that work: measured in the benchmark container, it cut time to the first
 * model request of a one-shot run from 1,034 ms to 835 ms. Node validates each
 * entry against its source, so a changed install only recompiles what changed.
 *
 * The cache lives in the per-user temp directory, which the OS cleans: private
 * on macOS and Windows, and on shared POSIX temp a per-user directory that must
 * be owned by this user and not writable by anyone else. If that check fails
 * the cache stays off; it never changes what the runtime does, only how fast
 * it starts. `AGENC_COMPILE_CACHE=0` turns it off, and an explicit
 * `NODE_COMPILE_CACHE` (already enabled by Node at startup) is left alone.
 */
import { lstatSync, mkdirSync } from "node:fs";
import module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const AGENC_COMPILE_CACHE_ENV = "AGENC_COMPILE_CACHE";

/** A long-lived daemon saves what it compiled at these points after start. */
const DAEMON_FLUSH_DELAYS_MS = [5_000, 60_000] as const;

/** Where this user's cache lives, or null when no private location exists. */
export function compileCacheDirectory(
  platform: NodeJS.Platform,
  uid: number | undefined,
  temp: string,
): string | null {
  if (platform === "win32") return join(temp, "agenc-compile-cache");
  if (uid === undefined) return null;
  return join(temp, `agenc-compile-cache-${uid}`);
}

/**
 * Creates the directory, or accepts an existing one only when it is a real
 * directory (not a link) owned by this user that no one else can write.
 */
export function preparePrivateDirectory(
  directory: string,
  platform: NodeJS.Platform,
  uid: number | undefined,
): boolean {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
  }
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    if (platform === "win32") return true;
    return stat.uid === uid && (stat.mode & 0o022) === 0;
  } catch {
    return false;
  }
}

/** Turns the cache on for this process and everything it loads from here on. */
export function enableAgenCCompileCache(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env[AGENC_COMPILE_CACHE_ENV]?.trim() === "0") return null;
  if (typeof module.enableCompileCache !== "function") return null;
  const existing = module.getCompileCacheDir?.();
  if (existing !== undefined) return existing;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const directory = compileCacheDirectory(process.platform, uid, tmpdir());
  if (directory === null || !preparePrivateDirectory(directory, process.platform, uid)) {
    return null;
  }
  try {
    const result = module.enableCompileCache(directory);
    return result.directory ?? null;
  } catch {
    return null;
  }
}

/**
 * A daemon can run for days and may end without a clean exit, which is when
 * Node would otherwise write the cache. Save shortly after start and once
 * more after the first session has loaded its code.
 */
export function scheduleDaemonCompileCacheFlush(): void {
  if (typeof module.flushCompileCache !== "function") return;
  if (module.getCompileCacheDir?.() === undefined) return;
  for (const delay of DAEMON_FLUSH_DELAYS_MS) {
    setTimeout(() => {
      try {
        module.flushCompileCache();
      } catch {
        // A cache that cannot be written only costs the next start its speedup.
      }
    }, delay).unref();
  }
}
