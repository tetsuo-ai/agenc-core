import { BoundedRegularFileError, readBoundedRegularFile } from "../utils/bounded-regular-file.js";
/** Canonical home and local endpoint discovery, without daemon orchestration. */
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveHomeContext } from "../config/home.js";
import { agenCDaemonLocalEndpoint } from "../../../packages/agenc-sdk/lib/local-endpoint.mjs";

export const AGENC_DAEMON_COOKIE_FILENAME = "daemon.cookie";

export const AGENC_DAEMON_PID_FILENAME = "daemon.pid";

export function resolveAgenCDaemonHome(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return resolveHomeContext(env, { platformHome: userHome }).path;
}


export function resolveAgenCDaemonPidPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return join(resolveAgenCDaemonHome(env, userHome), AGENC_DAEMON_PID_FILENAME);
}


export function resolveAgenCDaemonSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  return agenCDaemonLocalEndpoint(
    resolveAgenCDaemonHome(env, userHome),
    platform,
  );
}


export function resolveAgenCDaemonCookiePath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return join(
    resolveAgenCDaemonHome(env, userHome),
    AGENC_DAEMON_COOKIE_FILENAME,
  );
}


export const AGENC_DAEMON_PID_MAX_BYTES = 64;

export async function readAgenCDaemonPid(
  pidPath: string,
): Promise<number | null> {
  try {
    const raw = await readBoundedRegularFile(
      pidPath,
      AGENC_DAEMON_PID_MAX_BYTES,
    );
    const canonical = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    if (!/^[1-9]\d*$/u.test(canonical)) return null;
    const pid = Number(canonical);
    return Number.isSafeInteger(pid) && pid > 1 ? pid : null;
  } catch (error) {
    if (
      asNodeError(error).code === "ENOENT" ||
      error instanceof BoundedRegularFileError
    ) {
      return null;
    }
    throw error;
  }
}

function asNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error : new Error(String(error));
}
