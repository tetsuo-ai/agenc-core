/**
 * AgenC daemon CLI controls.
 *
 * F-03i owns the local process controls only: start, stop, status, restart,
 * and the pid file. Request dispatch and health probes are wired by later
 * daemon rows.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgenCDaemonAgentManager,
  type AgenCDaemonAgentSnapshotFlush,
} from "./agent-lifecycle.js";
import { AgenCDelegateBackgroundAgentRunner } from "./background-agent-runner.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCCommandExecService } from "./command-exec.js";
import {
  AgenCDaemonJsonRpcDispatcher,
  type AgenCDaemonJsonRpcConnection,
} from "./daemon-dispatcher.js";
import { JSON_RPC_VERSION, type JsonObject } from "./protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import { AgenCUnixSocketServer } from "./transport/unix-socket.js";
import {
  AgenCCleanupRegistry,
  installAgenCShutdownSignalHandlers,
  summarizeAgenCShutdown,
  type AgenCSignalProcess,
} from "../lifecycle/index.js";
import { createAuthBackend } from "../auth/index.js";
import { loadConfig } from "../config/index.js";

export const AGENC_DAEMON_PID_FILENAME = "daemon.pid";
export const AGENC_DAEMON_SOCKET_FILENAME = "daemon.sock";
export const AGENC_DAEMON_COOKIE_FILENAME = "daemon.cookie";
export const AGENC_DAEMON_SNAPSHOT_FILENAME = "daemon-snapshot.json";

export type AgenCDaemonCliAction =
  | "restart"
  | "run"
  | "start"
  | "status"
  | "stop";

export type AgenCDaemonCliCommand =
  | { readonly kind: "command"; readonly action: AgenCDaemonCliAction }
  | { readonly kind: "help"; readonly text: string }
  | { readonly kind: "error"; readonly message: string };

export interface AgenCDaemonCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
}

export interface AgenCDaemonCliHost {
  readonly env: NodeJS.ProcessEnv;
  readonly userHome: string;
  readonly entrypointPath: string;
  readonly execPath: string;
  readonly pid: number;
  spawnDetachedDaemon(env: NodeJS.ProcessEnv): number;
  isPidRunning(pid: number): boolean;
  terminatePid(pid: number): void;
  sleep(ms: number): Promise<void>;
}

export interface RunAgenCDaemonCliOptions {
  readonly io?: AgenCDaemonCliIo;
  readonly host?: AgenCDaemonCliHost;
  readonly signalProcess?: AgenCSignalProcess;
  readonly beforeDaemonReady?: () => void | Promise<void>;
  readonly stopTimeoutMs?: number;
}

export function defaultAgenCDaemonPidPath(userHome = homedir()): string {
  return join(userHome, ".agenc", AGENC_DAEMON_PID_FILENAME);
}

export function resolveAgenCDaemonHome(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  const configured = env.AGENC_HOME?.trim();
  return configured && configured.length > 0
    ? configured
    : join(userHome, ".agenc");
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
): string {
  return join(
    resolveAgenCDaemonHome(env, userHome),
    AGENC_DAEMON_SOCKET_FILENAME,
  );
}

export function resolveAgenCDaemonCookiePath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return join(resolveAgenCDaemonHome(env, userHome), AGENC_DAEMON_COOKIE_FILENAME);
}

export function resolveAgenCDaemonSnapshotPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return join(
    resolveAgenCDaemonHome(env, userHome),
    AGENC_DAEMON_SNAPSHOT_FILENAME,
  );
}

export function formatAgenCDaemonCliHelpText(): string {
  return [
    "Usage: agenc daemon <start|stop|status|restart>",
    "",
    "Commands:",
    "  start     Start the local AgenC daemon",
    "  stop      Stop the local AgenC daemon",
    "  status    Show local AgenC daemon status",
    "  restart   Stop and start the local AgenC daemon",
  ].join("\n");
}

export function parseAgenCDaemonCliArgs(
  argv: readonly string[],
): AgenCDaemonCliCommand | null {
  if (argv[0] !== "daemon") return null;
  const action = argv[1];
  if (action === undefined || action === "--help" || action === "-h") {
    return { kind: "help", text: formatAgenCDaemonCliHelpText() };
  }
  if (
    action === "start" ||
    action === "stop" ||
    action === "status" ||
    action === "restart" ||
    action === "run"
  ) {
    return { kind: "command", action };
  }
  return {
    kind: "error",
    message: `unknown daemon command: ${action}`,
  };
}

export async function runAgenCDaemonCli(
  command: AgenCDaemonCliCommand,
  options: RunAgenCDaemonCliOptions = {},
): Promise<number> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr };
  const host = options.host ?? createNodeDaemonCliHost();

  switch (command.kind) {
    case "help":
      io.stdout.write(`${command.text}\n`);
      return 0;
    case "error":
      io.stderr.write(`agenc: ${command.message}\n`);
      io.stderr.write(`${formatAgenCDaemonCliHelpText()}\n`);
      return 1;
    case "command":
      return runAgenCDaemonAction(command.action, host, io, options);
  }
}

async function runAgenCDaemonAction(
  action: AgenCDaemonCliAction,
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  options: RunAgenCDaemonCliOptions,
): Promise<number> {
  switch (action) {
    case "start":
      return startAgenCDaemon(host, io);
    case "stop":
      return stopAgenCDaemon(host, io, options.stopTimeoutMs ?? 2000);
    case "status":
      return statusAgenCDaemon(host, io);
    case "restart": {
      await stopAgenCDaemon(host, io, options.stopTimeoutMs ?? 2000, {
        quietWhenStopped: true,
      });
      return startAgenCDaemon(host, io);
    }
    case "run":
      return runAgenCDaemonForeground(host, io, {
        signalProcess: options.signalProcess,
        beforeDaemonReady: options.beforeDaemonReady,
      });
  }
}

async function startAgenCDaemon(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
): Promise<number> {
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const existingPid = await readAgenCDaemonPid(pidPath);
  if (existingPid !== null && host.isPidRunning(existingPid)) {
    io.stdout.write(`AgenC daemon already running (pid ${existingPid})\n`);
    return 0;
  }
  if (existingPid !== null) {
    await removeAgenCDaemonPid(pidPath);
  }

  const childPid = host.spawnDetachedDaemon({
    ...host.env,
    AGENC_DAEMON_RUN: "1",
  });
  await writeAgenCDaemonPid(pidPath, childPid);
  io.stdout.write(`AgenC daemon started (pid ${childPid})\n`);
  return 0;
}

async function stopAgenCDaemon(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  timeoutMs: number,
  options: { readonly quietWhenStopped?: boolean } = {},
): Promise<number> {
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const pid = await readAgenCDaemonPid(pidPath);
  if (pid === null) {
    if (!options.quietWhenStopped) {
      io.stdout.write("AgenC daemon stopped\n");
    }
    return 1;
  }
  if (!host.isPidRunning(pid)) {
    await removeAgenCDaemonPid(pidPath);
    if (!options.quietWhenStopped) {
      io.stdout.write("AgenC daemon stopped\n");
    }
    return 1;
  }

  host.terminatePid(pid);
  const stopped = await waitForPidExit(host, pid, timeoutMs);
  if (!stopped) {
    io.stderr.write(`agenc: daemon did not stop before timeout (pid ${pid})\n`);
    return 1;
  }

  await removeAgenCDaemonPid(pidPath);
  io.stdout.write(`AgenC daemon stopped (pid ${pid})\n`);
  return 0;
}

async function statusAgenCDaemon(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
): Promise<number> {
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const pid = await readAgenCDaemonPid(pidPath);
  if (pid !== null && host.isPidRunning(pid)) {
    io.stdout.write(`AgenC daemon running (pid ${pid})\n`);
    return 0;
  }
  io.stdout.write("AgenC daemon stopped\n");
  return 1;
}

async function runAgenCDaemonForeground(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  options: {
    readonly signalProcess?: AgenCSignalProcess;
    readonly beforeDaemonReady?: () => void | Promise<void>;
  } = {},
): Promise<number> {
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  const snapshotPath = resolveAgenCDaemonSnapshotPath(host.env, host.userHome);
  const daemonCookie = await ensureAgenCDaemonCookie(
    resolveAgenCDaemonCookiePath(host.env, host.userHome),
  );
  const loadedConfig = await loadConfig({
    home: daemonHome,
    onWarn: (message) => io.stderr.write(`${message}\n`),
  });
  const authBackend = createAuthBackend(loadedConfig.config, {
    agencHome: daemonHome,
    env: host.env,
  });
  const sessionManager = new AgenCDaemonSessionManager();
  const clientMultiplexer = new AgenCDaemonClientMultiplexer({
    sessionManager,
  });
  const commandExec = new AgenCCommandExecService();
  const cleanup = new AgenCCleanupRegistry();
  const runner = new AgenCDelegateBackgroundAgentRunner({
    env: host.env,
    argv: [host.execPath, host.entrypointPath, "--autonomous"],
  });
  const agentManager = new AgenCDaemonAgentManager({
    runner,
    sessionManager,
    defaultCwd: () => process.cwd(),
    snapshotFlush: (snapshot) =>
      writeAgenCDaemonSnapshot(snapshotPath, snapshot),
    broadcastSessionEvent: async (sessionId, event) => {
      await clientMultiplexer.broadcastSessionEvent(sessionId, event);
    },
  });
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager,
    clientMultiplexer,
    commandExec,
    authBackend,
    initializeAuthenticator: (params) => params.authCookie === daemonCookie,
  });
  const connections = new Map<number, AgenCDaemonJsonRpcConnection>();
  const socketConnections = new Map<
    number,
    { readonly send: (message: JsonObject) => Promise<void> }
  >();
  let shuttingDown = false;
  const connectionFor = (connectionId: number): AgenCDaemonJsonRpcConnection => {
    const current = connections.get(connectionId);
    if (current !== undefined) return current;
    const next = dispatcher.createConnection({
      sendNotification: async (message) => {
        await socketConnections.get(connectionId)?.send(message);
      },
    });
    connections.set(connectionId, next);
    return next;
  };
  const socketServer = new AgenCUnixSocketServer({
    socketPath,
    onMessage: async (message, context) => {
      if (shuttingDown) {
        await context.send(daemonShuttingDownResponse(message));
        return;
      }
      socketConnections.set(context.connectionId, {
        send: (notification) => context.send(notification),
      });
      await context.send(await connectionFor(context.connectionId).dispatch(message));
    },
    onError: (error) => {
      io.stderr.write(`agenc: daemon socket error: ${error.message}\n`);
    },
    onConnectionClosed: (connectionId) => {
      const connection = connections.get(connectionId);
      connections.delete(connectionId);
      socketConnections.delete(connectionId);
      void connection?.close().catch(() => {});
      for (const clientId of connection?.trackedClientIds ?? []) {
        void clientMultiplexer.removeClient(clientId).catch(() => {});
      }
    },
  });
  cleanup.register("daemon-pid", async () => {
    await removeAgenCDaemonPid(pidPath, host.pid);
  });
  cleanup.register("daemon-snapshots", async () => {
    await agentManager.flushSnapshots("daemon_shutdown");
  });
  cleanup.register("daemon-agents", async () => {
    await agentManager.stopAll("daemon_shutdown");
  });
  cleanup.register("daemon-command-exec", async () => {
    await commandExec.closeAll("daemon_shutdown");
  });
  cleanup.register("daemon-connections", async () => {
    const activeConnections = [...connections.values()];
    connections.clear();
    socketConnections.clear();
    await Promise.all(activeConnections.map((connection) => connection.close()));
  });
  cleanup.register("daemon-socket", async () => {
    await socketServer.close();
  });

  const shutdownSignal = installAgenCShutdownSignalHandlers(
    (event) => {
      shuttingDown = true;
      io.stderr.write(`${summarizeAgenCShutdown(event)}\n`);
    },
    options.signalProcess ?? process,
  );
  let exitCode = 0;
  let cleanupContext:
    | { readonly reason: "daemon_shutdown" }
    | Awaited<typeof shutdownSignal.completed> = { reason: "daemon_shutdown" };
  try {
    await socketServer.listen();
    await options.beforeDaemonReady?.();
    if (!shuttingDown) {
      await writeAgenCDaemonPid(pidPath, host.pid);
    }
    if (!shuttingDown) {
      io.stdout.write(`AgenC daemon running (pid ${host.pid})\n`);
    }

    const event = await shutdownSignal.completed;
    cleanupContext = event;
    exitCode = event.exitCode;
  } finally {
    shuttingDown = true;
    shutdownSignal.dispose();
    const results = await cleanup.run(cleanupContext);
    const failed = results.filter((result) => !result.ok);
    if (failed.length > 0) {
      for (const failure of failed) {
        io.stderr.write(
          `agenc: cleanup[${failure.name}] failed: ${formatCleanupError(failure.error)}\n`,
        );
      }
      if (exitCode === 0) exitCode = 1;
    }
  }
  return exitCode;
}

async function waitForPidExit(
  host: AgenCDaemonCliHost,
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (!host.isPidRunning(pid)) return true;
    await host.sleep(25);
  }
  return !host.isPidRunning(pid);
}

export async function readAgenCDaemonPid(
  pidPath: string,
): Promise<number | null> {
  try {
    const raw = (await readFile(pidPath, "utf8")).trim();
    const pid = Number.parseInt(raw, 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if (asNodeError(error).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeAgenCDaemonPid(
  pidPath: string,
  pid: number,
): Promise<void> {
  await mkdir(dirname(pidPath), { recursive: true, mode: 0o700 });
  await writeFile(pidPath, `${pid}\n`, { mode: 0o600 });
}

export async function removeAgenCDaemonPid(
  pidPath: string,
  expectedPid?: number,
): Promise<void> {
  if (expectedPid !== undefined) {
    const currentPid = await readAgenCDaemonPid(pidPath);
    if (currentPid !== expectedPid) return;
  }
  await rm(pidPath, { force: true });
}

export async function ensureAgenCDaemonCookie(
  cookiePath: string,
): Promise<string> {
  try {
    const existing = (await readFile(cookiePath, "utf8")).trim();
    if (existing.length > 0) {
      await chmod(cookiePath, 0o600).catch(() => {});
      return existing;
    }
  } catch (error) {
    if (asNodeError(error).code !== "ENOENT") throw error;
  }

  const cookie = randomBytes(32).toString("hex");
  await mkdir(dirname(cookiePath), { recursive: true, mode: 0o700 });
  await writeFile(cookiePath, `${cookie}\n`, { mode: 0o600 });
  return cookie;
}

export async function writeAgenCDaemonSnapshot(
  snapshotPath: string,
  snapshot: AgenCDaemonAgentSnapshotFlush,
): Promise<void> {
  await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function createNodeDaemonCliHost(): AgenCDaemonCliHost {
  const entrypointPath = process.argv[1] ?? "";
  return {
    env: process.env,
    userHome: homedir(),
    entrypointPath,
    execPath: process.execPath,
    pid: process.pid,
    spawnDetachedDaemon: (env) => {
      const child = spawn(process.execPath, [entrypointPath, "daemon", "run"], {
        detached: true,
        env,
        stdio: "ignore",
      });
      child.unref();
      if (child.pid === undefined) {
        throw new Error("AgenC daemon child process did not expose a pid");
      }
      return child.pid;
    },
    isPidRunning: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    terminatePid: (pid) => {
      process.kill(pid, "SIGTERM");
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function asNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error : new Error(String(error));
}

function daemonShuttingDownResponse(message: JsonObject): JsonObject {
  return {
    jsonrpc: JSON_RPC_VERSION,
    ...(message.id !== undefined ? { id: message.id } : {}),
    error: {
      code: -32000,
      message: "AgenC daemon is shutting down",
    },
  };
}

function formatCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
