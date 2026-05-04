/**
 * AgenC daemon CLI controls.
 *
 * F-03i owns the local process controls only: start, stop, status, restart,
 * and the pid file. Request dispatch and health probes are wired by later
 * daemon rows.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgenCDaemonAgentManager,
  type AgenCDaemonAgentRunSnapshot,
  type AgenCDaemonAgentLogThreadStoreRoute,
  type AgenCDaemonAgentSnapshotFlush,
  type AgenCDaemonAgentStatusSnapshot,
  type AgenCDaemonMessageExchangeSnapshot,
  type AgenCDaemonSnapshotSessionRoute,
} from "./agent-lifecycle.js";
import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBackgroundAgentRunner,
} from "./background-agent-runner.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCCommandExecService } from "./command-exec.js";
import {
  AgenCDaemonJsonRpcDispatcher,
  type AgenCDaemonJsonRpcConnection,
} from "./daemon-dispatcher.js";
import {
  JSON_RPC_VERSION,
  type AgentStatus,
  type AgentToolOutputLog,
  type JsonObject,
  type JsonValue,
  type SessionStatus,
} from "./protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import { AgenCUnixSocketServer } from "./transport/unix-socket.js";
import {
  AgenCDaemonCookieAuthenticator,
  ensureAgenCDaemonCookie,
} from "./transport/auth.js";
import { AgenCDaemonHealthService } from "./health.js";
import {
  AgenCCleanupRegistry,
  installAgenCShutdownSignalHandlers,
  summarizeAgenCShutdown,
  type AgenCSignalProcess,
} from "../lifecycle/index.js";
import { createAuthBackend } from "../auth/index.js";
import type { AuthBackend } from "../auth/backend.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { createPermissionAuditFileLogger } from "../permissions/permission-audit-log.js";
import {
  loadConfig,
  type AgenCConfig,
  type AgentRunRetentionConfig,
} from "../config/index.js";
import {
  recoverDaemonStateOnStartup,
  type DaemonStartupRecoveryReport,
  type RecoveredInFlightToolCall,
  type RecoveredAgentRun,
  type RecoveredSessionStateSnapshot,
  type ToolRecoveryAction,
} from "../state/recovery.js";
import {
  pruneSessionStateSnapshots,
  pruneTerminalAgentRuns,
} from "../state/pruning.js";
import { StateSqliteHealthStatsReader } from "../state/health-stats.js";
import { upsertAgentRun } from "../state/agent-runs.js";
import { AgenCSessionSnapshotPolicy } from "../state/snapshot-policy.js";
import { readRotatedToolOutputLog } from "../state/tool-output-rotation.js";
import {
  discoverStateDatabasePaths,
  LOGS_DATABASE_FILENAME,
  openStateDatabasePaths,
  resolveStateDatabasePaths,
  STATE_DATABASE_FILENAME,
  type StateDatabasePaths,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";
import { FileThreadStore } from "../thread-store/index.js";
import type { LLMContentPart, LLMMessage } from "../llm/types.js";

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
  readonly runner?: AgenCBackgroundAgentRunner;
  readonly snapshotPeriodicIntervalMs?: number;
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
  return join(
    resolveAgenCDaemonHome(env, userHome),
    AGENC_DAEMON_COOKIE_FILENAME,
  );
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
    "       agenc daemon start --foreground",
    "",
    "Commands:",
    "  start                 Start the local AgenC daemon",
    "  start --foreground    Run the daemon in the current process",
    "  stop                  Stop the local AgenC daemon",
    "  status                Show local AgenC daemon status",
    "  restart               Stop and start the local AgenC daemon",
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
    const extra = argv.slice(2);
    if (action === "start" && extra[0] === "--foreground") {
      if (extra.length === 1) {
        return { kind: "command", action: "run" };
      }
      return {
        kind: "error",
        message: `unknown daemon start option: ${extra[1]}`,
      };
    }
    if (extra.length > 0) {
      return {
        kind: "error",
        message: `unknown daemon ${action} option: ${extra[0]}`,
      };
    }
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
        runner: options.runner,
        snapshotPeriodicIntervalMs: options.snapshotPeriodicIntervalMs,
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
  if ((await tryResolveAgenCDaemonAuthStartup(host, io)) === null) {
    return 1;
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
    readonly runner?: AgenCBackgroundAgentRunner;
    readonly snapshotPeriodicIntervalMs?: number;
  } = {},
): Promise<number> {
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const authStartup = await tryResolveAgenCDaemonAuthStartup(host, io);
  if (authStartup === null) {
    return 1;
  }
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  const snapshotPath = resolveAgenCDaemonSnapshotPath(host.env, host.userHome);
  const daemonCookie = await ensureAgenCDaemonCookie(
    resolveAgenCDaemonCookiePath(host.env, host.userHome),
  );
  const cookieAuthenticator = new AgenCDaemonCookieAuthenticator(daemonCookie);
  let startupRecovery: DaemonStartupRecoveryReport;
  try {
    startupRecovery = recoverAgenCDaemonStartupState(
      authStartup.daemonHome,
      process.cwd(),
      authStartup.config,
    );
    reportAgenCDaemonStartupRecovery(io, startupRecovery);
  } catch (error) {
    io.stderr.write(
      `agenc: daemon state recovery failed: ${formatCleanupError(error)}\n`,
    );
    return 1;
  }
  const threadStore = new FileThreadStore({
    cwd: process.cwd(),
    agencHome: authStartup.daemonHome,
  });
  const sessionManager = new AgenCDaemonSessionManager({ threadStore });
  const clientMultiplexer = new AgenCDaemonClientMultiplexer({
    sessionManager,
  });
  const commandExec = new AgenCCommandExecService();
  const cleanup = new AgenCCleanupRegistry();
  let shuttingDown = false;
  const runner =
    options.runner ??
    new AgenCDelegateBackgroundAgentRunner({
      env: host.env,
      argv: [host.execPath, host.entrypointPath, "--autonomous"],
      authBackend: authStartup.authBackend,
      agentBudget: authStartup.config.agent?.budget,
    });
  let snapshotPolicies: AgenCDaemonSnapshotPolicyRegistry;
  try {
    snapshotPolicies = new AgenCDaemonSnapshotPolicyRegistry({
      agencHome: authStartup.daemonHome,
      defaultCwd: process.cwd(),
      snapshotRetention: authStartup.config.agent?.retention,
      periodicIntervalMs: options.snapshotPeriodicIntervalMs,
      onError: (error) =>
        io.stderr.write(
          `agenc: daemon snapshot policy failed: ${formatCleanupError(error)}\n`,
        ),
    });
  } catch (error) {
    io.stderr.write(
      `agenc: daemon snapshot policy initialization failed: ${formatCleanupError(error)}\n`,
    );
    return 1;
  }
  const agentManager = new AgenCDaemonAgentManager({
    runner,
    sessionManager,
    threadStore,
    defaultCwd: () => process.cwd(),
    snapshotFlush: (snapshot) =>
      writeAgenCDaemonSnapshot(snapshotPath, snapshot),
    broadcastSessionEvent: async (sessionId, event) => {
      try {
        snapshotPolicies.recordSessionEvent(sessionId, event);
      } catch (error) {
        io.stderr.write(
          `agenc: daemon snapshot policy failed: ${formatCleanupError(error)}\n`,
        );
      }
      await clientMultiplexer.broadcastSessionEvent(sessionId, event);
    },
    recordMessageExchange: (exchange) => {
      try {
        snapshotPolicies.recordMessageExchange(exchange);
      } catch (error) {
        io.stderr.write(
          `agenc: daemon snapshot policy failed: ${formatCleanupError(error)}\n`,
        );
      }
    },
    recordAgentStatusTransition: (transition) => {
      try {
        snapshotPolicies.recordAgentStatusTransition(transition);
      } catch (error) {
        io.stderr.write(
          `agenc: daemon snapshot policy failed: ${formatCleanupError(error)}\n`,
        );
      }
    },
    recordAgentRun: (run) => {
      try {
        snapshotPolicies.recordAgentRun(run);
      } catch (error) {
        io.stderr.write(
          `agenc: daemon snapshot policy failed: ${formatCleanupError(error)}\n`,
        );
        throw error;
      }
    },
    registerSnapshotSession: (session) => {
      try {
        snapshotPolicies.registerSession(session);
      } catch (error) {
        io.stderr.write(
          `agenc: daemon snapshot policy failed: ${formatCleanupError(error)}\n`,
        );
      }
    },
    threadStoreForAgentLogs: (route) =>
      snapshotPolicies.threadStoreForAgentLogs(route),
    readAgentToolOutputs: ({ agentId, sessionIds }) =>
      snapshotPolicies.readAgentToolOutputs({ agentId, sessionIds }),
    onSnapshotError: (error) =>
      io.stderr.write(
        `agenc: daemon snapshot policy failed: ${formatCleanupError(error)}\n`,
      ),
    permissionAuditLogger: createPermissionAuditFileLogger({
      agencHome: authStartup.daemonHome,
    }),
    onPermissionAuditError: (error) =>
      io.stderr.write(
        `agenc: permission audit log failed: ${formatCleanupError(error)}\n`,
      ),
  });
  try {
    snapshotPolicies.hydrateStartupRecovery(startupRecovery);
    snapshotPolicies.startPeriodic();
  } catch (error) {
    snapshotPolicies.close();
    io.stderr.write(
      `agenc: daemon snapshot policy initialization failed: ${formatCleanupError(error)}\n`,
    );
    return 1;
  }
  await hydrateAgenCDaemonStartupRecovery(
    sessionManager,
    agentManager,
    runner,
    startupRecovery,
    {
      recordReplayToolResult: (result) =>
        snapshotPolicies.recordSessionEvent(result.sessionId, {
          method: "event.session_event",
          params: {
            agentId: result.agentId,
            event: {
              type:
                result.terminalStatus === "poisoned"
                  ? "tool_call_recovery_poisoned"
                  : "tool_call_completed",
              payload: {
                callId: result.callId,
                result: result.result,
                isError: result.isError,
                metadata: {
                  toolName: result.toolName,
                  ...(result.recoveryCategory !== undefined
                    ? { recoveryCategory: result.recoveryCategory }
                    : {}),
                },
              },
            },
          },
        }),
    },
  );
  const health = new AgenCDaemonHealthService({
    sessionCounter: sessionManager,
    stateCounter: new StateSqliteHealthStatsReader(
      resolveStateDatabasePaths({
        cwd: process.cwd(),
        agencHome: authStartup.daemonHome,
      }),
    ),
    ready: () => !shuttingDown,
  });
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager,
    clientMultiplexer,
    commandExec,
    authBackend: authStartup.authBackend,
    health,
    initializeAuthenticator: (params) =>
      cookieAuthenticator.authenticateInitializeParams(params),
  });
  const connections = new Map<number, AgenCDaemonJsonRpcConnection>();
  const socketConnections = new Map<
    number,
    { readonly send: (message: JsonObject) => Promise<void> }
  >();
  const connectionFor = (
    connectionId: number,
  ): AgenCDaemonJsonRpcConnection => {
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
      const response = await connectionFor(context.connectionId).dispatch(
        message,
      );
      await context.send(response);
      if (isDaemonConnectionAuthenticationFailure(response)) {
        context.close();
      }
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
  cleanup.register("daemon-snapshot-policy", async () => {
    snapshotPolicies.close();
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
  cleanup.register("daemon-thread-store", async () => {
    threadStore.close();
  });
  cleanup.register("daemon-connections", async () => {
    const activeConnections = [...connections.values()];
    connections.clear();
    socketConnections.clear();
    await Promise.all(
      activeConnections.map((connection) => connection.close()),
    );
  });
  cleanup.register("daemon-socket", async () => {
    await socketServer.close();
  });

  const shutdownSignal = installAgenCShutdownSignalHandlers((event) => {
    shuttingDown = true;
    io.stderr.write(`${summarizeAgenCShutdown(event)}\n`);
  }, options.signalProcess ?? process);
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

function recoverAgenCDaemonStartupState(
  daemonHome: string,
  cwd: string,
  config: AgenCConfig,
): DaemonStartupRecoveryReport {
  const recoveredAt = new Date().toISOString();
  const paths = uniqueStateDatabasePaths([
    ...discoverStateDatabasePaths(daemonHome),
    resolveStateDatabasePaths({ cwd, agencHome: daemonHome }),
  ]);
  const recoveredRuns: RecoveredAgentRun[] = [];
  const recoveredToolCalls: RecoveredInFlightToolCall[] = [];
  const warnings: DaemonStartupRecoveryReport["warnings"][number][] = [];

  for (const pathSet of paths) {
    const driver = openStateDatabasePaths(pathSet);
    try {
      pruneTerminalAgentRuns(driver, config.agent?.retention);
      pruneSessionStateSnapshots(driver, config.agent?.retention);
      const report = recoverDaemonStateOnStartup(driver, {
        now: () => recoveredAt,
      });
      recoveredRuns.push(...report.recoveredRuns);
      recoveredToolCalls.push(...report.recoveredToolCalls);
      warnings.push(...report.warnings);
    } finally {
      driver.close();
    }
  }

  return {
    recoveredAt,
    recoveredRuns,
    recoveredToolCalls,
    warnings,
  };
}

function uniqueStateDatabasePaths(
  paths: readonly StateDatabasePaths[],
): StateDatabasePaths[] {
  const byStateDb = new Map<string, StateDatabasePaths>();
  for (const pathSet of paths) {
    byStateDb.set(pathSet.stateDbPath, pathSet);
  }
  return [...byStateDb.values()].sort((left, right) =>
    left.projectDir.localeCompare(right.projectDir),
  );
}

interface AgenCDaemonSnapshotPolicyRegistryOptions {
  readonly agencHome: string;
  readonly defaultCwd: string;
  readonly snapshotRetention?: AgentRunRetentionConfig;
  readonly periodicIntervalMs?: number;
  readonly onError: (error: unknown) => void;
}

interface AgenCDaemonSnapshotPolicyEntry {
  readonly driver: StateSqliteDriver;
  readonly policy: AgenCSessionSnapshotPolicy;
}

class AgenCDaemonSnapshotPolicyRegistry {
  readonly #agencHome: string;
  readonly #defaultCwd: string;
  readonly #snapshotRetention: AgentRunRetentionConfig | undefined;
  readonly #periodicIntervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #policies = new Map<string, AgenCDaemonSnapshotPolicyEntry>();
  readonly #sessionPolicyKeys = new Map<string, string>();
  readonly #threadStores = new Map<string, FileThreadStore>();
  #periodicTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AgenCDaemonSnapshotPolicyRegistryOptions) {
    this.#agencHome = options.agencHome;
    this.#defaultCwd = options.defaultCwd;
    this.#snapshotRetention = options.snapshotRetention;
    this.#periodicIntervalMs = options.periodicIntervalMs ?? 30_000;
    this.#onError = options.onError;
    this.#policyForCwd(this.#defaultCwd);
  }

  hydrateStartupRecovery(report: DaemonStartupRecoveryReport): void {
    for (const run of report.recoveredRuns) {
      if (run.currentSessionId === undefined) continue;
      const policy = this.#policyForProjectDir(run.projectDir);
      this.#rememberSession(run.currentSessionId, policy.driver.stateDbPath);
      policy.policy.trackSession(run.currentSessionId, run.id);
      if (run.latestSnapshot !== undefined) {
        policy.policy.hydrateSession({
          sessionId: run.currentSessionId,
          snapshotAt: run.latestSnapshot.snapshotAt,
          conversation: run.latestSnapshot.conversation,
          toolState: run.latestSnapshot.toolState,
          mcpConnectionState: run.latestSnapshot.mcpConnectionState,
        });
      }
    }
  }

  startPeriodic(): void {
    if (this.#periodicTimer !== undefined) return;
    this.#periodicTimer = setInterval(() => {
      try {
        this.flushPeriodic();
      } catch (error) {
        this.#onError(error);
      }
    }, this.#periodicIntervalMs);
    this.#periodicTimer.unref?.();
  }

  flushPeriodic(): void {
    for (const entry of this.#policies.values()) {
      entry.policy.flushPeriodic();
    }
  }

  close(): void {
    if (this.#periodicTimer !== undefined) {
      clearInterval(this.#periodicTimer);
      this.#periodicTimer = undefined;
    }
    for (const entry of this.#policies.values()) {
      entry.driver.close();
    }
    for (const store of this.#threadStores.values()) {
      store.close();
    }
    this.#policies.clear();
    this.#sessionPolicyKeys.clear();
    this.#threadStores.clear();
  }

  recordSessionEvent(sessionId: string, event: JsonObject): void {
    const entry = this.#policyForSession(sessionId);
    entry.policy.recordSessionEvent(sessionId, event);
  }

  registerSession(session: AgenCDaemonSnapshotSessionRoute): void {
    const entry = this.#policyForRoute(session);
    this.#rememberSession(session.sessionId, entry.driver.stateDbPath);
    entry.policy.trackSession(session.sessionId, session.agentId);
  }

  recordMessageExchange(exchange: AgenCDaemonMessageExchangeSnapshot): void {
    const entry = this.#policyForRoute(exchange);
    this.#rememberSession(exchange.sessionId, entry.driver.stateDbPath);
    entry.policy.recordMessageExchange(exchange);
  }

  recordAgentStatusTransition(
    transition: AgenCDaemonAgentStatusSnapshot,
  ): void {
    const entry = this.#policyForRoute(transition);
    this.#rememberSession(transition.sessionId, entry.driver.stateDbPath);
    entry.policy.recordAgentStatusTransition(transition);
  }

  recordAgentRun(run: AgenCDaemonAgentRunSnapshot): void {
    const entry = this.#policyForRoute(run);
    upsertAgentRun(entry.driver, run);
    if (run.currentSessionId !== undefined) {
      this.#rememberSession(run.currentSessionId, entry.driver.stateDbPath);
      entry.policy.trackSession(run.currentSessionId, run.id);
    }
  }

  threadStoreForAgentLogs(
    route: AgenCDaemonAgentLogThreadStoreRoute,
  ): FileThreadStore {
    return this.#threadStoreForRoute(route);
  }

  readAgentToolOutputs(params: {
    readonly agentId: string;
    readonly sessionIds: readonly string[];
  }): readonly AgentToolOutputLog[] {
    void params.agentId;
    const outputs: AgentToolOutputLog[] = [];
    for (const sessionId of params.sessionIds) {
      const entry = this.#policyForSession(sessionId);
      const rows = entry.driver
        .prepareState<
          [string],
          {
            tool_call_id: string;
            tool_name: string;
            status: string;
            output_partial: string | null;
            output_log_path: string | null;
            output_log_bytes: number;
            started_at: string;
          }
        >(
          `SELECT
             tool_call_id,
             tool_name,
             status,
             output_partial,
             output_log_path,
             output_log_bytes,
             started_at
           FROM in_flight_tool_calls
           WHERE session_id = ?
           ORDER BY started_at ASC, tool_call_id ASC`,
        )
        .all(sessionId);
      for (const row of rows) {
        const rotated =
          row.output_log_path === null
            ? ""
            : readRotatedToolOutputLog(row.output_log_path);
        const output = `${row.output_partial ?? ""}${rotated}`;
        outputs.push({
          sessionId,
          toolCallId: row.tool_call_id,
          toolName: row.tool_name,
          status: row.status,
          output,
          outputBytes: Buffer.byteLength(output, "utf8"),
          ...(row.output_log_path !== null
            ? { outputLogPath: row.output_log_path }
            : {}),
          ...(row.output_log_bytes > 0
            ? { outputLogBytes: row.output_log_bytes }
            : {}),
        });
      }
    }
    return outputs;
  }

  #policyForSession(sessionId: string): AgenCDaemonSnapshotPolicyEntry {
    const key = this.#sessionPolicyKeys.get(sessionId);
    if (key !== undefined) {
      const entry = this.#policies.get(key);
      if (entry !== undefined) return entry;
    }
    const entry = this.#policyForCwd(this.#defaultCwd);
    this.#rememberSession(sessionId, entry.driver.stateDbPath);
    return entry;
  }

  #policyForRoute(route: {
    readonly cwd?: string;
    readonly stateProjectDir?: string;
  }): AgenCDaemonSnapshotPolicyEntry {
    if (route.stateProjectDir !== undefined) {
      return this.#policyForProjectDir(route.stateProjectDir);
    }
    return this.#policyForCwd(route.cwd ?? this.#defaultCwd);
  }

  #threadStoreForRoute(route: {
    readonly cwd?: string;
    readonly stateProjectDir?: string;
  }): FileThreadStore {
    const key =
      route.stateProjectDir !== undefined
        ? `project:${route.stateProjectDir}`
        : `cwd:${route.cwd ?? this.#defaultCwd}`;
    const existing = this.#threadStores.get(key);
    if (existing !== undefined) return existing;
    const store =
      route.stateProjectDir !== undefined
        ? new FileThreadStore({
            projectDir: route.stateProjectDir,
            agencHome: this.#agencHome,
          })
        : new FileThreadStore({
            cwd: route.cwd ?? this.#defaultCwd,
            agencHome: this.#agencHome,
          });
    this.#threadStores.set(key, store);
    return store;
  }

  #policyForCwd(cwd: string): AgenCDaemonSnapshotPolicyEntry {
    return this.#policyForPaths(
      resolveStateDatabasePaths({ cwd, agencHome: this.#agencHome }),
    );
  }

  #policyForProjectDir(projectDir: string): AgenCDaemonSnapshotPolicyEntry {
    return this.#policyForPaths({
      projectDir,
      stateDbPath: join(projectDir, STATE_DATABASE_FILENAME),
      logsDbPath: join(projectDir, LOGS_DATABASE_FILENAME),
    });
  }

  #policyForPaths(paths: StateDatabasePaths): AgenCDaemonSnapshotPolicyEntry {
    const existing = this.#policies.get(paths.stateDbPath);
    if (existing !== undefined) return existing;
    const driver = openStateDatabasePaths(paths);
    const policy = new AgenCSessionSnapshotPolicy(driver, {
      agencHome: this.#agencHome,
      snapshotRetention: this.#snapshotRetention,
      onError: this.#onError,
    });
    const entry = { driver, policy };
    this.#policies.set(paths.stateDbPath, entry);
    return entry;
  }

  #rememberSession(sessionId: string, stateDbPath: string): void {
    this.#sessionPolicyKeys.set(sessionId, stateDbPath);
  }
}

async function hydrateAgenCDaemonStartupRecovery(
  sessionManager: AgenCDaemonSessionManager,
  agentManager: AgenCDaemonAgentManager,
  runner: AgenCBackgroundAgentRunner,
  report: DaemonStartupRecoveryReport,
  options: {
    readonly recordReplayToolResult?: (
      result: RecoveredReplayToolResult,
    ) => void | Promise<void>;
  } = {},
): Promise<void> {
  for (const run of report.recoveredRuns) {
    const runtimeAvailable = await restoreRecoveredAgentRuntime(
      runner,
      run,
      options,
    );
    const metadata = recoveryMetadataForRun(report, run, runtimeAvailable);
    if (run.currentSessionId !== undefined) {
      await sessionManager.restoreSession({
        sessionId: run.currentSessionId,
        agentId: run.id,
        status: sessionStatusForRecoveredRun(run),
        createdAt: run.startedAt,
        initialPrompt: run.objective,
        metadata,
      });
    }
    await agentManager.restoreAgent({
      agentId: run.id,
      objective: run.objective,
      status: agentStatusForRecoveredRun(run),
      createdAt: run.startedAt,
      startedAt: run.startedAt,
      lastActiveAt: run.lastActiveAt,
      stateProjectDir: run.projectDir,
      metadata,
      runtimeAvailable,
      ...(run.currentSessionId !== undefined
        ? { sessionIds: [run.currentSessionId] }
        : {}),
    });
  }
}

interface RecoveredReplayToolResult {
  readonly agentId: string;
  readonly sessionId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly result: string;
  readonly isError: boolean;
  readonly terminalStatus?: "completed" | "failed" | "poisoned";
  readonly recoveryCategory?: ToolRecoveryCategory;
}

function agentStatusForRecoveredRun(_run: RecoveredAgentRun): AgentStatus {
  return "idle";
}

function sessionStatusForRecoveredRun(_run: RecoveredAgentRun): SessionStatus {
  return "waiting";
}

function recoveryMetadataForRun(
  report: DaemonStartupRecoveryReport,
  run: RecoveredAgentRun,
  runtimeAvailable: boolean,
): JsonObject {
  return {
    recovery: {
      recoveredAt: report.recoveredAt,
      projectDir: run.projectDir,
      runStatus: run.status,
      runnable: runtimeAvailable,
      runtimeRestore: runtimeAvailable ? "available" : "unavailable",
      toolRecoveryMode: "category_policy",
      ...(run.createdByClient !== undefined
        ? { createdByClient: run.createdByClient }
        : {}),
      ...(run.latestSnapshot !== undefined
        ? { snapshot: recoverySnapshotMetadata(run.latestSnapshot) }
        : {}),
    },
  };
}

async function restoreRecoveredAgentRuntime(
  runner: AgenCBackgroundAgentRunner,
  run: RecoveredAgentRun,
  options: {
    readonly recordReplayToolResult?: (
      result: RecoveredReplayToolResult,
    ) => void | Promise<void>;
  } = {},
): Promise<boolean> {
  if (!isRecoveredRunRuntimeRestorable(run)) return false;
  if (runner.restoreAgent === undefined) return false;
  const initialMessages = recoveredInitialMessages(run.latestSnapshot);
  const replayToolCalls = recoveredReplayToolCalls(run.latestSnapshot);
  try {
    return await runner.restoreAgent({
      agentId: run.id,
      objective: run.objective,
      cwd: run.projectDir,
      startedAt: run.startedAt,
      currentSessionId: run.currentSessionId,
      ...optionalMetadataString(run.metadata, "model"),
      ...optionalMetadataString(run.metadata, "provider"),
      ...optionalMetadataString(run.metadata, "profile"),
      ...(initialMessages !== undefined ? { initialMessages } : {}),
      ...(replayToolCalls.length > 0 ? { replayToolCalls } : {}),
      ...(options.recordReplayToolResult !== undefined
        ? {
            onReplayToolResult: (result) =>
              options.recordReplayToolResult?.({
                agentId: run.id,
                ...result,
              }),
          }
        : {}),
      metadata: {
        ...(run.metadata ?? {}),
        recovery: true,
        runStatus: run.status,
        ...(run.lastSnapshotAt !== undefined
          ? { lastSnapshotAt: run.lastSnapshotAt }
          : {}),
      },
    });
  } catch {
    return false;
  }
}

function recoveredReplayToolCalls(
  snapshot: RecoveredSessionStateSnapshot | undefined,
): Array<{ readonly callId: string; readonly toolName: string; readonly args: JsonValue }> {
  if (snapshot === undefined) return [];
  return snapshot.recoveredToolCalls
    .filter((call) => call.recoveryAction === "replay")
    .filter((call) => call.args !== undefined)
    .map((call) => ({
      callId: call.toolCallId,
      toolName: call.toolName,
      args: call.args as JsonValue,
    }));
}

function isRecoveredRunRuntimeRestorable(run: RecoveredAgentRun): boolean {
  return (
    run.currentSessionId !== undefined &&
    run.latestSnapshot !== undefined &&
    typeof run.metadata?.agentPath === "string" &&
    run.metadata.agentPath.trim().length > 0
  );
}

function optionalMetadataString(
  metadata: JsonObject | undefined,
  key: string,
): Record<string, string> {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim().length > 0
    ? { [key]: value.trim() }
    : {};
}

function recoverySnapshotMetadata(
  snapshot: RecoveredSessionStateSnapshot,
): JsonObject {
  return {
    projectDir: snapshot.projectDir,
    sessionId: snapshot.sessionId,
    snapshotAt: snapshot.snapshotAt,
    conversation: snapshot.conversation as JsonValue,
    toolState: snapshot.toolState as JsonValue,
    mcpConnectionState: snapshot.mcpConnectionState as JsonValue,
    recoveredToolCalls: snapshot.recoveredToolCalls.map(recoveryToolCallMetadata),
  };
}

function recoveredInitialMessages(
  snapshot: RecoveredSessionStateSnapshot | undefined,
): ReadonlyArray<LLMMessage> | undefined {
  const conversation = snapshot?.conversation;
  if (!Array.isArray(conversation)) return undefined;
  const messages = conversation
    .map(recoveredMessage)
    .filter((message): message is LLMMessage => message !== undefined);
  return messages.length > 0 ? messages : undefined;
}

function recoveredMessage(value: unknown): LLMMessage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    readonly role?: unknown;
    readonly content?: unknown;
    readonly phase?: unknown;
    readonly toolCalls?: unknown;
    readonly toolCallId?: unknown;
    readonly toolName?: unknown;
  };
  if (
    candidate.role !== "system" &&
    candidate.role !== "user" &&
    candidate.role !== "assistant" &&
    candidate.role !== "tool"
  ) {
    return undefined;
  }
  const content =
    typeof candidate.content === "string"
      ? candidate.content
      : Array.isArray(candidate.content)
        ? recoveredContentParts(candidate.content)
        : "";
  return {
    role: candidate.role,
    content,
    ...(candidate.phase === "commentary" ||
    candidate.phase === "final_answer"
      ? { phase: candidate.phase }
      : {}),
    ...(Array.isArray(candidate.toolCalls)
      ? { toolCalls: candidate.toolCalls as LLMMessage["toolCalls"] }
      : {}),
    ...(typeof candidate.toolCallId === "string"
      ? { toolCallId: candidate.toolCallId }
      : {}),
    ...(typeof candidate.toolName === "string"
      ? { toolName: candidate.toolName }
      : {}),
  };
}

function recoveredContentParts(value: readonly unknown[]): LLMContentPart[] {
  const parts: LLMContentPart[] = [];
  for (const part of value) {
    if (part === null || typeof part !== "object" || Array.isArray(part)) {
      continue;
    }
    const candidate = part as {
      readonly type?: unknown;
      readonly text?: unknown;
      readonly image_url?: unknown;
      readonly source?: unknown;
      readonly title?: unknown;
      readonly filename?: unknown;
      readonly fallbackText?: unknown;
      readonly fallbackTextTruncated?: unknown;
      readonly fallbackTextError?: unknown;
    };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      parts.push({ type: "text", text: candidate.text });
      continue;
    }
    if (
      candidate.type === "image_url" &&
      candidate.image_url !== null &&
      typeof candidate.image_url === "object" &&
      !Array.isArray(candidate.image_url)
    ) {
      const image = candidate.image_url as { readonly url?: unknown };
      if (typeof image.url === "string") {
        parts.push({ type: "image_url", image_url: { url: image.url } });
      }
      continue;
    }
    if (
      candidate.type === "document" &&
      candidate.source !== null &&
      typeof candidate.source === "object" &&
      !Array.isArray(candidate.source)
    ) {
      const source = candidate.source as {
        readonly type?: unknown;
        readonly media_type?: unknown;
        readonly data?: unknown;
      };
      if (
        source.type === "base64" &&
        source.media_type === "application/pdf" &&
        typeof source.data === "string"
      ) {
        parts.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: source.data,
          },
          ...(typeof candidate.title === "string"
            ? { title: candidate.title }
            : {}),
          ...(typeof candidate.filename === "string"
            ? { filename: candidate.filename }
            : {}),
          ...(typeof candidate.fallbackText === "string"
            ? { fallbackText: candidate.fallbackText }
            : {}),
          ...(typeof candidate.fallbackTextTruncated === "boolean"
            ? { fallbackTextTruncated: candidate.fallbackTextTruncated }
            : {}),
          ...(typeof candidate.fallbackTextError === "string"
            ? { fallbackTextError: candidate.fallbackTextError }
            : {}),
        });
      }
    }
  }
  return parts;
}

function recoveryToolCallMetadata(call: RecoveredInFlightToolCall): JsonObject {
  return {
    projectDir: call.projectDir,
    sessionId: call.sessionId,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    statusBefore: call.statusBefore,
    statusAfter: call.statusAfter,
    recoveryCategory: call.recoveryCategory,
    recoveryAction: call.recoveryAction,
    startedAt: call.startedAt,
    ...(call.args !== undefined ? { args: call.args as JsonValue } : {}),
    ...(call.outputPartial !== undefined
      ? { outputPartial: call.outputPartial }
      : {}),
    ...(call.outputLogPath !== undefined
      ? { outputLogPath: call.outputLogPath }
      : {}),
    ...(call.outputLogBytes !== undefined
      ? { outputLogBytes: call.outputLogBytes }
      : {}),
  };
}

function reportAgenCDaemonStartupRecovery(
  io: AgenCDaemonCliIo,
  report: DaemonStartupRecoveryReport,
): void {
  if (report.recoveredRuns.length > 0) {
    io.stderr.write(
      `agenc: daemon recovery loaded ${report.recoveredRuns.length} agent run(s) from state\n`,
    );
  }
  const summary = summarizeToolRecoveryActions(report.recoveredToolCalls);
  if (report.recoveredToolCalls.length > 0) {
    io.stderr.write(
      `agenc: daemon recovery processed ${report.recoveredToolCalls.length} stale in-flight tool call(s): replay=${summary.replay}, poison=${summary.poison}, cancel=${summary.cancel}\n`,
    );
  }
  if (report.warnings.length > 0) {
    io.stderr.write(
      `agenc: daemon recovery emitted ${report.warnings.length} warning(s)\n`,
    );
  }
}

function summarizeToolRecoveryActions(
  calls: readonly RecoveredInFlightToolCall[],
): Record<ToolRecoveryAction, number> {
  const summary: Record<ToolRecoveryAction, number> = {
    replay: 0,
    poison: 0,
    cancel: 0,
  };
  for (const call of calls) summary[call.recoveryAction] += 1;
  return summary;
}

interface AgenCDaemonAuthStartup {
  readonly daemonHome: string;
  readonly config: AgenCConfig;
  readonly authBackend: AuthBackend;
}

async function tryResolveAgenCDaemonAuthStartup(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
): Promise<AgenCDaemonAuthStartup | null> {
  try {
    const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
    const loadedConfig = await loadConfig({
      home: daemonHome,
      onWarn: (message) => io.stderr.write(`${message}\n`),
    });
    return {
      daemonHome,
      config: loadedConfig.config,
      authBackend: createAuthBackend(loadedConfig.config, {
        agencHome: daemonHome,
        env: host.env,
      }),
    };
  } catch (error) {
    io.stderr.write(
      `agenc: daemon auth backend initialization failed: ${formatCleanupError(error)}\n`,
    );
    return null;
  }
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

export async function writeAgenCDaemonSnapshot(
  snapshotPath: string,
  snapshot: AgenCDaemonAgentSnapshotFlush,
): Promise<void> {
  await mkdir(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
    mode: 0o600,
  });
}

export { ensureAgenCDaemonCookie } from "./transport/auth.js";

export function createNodeDaemonCliHost(): AgenCDaemonCliHost {
  const entrypointPath = process.argv[1] ?? "";
  return {
    env: process.env,
    userHome: homedir(),
    entrypointPath,
    execPath: process.execPath,
    pid: process.pid,
    spawnDetachedDaemon: (env) => {
      const child = spawn(
        process.execPath,
        [entrypointPath, "daemon", "start", "--foreground"],
        {
          detached: true,
          env,
          stdio: "ignore",
        },
      );
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

function isDaemonConnectionAuthenticationFailure(message: JsonObject): boolean {
  const error = message.error;
  if (typeof error !== "object" || error === null || Array.isArray(error)) {
    return false;
  }
  const data = (error as { readonly data?: unknown }).data;
  return (
    typeof data === "object" &&
    data !== null &&
    !Array.isArray(data) &&
    (data as { readonly code?: unknown }).code ===
      "CONNECTION_AUTHENTICATION_FAILED"
  );
}

function formatCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
