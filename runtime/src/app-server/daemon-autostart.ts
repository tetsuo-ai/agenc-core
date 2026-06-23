/**
 * AgenC daemon autostart orchestration.
 *
 * F-04a owns the thin-client startup contract: check for the daemon, start it
 * if needed, wait until it is ready, then hand control to a connector hook.
 */

import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  createNodeDaemonCliHost,
  readAgenCDaemonPid,
  removeAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonSocketPath,
  runAgenCDaemonCli,
  resolveAgenCDaemonHome,
  writeAgenCDaemonPid,
  type AgenCDaemonCliHost,
  type AgenCDaemonCliIo,
} from "./daemon-cli.js";
import {
  readDaemonRuntimeInfo,
  readDistVersion,
  removeDaemonRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath,
  resolveRuntimePackageRootFromUrl,
} from "./daemon-runtime-info.js";
import { loadConfig } from "../config/loader.js";
import {
  resolveMcpServeDefaults,
  type ResolvedMcpServeDefaults,
} from "../mcp/server/start.js";
import { canConnectToUnixSocket } from "./transport/unix-socket.js";

export type AgenCDaemonAutostartStatus = "already-running" | "started";

export const AGENC_DAEMON_AUTOSTART_READY_TIMEOUT_MS = 15_000;

export interface AgenCDaemonConnectionTarget {
  readonly pid: number;
  readonly pidPath: string;
}

export interface AgenCDaemonAutostartResult
  extends AgenCDaemonConnectionTarget {
  readonly status: AgenCDaemonAutostartStatus;
  readonly ready: true;
  readonly connected: boolean;
}

export interface AgenCDaemonAutostartConfig {
  readonly daemonEnabled: boolean;
  readonly mcpServer: ResolvedMcpServeDefaults;
}

export interface AgenCDaemonAutostartOptions {
  readonly host?: AgenCDaemonCliHost;
  readonly io?: AgenCDaemonCliIo;
  readonly waitTimeoutMs?: number;
  readonly pollMs?: number;
  readonly isReady?: (
    target: AgenCDaemonConnectionTarget,
  ) => boolean | Promise<boolean>;
  readonly connect?: (target: AgenCDaemonConnectionTarget) => Promise<void> | void;
  readonly findOrphanDaemonPids?: (
    targetHome: string,
  ) => Promise<readonly number[]> | readonly number[];
  readonly terminateOrphanDaemonPid?: (pid: number) => Promise<void> | void;
}

export class AgenCDaemonAutostartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgenCDaemonAutostartError";
  }
}

export function shouldAutostartAgenCDaemon(
  env: NodeJS.ProcessEnv = process.env,
  configAutostart = true,
): boolean {
  const raw = env.AGENC_DAEMON_AUTOSTART?.trim().toLowerCase();
  if (raw !== undefined && raw.length > 0) {
    return raw !== "0" && raw !== "false" && raw !== "off";
  }
  return configAutostart;
}

export async function resolveAgenCDaemonAutostartEnabled(
  env: NodeJS.ProcessEnv = process.env,
  userHome?: string,
): Promise<boolean> {
  return (await resolveAgenCDaemonAutostartConfig(env, userHome)).daemonEnabled;
}

export async function resolveAgenCDaemonAutostartConfig(
  env: NodeJS.ProcessEnv = process.env,
  userHome?: string,
): Promise<AgenCDaemonAutostartConfig> {
  const home = resolveAgenCDaemonHome(env, userHome);
  const loaded = await loadConfig({ home });
  const configAutostart = loaded.config.daemon?.autostart ?? true;
  return {
    daemonEnabled: shouldAutostartAgenCDaemon(env, configAutostart),
    mcpServer: resolveMcpServeDefaults(loaded.config.mcp?.server),
  };
}

export async function ensureAgenCDaemonAutostart(
  options: AgenCDaemonAutostartOptions = {},
): Promise<AgenCDaemonAutostartResult> {
  const host = options.host ?? createNodeDaemonCliHost();
  const io = options.io ?? silentIo();
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath));
  let status: AgenCDaemonAutostartStatus = "already-running";
  let pid = await readAgenCDaemonPid(pidPath);

  // Detect runtime-build skew: if the running daemon was launched
  // against an older `dist/VERSION` than the one currently on disk
  // (typical scenario: `npm run build` while the daemon was alive),
  // its in-memory bundle still references chunk filenames that
  // `clean: true` deleted. Any dynamic `import()` in a turn fails
  // with "Cannot find module" and the spinner hangs forever. Kill
  // the stale daemon here so the start-fresh branch below replaces
  // it transparently.
  let respawnReason: string | null = null;
  if (pid !== null && host.isPidRunning(pid)) {
    const runtimeRoot = resolveRuntimePackageRootFromUrl(import.meta.url);
    const currentVersion =
      runtimeRoot !== null ? readDistVersion(runtimeRoot) : null;
    const daemonInfo = readDaemonRuntimeInfo(runtimeInfoPath);
    if (
      currentVersion !== null &&
      daemonInfo !== null &&
      daemonInfo.buildTime !== currentVersion.buildTime
    ) {
      respawnReason = `daemon build skew (running buildTime ${daemonInfo.buildTime} != on-disk ${currentVersion.buildTime})`;
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      const skewDeadline = Date.now() + 5000;
      while (Date.now() < skewDeadline && host.isPidRunning(pid)) {
        await host.sleep(50);
      }
      if (host.isPidRunning(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
      await removeAgenCDaemonPid(pidPath, pid);
      removeDaemonRuntimeInfo(runtimeInfoPath);
      pid = null;
    }
  } else if (pid !== null && !host.isPidRunning(pid)) {
    respawnReason = `daemon pid ${pid} not running — stale pid file`;
  } else if (pid === null) {
    respawnReason = "no daemon pid recorded";
  }

  if (pid === null || !host.isPidRunning(pid)) {
    const recoveredPid = await recoverPidlessAgenCDaemon({
      daemonHome,
      pidPath,
      host,
      options,
    });
    if (recoveredPid !== null) {
      pid = recoveredPid;
      respawnReason = null;
    }
  }

  if (pid === null || !host.isPidRunning(pid)) {
    // Round-2 M-NEW3: previously the autostart respawned silently
    // because `io` defaulted to `silentIo`. Surface the start event
    // on stderr so the user sees that a daemon respawn happened
    // (without bypassing the silent default for tests that pass
    // their own io). Reason is set above based on which branch
    // triggered the respawn.
    if (respawnReason !== null) {
      io.stderr.write(
        `agenc: starting daemon (${respawnReason})\n`,
      );
    }
    const startExit = await runAgenCDaemonCli(
      { kind: "command", action: "start" },
      {
        host,
        io,
        // The autostart path owns its own readiness wait below
        // (`waitForAgenCDaemonReady`, honoring this call's `isReady`/timeout
        // options), so opt the bare `start` control out of its own duplicate
        // socket-readiness gate. This keeps autostart's start→ready sequence
        // byte-for-byte identical to before the bare-control readiness gate
        // was added.
        waitForDaemonReady: async () => true,
      },
    );
    if (startExit !== 0) {
      throw new AgenCDaemonAutostartError("AgenC daemon start failed");
    }
    pid = await readAgenCDaemonPid(pidPath);
    status = "started";
  }

  if (pid === null) {
    throw new AgenCDaemonAutostartError("AgenC daemon pid file was not written");
  }

  const target = { pid, pidPath };
  const ready = await waitForAgenCDaemonReady(target, host, options);
  if (!ready) {
    throw new AgenCDaemonAutostartError(
      `AgenC daemon did not become ready before timeout (pid ${pid})`,
    );
  }

  await Promise.resolve(options.connect?.(target));
  return {
    ...target,
    status,
    ready: true,
    connected: options.connect !== undefined,
  };
}

async function recoverPidlessAgenCDaemon(params: {
  readonly daemonHome: string;
  readonly pidPath: string;
  readonly host: AgenCDaemonCliHost;
  readonly options: AgenCDaemonAutostartOptions;
}): Promise<number | null> {
  const orphanPids = [
    ...await Promise.resolve(
      params.options.findOrphanDaemonPids?.(params.daemonHome) ??
        findPidlessAgenCDaemonPids(params.host, params.daemonHome),
    ),
  ].filter((pid) => params.host.isPidRunning(pid));
  if (orphanPids.length === 0) return null;

  const socketPath = resolveAgenCDaemonSocketPath(
    params.host.env,
    params.host.userHome,
  );
  // Only adopt the orphan when the leftover socket is actually accepting
  // connections. A stale socket inode (left after a crash without unlink)
  // passes a bare lstat()/isSocket() check but has no listener, so adopting
  // it would make autostart wait/connect forever against a dead socket.
  // `canConnectToUnixSocket` performs a real connect() probe (the same
  // liveness check `prepareAgenCUnixSocketPath` uses to decide if a socket
  // is in use). The lstat precondition keeps us from attempting a connect
  // against a missing or non-socket path.
  if (
    (await isAgenCDaemonSocketPresent(socketPath)) &&
    (await canConnectToUnixSocket(socketPath))
  ) {
    const recoveredPid = orphanPids[0];
    if (recoveredPid === undefined) return null;
    await writeAgenCDaemonPid(params.pidPath, recoveredPid);
    return recoveredPid;
  }

  await Promise.all(
    orphanPids.map((pid) =>
      terminatePidlessAgenCDaemonPid(pid, params.host, params.options),
    ),
  );
  return null;
}

async function terminatePidlessAgenCDaemonPid(
  pid: number,
  host: AgenCDaemonCliHost,
  options: AgenCDaemonAutostartOptions,
): Promise<void> {
  if (options.terminateOrphanDaemonPid !== undefined) {
    await Promise.resolve(options.terminateOrphanDaemonPid(pid));
    return;
  }

  try {
    host.terminatePid(pid);
  } catch {
    /* already gone */
  }
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && host.isPidRunning(pid)) {
    await host.sleep(50);
  }
  if (!host.isPidRunning(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

async function isAgenCDaemonSocketPresent(socketPath: string): Promise<boolean> {
  try {
    return (await lstat(socketPath)).isSocket();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function findPidlessAgenCDaemonPids(
  host: AgenCDaemonCliHost,
  daemonHome: string,
): Promise<readonly number[]> {
  if (process.platform !== "linux" || host.entrypointPath.length === 0) {
    return [];
  }
  let entries: readonly import("node:fs").Dirent[];
  try {
    entries = await readdir("/proc", { withFileTypes: true });
  } catch {
    return [];
  }

  const expectedEntrypoint = resolve(host.entrypointPath);
  const expectedHome = resolve(daemonHome);
  const pids: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const candidatePid = Number.parseInt(entry.name, 10);
    if (
      !Number.isSafeInteger(candidatePid) ||
      candidatePid <= 1 ||
      candidatePid === host.pid
    ) {
      continue;
    }
    const procDir = join("/proc", entry.name);
    const argv = await readProcList(join(procDir, "cmdline"));
    const entrypointIndex = argv.findIndex((value) => {
      try {
        return resolve(value) === expectedEntrypoint;
      } catch {
        return false;
      }
    });
    if (entrypointIndex === -1) continue;
    const tail = argv.slice(entrypointIndex + 1);
    if (
      tail[0] !== "daemon" ||
      tail[1] !== "start" ||
      tail[2] !== "--foreground"
    ) {
      continue;
    }

    const env = await readProcEnv(join(procDir, "environ"));
    const candidateHome =
      env.AGENC_HOME ?? (env.HOME !== undefined ? join(env.HOME, ".agenc") : null);
    if (candidateHome === null || resolve(candidateHome) !== expectedHome) {
      continue;
    }
    pids.push(candidatePid);
  }
  return pids;
}

async function readProcList(path: string): Promise<readonly string[]> {
  try {
    return (await readFile(path, "utf8")).split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

async function readProcEnv(path: string): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  for (const entry of await readProcList(path)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    env[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return env;
}

async function waitForAgenCDaemonReady(
  target: AgenCDaemonConnectionTarget,
  host: AgenCDaemonCliHost,
  options: AgenCDaemonAutostartOptions,
): Promise<boolean> {
  const timeoutMs = options.waitTimeoutMs ?? AGENC_DAEMON_AUTOSTART_READY_TIMEOUT_MS;
  const pollMs = options.pollMs ?? 25;
  const startedAt = Date.now();
  const isReady =
    options.isReady ??
    ((readyTarget: AgenCDaemonConnectionTarget) =>
      isAgenCDaemonPidAndCookieReady(readyTarget, host));

  while (Date.now() - startedAt < timeoutMs) {
    if (await Promise.resolve(isReady(target))) return true;
    await host.sleep(pollMs);
  }
  return Promise.resolve(isReady(target));
}

async function isAgenCDaemonPidAndCookieReady(
  target: AgenCDaemonConnectionTarget,
  host: AgenCDaemonCliHost,
): Promise<boolean> {
  if (!host.isPidRunning(target.pid)) return false;
  const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  try {
    if ((await readFile(cookiePath, "utf8")).trim().length === 0) {
      return false;
    }
    return (await lstat(socketPath)).isSocket();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") return false;
    throw error;
  }
}

function silentIo(): AgenCDaemonCliIo {
  const sink = {
    write: () => true,
  } as Pick<NodeJS.WriteStream, "write">;
  return {
    stdout: sink,
    stderr: sink,
  };
}
