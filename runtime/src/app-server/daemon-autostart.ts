/**
 * AgenC daemon autostart orchestration.
 *
 * F-04a owns the thin-client startup contract: check for the daemon, start it
 * if needed, wait until it is ready, then hand control to a connector hook.
 */

import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  createNodeDaemonCliHost,
  readAgenCDaemonPid,
  removeAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonPidPath,
  runAgenCDaemonCli,
  resolveAgenCDaemonHome,
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

export type AgenCDaemonAutostartStatus = "already-running" | "started";

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
      { host, io },
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

async function waitForAgenCDaemonReady(
  target: AgenCDaemonConnectionTarget,
  host: AgenCDaemonCliHost,
  options: AgenCDaemonAutostartOptions,
): Promise<boolean> {
  const timeoutMs = options.waitTimeoutMs ?? 2000;
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
  try {
    return (await readFile(cookiePath, "utf8")).trim().length > 0;
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
