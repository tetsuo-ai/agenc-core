/**
 * AgenC daemon autostart orchestration.
 *
 * F-04a owns the thin-client startup contract: check for the daemon, start it
 * if needed, wait until it is ready, then hand control to a connector hook.
 */

import {
  createNodeDaemonCliHost,
  readAgenCDaemonPid,
  resolveAgenCDaemonPidPath,
  runAgenCDaemonCli,
  resolveAgenCDaemonHome,
  type AgenCDaemonCliHost,
  type AgenCDaemonCliIo,
} from "./daemon-cli.js";
import { loadConfig } from "../config/index.js";

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
  const home = resolveAgenCDaemonHome(env, userHome);
  const loaded = await loadConfig({ home });
  const configAutostart = loaded.config.daemon?.autostart ?? true;
  return shouldAutostartAgenCDaemon(env, configAutostart);
}

export async function ensureAgenCDaemonAutostart(
  options: AgenCDaemonAutostartOptions = {},
): Promise<AgenCDaemonAutostartResult> {
  const host = options.host ?? createNodeDaemonCliHost();
  const io = options.io ?? silentIo();
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  let status: AgenCDaemonAutostartStatus = "already-running";
  let pid = await readAgenCDaemonPid(pidPath);

  if (pid === null || !host.isPidRunning(pid)) {
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
      host.isPidRunning(readyTarget.pid));

  while (Date.now() - startedAt < timeoutMs) {
    if (await Promise.resolve(isReady(target))) return true;
    await host.sleep(pollMs);
  }
  return Promise.resolve(isReady(target));
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
