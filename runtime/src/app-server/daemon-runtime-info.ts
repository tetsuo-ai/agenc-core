/**
 * Daemon runtime-info sidecar.
 *
 * On startup the daemon records the build it was launched against
 * (`runtimeVersion`, `commit`, `buildTime` from `dist/VERSION`) into
 * `~/.agenc/daemon-runtime.json`, next to `daemon.pid`. On CLI startup,
 * `ensureAgenCDaemonAutostart` compares the recorded `buildTime`
 * against the current `dist/VERSION.buildTime`. If they differ — i.e.
 * the runtime was rebuilt while the daemon was running — the CLI
 * SIGTERM's the stale process and lets autostart spawn a fresh one.
 *
 * This exists because the ESM bundler emits content-hashed chunk
 * filenames (`run-turn-AVRTIPZE.js`). A `npm run build` deletes the
 * old chunks via `clean: true` and writes new ones with new hashes.
 * The daemon in memory still references the OLD names; any dynamic
 * `import()` during a turn fails with `Cannot find module`, the turn
 * never completes, and the spinner hangs forever. Version-mismatch
 * detection turns the silent-hang failure mode into a transparent
 * respawn.
 */

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locate the `@tetsuo-ai/runtime` package root from `import.meta.url`.
 * Mirrors the resolver in `diagnostics/doctor.ts`; kept local so this
 * module doesn't take a dependency on the diagnostics layer.
 */
export function resolveRuntimePackageRootFromUrl(
  moduleUrl: string,
): string | null {
  const here = dirname(fileURLToPath(moduleUrl));
  const candidates = [
    resolve(here, "../.."),
    resolve(here, ".."),
    resolve(process.cwd(), "runtime"),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    const manifest = join(candidate, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        readonly name?: unknown;
      };
      if (parsed.name === "@tetsuo-ai/runtime") return candidate;
    } catch {
      /* try next */
    }
  }
  return null;
}

export interface DaemonRuntimeInfo {
  readonly pid: number;
  readonly runtimeVersion: string;
  readonly commit: string;
  readonly buildTime: string;
  readonly startedAt: string;
}

const AGENC_DAEMON_RUNTIME_INFO_FILENAME = "daemon-runtime.json";

export function resolveAgenCDaemonRuntimeInfoPath(daemonHome: string): string {
  return join(daemonHome, AGENC_DAEMON_RUNTIME_INFO_FILENAME);
}

/**
 * Read the `dist/VERSION` file produced by
 * `runtime/scripts/write-build-version.mjs`. Returns null when the
 * file is missing or malformed — callers should treat that as "skew
 * detection unavailable" and avoid forcing a respawn on lack of
 * data.
 */
export function readDistVersion(runtimeRoot: string): {
  readonly runtimeVersion: string;
  readonly commit: string;
  readonly buildTime: string;
} | null {
  try {
    const raw = readFileSync(join(runtimeRoot, "dist", "VERSION"), "utf8");
    const parsed = JSON.parse(raw) as Partial<{
      runtimeVersion: string;
      commit: string;
      buildTime: string;
    }>;
    if (
      typeof parsed.runtimeVersion !== "string" ||
      typeof parsed.commit !== "string" ||
      typeof parsed.buildTime !== "string"
    ) {
      return null;
    }
    return {
      runtimeVersion: parsed.runtimeVersion,
      commit: parsed.commit,
      buildTime: parsed.buildTime,
    };
  } catch {
    return null;
  }
}

export function readDaemonRuntimeInfo(
  path: string,
): DaemonRuntimeInfo | null {
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<DaemonRuntimeInfo>;
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.runtimeVersion !== "string" ||
      typeof parsed.commit !== "string" ||
      typeof parsed.buildTime !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      runtimeVersion: parsed.runtimeVersion,
      commit: parsed.commit,
      buildTime: parsed.buildTime,
      startedAt: parsed.startedAt,
    };
  } catch {
    return null;
  }
}

export function writeDaemonRuntimeInfo(
  path: string,
  info: DaemonRuntimeInfo,
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(info, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function removeDaemonRuntimeInfo(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}
