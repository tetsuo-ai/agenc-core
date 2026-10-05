/**
 * Daemon runtime-info sidecar.
 *
 * On startup the daemon records the build it was launched against
 * (`runtimeVersion`, `commit`, `buildTime` from `dist/VERSION`) into
 * `~/.agenc/daemon-runtime.json`, next to `daemon.pid`. On CLI startup,
 * `ensureAgenCDaemonAutostart` compares the complete recorded build tuple
 * against the current `dist/VERSION` tuple. If any field
 * differs — i.e. the runtime was rebuilt while the daemon was running — the
 * CLI requests authenticated instance-bound self-shutdown and lets autostart
 * spawn a fresh one. A numeric signal is only a Linux fallback after the
 * same-home process and stable start token are rebound immediately beforehand.
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

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isAgenCDaemonInstanceIdentity,
  type AgenCDaemonInstanceIdentity,
} from "./daemon-instance-identity.js";
import { writeDurableAtomicFileSync } from "../utils/durable-atomic-file.js";
import { readBoundedRegularFileSync } from "../utils/bounded-regular-file.js";

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
  /** Missing only in a sidecar written by a pre-instance-identity daemon. */
  readonly instanceId?: string;
  /** Missing only in a sidecar written by a pre-instance-identity daemon. */
  readonly processStart?: string;
  readonly runtimeVersion: string;
  readonly commit: string;
  readonly buildTime: string;
  readonly startedAt: string;
  /**
   * The websocket URL this daemon actually bound. Optional: readers must
   * tolerate its absence (older daemons, and any daemon whose websocket
   * listener is unavailable). Clients that would otherwise assume the fixed
   * default port need this, because a daemon whose default port was taken
   * falls back to an ephemeral one.
   */
  readonly webSocketUrl?: string;
  /** The local endpoint actually bound; absent in older sidecars. */
  readonly socketPath?: string;
}

const AGENC_DAEMON_RUNTIME_INFO_FILENAME = "daemon-runtime.json";
export const AGENC_DAEMON_RUNTIME_INFO_MAX_BYTES = 64 * 1_024;

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

export function readDaemonRuntimeInfo(path: string): DaemonRuntimeInfo | null {
  try {
    const raw = readBoundedRegularFileSync(
      path,
      AGENC_DAEMON_RUNTIME_INFO_MAX_BYTES,
    );
    const parsed = JSON.parse(raw) as Partial<DaemonRuntimeInfo>;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 1 ||
      typeof parsed.runtimeVersion !== "string" ||
      typeof parsed.commit !== "string" ||
      typeof parsed.buildTime !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    return {
      pid: parsed.pid,
      ...(typeof parsed.instanceId === "string" && parsed.instanceId.length > 0
        ? { instanceId: parsed.instanceId }
        : {}),
      ...(typeof parsed.processStart === "string" &&
      parsed.processStart.length > 0
        ? { processStart: parsed.processStart }
        : {}),
      ...(typeof parsed.socketPath === "string" && parsed.socketPath.length > 0
        ? { socketPath: parsed.socketPath }
        : {}),
      runtimeVersion: parsed.runtimeVersion,
      commit: parsed.commit,
      buildTime: parsed.buildTime,
      startedAt: parsed.startedAt,
      ...(typeof parsed.webSocketUrl === "string" &&
      parsed.webSocketUrl.length > 0
        ? { webSocketUrl: parsed.webSocketUrl }
        : {}),
    };
  } catch {
    return null;
  }
}

export function daemonInstanceIdentityFromRuntimeInfo(
  info: DaemonRuntimeInfo | null,
): AgenCDaemonInstanceIdentity | null {
  if (!isAgenCDaemonInstanceIdentity(info)) return null;
  return {
    pid: info.pid,
    instanceId: info.instanceId,
    processStart: info.processStart,
    runtimeVersion: info.runtimeVersion,
    commit: info.commit,
    buildTime: info.buildTime,
  };
}

export function writeDaemonRuntimeInfo(
  path: string,
  info: DaemonRuntimeInfo & AgenCDaemonInstanceIdentity,
): void {
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeDurableAtomicFileSync(
    path,
    temporaryPath,
    `${JSON.stringify(info, null, 2)}\n`,
  );
}

export function removeDaemonRuntimeInfo(
  path: string,
  expectedInstanceId?: string,
): void {
  try {
    if (
      expectedInstanceId !== undefined &&
      readDaemonRuntimeInfo(path)?.instanceId !== expectedInstanceId
    ) {
      return;
    }
    rmSync(path, { force: true });
  } catch {
    /* best-effort */
  }
}
