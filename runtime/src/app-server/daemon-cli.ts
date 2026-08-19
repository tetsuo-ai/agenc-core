/**
 * AgenC daemon CLI controls.
 *
 * F-03i owns the local process controls only: start, stop, status, reload,
 * restart, and the pid file. Request dispatch and health probes are wired by
 * later daemon rows.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createDaemonWorkflowController } from "./workflow/daemon-wiring.js";
import { DaemonWorkflowStartService } from "./workflow/run-start-service.js";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
} from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  AgenCDaemonAgentManager,
  type AgenCDaemonAgentRunSnapshot,
  type AgenCDaemonAgentLogThreadStoreRoute,
  type AgenCDaemonAgentSnapshotFlush,
  type AgenCDaemonAgentStatusSnapshot,
  type AgenCDaemonMessageExchangeSnapshot,
  type AgenCDaemonRunTerminalSnapshot,
  type AgenCDaemonSnapshotSessionRoute,
} from "./agent-lifecycle.js";
import {
  AgenCDelegateBackgroundAgentRunner,
  type AgenCBackgroundAgentRunner,
  type AgenCDelegateBackgroundAgentRunnerRuntimeConfig,
} from "./background-agent-runner.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCCommandExecService } from "./command-exec.js";
import { CsvAgentJobsRepositoryAuthority } from "./csv-agent-jobs-authority.js";
import { AgenCCsvJobReviewStateService } from "./csv-job-review.js";
import { resolveDefaultLinuxSandboxExecutable } from "../sandbox/execution-broker.js";
import {
  daemonInstanceIdentityFromRuntimeInfo,
  readDaemonRuntimeInfo,
  readDistVersion,
  removeDaemonRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath,
  resolveRuntimePackageRootFromUrl,
  writeDaemonRuntimeInfo,
} from "./daemon-runtime-info.js";
import {
  findLinuxAgenCDaemonProcesses,
  inspectLinuxAgenCDaemonProcess,
  isAgenCDaemonInstanceIdentity,
  readAgenCDaemonProcessStart,
  sameAgenCDaemonInstanceIdentity,
  type AgenCDaemonInstanceIdentity,
  type AgenCDaemonProcessIdentity,
} from "./daemon-instance-identity.js";
import {
  AgenCDaemonJsonRpcDispatcher,
  type AgenCDaemonJsonRpcConnection,
} from "./daemon-dispatcher.js";
import { AgenCRealtimeRpcService } from "./realtime.js";
import {
  AgenCRealtimeCallClient,
  AgenCRealtimeWebSocketTransportConnector,
  type AgenCRealtimeHeadersProvider,
} from "./realtime-transport.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type AgentStatus,
  type AgentToolOutputLog,
  type AgenCDaemonErrorResponse,
  type AgenCDaemonResponse,
  type AgenCDaemonSuccessResponse,
  type DaemonReloadResult,
  type HealthMemoryStats,
  type HealthSessionStats,
  type HealthStateStats,
  type HealthStatsResult,
  type JsonObject,
  type JsonValue,
  type SessionStatus,
} from "./protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import {
  AgenCUnixSocketServer,
  agenCDaemonLocalEndpoint,
  canConnectToUnixSocket,
  isAgenCWindowsNamedPipePath,
} from "./transport/unix-socket.js";
import { AgenCWebSocketServer } from "./transport/websocket.js";
import {
  AgenCDaemonCookieAuthenticator,
  createAgenCDaemonPrivateSocketOwnerIdentity,
  createAgenCDaemonPeerUidIdentity,
  ensureAgenCDaemonCookie,
} from "./transport/auth.js";
import type { AgenCNativePeerCredentialBinding } from "./transport/peer-credentials.js";
import { AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT } from "../app-server-protocol/index.js";
import { AgenCDaemonHealthService } from "./health.js";
import { AgenCDaemonRunInspectionService } from "./run-inspection.js";
import { AgenCCleanupRegistry } from "../lifecycle/cleanup-registry.js";
import { closeAllBrowserManagers } from "../browser/manager.js";
import { installAgenCShutdownSignalHandlers } from "../lifecycle/signal-handlers.js";
import { summarizeAgenCShutdown } from "../lifecycle/shutdown-message.js";
import type { AgenCSignalProcess } from "../lifecycle/signal-handlers.js";
import { createAuthBackend } from "../auth/selection.js";
import type { AuthBackend } from "../auth/backend.js";
import type { ToolRecoveryCategory } from "../tools/types.js";
import { acquireLocalSqliteLock } from "../utils/sqlite-lock.js";
import { writeDurableAtomicFile } from "../utils/durable-atomic-file.js";
import {
  BoundedRegularFileError,
  readBoundedRegularFile,
} from "../utils/bounded-regular-file.js";
import {
  AGENC_DAEMON_STARTUP_GUARD_ENV,
  createAgenCDaemonStartupGuardController,
  createAgenCDaemonStartupGuardReceiver,
  takeAgenCDaemonStartupGuardToken,
  type AgenCDaemonStartupGuardChannel,
  type AgenCDaemonStartupGuardController,
  type AgenCDaemonStartupGuardReceiver,
} from "./daemon-startup-guard.js";
import { createPermissionAuditFileLogger } from "../permissions/permission-audit-log.js";
import { loadConfig } from "../config/loader.js";
import { resolveProviderBaseURL } from "../config/env.js";
import type { AgenCConfig, AgentRunRetentionConfig } from "../config/schema.js";
import { CodePredictionService } from "../services/code-prediction/service.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../llm/registry/provider-info.js";
import {
  prepareMcpSseServerReconfigurationFromConfig,
  resolveMcpServeDefaults,
  startMcpServerFromConfig,
  type StartedMcpSseServer,
} from "../mcp/server/start.js";
import {
  recoverDaemonStateOnStartup,
  StartupResumeSourceBudget,
  type DaemonStartupRecoveryReport,
  type RecoveredInFlightToolCall,
  type RecoveredAgentRun,
  type RecoveredSessionStateSnapshot,
  type ToolRecoveryAction,
} from "../state/recovery.js";
import {
  pruneSessionStateSnapshots,
  pruneTerminalAgentRuns,
  type RolloutRetentionPolicy,
} from "../state/pruning.js";
import { StateSqliteHealthStatsReader } from "../state/health-stats.js";
import { upsertAgentRun } from "../state/agent-runs.js";
import { StateRunDurabilityRepository } from "../state/run-durability.js";
import { hitM4DurabilityFailpoint } from "../durability/failpoints.js";
import type { CancelAgentRunTreeReport } from "../state/run-cancellation.js";
import { ExecutionAdmissionRepository } from "../state/execution-admission.js";
import { cancelRunTreeAndAdmission } from "../state/run-admission-cancellation.js";
import { ExecutionAdmissionKernel } from "../budget/execution-admission-kernel.js";
import { resolveAdmissionConcurrencyLimits } from "../budget/admission-config.js";
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
import { FileThreadStore } from "../thread-store/store.js";
import { MultiProjectFileThreadStore } from "../thread-store/multi-project-store.js";
import { resolveDaemonDefaultCwd } from "./daemon-workspace.js";
import type { LLMContentPart, LLMMessage } from "../llm/types.js";
import {
  classifyUntrustedToolResult,
  frameUntrustedToolHistoryMessages,
  frameUntrustedToolResultContent,
} from "../tools/untrusted-tool-result-framing.js";
import {
  createSizeCappedFileLogSink,
  type SizeCappedFileLogSink,
} from "../utils/logger.js";
import { configureGlobalAgents } from "../utils/proxy.js";
import { isRecord } from "../utils/record.js";
import { startHeapWatchdog } from "../services/heapWatchdog/heapWatchdog.js";

const AGENC_DAEMON_PID_FILENAME = "daemon.pid";
const AGENC_DAEMON_COOKIE_FILENAME = "daemon.cookie";
const AGENC_DAEMON_SNAPSHOT_FILENAME = "daemon-snapshot.json";
const AGENC_DAEMON_LOG_FILENAME = "daemon.log";
const AGENC_DAEMON_FORCE_STOP_GRACE_MS = 2_000;

/**
 * Env override (megabytes) for the detached daemon's V8 old-space cap, and the
 * default applied when unset. Without an explicit `--max-old-space-size`, V8
 * picks a heuristic ceiling (~4GB on 64-bit hosts) and a runaway allocation
 * crashes the whole process unpredictably. Setting a generous explicit cap
 * keeps a leak bounded and surfaced (OOM error) instead of taking down the host.
 */
const AGENC_DAEMON_MAX_OLD_SPACE_MB_ENV = "AGENC_DAEMON_MAX_OLD_SPACE_MB";
const DEFAULT_DAEMON_MAX_OLD_SPACE_MB = 4096;

function hasOperatorHeapSnapshotOption(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_OPTIONS?.includes("heapsnapshot-near-heap-limit") ?? false;
}

/**
 * Builds the node CLI args for the detached daemon child, prepending an
 * explicit `--max-old-space-size` (overridable via
 * {@link AGENC_DAEMON_MAX_OLD_SPACE_MB_ENV}) ahead of the entrypoint. Exported
 * for unit testing of the arg construction.
 */
export function buildAgenCDaemonChildNodeArgs(
  entrypointPath: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string[] {
  const configured = env[AGENC_DAEMON_MAX_OLD_SPACE_MB_ENV]?.trim();
  let maxOldSpaceMb = DEFAULT_DAEMON_MAX_OLD_SPACE_MB;
  if (configured !== undefined && configured.length > 0) {
    const parsed = Number(configured);
    if (Number.isFinite(parsed) && parsed > 0) {
      maxOldSpaceMb = Math.floor(parsed);
    }
  }
  const diagnosticDirectory = join(
    resolveAgenCDaemonHome(env, userHome),
    "oom-snapshots",
  );
  const diagnosticArgs = hasOperatorHeapSnapshotOption(env)
    ? []
    : [
        "--heapsnapshot-near-heap-limit=1",
        `--diagnostic-dir=${diagnosticDirectory}`,
      ];
  return [
    `--max-old-space-size=${maxOldSpaceMb}`,
    ...diagnosticArgs,
    entrypointPath,
    "daemon",
    "start",
    "--foreground",
  ];
}
const AGENC_DAEMON_WEBSOCKET_HOST_ENV = "AGENC_DAEMON_WEBSOCKET_HOST";
const AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK_ENV =
  "AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK";
export const AGENC_DAEMON_WEBSOCKET_PORT_ENV = "AGENC_DAEMON_WEBSOCKET_PORT";
const AGENC_DAEMON_WEBSOCKET_PATH_ENV = "AGENC_DAEMON_WEBSOCKET_PATH";
const AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV = "AGENC_DAEMON_REQUEST_TIMEOUT_MS";
const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 2_000;
const DEFAULT_DAEMON_STOP_TIMEOUT_MS = 10_000;
/**
 * Env override (ms) for how long the daemon readiness waits block, plus the
 * default applied when unset/invalid. This single name covers BOTH the bare
 * daemon controls (`start`/`restart`/`reload`, here) and the agent autostart
 * path (`waitForAgenCDaemonReady` in `daemon-autostart.ts`), which imports
 * {@link resolveAgenCDaemonReadyTimeoutMs} so both budgets stay in sync from
 * one resolved value.
 */
export const AGENC_DAEMON_READY_TIMEOUT_MS_ENV =
  "AGENC_DAEMON_READY_TIMEOUT_MS";
/**
 * Bound for how long the daemon readiness waits block for the detached daemon
 * to bind and accept on its control socket before giving up.
 *
 * Raised from 15s to 45s: a cold start has to pay the full hydration cost
 * (state recovery + MCP server start + `socketServer.listen()`) before it can
 * accept, which empirically lands at ~15-16.5s — leaving the old 15s budget with
 * near-zero margin and producing false "did not become ready before timeout"
 * failures on healthy daemons. 45s gives ~3x headroom; CI can tune it back down
 * via {@link AGENC_DAEMON_READY_TIMEOUT_MS_ENV}. A longer budget only makes a
 * genuinely-broken daemon take longer to surface, which is the safer tradeoff
 * against false negatives on cold start.
 */
export const DEFAULT_DAEMON_READY_TIMEOUT_MS = 45_000;
const DEFAULT_DAEMON_READY_POLL_MS = 25;

/**
 * Resolve the daemon readiness timeout (ms) from the env override, falling back
 * to {@link DEFAULT_DAEMON_READY_TIMEOUT_MS} when unset or invalid. Matches the
 * codebase env-int convention (e.g. `getMaxMcpOutputTokens`): only a finite,
 * strictly-positive parse wins; everything else (non-numeric, NaN, <= 0) falls
 * back to the default. Exported so the autostart path resolves the same value.
 */
export function resolveAgenCDaemonReadyTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envValue = env[AGENC_DAEMON_READY_TIMEOUT_MS_ENV];
  if (envValue !== undefined && envValue.trim().length > 0) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_DAEMON_READY_TIMEOUT_MS;
}

const DEFAULT_DAEMON_WEBSOCKET_URL = new URL(
  AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT,
);
// Windows' identity-proved PowerShell creation-time query has a 45s cold-start
// ceiling. Startup cancellation checkpoints bracket that query and every
// other slow phase, so the parent allowance includes bounded cleanup margin.
const AGENC_DAEMON_STARTUP_CANCELLATION_TIMEOUT_MS = 60_000;
export const AGENC_DAEMON_WEBSOCKET_DEFAULT_HOST =
  DEFAULT_DAEMON_WEBSOCKET_URL.hostname;
export const AGENC_DAEMON_WEBSOCKET_DEFAULT_PORT = Number(
  DEFAULT_DAEMON_WEBSOCKET_URL.port,
);
export const AGENC_DAEMON_WEBSOCKET_DEFAULT_PATH =
  DEFAULT_DAEMON_WEBSOCKET_URL.pathname;

export type AgenCDaemonCliAction =
  "reload" | "restart" | "run" | "start" | "status" | "stop";

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
  readonly platform?: NodeJS.Platform;
  /** @internal Build identity seam for build-artifact-independent contracts. */
  readonly readCurrentRuntimeBuild?: () => Pick<
    AgenCDaemonInstanceIdentity,
    "runtimeVersion" | "commit" | "buildTime"
  > | null;
  spawnDetachedDaemon(env: NodeJS.ProcessEnv): number;
  /** Exact child capability retained only for this detached start invocation. */
  cancelSpawnedDaemon?(pid: number): Promise<void> | void;
  releaseSpawnedDaemonControl?(pid: number): void;
  /** Internal child-side endpoint for parent-requested startup cancellation. */
  readonly startupGuardReceiver?: AgenCDaemonStartupGuardReceiver;
  isPidRunning(pid: number): boolean;
  /** Test seam and portable PID-reuse identity provider. */
  readProcessIdentity?: (pid: number) => Promise<string | null> | string | null;
  terminatePid(pid: number, signal?: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
}

export interface RunAgenCDaemonCliOptions {
  readonly io?: AgenCDaemonCliIo;
  readonly host?: AgenCDaemonCliHost;
  readonly signalProcess?: AgenCSignalProcess;
  readonly beforeDaemonReady?: () => void | Promise<void>;
  /** @internal Reload/shutdown interposition contract-test seam. */
  readonly beforeDaemonReloadAdoption?: () => void | Promise<void>;
  /** @internal Deterministic lifecycle-cleanup interposition test seam. */
  readonly beforeDaemonAuthorityCleanup?: () => void | Promise<void>;
  readonly runner?: AgenCBackgroundAgentRunner;
  readonly nativePeerCredentialBinding?: AgenCNativePeerCredentialBinding;
  readonly nativePeerCredentialAddonPath?: string;
  readonly requireNativePeerCredentialForConnections?: boolean;
  readonly snapshotPeriodicIntervalMs?: number;
  readonly socketAcceptAuthenticationTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
  /** Internal: caller already serializes this lifecycle mutation. */
  readonly lifecycleLockHeld?: boolean;
  /** Internal restart handoff after stop+spawn mutation, before readiness. */
  readonly releaseLifecycleLockAfterStartMutation?: () => Promise<void>;
  /** Internal: a higher-level caller owns readiness, proof, and diagnostics. */
  readonly deferDaemonReadyWaitToCaller?: boolean;
  /** Isolated contract-test seam for post-spawn PID publication failures. */
  readonly writeDaemonPid?: (pidPath: string, pid: number) => Promise<void>;
  /**
   * Overrides the `health.stats` probe used by `status`. Defaults to a JSON-RPC
   * round-trip over the daemon's Unix socket. Injectable so unit tests can stub
   * the daemon response without spinning up a full server.
   */
  readonly requestHealthStats?: (
    host: AgenCDaemonCliHost,
  ) => Promise<HealthStatsResult>;
  readonly requestDaemonInstanceIdentity?: (
    host: AgenCDaemonCliHost,
  ) => Promise<AgenCDaemonInstanceIdentity> | AgenCDaemonInstanceIdentity;
  readonly requestDaemonShutdown?: (
    host: AgenCDaemonCliHost,
    expected: AgenCDaemonInstanceIdentity,
  ) => Promise<void> | void;
  /** Isolated contract-test seam for instance-bound reload transport. */
  readonly requestDaemonReload?: (
    host: AgenCDaemonCliHost,
    expected: AgenCDaemonInstanceIdentity,
  ) => Promise<DaemonReloadResult> | DaemonReloadResult;
  readonly inspectLegacyDaemonProcess?: (
    pid: number,
  ) =>
    | Promise<AgenCDaemonProcessIdentity | null>
    | AgenCDaemonProcessIdentity
    | null;
  /** Isolated contract-test seam for bounded Linux singleton discovery. */
  readonly findLegacyDaemonProcesses?: (
    daemonHome: string,
  ) =>
    | Promise<readonly AgenCDaemonProcessIdentity[]>
    | readonly AgenCDaemonProcessIdentity[];
  /**
   * Overrides the control-socket readiness probe used by `start`/`restart`,
   * `status`, and `reload`. Resolves `true` once the detached daemon has bound
   * and is accepting connections on its Unix socket (pid alive, cookie
   * written, socket connectable), mirroring the agent autostart readiness
   * contract. Defaults to a real connectability poll bounded by
   * {@link DEFAULT_DAEMON_READY_TIMEOUT_MS}. Injectable so unit tests can stub
   * readiness without spinning up a full server. The boolean argument is the
   * single-shot mode: when `true`, the probe checks readiness once with no
   * polling/timeout (used by `status`).
   */
  readonly waitForDaemonReady?: (
    host: AgenCDaemonCliHost,
    singleShot: boolean,
  ) => Promise<boolean>;
}

export interface AgenCDaemonWebSocketListenOptions {
  readonly host: string;
  readonly port: number;
  readonly path: string;
  // True only when the port is the implicit fixed default: an AGENC_HOME env
  // override already selects an ephemeral port, but HOME-based isolation and
  // multi-user machines resolve the same default and would otherwise collide
  // fatally with the long-lived daemon that holds it.
  readonly fallbackToEphemeralPortOnAddrInUse: boolean;
}

/** @internal Exported for a transport-ordering contract test. */
export class AgenCDaemonRpcShutdownCoordinator {
  #pendingAcknowledgements = 0;
  #completed = false;
  readonly #onAcknowledgementFlushed: () => void;

  constructor(onAcknowledgementFlushed: () => void) {
    this.#onAcknowledgementFlushed = onAcknowledgementFlushed;
  }

  get blocksRequests(): boolean {
    return this.#completed || this.#pendingAcknowledgements > 0;
  }

  accept(instanceId: string): {
    readonly shuttingDown: true;
    readonly instanceId: string;
  } {
    this.#pendingAcknowledgements += 1;
    return { shuttingDown: true, instanceId };
  }

  async send(
    message: JsonObject,
    response: AgenCDaemonResponse,
    send: (response: AgenCDaemonResponse) => Promise<void>,
  ): Promise<void> {
    const acceptedShutdown =
      message.method === "daemon.shutdown" &&
      !isDaemonErrorResponse(response) &&
      this.#pendingAcknowledgements > 0;
    try {
      await send(response);
    } catch (error) {
      if (acceptedShutdown && !this.#completed) {
        // Release only this response's acceptance. Another concurrent
        // acknowledgement remains counted and continues to block requests.
        this.#pendingAcknowledgements -= 1;
      }
      throw error;
    }
    if (!acceptedShutdown || this.#completed) return;

    // The transport's write callback is the causal flush barrier. Cleanup
    // cannot begin before at least one authenticated acknowledgement reaches
    // it, and a failed concurrent send cannot reopen a completed shutdown.
    this.#pendingAcknowledgements -= 1;
    this.#completed = true;
    this.#onAcknowledgementFlushed();
  }
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

export function resolveAgenCDaemonWebSocketListenOptions(
  env: NodeJS.ProcessEnv = process.env,
): AgenCDaemonWebSocketListenOptions {
  const host =
    env[AGENC_DAEMON_WEBSOCKET_HOST_ENV]?.trim() ||
    AGENC_DAEMON_WEBSOCKET_DEFAULT_HOST;
  if (
    !isLoopbackListenHost(host) &&
    !allowsNonLoopbackDaemonWebSocketHost(env)
  ) {
    throw new Error(
      `${AGENC_DAEMON_WEBSOCKET_HOST_ENV} must be a loopback host unless ` +
        `${AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK_ENV}=1 is set`,
    );
  }
  const path =
    env[AGENC_DAEMON_WEBSOCKET_PATH_ENV]?.trim() ||
    AGENC_DAEMON_WEBSOCKET_DEFAULT_PATH;
  const configuredPort = env[AGENC_DAEMON_WEBSOCKET_PORT_ENV]?.trim();
  if (configuredPort !== undefined && configuredPort.length > 0) {
    return {
      host,
      port: parseAgenCDaemonWebSocketPort(configuredPort),
      path,
      fallbackToEphemeralPortOnAddrInUse: false,
    };
  }
  // The fixed portal endpoint is only safe for the default daemon home. Test
  // and isolated homes must not collide with the user's long-lived daemon.
  if ((env.AGENC_HOME?.trim() ?? "").length > 0) {
    return { host, port: 0, path, fallbackToEphemeralPortOnAddrInUse: false };
  }
  return {
    host,
    port: AGENC_DAEMON_WEBSOCKET_DEFAULT_PORT,
    path,
    fallbackToEphemeralPortOnAddrInUse: true,
  };
}

function parseAgenCDaemonWebSocketPort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (
    !Number.isInteger(port) ||
    String(port) !== value ||
    port < 0 ||
    port > 65_535
  ) {
    throw new Error(
      `${AGENC_DAEMON_WEBSOCKET_PORT_ENV} must be an integer from 0 to 65535`,
    );
  }
  return port;
}

export function validateAgenCDaemonWebSocketOrigin(
  origin: string | undefined,
): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "https:" && url.hostname === "agenc.tech") {
    return true;
  }
  return url.protocol === "http:" && isLoopbackHostname(url.hostname);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}

function isLoopbackListenHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipFamily = isIP(normalized);
  if (ipFamily === 4) return normalized.startsWith("127.");
  return false;
}

function allowsNonLoopbackDaemonWebSocketHost(env: NodeJS.ProcessEnv): boolean {
  const value =
    env[AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK_ENV]?.trim().toLowerCase();
  return value === "1" || value === "true";
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

/**
 * Raw stderr of the most recent detached daemon spawn, captured until the
 * foreground daemon installs its rotating log sink. This is the only place a
 * pre-sink crash (loader failure, V8 fatal, top-level throw) leaves evidence:
 * `stdio: "ignore"` used to drop it, which made "daemon exited before ready"
 * undiagnosable without rebuilding the runtime.
 */
export const AGENC_DAEMON_SPAWN_STDERR_FILENAME = "daemon-spawn-stderr.log";

export function resolveAgenCDaemonSpawnStderrPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return join(
    resolveAgenCDaemonHome(env, userHome),
    AGENC_DAEMON_SPAWN_STDERR_FILENAME,
  );
}

const DAEMON_SPAWN_STDERR_TAIL_BYTES = 2_048;

/**
 * Bounded, single-line tail of the spawn stderr capture for embedding in
 * failure messages. Empty string when the file is missing or empty.
 */
export function readAgenCDaemonSpawnStderrTail(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  try {
    const raw = readFileSync(resolveAgenCDaemonSpawnStderrPath(env, userHome));
    const tail = raw
      .subarray(Math.max(0, raw.byteLength - DAEMON_SPAWN_STDERR_TAIL_BYTES))
      .toString("utf8")
      .trim();
    if (tail.length === 0) return "";
    const lines = tail
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.slice(-4).join(" | ");
  } catch {
    return "";
  }
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

export function resolveAgenCDaemonLogPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return join(resolveAgenCDaemonHome(env, userHome), AGENC_DAEMON_LOG_FILENAME);
}

const AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_ROOT = "/usr/lib/agenc";
const AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_MARKER = join(
  AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_ROOT,
  "peer-credentials-required",
);
const AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_ADDON = join(
  AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_ROOT,
  "agenc-peer-credentials.node",
);

export function resolveSystemNativePeerCredentialAddonPath(
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (
    platform !== "linux" ||
    !existsSync(AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_MARKER)
  ) {
    return undefined;
  }
  return AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_ADDON;
}

/**
 * Routes the foreground daemon's `console.*` output through a size-capped,
 * single-backup rotating file sink so `daemon.log` cannot grow without bound.
 * Returns a disposer that restores the original console and closes the sink.
 *
 * The detached daemon is spawned with `stdio: "ignore"`, so previously its log
 * output was either discarded or captured by an external, unbounded redirect.
 * Installing the sink in-process makes the daemon own a bounded log regardless
 * of how it was launched. Failure to open the sink degrades to a no-op (logging
 * must never block daemon startup).
 */
export function installAgenCDaemonLogSink(options: {
  readonly path: string;
  readonly console?: Pick<Console, "log" | "error" | "warn" | "info" | "debug">;
}): { readonly sink: SizeCappedFileLogSink; dispose(): void } | null {
  let sink: SizeCappedFileLogSink;
  try {
    sink = createSizeCappedFileLogSink({ path: options.path });
  } catch {
    return null;
  }
  const target = options.console ?? console;
  const original = {
    log: target.log.bind(target),
    error: target.error.bind(target),
    warn: target.warn.bind(target),
    info: target.info.bind(target),
    debug: target.debug.bind(target),
  };
  const format = (args: unknown[]): string =>
    `${args
      .map((arg) => (typeof arg === "string" ? arg : safeStringifyLogArg(arg)))
      .join(" ")}\n`;
  target.log = (...args: unknown[]) => sink.write(format(args));
  target.info = (...args: unknown[]) => sink.write(format(args));
  target.debug = (...args: unknown[]) => sink.write(format(args));
  target.warn = (...args: unknown[]) => sink.write(format(args));
  target.error = (...args: unknown[]) => sink.write(format(args));
  return {
    sink,
    dispose() {
      target.log = original.log;
      target.error = original.error;
      target.warn = original.warn;
      target.info = original.info;
      target.debug = original.debug;
      sink.close();
    },
  };
}

function safeStringifyLogArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

export function formatAgenCDaemonCliHelpText(): string {
  return [
    "Usage: agenc daemon <start|stop|status|reload|restart>",
    "       agenc daemon start --foreground",
    "",
    "Commands:",
    "  start                 Start the local AgenC daemon",
    "  start --foreground    Run the daemon in the current process",
    "  stop                  Stop the local AgenC daemon",
    "  status                Show local AgenC daemon status",
    "  reload                Reload daemon configuration in place",
    "  restart               Stop and start the local AgenC daemon",
    "",
    "Examples:",
    "  agenc daemon status",
    "  agenc daemon start",
    "  agenc daemon start --foreground",
    "  agenc daemon reload",
    "  agenc daemon restart",
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
  const extra = argv.slice(2);
  if (extra.length === 1 && (extra[0] === "--help" || extra[0] === "-h")) {
    return { kind: "help", text: formatAgenCDaemonCliHelpText() };
  }
  if (
    action === "start" ||
    action === "stop" ||
    action === "status" ||
    action === "reload" ||
    action === "restart" ||
    action === "run"
  ) {
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
      return startAgenCDaemon(host, io, options);
    case "stop":
      return stopAgenCDaemon(
        host,
        io,
        options.stopTimeoutMs ?? DEFAULT_DAEMON_STOP_TIMEOUT_MS,
        options,
      );
    case "status":
      return statusAgenCDaemon(host, io, options);
    case "reload":
      return reloadAgenCDaemon(host, io, options);
    case "restart": {
      // Stop and start are separate lifecycle transactions. This gives a
      // concurrent control command a well-defined ordering point between the
      // old generation's exit and replacement publication, while neither
      // restart nor stop holds the authority lock during an exit wait.
      const stopExit = await stopAgenCDaemon(
        host,
        io,
        options.stopTimeoutMs ?? DEFAULT_DAEMON_STOP_TIMEOUT_MS,
        { ...options, quietWhenStopped: true },
      );
      if (stopExit !== 0) return stopExit;
      return startAgenCDaemon(host, io, options);
    }
    case "run":
      return runAgenCDaemonForeground(host, io, {
        signalProcess: options.signalProcess,
        beforeDaemonReady: options.beforeDaemonReady,
        beforeDaemonReloadAdoption: options.beforeDaemonReloadAdoption,
        beforeDaemonAuthorityCleanup: options.beforeDaemonAuthorityCleanup,
        runner: options.runner,
        nativePeerCredentialBinding: options.nativePeerCredentialBinding,
        nativePeerCredentialAddonPath: options.nativePeerCredentialAddonPath,
        requireNativePeerCredentialForConnections:
          options.requireNativePeerCredentialForConnections,
        snapshotPeriodicIntervalMs: options.snapshotPeriodicIntervalMs,
        socketAcceptAuthenticationTimeoutMs:
          options.socketAcceptAuthenticationTimeoutMs,
        requestDaemonInstanceIdentity: options.requestDaemonInstanceIdentity,
        inspectLegacyDaemonProcess: options.inspectLegacyDaemonProcess,
        findLegacyDaemonProcesses: options.findLegacyDaemonProcesses,
      });
  }
}

/**
 * Single-shot control-socket readiness check, mirroring the agent autostart
 * contract (`isAgenCDaemonPidAndCookieReady` in `daemon-autostart.ts`): the pid
 * must be alive, the daemon cookie present and non-empty, and the Unix socket
 * must exist as a socket AND be connectable. The connectability probe closes
 * the window where the socket inode exists but `socketServer.listen()` has not
 * yet started accepting, which is exactly the race the bare controls hit.
 */
async function isAgenCDaemonControlSocketReady(
  host: AgenCDaemonCliHost,
  pid: number,
): Promise<boolean> {
  if (!host.isPidRunning(pid)) return false;
  const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  try {
    if ((await readFile(cookiePath, "utf8")).trim().length === 0) {
      return false;
    }
    if (isAgenCWindowsNamedPipePath(socketPath)) {
      return canConnectToUnixSocket(socketPath);
    }
    if (!(await lstat(socketPath)).isSocket()) {
      return false;
    }
  } catch (error) {
    if (asNodeError(error).code === "ENOENT") return false;
    throw error;
  }
  return canConnectToUnixSocket(socketPath);
}

/**
 * Polls {@link isAgenCDaemonControlSocketReady} until it observes readiness or
 * the bounded timeout elapses. Uses `host.sleep` so tests can drive the clock.
 * When `singleShot` is true, the readiness is checked exactly once with no
 * polling (used by `status`, which must not block on a slow/absent socket).
 */
async function defaultWaitForAgenCDaemonReady(
  host: AgenCDaemonCliHost,
  singleShot: boolean,
): Promise<boolean> {
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const pid = await readAgenCDaemonPid(pidPath);
  if (pid === null) return false;
  if (singleShot) {
    return isAgenCDaemonControlSocketReady(host, pid);
  }
  const startedAt = Date.now();
  const timeoutMs = resolveAgenCDaemonReadyTimeoutMs(host.env);
  while (Date.now() - startedAt < timeoutMs) {
    if (await isAgenCDaemonControlSocketReady(host, pid)) return true;
    if (!host.isPidRunning(pid)) return false;
    await host.sleep(DEFAULT_DAEMON_READY_POLL_MS);
  }
  return isAgenCDaemonControlSocketReady(host, pid);
}

type UntrackedAgenCDaemonSingleton =
  | {
      readonly kind: "legacy-process";
      readonly process: AgenCDaemonProcessIdentity;
    }
  | { readonly kind: "unbound-socket" };

async function discoverUntrackedAgenCDaemonSingleton(
  host: AgenCDaemonCliHost,
  findOverride: RunAgenCDaemonCliOptions["findLegacyDaemonProcesses"],
): Promise<UntrackedAgenCDaemonSingleton | null> {
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  if ((host.platform ?? process.platform) === "linux") {
    const find =
      findOverride ??
      ((targetHome: string) =>
        findLinuxAgenCDaemonProcesses(host, targetHome, "any-install"));
    const candidates = await Promise.resolve(find(daemonHome));
    if (candidates.length > 1) {
      throw new Error(
        `multiple untracked same-home AgenC daemons are active (${candidates.map((candidate) => candidate.pid).join(", ")})`,
      );
    }
    const candidate = candidates[0];
    if (candidate !== undefined) {
      return { kind: "legacy-process", process: candidate };
    }
  }
  if (
    await canConnectToUnixSocket(
      resolveAgenCDaemonSocketPath(host.env, host.userHome),
    )
  ) {
    return { kind: "unbound-socket" };
  }
  return null;
}

async function startAgenCDaemon(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  options: RunAgenCDaemonCliOptions = {},
): Promise<number> {
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  let spawnedDuringMutation: number | null = null;
  const mutate = async (): Promise<
    | {
        readonly kind: "already-running";
        readonly pid: number;
        readonly binding:
          | {
              readonly kind: "modern";
              readonly bound: BoundAgenCDaemonCliInstance;
            }
          | {
              readonly kind: "legacy";
              readonly process: AgenCDaemonProcessIdentity;
            };
      }
    | { readonly kind: "auth-failed" }
    | { readonly kind: "identity-conflict"; readonly message: string }
    | { readonly kind: "pending"; readonly pid: number }
    | { readonly kind: "spawned"; readonly pid: number }
  > => {
    let existingPid = await readAgenCDaemonPid(pidPath);
    const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath));
    let runtimeInfo = readDaemonRuntimeInfo(runtimeInfoPath);
    const recorded = daemonInstanceIdentityFromRuntimeInfo(runtimeInfo);

    // The authenticated sidecar is the modern generation authority. Consult
    // it independently of daemon.pid so a missing/dead/stale pid file cannot
    // make a second daemon overlap an already-bound instance.
    if (recorded !== null && host.isPidRunning(recorded.pid)) {
      const pidSnapshot = existingPid;
      try {
        const bound = await proveAgenCDaemonCliInstance(
          host,
          recorded.pid,
          runtimeInfoPath,
          options.requestDaemonInstanceIdentity,
        );
        if (recorded.pid !== pidSnapshot) {
          const sidecarNow = daemonInstanceIdentityFromRuntimeInfo(
            readDaemonRuntimeInfo(runtimeInfoPath),
          );
          if (
            (await readAgenCDaemonPid(pidPath)) !== pidSnapshot ||
            sidecarNow === null ||
            !sameAgenCDaemonInstanceIdentity(bound.identity, sidecarNow)
          ) {
            return {
              kind: "identity-conflict",
              message: "daemon metadata changed while repairing the pid file",
            };
          }
          await writeAgenCDaemonPid(pidPath, bound.identity.pid);
          existingPid = bound.identity.pid;
        }
        return {
          kind: "already-running",
          pid: bound.identity.pid,
          binding: { kind: "modern", bound },
        };
      } catch (error) {
        return {
          kind: "identity-conflict",
          message: formatCleanupError(error),
        };
      }
    }

    const legacySidecarPid = recorded === null ? runtimeInfo?.pid : undefined;
    if (legacySidecarPid !== undefined && host.isPidRunning(legacySidecarPid)) {
      if ((host.platform ?? process.platform) !== "linux") {
        return {
          kind: "identity-conflict",
          message:
            `legacy daemon pid ${legacySidecarPid} has no portable instance binding; ` +
            "stop it with the OS service/process manager after verifying its command and AgenC home, then retry",
        };
      }
      const inspectLegacy =
        options.inspectLegacyDaemonProcess ??
        ((targetPid: number) =>
          inspectLinuxAgenCDaemonProcess(
            targetPid,
            host,
            resolveAgenCDaemonHome(host.env, host.userHome),
            "any-install",
          ));
      const legacyProcess = await Promise.resolve(
        inspectLegacy(legacySidecarPid),
      );
      if (legacyProcess === null) {
        return {
          kind: "identity-conflict",
          message: `legacy daemon pid ${legacySidecarPid} could not be proven as a same-home Linux daemon`,
        };
      }
      if (existingPid !== legacySidecarPid) {
        if (
          (await readAgenCDaemonPid(pidPath)) !== existingPid ||
          JSON.stringify(readDaemonRuntimeInfo(runtimeInfoPath)) !==
            JSON.stringify(runtimeInfo)
        ) {
          return {
            kind: "identity-conflict",
            message:
              "daemon metadata changed while repairing a legacy pid file",
          };
        }
        await writeAgenCDaemonPid(pidPath, legacySidecarPid);
        existingPid = legacySidecarPid;
      }
      return {
        kind: "already-running",
        pid: legacySidecarPid,
        binding: { kind: "legacy", process: legacyProcess },
      };
    }

    if (existingPid !== null && host.isPidRunning(existingPid)) {
      if ((host.platform ?? process.platform) === "linux") {
        const inspectLegacy =
          options.inspectLegacyDaemonProcess ??
          ((targetPid: number) =>
            inspectLinuxAgenCDaemonProcess(
              targetPid,
              host,
              resolveAgenCDaemonHome(host.env, host.userHome),
              "any-install",
            ));
        const legacyProcess = await Promise.resolve(inspectLegacy(existingPid));
        if (legacyProcess !== null) {
          return {
            kind: "already-running",
            pid: existingPid,
            binding: { kind: "legacy", process: legacyProcess },
          };
        }
      }
      return {
        kind: "pending",
        pid: existingPid,
      };
    }
    if (existingPid !== null) {
      await removeAgenCDaemonPid(pidPath, existingPid);
      existingPid = null;
    }
    if (
      runtimeInfo !== null &&
      !host.isPidRunning(runtimeInfo.pid) &&
      JSON.stringify(readDaemonRuntimeInfo(runtimeInfoPath)) ===
        JSON.stringify(runtimeInfo)
    ) {
      removeDaemonRuntimeInfo(runtimeInfoPath, runtimeInfo.instanceId);
      runtimeInfo = null;
    }
    let untracked: UntrackedAgenCDaemonSingleton | null;
    try {
      untracked = await discoverUntrackedAgenCDaemonSingleton(
        host,
        options.findLegacyDaemonProcesses,
      );
    } catch (error) {
      return {
        kind: "identity-conflict",
        message: `untracked daemon discovery failed: ${formatCleanupError(error)}`,
      };
    }
    if (untracked?.kind === "unbound-socket") {
      return {
        kind: "identity-conflict",
        message:
          "daemon control socket is active without portable process identity; stop it with the OS service/process manager after verifying its command and AgenC home, then retry",
      };
    }
    if (untracked?.kind === "legacy-process") {
      if (
        (await readAgenCDaemonPid(pidPath)) !== existingPid ||
        JSON.stringify(readDaemonRuntimeInfo(runtimeInfoPath)) !==
          JSON.stringify(runtimeInfo)
      ) {
        return {
          kind: "identity-conflict",
          message: "daemon metadata changed during untracked process discovery",
        };
      }
      await writeAgenCDaemonPid(pidPath, untracked.process.pid);
      return {
        kind: "already-running",
        pid: untracked.process.pid,
        binding: { kind: "legacy", process: untracked.process },
      };
    }
    if ((await tryResolveAgenCDaemonAuthStartup(host, io)) === null) {
      return { kind: "auth-failed" };
    }

    const childPid = host.spawnDetachedDaemon({
      ...host.env,
      AGENC_DAEMON_RUN: "1",
    });
    // From this instruction onward every failure must cancel this exact child
    // through its retained startup capability. Record it before the first
    // awaited publication step so a durable-write failure cannot strand an
    // untracked daemon.
    spawnedDuringMutation = childPid;
    await (options.writeDaemonPid ?? writeAgenCDaemonPid)(pidPath, childPid);
    return { kind: "spawned", pid: childPid };
  };
  const release =
    options.lifecycleLockHeld === true
      ? null
      : await acquireAgenCDaemonLifecycleLock(host);
  let decision: Awaited<ReturnType<typeof mutate>> | undefined;
  const mutationErrors: unknown[] = [];
  try {
    decision = await mutate();
  } catch (error) {
    mutationErrors.push(error);
  }
  try {
    await release?.();
  } catch (error) {
    mutationErrors.push(error);
  }
  try {
    await options.releaseLifecycleLockAfterStartMutation?.();
  } catch (error) {
    mutationErrors.push(error);
  }
  if (mutationErrors.length > 0) {
    if (spawnedDuringMutation !== null) {
      try {
        await cancelDirectSpawnFailure(host, spawnedDuringMutation, pidPath);
      } catch (cleanupError) {
        throw new AggregateError(
          [...mutationErrors, cleanupError],
          `AgenC daemon start mutation failed and exact child cleanup could not be verified (pid ${spawnedDuringMutation})`,
          { cause: mutationErrors[0] },
        );
      }
    }
    if (mutationErrors.length === 1) throw mutationErrors[0];
    throw new AggregateError(
      mutationErrors,
      "AgenC daemon start mutation and lifecycle release both failed",
      { cause: mutationErrors[0] },
    );
  }
  if (decision === undefined) {
    throw new Error("daemon start mutation completed without a decision");
  }
  if (decision.kind === "identity-conflict") {
    io.stderr.write(`agenc: refusing daemon start: ${decision.message}\n`);
    return 1;
  }
  if (decision.kind === "auth-failed") return 1;

  if (options.deferDaemonReadyWaitToCaller === true) return 0;

  const targetPid = decision.pid;
  const waitForReady =
    options.waitForDaemonReady ?? defaultWaitForAgenCDaemonReady;
  const ready = await waitForReady(host, false);
  if (!ready) {
    const wasRunning = host.isPidRunning(targetPid);
    if (wasRunning) {
      io.stderr.write(
        `agenc: daemon process active (pid ${targetPid}) but its control ` +
          `socket did not become ready before timeout\n`,
      );
    } else {
      if (decision.kind !== "spawned") {
        await removeDirectExitedDaemonMetadata(host, targetPid, pidPath);
      }
      const stderrTail = readAgenCDaemonSpawnStderrTail(
        host.env,
        host.userHome,
      );
      io.stderr.write(
        `agenc: daemon process (pid ${targetPid}) exited before its control ` +
          `socket became ready` +
          (stderrTail.length > 0 ? `: ${stderrTail}` : "") +
          `\n`,
      );
    }
    if (decision.kind === "spawned") {
      try {
        await cancelDirectSpawnFailure(host, targetPid, pidPath);
      } catch (error) {
        io.stderr.write(
          `agenc: spawned daemon cleanup failed: ${formatCleanupError(error)}\n`,
        );
      }
    }
    return 1;
  }
  if (decision.kind === "pending" || decision.kind === "spawned") {
    try {
      // Socket listen precedes the foreground child's sidecar/final-pid
      // commit. Wait through its lifecycle transaction before authenticating
      // the complete publication, so neither a direct nor concurrent start
      // can report success inside that partial window.
      await withAgenCDaemonLifecycleLock(host, async () => {});
      if ((await readAgenCDaemonPid(pidPath)) !== targetPid) {
        throw new Error("daemon pid changed during identity publication");
      }
      await proveAgenCDaemonCliInstance(
        host,
        targetPid,
        resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath)),
        options.requestDaemonInstanceIdentity,
      );
    } catch (error) {
      io.stderr.write(
        `agenc: pid ${targetPid} became ready without a complete authenticated daemon identity: ${formatCleanupError(error)}\n`,
      );
      if (decision.kind === "spawned") {
        try {
          await cancelDirectSpawnFailure(host, targetPid, pidPath);
        } catch (cleanupError) {
          io.stderr.write(
            `agenc: spawned daemon cleanup failed: ${formatCleanupError(cleanupError)}\n`,
          );
        }
      }
      return 1;
    }
  } else {
    try {
      if (decision.binding.kind === "modern") {
        await revalidateBoundAgenCDaemonCliInstance(
          host,
          decision.binding.bound,
          resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath)),
          options.requestDaemonInstanceIdentity,
        );
      } else {
        const inspectLegacy =
          options.inspectLegacyDaemonProcess ??
          ((pid: number) =>
            inspectLinuxAgenCDaemonProcess(
              pid,
              host,
              resolveAgenCDaemonHome(host.env, host.userHome),
              "any-install",
            ));
        const current = await Promise.resolve(inspectLegacy(targetPid));
        if (
          current === null ||
          current.processStart !== decision.binding.process.processStart
        ) {
          throw new Error(
            "legacy daemon generation changed before start completed",
          );
        }
      }
    } catch (error) {
      io.stderr.write(
        `agenc: daemon generation changed before start completed: ${formatCleanupError(error)}\n`,
      );
      return 1;
    }
  }
  if (decision.kind === "spawned") {
    host.releaseSpawnedDaemonControl?.(targetPid);
  }
  io.stdout.write(
    decision.kind === "spawned"
      ? `AgenC daemon started (pid ${targetPid})\n`
      : `AgenC daemon already running (pid ${targetPid})\n`,
  );
  return 0;
}

async function cancelDirectSpawnFailure(
  host: AgenCDaemonCliHost,
  pid: number,
  pidPath: string,
): Promise<void> {
  const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath));
  const sidecarSnapshot = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(runtimeInfoPath),
  );
  if (host.cancelSpawnedDaemon === undefined) {
    if (!host.isPidRunning(pid)) {
      await removeDirectExitedDaemonMetadata(
        host,
        pid,
        pidPath,
        sidecarSnapshot,
      );
      return;
    }
    throw new Error(
      `exact startup cancellation channel is unavailable for live pid ${pid}`,
    );
  }
  await Promise.resolve(host.cancelSpawnedDaemon(pid));
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && host.isPidRunning(pid)) {
    await host.sleep(25);
  }
  if (host.isPidRunning(pid)) {
    throw new Error(
      `spawned daemon pid ${pid} acknowledged cleanup but remained alive`,
    );
  }
  await removeDirectExitedDaemonMetadata(host, pid, pidPath, sidecarSnapshot);
}

async function removeDirectExitedDaemonMetadata(
  host: AgenCDaemonCliHost,
  pid: number,
  pidPath: string,
  expectedSidecar: AgenCDaemonInstanceIdentity | null = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath))),
  ),
): Promise<void> {
  const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath));
  await withAgenCDaemonLifecycleLock(host, async () => {
    if (host.isPidRunning(pid) || (await readAgenCDaemonPid(pidPath)) !== pid) {
      return;
    }
    const sidecarNow = daemonInstanceIdentityFromRuntimeInfo(
      readDaemonRuntimeInfo(runtimeInfoPath),
    );
    if (
      (expectedSidecar === null) !== (sidecarNow === null) ||
      (expectedSidecar !== null &&
        sidecarNow !== null &&
        !sameAgenCDaemonInstanceIdentity(expectedSidecar, sidecarNow)) ||
      (sidecarNow !== null && sidecarNow.pid !== pid)
    ) {
      return;
    }
    if (host.isPidRunning(pid) || (await readAgenCDaemonPid(pidPath)) !== pid) {
      return;
    }
    await removeAgenCDaemonPid(pidPath, pid);
    if (sidecarNow !== null) {
      removeDaemonRuntimeInfo(runtimeInfoPath, sidecarNow.instanceId);
    }
  });
}

async function stopAgenCDaemon(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  timeoutMs: number,
  options: RunAgenCDaemonCliOptions & {
    readonly quietWhenStopped?: boolean;
  } = {},
): Promise<number> {
  return withAgenCDaemonLifecyclePhases(host, async (lifecycle) => {
    const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
    const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath));
    const pidSnapshot = await readAgenCDaemonPid(pidPath);
    const runtimeInfo = readDaemonRuntimeInfo(runtimeInfoPath);
    const recorded = daemonInstanceIdentityFromRuntimeInfo(runtimeInfo);
    let pid = pidSnapshot;
    if (recorded !== null) {
      let bound: BoundAgenCDaemonCliInstance | null = null;
      try {
        bound = await proveAgenCDaemonCliInstance(
          host,
          recorded.pid,
          runtimeInfoPath,
          options.requestDaemonInstanceIdentity,
        );
        const sidecarNow = daemonInstanceIdentityFromRuntimeInfo(
          readDaemonRuntimeInfo(runtimeInfoPath),
        );
        if (
          (await readAgenCDaemonPid(pidPath)) !== pidSnapshot ||
          sidecarNow === null ||
          !sameAgenCDaemonInstanceIdentity(bound.identity, sidecarNow)
        ) {
          throw new Error(
            "daemon metadata changed while repairing the pid file",
          );
        }
        if (pidSnapshot !== bound.identity.pid) {
          await writeAgenCDaemonPid(pidPath, bound.identity.pid);
        }
        pid = bound.identity.pid;
      } catch (error) {
        if (host.isPidRunning(recorded.pid)) {
          io.stderr.write(
            `agenc: refusing to stop pid ${recorded.pid} without a complete authenticated daemon identity: ${formatCleanupError(error)}\n`,
          );
          return 1;
        }
        removeDaemonRuntimeInfo(runtimeInfoPath, recorded.instanceId);
      }
      if (bound !== null) {
        const boundPid = bound.identity.pid;
        let shutdownError: unknown;
        try {
          const requestShutdown =
            options.requestDaemonShutdown ?? requestAgenCDaemonShutdown;
          await Promise.resolve(requestShutdown(host, bound.identity));
        } catch (error) {
          shutdownError = error;
        }
        await lifecycle.release();
        const exited = await waitForBoundPidExit(
          host,
          bound.process,
          shutdownError === undefined ? timeoutMs : 0,
        );
        if (!exited) {
          if ((host.platform ?? process.platform) !== "linux") {
            io.stderr.write(
              shutdownError === undefined
                ? `agenc: authenticated daemon shutdown was acknowledged but pid ${boundPid} remained bound; refusing an unsafe numeric signal\n`
                : `agenc: authenticated daemon shutdown failed for pid ${boundPid}: ${formatCleanupError(shutdownError)}; refusing an unsafe numeric signal\n`,
            );
            return 1;
          }
          try {
            await lifecycle.acquire();
            await rebindAgenCDaemonCliInstanceForLinuxSignal(
              host,
              bound,
              runtimeInfoPath,
              options.inspectLegacyDaemonProcess,
              "SIGTERM",
            );
            host.terminatePid(boundPid, "SIGTERM");
            await lifecycle.release();
            if (
              !(await waitForBoundPidExit(
                host,
                bound.process,
                AGENC_DAEMON_FORCE_STOP_GRACE_MS,
              ))
            ) {
              await lifecycle.acquire();
              await rebindAgenCDaemonCliInstanceForLinuxSignal(
                host,
                bound,
                runtimeInfoPath,
                options.inspectLegacyDaemonProcess,
                "SIGKILL",
              );
              io.stderr.write(
                `agenc: authenticated daemon did not stop after Linux SIGTERM (pid ${boundPid}); forcing stop\n`,
              );
              host.terminatePid(boundPid, "SIGKILL");
              await lifecycle.release();
              if (
                !(await waitForBoundPidExit(
                  host,
                  bound.process,
                  AGENC_DAEMON_FORCE_STOP_GRACE_MS,
                ))
              ) {
                io.stderr.write(
                  `agenc: authenticated daemon did not stop before timeout (pid ${boundPid})\n`,
                );
                return 1;
              }
            }
          } catch (error) {
            io.stderr.write(
              `agenc: refusing Linux numeric shutdown for pid ${boundPid} because its authenticated instance could not be rebound: ${formatCleanupError(error)}\n`,
            );
            return 1;
          }
        }
        await lifecycle.acquire();
        const cleanupPid = await readAgenCDaemonPid(pidPath);
        const cleanupSidecar = daemonInstanceIdentityFromRuntimeInfo(
          readDaemonRuntimeInfo(runtimeInfoPath),
        );
        if (
          (cleanupPid === null || cleanupPid === boundPid) &&
          (cleanupSidecar === null ||
            sameAgenCDaemonInstanceIdentity(cleanupSidecar, bound.identity)) &&
          !host.isPidRunning(boundPid)
        ) {
          await removeAgenCDaemonPid(pidPath, boundPid);
          removeDaemonRuntimeInfo(runtimeInfoPath, bound.identity.instanceId);
        }
        io.stdout.write(`AgenC daemon stopped (pid ${boundPid})\n`);
        return 0;
      }
    }

    const legacySidecarPid =
      runtimeInfo !== null &&
      daemonInstanceIdentityFromRuntimeInfo(runtimeInfo) === null
        ? runtimeInfo.pid
        : null;
    if (legacySidecarPid !== null && host.isPidRunning(legacySidecarPid)) {
      pid = legacySidecarPid;
    }
    if (pid === null) {
      const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
      if (await canConnectToUnixSocket(socketPath)) {
        io.stderr.write(
          "agenc: daemon control socket is active but no process identity is recorded; refusing to report it stopped\n",
        );
        return 1;
      }
      if (!options.quietWhenStopped) {
        io.stdout.write("AgenC daemon already stopped\n");
      }
      return 0;
    }
    if (!host.isPidRunning(pid)) {
      const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
      if (await canConnectToUnixSocket(socketPath)) {
        io.stderr.write(
          "agenc: daemon control socket is active but its recorded pid is stale; refusing to remove metadata or report it stopped\n",
        );
        return 1;
      }
      await removeAgenCDaemonPid(pidPath, pid);
      if (!options.quietWhenStopped) {
        io.stdout.write("AgenC daemon already stopped (removed stale pid)\n");
      }
      return 0;
    }

    if ((host.platform ?? process.platform) !== "linux") {
      io.stderr.write(
        `agenc: legacy daemon pid ${pid} has no instance identity; refusing an unsafe numeric signal on this platform. Stop it with the OS service/process manager after verifying its command and AgenC home, then retry\n`,
      );
      return 1;
    }
    const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
    const inspectLegacy =
      options.inspectLegacyDaemonProcess ??
      ((targetPid: number) =>
        inspectLinuxAgenCDaemonProcess(
          targetPid,
          host,
          daemonHome,
          "any-install",
        ));
    const legacyIdentity = await Promise.resolve(inspectLegacy(pid));
    if (legacyIdentity === null) {
      io.stderr.write(
        `agenc: legacy daemon pid ${pid} could not be proven as a same-home Linux daemon; refusing to signal it\n`,
      );
      return 1;
    }

    if (pidSnapshot !== pid) {
      if (
        (await readAgenCDaemonPid(pidPath)) !== pidSnapshot ||
        JSON.stringify(readDaemonRuntimeInfo(runtimeInfoPath)) !==
          JSON.stringify(runtimeInfo)
      ) {
        io.stderr.write(
          "agenc: daemon metadata changed while repairing a legacy pid file\n",
        );
        return 1;
      }
      await writeAgenCDaemonPid(pidPath, pid);
    }

    const beforeTerm = await Promise.resolve(inspectLegacy(pid));
    if (
      beforeTerm === null ||
      beforeTerm.processStart !== legacyIdentity.processStart
    ) {
      io.stderr.write(
        `agenc: legacy daemon identity changed before SIGTERM (pid ${pid}); refusing to signal it\n`,
      );
      return 1;
    }
    host.terminatePid(pid, "SIGTERM");
    await lifecycle.release();
    if (!(await waitForBoundPidExit(host, legacyIdentity, timeoutMs))) {
      await lifecycle.acquire();
      const beforeKill = await Promise.resolve(inspectLegacy(pid));
      if (
        beforeKill === null ||
        beforeKill.processStart !== legacyIdentity.processStart
      ) {
        io.stderr.write(
          `agenc: legacy daemon identity changed before SIGKILL (pid ${pid}); refusing to signal it\n`,
        );
        return 1;
      }
      io.stderr.write(
        `agenc: legacy daemon did not stop gracefully before timeout (pid ${pid}); forcing stop\n`,
      );
      host.terminatePid(pid, "SIGKILL");
      await lifecycle.release();
      if (
        !(await waitForBoundPidExit(
          host,
          legacyIdentity,
          AGENC_DAEMON_FORCE_STOP_GRACE_MS,
        ))
      ) {
        io.stderr.write(
          `agenc: daemon did not stop before timeout (pid ${pid})\n`,
        );
        return 1;
      }
    }

    await lifecycle.acquire();
    const cleanupPid = await readAgenCDaemonPid(pidPath);
    const cleanupRuntimeInfo = readDaemonRuntimeInfo(runtimeInfoPath);
    if (
      (cleanupPid === null || cleanupPid === pid) &&
      !host.isPidRunning(pid) &&
      (cleanupRuntimeInfo === null ||
        JSON.stringify(cleanupRuntimeInfo) === JSON.stringify(runtimeInfo))
    ) {
      await removeAgenCDaemonPid(pidPath, pid);
      if (
        runtimeInfo !== null &&
        JSON.stringify(cleanupRuntimeInfo) === JSON.stringify(runtimeInfo)
      ) {
        removeDaemonRuntimeInfo(runtimeInfoPath, runtimeInfo.instanceId);
      }
    }
    io.stdout.write(`AgenC daemon stopped (pid ${pid})\n`);
    return 0;
  });
}

interface BoundAgenCDaemonCliInstance {
  readonly identity: AgenCDaemonInstanceIdentity;
  readonly process: AgenCDaemonProcessIdentity;
}

async function rebindAgenCDaemonCliInstanceForLinuxSignal(
  host: AgenCDaemonCliHost,
  expected: BoundAgenCDaemonCliInstance,
  runtimeInfoPath: string,
  inspectOverride: RunAgenCDaemonCliOptions["inspectLegacyDaemonProcess"],
  signal: "SIGKILL" | "SIGTERM",
): Promise<void> {
  const sidecarBefore = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(runtimeInfoPath),
  );
  if (
    sidecarBefore === null ||
    !sameAgenCDaemonInstanceIdentity(sidecarBefore, expected.identity)
  ) {
    throw new Error(`daemon identity sidecar changed before Linux ${signal}`);
  }
  const inspect =
    inspectOverride ??
    ((pid: number) =>
      inspectLinuxAgenCDaemonProcess(
        pid,
        host,
        resolveAgenCDaemonHome(host.env, host.userHome),
        "any-install",
      ));
  const process = await Promise.resolve(inspect(expected.identity.pid));
  const sidecarAfter = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(runtimeInfoPath),
  );
  if (
    process === null ||
    process.processStart !== expected.process.processStart ||
    sidecarAfter === null ||
    !sameAgenCDaemonInstanceIdentity(sidecarAfter, expected.identity)
  ) {
    throw new Error(
      `daemon identity could not be rebound before Linux ${signal}`,
    );
  }
}

async function proveAgenCDaemonCliInstance(
  host: AgenCDaemonCliHost,
  expectedPid: number,
  runtimeInfoPath: string,
  requestIdentityOverride?: RunAgenCDaemonCliOptions["requestDaemonInstanceIdentity"],
): Promise<BoundAgenCDaemonCliInstance> {
  const before = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(runtimeInfoPath),
  );
  if (before === null || before.pid !== expectedPid) {
    throw new Error(
      "daemon identity sidecar is unavailable or names another pid",
    );
  }
  const processBefore = await readAgenCDaemonProcessStart(
    expectedPid,
    host.readProcessIdentity,
  );
  if (processBefore === null || processBefore !== before.processStart) {
    throw new Error("daemon process start identity does not match its sidecar");
  }
  const observed = await Promise.resolve(
    requestIdentityOverride?.(host) ?? requestAgenCDaemonInstanceIdentity(host),
  );
  if (!sameAgenCDaemonInstanceIdentity(before, observed)) {
    throw new Error("authenticated daemon identity does not match its sidecar");
  }
  const after = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(runtimeInfoPath),
  );
  const processAfter =
    (host.platform ?? process.platform) === "linux"
      ? await readAgenCDaemonProcessStart(expectedPid, host.readProcessIdentity)
      : processBefore;
  if (
    after === null ||
    !sameAgenCDaemonInstanceIdentity(before, after) ||
    processAfter === null ||
    processAfter !== processBefore ||
    processAfter !== after.processStart
  ) {
    throw new Error("daemon identity changed during authenticated proof");
  }
  return {
    identity: after,
    process: { pid: expectedPid, processStart: processAfter },
  };
}

async function revalidateBoundAgenCDaemonCliInstance(
  host: AgenCDaemonCliHost,
  expected: BoundAgenCDaemonCliInstance,
  runtimeInfoPath: string,
  requestIdentityOverride?: RunAgenCDaemonCliOptions["requestDaemonInstanceIdentity"],
): Promise<void> {
  if ((host.platform ?? process.platform) === "linux") {
    const current = await proveAgenCDaemonCliInstance(
      host,
      expected.identity.pid,
      runtimeInfoPath,
      requestIdentityOverride,
    );
    if (!sameAgenCDaemonInstanceIdentity(current.identity, expected.identity)) {
      throw new Error("authenticated daemon generation changed");
    }
    return;
  }
  const before = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(runtimeInfoPath),
  );
  if (
    before === null ||
    !sameAgenCDaemonInstanceIdentity(before, expected.identity)
  ) {
    throw new Error("daemon identity sidecar changed");
  }
  const observed = await Promise.resolve(
    requestIdentityOverride?.(host) ?? requestAgenCDaemonInstanceIdentity(host),
  );
  const after = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(runtimeInfoPath),
  );
  if (
    !sameAgenCDaemonInstanceIdentity(observed, expected.identity) ||
    after === null ||
    !sameAgenCDaemonInstanceIdentity(after, expected.identity) ||
    !host.isPidRunning(expected.identity.pid)
  ) {
    throw new Error("authenticated daemon generation changed");
  }
}

async function waitForBoundPidExit(
  host: AgenCDaemonCliHost,
  expected: AgenCDaemonProcessIdentity,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const linux = (host.platform ?? process.platform) === "linux";
  while (Date.now() < deadline) {
    if (!host.isPidRunning(expected.pid)) return true;
    if (linux) {
      const processStart = await readAgenCDaemonProcessStart(
        expected.pid,
        host.readProcessIdentity,
      );
      if (processStart === null || processStart !== expected.processStart) {
        return true;
      }
    }
    await host.sleep(25);
  }
  if (!host.isPidRunning(expected.pid)) return true;
  if (!linux) return false;
  const processStart = await readAgenCDaemonProcessStart(
    expected.pid,
    host.readProcessIdentity,
  );
  return processStart === null || processStart !== expected.processStart;
}

async function statusAgenCDaemon(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  options: RunAgenCDaemonCliOptions = {},
): Promise<number> {
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const pidSnapshot = await readAgenCDaemonPid(pidPath);
  const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath));
  const runtimeInfo = readDaemonRuntimeInfo(runtimeInfoPath);
  const recorded = daemonInstanceIdentityFromRuntimeInfo(runtimeInfo);
  let pid: number | null = null;
  let authenticatedSocketReady = false;

  if (recorded !== null && host.isPidRunning(recorded.pid)) {
    try {
      const bound = await proveAgenCDaemonCliInstance(
        host,
        recorded.pid,
        runtimeInfoPath,
        options.requestDaemonInstanceIdentity,
      );
      pid = bound.identity.pid;
      // The authenticated identity round-trip itself proves the control socket
      // is accepting requests, even when daemon.pid is stale or missing.
      authenticatedSocketReady = true;
    } catch (error) {
      io.stderr.write(
        `agenc: refusing daemon status for unverified pid ${recorded.pid}: ${formatCleanupError(error)}\n`,
      );
      return 1;
    }
  } else {
    const legacySidecarPid = recorded === null ? runtimeInfo?.pid : undefined;
    const legacyPid =
      legacySidecarPid !== undefined && host.isPidRunning(legacySidecarPid)
        ? legacySidecarPid
        : pidSnapshot !== null && host.isPidRunning(pidSnapshot)
          ? pidSnapshot
          : null;
    if (legacyPid === null) {
      const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
      if (await canConnectToUnixSocket(socketPath)) {
        io.stderr.write(
          "agenc: daemon control socket is active but no process identity is recorded; status is indeterminate\n",
        );
        return 1;
      }
      io.stdout.write("AgenC daemon stopped\n");
      return 1;
    }
    if ((host.platform ?? process.platform) !== "linux") {
      io.stderr.write(
        `agenc: daemon status is indeterminate for unbound pid ${legacyPid}; no portable instance identity is available\n`,
      );
      return 1;
    }
    const inspectLegacy =
      options.inspectLegacyDaemonProcess ??
      ((targetPid: number) =>
        inspectLinuxAgenCDaemonProcess(
          targetPid,
          host,
          resolveAgenCDaemonHome(host.env, host.userHome),
          "any-install",
        ));
    const legacyProcess = await Promise.resolve(inspectLegacy(legacyPid));
    if (legacyProcess === null) {
      io.stderr.write(
        `agenc: refusing daemon status for unverified pid ${legacyPid}; it is not a proven same-home Linux daemon\n`,
      );
      return 1;
    }
    pid = legacyProcess.pid;
  }

  if (pid !== null) {
    // Distinguish "pid alive AND control socket accepting" from "pid alive but
    // socket not yet listening" (the post-spawn / hydrating window). Probe the
    // socket connectability once (no blocking poll) so `status` stays fast and
    // never claims definitive readiness while the socket is absent.
    const waitForReady =
      options.waitForDaemonReady ?? defaultWaitForAgenCDaemonReady;
    let socketReady = authenticatedSocketReady;
    if (!socketReady) {
      try {
        socketReady = await waitForReady(host, true);
      } catch {
        // The same-home process is proven, but its socket is not yet ready.
        socketReady = false;
      }
    }
    if (socketReady) {
      io.stdout.write(`AgenC daemon running (pid ${pid})\n`);
    } else {
      io.stdout.write(
        `AgenC daemon running (pid ${pid}, control socket not ready)\n`,
      );
    }
    // Best-effort: enrich the running line with live health.stats
    // (uptime/RSS/heap/session+state counts) pulled over the daemon socket.
    // The identity-proven process line remains when health.stats is
    // unavailable, so status never converts an RPC enrichment failure into a
    // naked-pid ownership claim.
    const requestHealthStats =
      options.requestHealthStats ?? requestAgenCDaemonHealthStats;
    try {
      const stats = await requestHealthStats(host);
      for (const line of formatAgenCDaemonHealthStatsLines(stats)) {
        io.stdout.write(`${line}\n`);
      }
    } catch {
      // Leave the pid-only line in place; the daemon is up but health.stats
      // is unavailable (older daemon, missing cookie, socket race, timeout).
    }
    return 0;
  }
  io.stdout.write("AgenC daemon stopped\n");
  return 1;
}

async function requestAgenCDaemonHealthStats(
  host: AgenCDaemonCliHost,
): Promise<HealthStatsResult> {
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
  const authCookie = await readAgenCDaemonCookie(cookiePath);
  const timeoutMs = resolveAgenCDaemonRequestTimeoutMs(host.env);
  const responses = await sendAgenCDaemonJsonLineRequests(
    socketPath,
    timeoutMs,
    [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
          protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
          clientName: "agenc-daemon-cli",
          authCookie,
          capabilities: {},
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        method: "health.stats",
        params: {},
      },
    ],
  );
  const initializeResponse = responses[0];
  if (initializeResponse === undefined) {
    throw new Error("daemon did not return an initialize response");
  }
  assertExpectedDaemonResponse(initializeResponse, 1, "initialize");
  if (isDaemonErrorResponse(initializeResponse)) {
    throw new Error(initializeResponse.error.message);
  }
  const statsResponse = responses[1];
  if (statsResponse === undefined) {
    throw new Error("daemon did not return a health.stats response");
  }
  assertExpectedDaemonResponse(statsResponse, 2, "health.stats");
  if (isDaemonErrorResponse(statsResponse)) {
    throw new Error(statsResponse.error.message);
  }
  const result = (statsResponse as AgenCDaemonSuccessResponse<"health.stats">)
    .result;
  if (!isHealthStatsResult(result)) {
    throw new Error("daemon returned a malformed health.stats result");
  }
  return result;
}

/**
 * Authenticate to the home-scoped control socket and return the daemon
 * instance tuple carried by initialize. Older daemons deliberately fail this
 * proof instead of being adopted or signalled by PID alone.
 */
export async function requestAgenCDaemonInstanceIdentity(
  host: AgenCDaemonCliHost,
): Promise<AgenCDaemonInstanceIdentity> {
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
  const authCookie = await readAgenCDaemonCookie(cookiePath);
  const responses = await sendAgenCDaemonJsonLineRequests(
    socketPath,
    resolveAgenCDaemonRequestTimeoutMs(host.env),
    [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
          protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
          clientName: "agenc-daemon-instance-probe",
          authCookie,
          capabilities: {},
        },
      },
    ],
  );
  const response = responses[0];
  if (response === undefined) {
    throw new Error("daemon did not return an initialize response");
  }
  assertExpectedDaemonResponse(response, 1, "initialize");
  if (isDaemonErrorResponse(response)) {
    throw new Error(response.error.message);
  }
  const identity = (response as AgenCDaemonSuccessResponse<"initialize">).result
    .daemonIdentity;
  if (!isAgenCDaemonInstanceIdentity(identity)) {
    throw new Error("daemon did not return a valid instance identity");
  }
  return identity;
}

export async function requestAgenCDaemonShutdown(
  host: AgenCDaemonCliHost,
  expected: AgenCDaemonInstanceIdentity,
): Promise<void> {
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  const authCookie = await readAgenCDaemonCookie(
    resolveAgenCDaemonCookiePath(host.env, host.userHome),
  );
  const responses = await sendAgenCDaemonJsonLineRequests(
    socketPath,
    resolveAgenCDaemonRequestTimeoutMs(host.env),
    [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
          protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
          clientName: "agenc-daemon-shutdown",
          authCookie,
          capabilities: {},
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        method: "daemon.shutdown",
        params: { instanceId: expected.instanceId },
      },
    ],
  );
  const initializeResponse = responses[0];
  if (initializeResponse === undefined) {
    throw new Error("daemon did not return an initialize response");
  }
  assertExpectedDaemonResponse(initializeResponse, 1, "initialize");
  if (isDaemonErrorResponse(initializeResponse)) {
    throw new Error(initializeResponse.error.message);
  }
  const observed = (
    initializeResponse as AgenCDaemonSuccessResponse<"initialize">
  ).result.daemonIdentity;
  if (
    !isAgenCDaemonInstanceIdentity(observed) ||
    observed.instanceId !== expected.instanceId ||
    observed.pid !== expected.pid ||
    observed.processStart !== expected.processStart ||
    observed.runtimeVersion !== expected.runtimeVersion ||
    observed.commit !== expected.commit ||
    observed.buildTime !== expected.buildTime
  ) {
    throw new Error("daemon instance changed before shutdown");
  }
  const shutdownResponse = responses[1];
  if (shutdownResponse === undefined) {
    throw new Error("daemon did not acknowledge shutdown");
  }
  assertExpectedDaemonResponse(shutdownResponse, 2, "daemon.shutdown");
  if (isDaemonErrorResponse(shutdownResponse)) {
    throw new Error(shutdownResponse.error.message);
  }
  const result = (
    shutdownResponse as AgenCDaemonSuccessResponse<"daemon.shutdown">
  ).result;
  if (
    result.shuttingDown !== true ||
    result.instanceId !== expected.instanceId
  ) {
    throw new Error("daemon returned a malformed shutdown acknowledgement");
  }
}

export function formatAgenCDaemonHealthStatsLines(
  stats: HealthStatsResult,
): string[] {
  const lines = [
    `  uptime: ${formatDaemonUptime(stats.uptimeMs)}`,
    `  memory: rss=${formatDaemonMebibytes(stats.memory.rss)}, ` +
      `heap=${formatDaemonMebibytes(stats.memory.heapUsed)}/` +
      `${formatDaemonMebibytes(stats.memory.heapTotal)}`,
    `  sessions: active=${stats.sessions.active}, ` +
      `closed=${stats.sessions.closed}, total=${stats.sessions.total}`,
  ];
  if (stats.state !== undefined) {
    lines.push(
      `  state: agentRuns=${stats.state.agentRuns}, ` +
        `snapshots=${stats.state.sessionStateSnapshots}, ` +
        `inFlightToolCalls=${stats.state.inFlightToolCalls}`,
    );
  }
  return lines;
}

function formatDaemonUptime(uptimeMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(uptimeMs / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  if (minutes > 0 || hours > 0 || days > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(" ");
}

function formatDaemonMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function isHealthStatsResult(
  value: JsonValue | undefined,
): value is HealthStatsResult {
  if (!isJsonObject(value)) return false;
  if (
    typeof value.uptimeMs !== "number" ||
    typeof value.now !== "string" ||
    !isHealthSessionStats(value.sessions) ||
    !isHealthMemoryStats(value.memory)
  ) {
    return false;
  }
  return value.state === undefined || isHealthStateStats(value.state);
}

function isHealthSessionStats(
  value: JsonValue | undefined,
): value is HealthSessionStats {
  return (
    isJsonObject(value) &&
    typeof value.active === "number" &&
    typeof value.closed === "number" &&
    typeof value.total === "number"
  );
}

function isHealthMemoryStats(
  value: JsonValue | undefined,
): value is HealthMemoryStats {
  return (
    isJsonObject(value) &&
    typeof value.rss === "number" &&
    typeof value.heapTotal === "number" &&
    typeof value.heapUsed === "number"
  );
}

function isHealthStateStats(
  value: JsonValue | undefined,
): value is HealthStateStats {
  return (
    isJsonObject(value) &&
    typeof value.agentRuns === "number" &&
    typeof value.sessionStateSnapshots === "number" &&
    typeof value.inFlightToolCalls === "number"
  );
}

async function reloadAgenCDaemon(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  options: RunAgenCDaemonCliOptions = {},
): Promise<number> {
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const pidSnapshot = await readAgenCDaemonPid(pidPath);
  const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath));
  const recorded = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(runtimeInfoPath),
  );
  if (recorded === null) {
    const socketActive = await canConnectToUnixSocket(
      resolveAgenCDaemonSocketPath(host.env, host.userHome),
    );
    if (
      (pidSnapshot === null || !host.isPidRunning(pidSnapshot)) &&
      !socketActive
    ) {
      io.stdout.write("AgenC daemon stopped\n");
      return 1;
    }
    io.stderr.write(
      `agenc: refusing daemon reload for an active unverified daemon${pidSnapshot === null ? "" : ` (pid ${pidSnapshot})`}; no authenticated daemon instance identity is available\n`,
    );
    return 1;
  }
  if (!host.isPidRunning(recorded.pid)) {
    if (
      await canConnectToUnixSocket(
        resolveAgenCDaemonSocketPath(host.env, host.userHome),
      )
    ) {
      io.stderr.write(
        `agenc: refusing daemon reload because the recorded instance pid ${recorded.pid} is gone while the control socket remains active\n`,
      );
      return 1;
    }
    io.stdout.write("AgenC daemon stopped\n");
    return 1;
  }

  let bound: BoundAgenCDaemonCliInstance;
  try {
    bound = await proveAgenCDaemonCliInstance(
      host,
      recorded.pid,
      runtimeInfoPath,
      options.requestDaemonInstanceIdentity,
    );
    const requestReload =
      options.requestDaemonReload ?? requestAgenCDaemonReload;
    await Promise.resolve(requestReload(host, bound.identity));
  } catch (error) {
    io.stderr.write(
      `agenc: daemon reload failed (pid ${recorded.pid}): ${formatCleanupError(error)}\n`,
    );
    return 1;
  }
  io.stdout.write(
    `AgenC daemon reloaded configuration (pid ${bound.identity.pid})\n`,
  );
  return 0;
}

async function requestAgenCDaemonReload(
  host: AgenCDaemonCliHost,
  expected: AgenCDaemonInstanceIdentity,
): Promise<DaemonReloadResult> {
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
  const authCookie = await readAgenCDaemonCookie(cookiePath);
  const timeoutMs = resolveAgenCDaemonRequestTimeoutMs(host.env);
  const responses = await sendAgenCDaemonJsonLineRequests(
    socketPath,
    timeoutMs,
    [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
          protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
          clientName: "agenc-daemon-cli",
          authCookie,
          capabilities: {},
        },
      },
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 2,
        method: "daemon.reload",
        params: {},
      },
    ],
    (response, responseIndex) => {
      if (responseIndex !== 0) return;
      assertExpectedDaemonResponse(response, 1, "initialize");
      if (isDaemonErrorResponse(response)) {
        throw new Error(response.error.message);
      }
      const observed = (response as AgenCDaemonSuccessResponse<"initialize">)
        .result.daemonIdentity;
      if (
        !isAgenCDaemonInstanceIdentity(observed) ||
        !sameAgenCDaemonInstanceIdentity(observed, expected)
      ) {
        throw new Error("daemon instance changed before reload");
      }
    },
  );
  const initializeResponse = responses[0];
  if (initializeResponse === undefined) {
    throw new Error("daemon did not return an initialize response");
  }
  assertExpectedDaemonResponse(initializeResponse, 1, "initialize");
  if (isDaemonErrorResponse(initializeResponse)) {
    throw new Error(initializeResponse.error.message);
  }
  const reloadResponse = responses[1];
  if (reloadResponse === undefined) {
    throw new Error("daemon did not return a daemon.reload response");
  }
  assertExpectedDaemonResponse(reloadResponse, 2, "daemon.reload");
  if (isDaemonErrorResponse(reloadResponse)) {
    throw new Error(reloadResponse.error.message);
  }
  const result = (reloadResponse as AgenCDaemonSuccessResponse<"daemon.reload">)
    .result;
  if (!isDaemonReloadResult(result)) {
    throw new Error("daemon returned a malformed daemon.reload result");
  }
  return result;
}

function resolveAgenCDaemonRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const configured = env[AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV]?.trim();
  if (configured === undefined || configured.length === 0) {
    return DEFAULT_DAEMON_REQUEST_TIMEOUT_MS;
  }
  const timeoutMs = Number.parseInt(configured, 10);
  if (
    !Number.isInteger(timeoutMs) ||
    String(timeoutMs) !== configured ||
    timeoutMs <= 0
  ) {
    throw new Error(
      `${AGENC_DAEMON_REQUEST_TIMEOUT_MS_ENV} must be a positive integer`,
    );
  }
  return timeoutMs;
}

async function readAgenCDaemonCookie(cookiePath: string): Promise<string> {
  try {
    const cookie = (await readFile(cookiePath, "utf8")).trim();
    if (cookie.length > 0) return cookie;
  } catch (error) {
    if (asNodeError(error).code !== "ENOENT") throw error;
  }
  throw new Error(`daemon cookie is not available at ${cookiePath}`);
}

function sendAgenCDaemonJsonLineRequests(
  socketPath: string,
  timeoutMs: number,
  requests: readonly object[],
  beforeNextRequest?: (
    response: AgenCDaemonResponse,
    responseIndex: number,
  ) => void,
): Promise<readonly AgenCDaemonResponse[]> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const responses: AgenCDaemonResponse[] = [];
    let buffer = "";
    let nextRequestIndex = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      finish(
        new Error(`Timed out waiting for daemon response at ${socketPath}`),
      );
    }, timeoutMs);

    const finish = (
      error: Error | null,
      responseList?: readonly AgenCDaemonResponse[],
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error !== null) {
        reject(error);
        return;
      }
      resolve(responseList!);
    };
    const writeNextRequest = () => {
      const request = requests[nextRequestIndex];
      if (request === undefined) return;
      nextRequestIndex += 1;
      socket.write(`${JSON.stringify(request)}\n`);
    };

    socket.setEncoding("utf8");
    socket.once("connect", writeNextRequest);
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length === 0) continue;
        try {
          const message = JSON.parse(line) as JsonValue;
          if (!isJsonObject(message) || !isJsonRpcResponse(message)) {
            continue;
          }
          const response = message as AgenCDaemonResponse;
          responses.push(response);
          if (
            isDaemonErrorResponse(response) ||
            responses.length >= requests.length
          ) {
            finish(null, responses);
            return;
          }
          beforeNextRequest?.(response, responses.length - 1);
          writeNextRequest();
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
    });
    socket.once("error", (error) => {
      finish(error);
    });
    socket.once("close", () => {
      finish(
        new Error(`Daemon connection closed before response at ${socketPath}`),
      );
    });
  });
}

async function runAgenCDaemonForeground(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  options: {
    readonly signalProcess?: AgenCSignalProcess;
    readonly beforeDaemonReady?: () => void | Promise<void>;
    readonly beforeDaemonReloadAdoption?: () => void | Promise<void>;
    readonly beforeDaemonAuthorityCleanup?: () => void | Promise<void>;
    readonly runner?: AgenCBackgroundAgentRunner;
    readonly nativePeerCredentialBinding?: AgenCNativePeerCredentialBinding;
    readonly nativePeerCredentialAddonPath?: string;
    readonly requireNativePeerCredentialForConnections?: boolean;
    readonly snapshotPeriodicIntervalMs?: number;
    readonly socketAcceptAuthenticationTimeoutMs?: number;
    readonly requestDaemonInstanceIdentity?: RunAgenCDaemonCliOptions["requestDaemonInstanceIdentity"];
    readonly inspectLegacyDaemonProcess?: RunAgenCDaemonCliOptions["inspectLegacyDaemonProcess"];
    readonly findLegacyDaemonProcesses?: RunAgenCDaemonCliOptions["findLegacyDaemonProcesses"];
  } = {},
): Promise<number> {
  const release = await acquireAgenCDaemonLifecycleLock(host);
  let released = false;
  let foregroundCompleted = false;
  const releaseOnce = async () => {
    if (released) return;
    released = true;
    await release();
  };
  try {
    const exitCode = await runAgenCDaemonForegroundLocked(host, io, {
      ...options,
      releaseLifecycleLock: releaseOnce,
    });
    foregroundCompleted = true;
    return exitCode;
  } finally {
    let releaseOk = true;
    try {
      await releaseOnce();
    } catch (error) {
      releaseOk = false;
      throw error;
    } finally {
      if (host.startupGuardReceiver?.wasRequested() === true) {
        await host.startupGuardReceiver
          .acknowledgeAfterCleanup(foregroundCompleted && releaseOk)
          .catch(() => {});
      }
    }
  }
}

async function runAgenCDaemonForegroundLocked(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  options: {
    readonly signalProcess?: AgenCSignalProcess;
    readonly beforeDaemonReady?: () => void | Promise<void>;
    readonly beforeDaemonReloadAdoption?: () => void | Promise<void>;
    readonly beforeDaemonAuthorityCleanup?: () => void | Promise<void>;
    readonly runner?: AgenCBackgroundAgentRunner;
    readonly nativePeerCredentialBinding?: AgenCNativePeerCredentialBinding;
    readonly nativePeerCredentialAddonPath?: string;
    readonly requireNativePeerCredentialForConnections?: boolean;
    readonly snapshotPeriodicIntervalMs?: number;
    readonly socketAcceptAuthenticationTimeoutMs?: number;
    readonly requestDaemonInstanceIdentity?: RunAgenCDaemonCliOptions["requestDaemonInstanceIdentity"];
    readonly inspectLegacyDaemonProcess?: RunAgenCDaemonCliOptions["inspectLegacyDaemonProcess"];
    readonly findLegacyDaemonProcesses?: RunAgenCDaemonCliOptions["findLegacyDaemonProcesses"];
    readonly releaseLifecycleLock: () => Promise<void>;
  },
): Promise<number> {
  // A cancellation queued while this child was blocked on the lifecycle lock
  // must win before recovery, services, MCP, or either listener is created.
  if (host.startupGuardReceiver?.wasRequested() === true) return 1;
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const existingPid = await readAgenCDaemonPid(pidPath);
  const existingRuntimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(
    dirname(pidPath),
  );
  const existingRuntimeInfo = readDaemonRuntimeInfo(existingRuntimeInfoPath);
  const recorded = daemonInstanceIdentityFromRuntimeInfo(existingRuntimeInfo);
  if (
    recorded !== null &&
    recorded.pid !== host.pid &&
    host.isPidRunning(recorded.pid)
  ) {
    try {
      const bound = await proveAgenCDaemonCliInstance(
        host,
        recorded.pid,
        existingRuntimeInfoPath,
        options.requestDaemonInstanceIdentity,
      );
      const sidecarNow = daemonInstanceIdentityFromRuntimeInfo(
        readDaemonRuntimeInfo(existingRuntimeInfoPath),
      );
      if (
        (await readAgenCDaemonPid(pidPath)) !== existingPid ||
        sidecarNow === null ||
        !sameAgenCDaemonInstanceIdentity(bound.identity, sidecarNow)
      ) {
        throw new Error("daemon metadata changed during foreground admission");
      }
      if (existingPid !== bound.identity.pid) {
        await writeAgenCDaemonPid(pidPath, bound.identity.pid);
      }
      io.stderr.write(
        `agenc: refusing foreground daemon start while authenticated daemon pid ${bound.identity.pid} is active\n`,
      );
      return 1;
    } catch (error) {
      io.stderr.write(
        `agenc: refusing foreground daemon start because live daemon identity could not be authenticated: ${formatCleanupError(error)}\n`,
      );
      return 1;
    }
  }
  if (recorded !== null && !host.isPidRunning(recorded.pid)) {
    removeDaemonRuntimeInfo(existingRuntimeInfoPath, recorded.instanceId);
  }
  const legacySidecarPid =
    recorded === null ? existingRuntimeInfo?.pid : undefined;
  if (
    legacySidecarPid !== undefined &&
    legacySidecarPid !== host.pid &&
    host.isPidRunning(legacySidecarPid)
  ) {
    if ((host.platform ?? process.platform) !== "linux") {
      io.stderr.write(
        `agenc: refusing foreground daemon start while legacy daemon pid ${legacySidecarPid} is active without a portable instance binding; stop it with the OS service/process manager after verifying its command and AgenC home, then retry\n`,
      );
      return 1;
    }
    const inspectLegacy =
      options.inspectLegacyDaemonProcess ??
      ((targetPid: number) =>
        inspectLinuxAgenCDaemonProcess(
          targetPid,
          host,
          resolveAgenCDaemonHome(host.env, host.userHome),
          "any-install",
        ));
    const legacyProcess = await Promise.resolve(
      inspectLegacy(legacySidecarPid),
    );
    if (legacyProcess === null) {
      io.stderr.write(
        `agenc: refusing foreground daemon start because legacy daemon pid ${legacySidecarPid} could not be proven as a same-home Linux daemon\n`,
      );
      return 1;
    }
    if (
      (await readAgenCDaemonPid(pidPath)) !== existingPid ||
      JSON.stringify(readDaemonRuntimeInfo(existingRuntimeInfoPath)) !==
        JSON.stringify(existingRuntimeInfo)
    ) {
      io.stderr.write(
        "agenc: refusing foreground daemon start because legacy daemon metadata changed during admission\n",
      );
      return 1;
    }
    if (existingPid !== legacySidecarPid) {
      await writeAgenCDaemonPid(pidPath, legacySidecarPid);
    }
    io.stderr.write(
      `agenc: refusing foreground daemon start while proven legacy daemon pid ${legacySidecarPid} is active\n`,
    );
    return 1;
  }
  if (
    existingPid !== null &&
    existingPid !== host.pid &&
    host.isPidRunning(existingPid)
  ) {
    io.stderr.write(
      `agenc: refusing foreground daemon start while pid ${existingPid} is active\n`,
    );
    return 1;
  }
  if (existingPid !== null && !host.isPidRunning(existingPid)) {
    await removeAgenCDaemonPid(pidPath, existingPid);
  }
  if (
    existingRuntimeInfo !== null &&
    !host.isPidRunning(existingRuntimeInfo.pid) &&
    JSON.stringify(readDaemonRuntimeInfo(existingRuntimeInfoPath)) ===
      JSON.stringify(existingRuntimeInfo)
  ) {
    removeDaemonRuntimeInfo(
      existingRuntimeInfoPath,
      existingRuntimeInfo.instanceId,
    );
  }
  const discoveryPidSnapshot = await readAgenCDaemonPid(pidPath);
  const discoveryRuntimeInfoSnapshot = readDaemonRuntimeInfo(
    existingRuntimeInfoPath,
  );
  let untracked: UntrackedAgenCDaemonSingleton | null;
  try {
    untracked = await discoverUntrackedAgenCDaemonSingleton(
      host,
      options.findLegacyDaemonProcesses,
    );
  } catch (error) {
    io.stderr.write(
      `agenc: refusing foreground daemon start because untracked daemon discovery failed: ${formatCleanupError(error)}\n`,
    );
    return 1;
  }
  if (untracked?.kind === "unbound-socket") {
    io.stderr.write(
      "agenc: refusing foreground daemon start because the daemon control socket is active without portable process identity; stop it with the OS service/process manager after verifying its command and AgenC home, then retry\n",
    );
    return 1;
  }
  if (untracked?.kind === "legacy-process") {
    if (
      (await readAgenCDaemonPid(pidPath)) !== discoveryPidSnapshot ||
      JSON.stringify(readDaemonRuntimeInfo(existingRuntimeInfoPath)) !==
        JSON.stringify(discoveryRuntimeInfoSnapshot)
    ) {
      io.stderr.write(
        "agenc: refusing foreground daemon start because metadata changed during untracked process discovery\n",
      );
      return 1;
    }
    if (discoveryPidSnapshot !== untracked.process.pid) {
      await writeAgenCDaemonPid(pidPath, untracked.process.pid);
    }
    io.stderr.write(
      `agenc: refusing foreground daemon start while untracked same-home daemon pid ${untracked.process.pid} is active\n`,
    );
    return 1;
  }
  // Install the process-wide proxy/mTLS dispatcher before any daemon service
  // (including a possibly-remote-HTTP auth backend) issues a request. The TUI
  // does this via applyConfigEnvironmentVariables; the headless daemon never
  // runs that path, so a bare fetch()/global-axios call would otherwise ignore
  // HTTPS_PROXY. No-op when no proxy/mTLS/CA env is present.
  configureGlobalAgents();
  const authStartup = await tryResolveAgenCDaemonAuthStartup(host, io);
  if (authStartup === null) {
    return 1;
  }
  if (host.startupGuardReceiver?.wasRequested() === true) return 1;
  // OOM self-diagnosis: the daemon is the longest-lived agenc process, so a
  // near-limit heap snapshot here is the difference between a diagnosable
  // field OOM and a bare V8 abort.
  startHeapWatchdog({
    agencHome: authStartup.daemonHome,
    warn: (message) => io.stderr.write(`${message}\n`),
  });
  let activeConfig = authStartup.config;
  const reloadableAuthBackend = new AgenCDaemonReloadableAuthBackend(
    authStartup.authBackend,
  );
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  let webSocketListenOptions: AgenCDaemonWebSocketListenOptions;
  try {
    webSocketListenOptions = resolveAgenCDaemonWebSocketListenOptions(host.env);
  } catch (error) {
    io.stderr.write(
      `agenc: daemon websocket configuration failed: ${formatCleanupError(error)}\n`,
    );
    return 1;
  }
  const snapshotPath = resolveAgenCDaemonSnapshotPath(host.env, host.userHome);
  const daemonCookie = await ensureAgenCDaemonCookie(
    resolveAgenCDaemonCookiePath(host.env, host.userHome),
  );
  const cookieAuthenticator = new AgenCDaemonCookieAuthenticator(daemonCookie);
  const runtimeRoot = resolveRuntimePackageRootFromUrl(import.meta.url);
  const distVersion = host.readCurrentRuntimeBuild
    ? host.readCurrentRuntimeBuild()
    : runtimeRoot !== null
      ? readDistVersion(runtimeRoot)
      : null;
  const processStart = await readAgenCDaemonProcessStart(
    host.pid,
    host.readProcessIdentity,
  );
  if (processStart === null) {
    io.stderr.write(
      `agenc: daemon process identity could not be established (pid ${host.pid})\n`,
    );
    return 1;
  }
  const daemonIdentity: AgenCDaemonInstanceIdentity = {
    pid: host.pid,
    instanceId: randomUUID(),
    processStart,
    runtimeVersion: distVersion?.runtimeVersion ?? "development",
    commit: distVersion?.commit ?? "unknown",
    buildTime: distVersion?.buildTime ?? "unknown",
  };
  let lifecycleLockReleased = false;
  let startupRecovery: DaemonStartupRecoveryReport;
  if (host.startupGuardReceiver?.wasRequested() === true) return 1;
  try {
    startupRecovery = recoverAgenCDaemonStartupState(
      authStartup.daemonHome,
      process.cwd(),
      activeConfig,
    );
    reportAgenCDaemonStartupRecovery(io, startupRecovery);
  } catch (error) {
    io.stderr.write(
      `agenc: daemon state recovery failed: ${formatCleanupError(error)}\n`,
    );
    return 1;
  }
  const cleanup = new AgenCCleanupRegistry();
  let cleanupHandled = false;
  let startupFailure: unknown;
  try {
    if (host.startupGuardReceiver?.wasRequested() === true) return 1;
    // DAE-03: union session/thread discovery across all projects under AGENC_HOME
    // (not only the daemon-start cwd registry).
    const primaryCwd = resolveDaemonDefaultCwd(host.env);
    const threadStore = new MultiProjectFileThreadStore({
      primaryCwd,
      agencHome: authStartup.daemonHome,
    });
    cleanup.register("daemon-thread-store", async () => {
      threadStore.close();
    });
    let codePrediction: CodePredictionService | undefined;
    const sessionManager = new AgenCDaemonSessionManager({
      threadStore,
      onSessionTerminated: (sessionId) =>
        codePrediction?.disposeSession(sessionId),
    });
    // Forward declaration: set once the connection registry below exists. Lets
    // the multiplexer ask the transport to tear down a slow consumer's socket
    // when that client's pending delivery backlog trips the per-client cap.
    let destroyEvictedClientConnection:
      ((clientId: string) => void) | undefined;
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager,
      onClientEvicted: (clientId) => {
        destroyEvictedClientConnection?.(clientId);
      },
    });
    const commandExec = new AgenCCommandExecService({
      agencLinuxSandboxExe: resolveDefaultLinuxSandboxExecutable(),
      allowGpu: activeConfig.sandbox?.allow_gpu === true,
    });
    cleanup.register("daemon-command-exec", async () => {
      await commandExec.closeAll("daemon_shutdown");
    });
    const csvAgentJobsRepositories = new CsvAgentJobsRepositoryAuthority({
      agencHome: authStartup.daemonHome,
    });
    cleanup.register("daemon-csv-agent-jobs", () =>
      csvAgentJobsRepositories.close(),
    );
    let executionAdmissionKernel: ExecutionAdmissionKernel;
    try {
      executionAdmissionKernel = new ExecutionAdmissionKernel({
        agencHome: authStartup.daemonHome,
        limits: resolveAdmissionConcurrencyLimits(host.env, {
          sessionLimit: activeConfig.agent_max_threads,
        }),
      });
      const recovery = executionAdmissionKernel.initializeExistingState();
      if (
        recovery.requeued > 0 ||
        recovery.heldUnknown > 0 ||
        recovery.expired > 0 ||
        recovery.detachedQueued > 0 ||
        recovery.staleRunBindings > 0
      ) {
        io.stderr.write(
          `agenc: admission recovery databases=${recovery.databases} ` +
            `requeued=${recovery.requeued} held_unknown=${recovery.heldUnknown} ` +
            `expired=${recovery.expired} detached=${recovery.detachedQueued} ` +
            `stale_run_bindings=${recovery.staleRunBindings}\n`,
        );
      }
      // A failed project is excluded from admission, not fatal: the daemon
      // must keep serving every other project (a legacy or damaged journal
      // in one old workspace used to brick startup globally).
      for (const failure of recovery.failures) {
        io.stderr.write(
          `agenc: execution admission recovery excluded ${failure.projectDir} ` +
            `(${failure.stateDbPath}): ${failure.message}\n`,
        );
      }
    } catch (error) {
      io.stderr.write(
        `agenc: execution admission recovery failed: ${formatCleanupError(error)}\n`,
      );
      return 1;
    }
    cleanup.register("daemon-execution-admission", () => {
      executionAdmissionKernel.close();
    });
    if (host.startupGuardReceiver?.wasRequested() === true) return 1;
    // Only the spawned, detached daemon (AGENC_DAEMON_RUN=1) redirects console
    // output into the size-capped rotating sink; a `--foreground` invocation run
    // directly by a user keeps writing to the inherited terminal.
    if (host.env.AGENC_DAEMON_RUN === "1") {
      const logSink = installAgenCDaemonLogSink({
        path: resolveAgenCDaemonLogPath(host.env, host.userHome),
      });
      if (logSink !== null) {
        cleanup.register("daemon-log-sink", () => {
          logSink.dispose();
        });
      }
    }
    let shuttingDown = false;
    let resolveRpcShutdown!: () => void;
    const rpcShutdownCompleted = new Promise<void>((resolve) => {
      resolveRpcShutdown = resolve;
    });
    let fatalPeerCredentialFailure: Error | null = null;
    let resolveFatalPeerCredentialFailure!: (error: Error) => void;
    const fatalPeerCredentialFailureCompleted = new Promise<Error>(
      (resolve) => {
        resolveFatalPeerCredentialFailure = resolve;
      },
    );
    let runner = options.runner;
    let configuredRunner: AgenCDelegateBackgroundAgentRunner | undefined;
    if (runner === undefined) {
      configuredRunner = new AgenCDelegateBackgroundAgentRunner({
        env: host.env,
        argv: [host.execPath, host.entrypointPath, "--autonomous"],
        executionAdmissionKernel,
        csvAgentJobsRepositories,
        ...createAgenCDaemonDelegateRunnerRuntimeConfig(
          host,
          activeConfig,
          reloadableAuthBackend,
        ),
      });
      runner = configuredRunner;
    }
    let snapshotPolicies: AgenCDaemonSnapshotPolicyRegistry;
    try {
      snapshotPolicies = new AgenCDaemonSnapshotPolicyRegistry({
        agencHome: authStartup.daemonHome,
        defaultCwd: primaryCwd,
        snapshotRetention: activeConfig.agent?.retention,
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
    cleanup.register("daemon-snapshot-policy", async () => {
      snapshotPolicies.close();
    });
    const agentManager = new AgenCDaemonAgentManager({
      runner,
      sessionManager,
      threadStore,
      // DAE-02: prefer client/workspace env over frozen OS cwd when params omit cwd.
      defaultCwd: () => resolveDaemonDefaultCwd(host.env),
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
      recordRunTerminal: (terminal) => {
        try {
          snapshotPolicies.recordRunTerminal(terminal);
        } catch (error) {
          io.stderr.write(
            `agenc: durable run terminal commit failed: ${formatCleanupError(error)}\n`,
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
      cancelRunTreeDurable: (params) =>
        cancelRunTreeAcrossStateDatabases(
          authStartup.daemonHome,
          primaryCwd,
          params,
        ),
      voidBudgetHoldsForAgents: (agentIds) => {
        let voided = 0;
        for (const agentId of agentIds) {
          voided += executionAdmissionKernel.cancelRun(
            agentId,
            "run.cancel",
          ).voidedReservations;
        }
        return voided;
      },
    });
    cleanup.register("daemon-snapshots", async () => {
      await agentManager.flushSnapshots("daemon_shutdown");
    });
    cleanup.register("daemon-agents", async () => {
      await agentManager.stopAll("daemon_shutdown", {
        disposition: "suspend_idle",
      });
    });
    codePrediction =
      runner.resolveCodePredictionSource === undefined
        ? undefined
        : new CodePredictionService({
            resolveSource: (sessionId) =>
              agentManager.resolveCodePredictionSource(sessionId),
            config: activeConfig.buffer?.prediction,
          });
    if (codePrediction !== undefined) {
      cleanup.register("daemon-code-prediction", () =>
        codePrediction.dispose(),
      );
    }
    // Wire the runner's terminal-status hook into the lifecycle so a
    // completed/errored agent's status transitions out of `running` in
    // `agent.list` immediately, instead of being lost in the race
    // between the runner's `#cleanupWhenComplete` deletion and the
    // lifecycle's lazy snapshot poll. The setter is optional on the
    // interface so injected runners (tests, alt implementations) can
    // skip it without binding to the concrete delegate runner.
    runner.setOnActiveAgentTerminated?.((agentId, snapshot) =>
      agentManager.handleRunnerTerminated(agentId, snapshot),
    );
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
    if (host.startupGuardReceiver?.wasRequested() === true) return 1;
    // M5 verified-change workflow controller. Constructed over the shared
    // admission kernel + durable state, with the Phase 5 session-backed seams
    // (per-run daemon session, rollout journal, sandbox-brokered worktrees and
    // verification commands, delegate spawner, one-shot reviewer). Open
    // workflow runs are resumed (D3 recovery) after admission recovery and
    // startup journal recovery so adopted/re-executed effects observe fully
    // recovered budget state.
    const workflowWiring = createDaemonWorkflowController({
      agencHome: authStartup.daemonHome,
      primaryCwd,
      kernel: executionAdmissionKernel,
      warn: (message) => io.stderr.write(`agenc: ${message}\n`),
      env: host.env,
      authBackend: reloadableAuthBackend,
      stateDatabasePaths: () =>
        discoverAgenCDaemonStateDatabasePaths(
          authStartup.daemonHome,
          primaryCwd,
        ),
    });
    cleanup.register("daemon-workflow-controller", () => {
      workflowWiring.close();
    });
    void workflowWiring.resumeOpenWorkflows().catch((error) => {
      io.stderr.write(
        `agenc: workflow startup recovery failed: ${formatCleanupError(error)}\n`,
      );
    });
    const workflowStartService = new DaemonWorkflowStartService({
      controller: workflowWiring.controller,
      primaryCwd,
      recordAgentRun: (run) => {
        snapshotPolicies.recordAgentRun(run);
      },
      warn: (message) => io.stderr.write(`agenc: ${message}\n`),
    });
    const health = new AgenCDaemonHealthService({
      sessionCounter: sessionManager,
      stateCounter: new StateSqliteHealthStatsReader(
        discoverAgenCDaemonStateDatabasePaths(
          authStartup.daemonHome,
          process.cwd(),
        ),
      ),
      ready: () => !shuttingDown,
    });
    const realtime = new AgenCRealtimeRpcService({
      resolveThread: (threadId) =>
        runner.resolveRealtimeThread?.(threadId) ?? null,
    });
    let activeMcpServer = inactiveDaemonMcpServerHandle(activeConfig);
    let reloadChain = Promise.resolve<DaemonReloadResult | null>(null);
    const reloadConfig = (): Promise<DaemonReloadResult> => {
      reloadChain = reloadChain
        .catch(() => null)
        .then(async () => {
          if (shuttingDown) {
            throw new Error("daemon is shutting down");
          }
          const next = await resolveAgenCDaemonAuthStartup(host, io);
          if (shuttingDown) {
            throw new Error("daemon is shutting down");
          }
          const previousMcpServer = activeMcpServer;
          const preparedMcpChange =
            await prepareConfiguredDaemonMcpServerChange(
              previousMcpServer,
              next.config,
              io,
            );
          let adopted = false;
          try {
            await options.beforeDaemonReloadAdoption?.();
            // Preparation may bind a replacement MCP listener. Shutdown fences
            // adoption before mutating any live runtime configuration, and the
            // finally block rejects that prepared handle.
            if (shuttingDown) {
              throw new Error("daemon is shutting down");
            }
            reloadableAuthBackend.replace(next.authBackend);
            configuredRunner?.updateRuntimeConfig(
              createAgenCDaemonDelegateRunnerRuntimeConfig(
                host,
                next.config,
                reloadableAuthBackend,
              ),
            );
            snapshotPolicies.updateSnapshotRetention(
              next.config.agent?.retention,
            );
            executionAdmissionKernel.updateLimits(
              resolveAdmissionConcurrencyLimits(host.env, {
                sessionLimit: next.config.agent_max_threads,
              }),
            );
            activeConfig = next.config;
            await codePrediction?.updateConfig(next.config.buffer?.prediction);
            activeMcpServer = preparedMcpChange.adopt();
            adopted = true;
          } finally {
            if (!adopted) {
              await preparedMcpChange.reject();
            }
          }
          if (preparedMcpChange.closePreviousAfterAdoption) {
            await closeReplacedDaemonMcpServer(previousMcpServer, io);
          }
          const result: DaemonReloadResult = {
            reloaded: true,
            configReloadedAt: new Date().toISOString(),
            mcpServer: daemonMcpServerReloadResult(activeMcpServer),
          };
          io.stderr.write("AgenC daemon config reloaded\n");
          return result;
        });
      return reloadChain.then((result) => {
        if (result === null) {
          throw new Error("daemon reload did not produce a result");
        }
        return result;
      });
    };
    const rpcShutdown = new AgenCDaemonRpcShutdownCoordinator(() => {
      shuttingDown = true;
      resolveRpcShutdown();
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager,
      clientMultiplexer,
      sessionManager,
      fuzzyAllowedRoots: [primaryCwd],
      commandExec,
      authBackend: reloadableAuthBackend,
      daemonControl: {
        reloadConfig,
        shutdown: (instanceId) => {
          // Fence ingress synchronously, before the success response is built or
          // flushed, so no reload can enter behind an accepted shutdown.
          shuttingDown = true;
          return rpcShutdown.accept(instanceId);
        },
      },
      health,
      realtime,
      runInspection: new AgenCDaemonRunInspectionService({
        stateDatabasePaths: () =>
          discoverAgenCDaemonStateDatabasePaths(
            authStartup.daemonHome,
            primaryCwd,
          ),
        agencHome: authStartup.daemonHome,
      }),
      workflow: workflowStartService,
      csvJobReview: new AgenCCsvJobReviewStateService(csvAgentJobsRepositories),
      ...(codePrediction !== undefined ? { codePrediction } : {}),
      daemonIdentity,
      initializeAuthenticator: (params) =>
        cookieAuthenticator.authenticateInitializeParams(params),
    });
    const connections = new Map<string, AgenCDaemonJsonRpcConnection>();
    const socketConnections = new Map<
      string,
      { readonly send: (message: JsonObject) => Promise<void> }
    >();
    const connectionFor = (
      connectionKey: string,
    ): AgenCDaemonJsonRpcConnection => {
      const current = connections.get(connectionKey);
      if (current !== undefined) return current;
      const next = dispatcher.createConnection({
        sendNotification: async (message) => {
          await socketConnections.get(connectionKey)?.send(message);
        },
      });
      connections.set(connectionKey, next);
      return next;
    };
    const closeConnection = (connectionKey: string): void => {
      const connection = connections.get(connectionKey);
      connections.delete(connectionKey);
      socketConnections.delete(connectionKey);
      void connection?.close().catch(() => {});
      for (const clientId of connection?.trackedClientIds ?? []) {
        void clientMultiplexer.removeClient(clientId).catch(() => {});
      }
    };
    // Tear down the transport for a slow consumer the multiplexer evicted for an
    // unbounded pending delivery backlog. The multiplexer already removed the
    // client from its routing state. A single transport connection can carry
    // MULTIPLE tracked clients (trackedClientIds is a set keyed by the clientId a
    // peer supplies in attach calls), so only destroy the whole connection when
    // the evicted client is its SOLE tracked client — otherwise just stop
    // tracking that client and leave the connection (and its other healthy
    // co-located clients) untouched. Destroying the socket ends the backpressured
    // peer so it stops pinning daemon heap; it can reconnect and replay through
    // the normal detached-buffer path.
    destroyEvictedClientConnection = (clientId: string): void => {
      for (const [connectionKey, connection] of connections) {
        if (!connection.trackedClientIds.includes(clientId)) {
          continue;
        }
        const wasSoleClient = connection.untrackClientId(clientId);
        if (wasSoleClient) {
          closeConnection(connectionKey);
        }
        return;
      }
    };
    const systemNativePeerCredentialAddonPath =
      options.nativePeerCredentialBinding === undefined
        ? resolveSystemNativePeerCredentialAddonPath()
        : undefined;
    const nativePeerCredentialAddonPath =
      options.nativePeerCredentialAddonPath ??
      systemNativePeerCredentialAddonPath;
    const socketServer = new AgenCUnixSocketServer({
      socketPath,
      nativePeerCredentialAddonPath,
      requireRootOwnedNativePeerCredentialAddon:
        options.nativePeerCredentialAddonPath === undefined &&
        systemNativePeerCredentialAddonPath !== undefined,
      requireNativePeerCredentialForConnections:
        nativePeerCredentialAddonPath !== undefined ||
        options.requireNativePeerCredentialForConnections === true,
      onRequiredNativePeerCredentialFailure: (error) => {
        if (fatalPeerCredentialFailure !== null) return;
        fatalPeerCredentialFailure = error;
        shuttingDown = true;
        io.stderr.write(
          `agenc: fatal daemon socket authentication failure: ${error.message}\n`,
        );
        resolveFatalPeerCredentialFailure(error);
      },
      nativePeerCredentialBinding: options.nativePeerCredentialBinding,
      onNativePeerCredentialUnavailable: (message) => {
        io.stderr.write(
          `agenc: daemon peer credential native binding unavailable: ${message}\n`,
        );
      },
      acceptAuthenticator: (message, context) =>
        message.method === "initialize" &&
        (daemonVerifiedIdentityForContext(context) !== null ||
          cookieAuthenticator.authenticateInitializeMessage(message) !== null),
      acceptAuthenticationTimeoutMs:
        options.socketAcceptAuthenticationTimeoutMs,
      onAuthenticationFailed: async (message, context) => {
        await context.send(
          daemonConnectionAuthenticationFailedResponse(message),
        );
      },
      onMessage: async (message, context) => {
        if (shuttingDown || rpcShutdown.blocksRequests) {
          await context.send(daemonShuttingDownResponse(message));
          return;
        }
        const connectionKey = daemonTransportConnectionKey(
          "unix",
          context.connectionId,
        );
        socketConnections.set(connectionKey, {
          send: (notification) => context.send(notification),
        });
        const connection = connectionFor(connectionKey);
        const verifiedIdentity = daemonVerifiedIdentityForContext(context);
        if (!connection.initialized && verifiedIdentity !== null) {
          connection.markDaemonSocketIdentity(verifiedIdentity);
        }
        const response = await connection.dispatch(message);
        await rpcShutdown.send(message, response, context.send);
        if (isDaemonConnectionAuthenticationFailure(response)) {
          context.close();
        }
      },
      onError: (error) => {
        io.stderr.write(`agenc: daemon socket error: ${error.message}\n`);
      },
      onConnectionClosed: (connectionId) => {
        closeConnection(daemonTransportConnectionKey("unix", connectionId));
      },
    });
    const webSocketServer = new AgenCWebSocketServer({
      ...webSocketListenOptions,
      ready: () => !shuttingDown,
      validateOrigin: validateAgenCDaemonWebSocketOrigin,
      // gaphunt3 #47: mirror the Unix socket accept-auth gate, but the ws path
      // has no peer-credential identity, so it relies solely on the
      // cookie/initialize check.
      acceptAuthenticator: (message) =>
        message.method === "initialize" &&
        cookieAuthenticator.authenticateInitializeMessage(message) !== null,
      acceptAuthenticationTimeoutMs:
        options.socketAcceptAuthenticationTimeoutMs,
      onAuthenticationFailed: async (message, context) => {
        await context.send(
          daemonConnectionAuthenticationFailedResponse(message),
        );
      },
      onMessage: async (message, context) => {
        if (shuttingDown || rpcShutdown.blocksRequests) {
          await context.send(daemonShuttingDownResponse(message));
          return;
        }
        const connectionKey = daemonTransportConnectionKey(
          "websocket",
          context.connectionId,
        );
        socketConnections.set(connectionKey, {
          send: (notification) => context.send(notification),
        });
        const response = await connectionFor(connectionKey).dispatch(message);
        await rpcShutdown.send(message, response, context.send);
        if (isDaemonConnectionAuthenticationFailure(response)) {
          context.close();
        }
      },
      onError: (error) => {
        io.stderr.write(`agenc: daemon websocket error: ${error.message}\n`);
      },
      onConnectionClosed: (connectionId) => {
        closeConnection(
          daemonTransportConnectionKey("websocket", connectionId),
        );
      },
    });
    cleanup.register("daemon-browser", async () => {
      await closeAllBrowserManagers();
    });
    cleanup.register("daemon-fuzzy-file-index", async () => {
      await dispatcher.close();
    });
    cleanup.register("daemon-connections", async () => {
      const activeConnections = [...connections.values()];
      connections.clear();
      socketConnections.clear();
      await Promise.all(
        activeConnections.map((connection) => connection.close()),
      );
    });
    cleanup.register("daemon-authority", async () => {
      await options.beforeDaemonAuthorityCleanup?.();
      await runAgenCDaemonAuthorityCleanup({
        host,
        lifecycleLockHeld: !lifecycleLockReleased,
        closeSocket: () => socketServer.close(),
        removeMetadata: () =>
          removeOwnedForegroundDaemonMetadata({
            expected: daemonIdentity,
            pidPath,
            runtimeInfoPath: existingRuntimeInfoPath,
          }),
      });
    });
    cleanup.register("daemon-websocket", async () => {
      await webSocketServer.close();
    });
    cleanup.register("daemon-mcp-server", async () => {
      await activeMcpServer.close();
    });

    const signalProcess = options.signalProcess ?? process;
    const shutdownSignal = installAgenCShutdownSignalHandlers((event) => {
      shuttingDown = true;
      io.stderr.write(`${summarizeAgenCShutdown(event)}\n`);
    }, signalProcess);
    let exitCode = 0;
    let cleanupContext:
      | { readonly reason: "daemon_shutdown" }
      | Awaited<typeof shutdownSignal.completed> = {
      reason: "daemon_shutdown",
    };
    try {
      if (host.startupGuardReceiver?.wasRequested() === true) {
        exitCode = 1;
        return exitCode;
      }
      try {
        activeMcpServer = await startConfiguredDaemonMcpServer(
          activeConfig,
          io,
        );
      } catch {
        exitCode = 1;
        return exitCode;
      }
      if (host.startupGuardReceiver?.wasRequested() === true) {
        exitCode = 1;
        return exitCode;
      }
      await socketServer.listen();
      if (host.startupGuardReceiver?.wasRequested() === true) {
        exitCode = 1;
        return exitCode;
      }
      const webSocketAddress = await webSocketServer.listen();
      if (
        webSocketListenOptions.fallbackToEphemeralPortOnAddrInUse &&
        webSocketAddress.port !== webSocketListenOptions.port
      ) {
        io.stderr.write(
          `agenc: daemon websocket port ${webSocketListenOptions.port} is in ` +
            `use by another process; listening on ephemeral port ` +
            `${webSocketAddress.port} instead\n`,
        );
      }
      io.stderr.write(
        `AgenC daemon websocket listening on ${webSocketAddress.url}\n`,
      );
      const beforeDaemonReady = Promise.resolve(options.beforeDaemonReady?.());
      if (host.startupGuardReceiver === undefined) {
        await beforeDaemonReady;
      } else {
        await Promise.race([
          beforeDaemonReady,
          host.startupGuardReceiver.requested,
        ]);
        if (host.startupGuardReceiver.wasRequested()) shuttingDown = true;
      }
      if (!shuttingDown) {
        // Record the runtime build this daemon was launched against so
        // the CLI's `ensureDaemonReady` path can detect version skew on
        // the next invocation and respawn instead of hanging on a
        // missing-chunk dynamic import.
        const runtimeInfoPath = existingRuntimeInfoPath;
        try {
          // The identity-bearing sidecar is committed before this final pid
          // refresh. A detached parent may have published a provisional pid;
          // lifecycle contenders treat that sidecar-less window as pending and
          // wait for this foreground readiness commit.
          writeDaemonRuntimeInfo(runtimeInfoPath, {
            ...daemonIdentity,
            startedAt: new Date().toISOString(),
            // Records the port actually bound, which is not the default when
            // another daemon already holds it and the listener fell back.
            webSocketUrl: webSocketAddress.url,
          });
          await writeAgenCDaemonPid(pidPath, host.pid);
          await options.releaseLifecycleLock();
          lifecycleLockReleased = true;
        } catch (error) {
          io.stderr.write(
            `agenc: failed to persist daemon identity: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
          exitCode = 1;
          return exitCode;
        }
      }
      if (!shuttingDown) {
        io.stdout.write(`AgenC daemon running (pid ${host.pid})\n`);
      }

      const termination = await Promise.race([
        shutdownSignal.completed.then((event) => ({
          kind: "signal" as const,
          event,
        })),
        fatalPeerCredentialFailureCompleted.then((error) => ({
          kind: "peer_credential_failure" as const,
          error,
        })),
        rpcShutdownCompleted.then(() => ({
          kind: "rpc_shutdown" as const,
        })),
        ...(host.startupGuardReceiver === undefined
          ? []
          : [
              host.startupGuardReceiver.requested.then(() => ({
                kind: "startup_cancel" as const,
              })),
            ]),
      ]);
      if (termination.kind === "signal") {
        cleanupContext = termination.event;
        exitCode = termination.event.exitCode;
      } else if (termination.kind === "peer_credential_failure") {
        cleanupContext = { reason: "daemon_shutdown" };
        exitCode = 1;
      } else {
        cleanupContext = { reason: "daemon_shutdown" };
        exitCode = termination.kind === "startup_cancel" ? 1 : 0;
      }
    } finally {
      shuttingDown = true;
      shutdownSignal.dispose();
      // Any reload admitted before the ingress fence must either finish or
      // reject its prepared resources before MCP/socket cleanup begins.
      await reloadChain.catch(() => null);
      const results = await cleanup.run(cleanupContext);
      cleanupHandled = true;
      const failed = results.filter((result) => !result.ok);
      if (failed.length > 0) {
        for (const failure of failed) {
          io.stderr.write(
            `agenc: cleanup[${failure.name}] failed: ${formatCleanupError(failure.error)}\n`,
          );
        }
        if (exitCode === 0) exitCode = 1;
      }
      if (host.startupGuardReceiver?.wasRequested() === true) {
        try {
          await host.startupGuardReceiver.acknowledgeAfterCleanup(
            failed.length === 0,
          );
        } catch (error) {
          io.stderr.write(
            `agenc: startup cancellation acknowledgement failed: ${formatCleanupError(error)}\n`,
          );
          if (exitCode === 0) exitCode = 1;
        }
      }
    }
    return exitCode;
  } catch (error) {
    startupFailure = error;
    throw error;
  } finally {
    const finalizationErrors: unknown[] = [];
    if (!cleanupHandled) {
      const results = await cleanup.run({ reason: "daemon_shutdown" });
      for (const result of results) {
        if (result.ok) continue;
        io.stderr.write(
          `agenc: cleanup[${result.name}] failed: ${formatCleanupError(result.error)}\n`,
        );
        finalizationErrors.push(result.error);
      }
    }
    try {
      closeRecoveredStartupResumeSources(startupRecovery.recoveredRuns);
    } catch (error) {
      finalizationErrors.push(error);
    }
    if (finalizationErrors.length > 0) {
      throw new AggregateError(
        startupFailure === undefined
          ? finalizationErrors
          : [startupFailure, ...finalizationErrors],
        "daemon startup finalization failed",
        { cause: startupFailure },
      );
    }
  }
}

async function removeOwnedForegroundDaemonMetadata(params: {
  readonly expected: AgenCDaemonInstanceIdentity;
  readonly pidPath: string;
  readonly runtimeInfoPath: string;
}): Promise<void> {
  const runtimeInfoPathExists = existsSync(params.runtimeInfoPath);
  const recorded = daemonInstanceIdentityFromRuntimeInfo(
    readDaemonRuntimeInfo(params.runtimeInfoPath),
  );
  const recordedIsExpected =
    recorded !== null &&
    sameAgenCDaemonInstanceIdentity(recorded, params.expected);
  const currentPid = await readAgenCDaemonPid(params.pidPath);
  const errors: unknown[] = [];

  if (recordedIsExpected) {
    try {
      await rm(params.runtimeInfoPath, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (
    currentPid === params.expected.pid &&
    (!runtimeInfoPathExists || recordedIsExpected)
  ) {
    try {
      await removeAgenCDaemonPid(params.pidPath, params.expected.pid);
    } catch (error) {
      errors.push(error);
    }
  }
  throwDaemonAuthorityCleanupErrors(errors);
}

/** @internal Exported for lifecycle-lock and cleanup-error contract tests. */
export async function runAgenCDaemonAuthorityCleanup(params: {
  readonly host: Pick<AgenCDaemonCliHost, "env" | "userHome">;
  readonly lifecycleLockHeld: boolean;
  readonly closeSocket: () => Promise<void> | void;
  readonly removeMetadata: () => Promise<void> | void;
}): Promise<void> {
  const cleanupAuthority = async (): Promise<void> => {
    const errors: unknown[] = [];
    try {
      await params.closeSocket();
    } catch (error) {
      errors.push(error);
    }
    try {
      await params.removeMetadata();
    } catch (error) {
      errors.push(error);
    }
    throwDaemonAuthorityCleanupErrors(errors);
  };
  if (params.lifecycleLockHeld) {
    // Startup still owns the foreground admission lock. Reacquiring it here
    // would deadlock a failed/cancelled launch before publication.
    await cleanupAuthority();
    return;
  }
  await withAgenCDaemonLifecycleLock(params.host, cleanupAuthority);
}

function throwDaemonAuthorityCleanupErrors(errors: readonly unknown[]): void {
  if (errors.length === 0) return;
  const primary = errors[0];
  if (errors.length === 1) throw primary;
  throw new AggregateError(errors, "daemon authority cleanup failed", {
    cause: primary,
  });
}

interface AgenCDaemonMcpServerHandle {
  readonly fingerprint: string;
  readonly bindingFingerprint: string;
  readonly status: "disabled" | "unsupported" | "listening";
  readonly url?: string;
  readonly server?: StartedMcpSseServer;
  close(): Promise<void>;
}

interface PreparedDaemonMcpServerChange {
  readonly closePreviousAfterAdoption: boolean;
  adopt(): AgenCDaemonMcpServerHandle;
  reject(): Promise<void>;
}

async function prepareConfiguredDaemonMcpServerChange(
  active: AgenCDaemonMcpServerHandle,
  config: AgenCConfig,
  io: AgenCDaemonCliIo,
): Promise<PreparedDaemonMcpServerChange> {
  const fingerprint = daemonMcpServerFingerprint(config);
  if (active.fingerprint === fingerprint) {
    return {
      closePreviousAfterAdoption: false,
      adopt: () => active,
      reject: async () => {},
    };
  }

  const defaults = resolveMcpServeDefaults(config.mcp?.server);
  if (
    active.server !== undefined &&
    defaults.enabled &&
    defaults.transport === "sse" &&
    defaults.workspace !== undefined &&
    active.bindingFingerprint === daemonMcpServerBindingFingerprint(config)
  ) {
    const prepared = await prepareMcpSseServerReconfigurationFromConfig(
      active.server,
      config,
    );
    const next = listeningDaemonMcpServerHandle(config, active.server);
    return {
      closePreviousAfterAdoption: false,
      adopt() {
        const revokedSessions = prepared.apply();
        io.stderr.write(
          `AgenC MCP server workspace reconfigured; revoked ${revokedSessions} session${revokedSessions === 1 ? "" : "s"}\n`,
        );
        return next;
      },
      reject: async () => {},
    };
  }

  const next = await startConfiguredDaemonMcpServer(config, io);
  return {
    closePreviousAfterAdoption: next !== active,
    adopt: () => next,
    reject: () => closeDaemonMcpServerAfterReloadFailure(next, io),
  };
}

async function startConfiguredDaemonMcpServer(
  config: AgenCConfig,
  io: AgenCDaemonCliIo,
): Promise<AgenCDaemonMcpServerHandle> {
  try {
    const result = await startMcpServerFromConfig(config);
    if (result.kind === "disabled") {
      return inactiveDaemonMcpServerHandle(config, "disabled");
    }
    if (result.kind === "unsupported") {
      io.stderr.write(
        `agenc: ${result.reason}; skipping daemon MCP autostart\n`,
      );
      return inactiveDaemonMcpServerHandle(config, "unsupported");
    }

    io.stderr.write(`AgenC MCP server listening on ${result.server.url}\n`);
    return listeningDaemonMcpServerHandle(config, result.server);
  } catch (error) {
    io.stderr.write(
      `agenc: daemon MCP server start failed: ${formatCleanupError(error)}\n`,
    );
    throw error;
  }
}

function inactiveDaemonMcpServerHandle(
  config?: AgenCConfig,
  status: "disabled" | "unsupported" = "disabled",
): AgenCDaemonMcpServerHandle {
  return {
    fingerprint:
      config === undefined
        ? "unconfigured"
        : daemonMcpServerFingerprint(config),
    bindingFingerprint:
      config === undefined
        ? "unconfigured"
        : daemonMcpServerBindingFingerprint(config),
    status,
    close: async () => {},
  };
}

function listeningDaemonMcpServerHandle(
  config: AgenCConfig,
  server: StartedMcpSseServer,
): AgenCDaemonMcpServerHandle {
  return {
    fingerprint: daemonMcpServerFingerprint(config),
    bindingFingerprint: daemonMcpServerBindingFingerprint(config),
    status: "listening",
    url: server.url,
    server,
    close: () => server.close(),
  };
}

function daemonMcpServerFingerprint(config: AgenCConfig): string {
  return JSON.stringify(resolveMcpServeDefaults(config.mcp?.server));
}

function daemonMcpServerBindingFingerprint(config: AgenCConfig): string {
  const defaults = resolveMcpServeDefaults(config.mcp?.server);
  return JSON.stringify({
    enabled: defaults.enabled,
    transport: defaults.transport,
    host: defaults.host,
    port: defaults.port,
  });
}

function daemonMcpServerReloadResult(
  handle: AgenCDaemonMcpServerHandle,
): DaemonReloadResult["mcpServer"] {
  return {
    status: handle.status,
    ...(handle.url !== undefined ? { url: handle.url } : {}),
  };
}

async function closeReplacedDaemonMcpServer(
  handle: AgenCDaemonMcpServerHandle,
  io: AgenCDaemonCliIo,
): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    io.stderr.write(
      `agenc: replaced daemon MCP server close failed: ${formatCleanupError(error)}\n`,
    );
  }
}

async function closeDaemonMcpServerAfterReloadFailure(
  handle: AgenCDaemonMcpServerHandle,
  io: AgenCDaemonCliIo,
): Promise<void> {
  try {
    await handle.close();
  } catch (error) {
    io.stderr.write(
      `agenc: rejected daemon MCP server close failed: ${formatCleanupError(error)}\n`,
    );
  }
}

function recoverAgenCDaemonStartupState(
  daemonHome: string,
  cwd: string,
  config: AgenCConfig,
): DaemonStartupRecoveryReport {
  const recoveredAt = new Date().toISOString();
  const paths = discoverAgenCDaemonStateDatabasePaths(daemonHome, cwd);
  const recoveredRuns: RecoveredAgentRun[] = [];
  const recoveredToolCalls: RecoveredInFlightToolCall[] = [];
  const startupResumeSourceBudget = new StartupResumeSourceBudget();
  const warnings: DaemonStartupRecoveryReport["warnings"][number][] = [];
  const recoveryExclusions: DaemonStartupRecoveryReport["recoveryExclusions"][number][] =
    [];

  try {
    for (const pathSet of paths) {
      const driver = openStateDatabasePaths(pathSet);
      try {
        pruneTerminalAgentRuns(driver, config.agent?.retention);
        pruneSessionStateSnapshots(driver, config.agent?.retention);
        const report = recoverDaemonStateOnStartup(driver, {
          now: () => recoveredAt,
          retainRuntimeResumeSources: true,
          startupResumeSourceBudget,
        });
        recoveredRuns.push(...report.recoveredRuns);
        recoveredToolCalls.push(...report.recoveredToolCalls);
        warnings.push(...report.warnings);
        recoveryExclusions.push(...report.recoveryExclusions);
      } finally {
        driver.close();
      }
    }
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const run of recoveredRuns) {
      try {
        run.resumeSource?.close();
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "daemon state recovery and resume-source cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }

  return {
    recoveredAt,
    recoveredRuns,
    recoveredToolCalls,
    warnings,
    recoveryExclusions,
  };
}

function closeRecoveredStartupResumeSources(
  runs: readonly RecoveredAgentRun[],
): void {
  const errors: unknown[] = [];
  for (const run of runs) {
    try {
      run.resumeSource?.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "daemon startup resume-source cleanup failed",
    );
  }
}

/**
 * Durable half of run.cancel: apply the tree-scoped cascade against every
 * project state DB that holds the run row (a run lives in exactly one
 * project DB in practice; the merge keeps the result honest if ids ever
 * collide across projects). Missing everywhere → `missing: true`.
 */
function cancelRunTreeAcrossStateDatabases(
  daemonHome: string,
  cwd: string,
  params: {
    readonly runId: string;
    readonly reason: string;
    readonly cancelledAt: string;
  },
): CancelAgentRunTreeReport {
  const paths = discoverAgenCDaemonStateDatabasePaths(daemonHome, cwd);
  let merged: CancelAgentRunTreeReport | undefined;
  for (const pathSet of paths) {
    const driver = openStateDatabasePaths(pathSet);
    try {
      const admissions = new ExecutionAdmissionRepository(driver, {
        now: () => new Date(params.cancelledAt),
      });
      const atomic = cancelRunTreeAndAdmission(driver, admissions, params);
      const report: CancelAgentRunTreeReport = {
        ...atomic.run,
        admissionVoidedReservations:
          atomic.admission.voidedReservationIds.length,
        admissionHeldUnknownReservations:
          atomic.admission.heldUnknownReservationIds.length,
      };
      if (report.missing) continue;
      if (merged === undefined) {
        merged = report;
        continue;
      }
      merged = {
        runId: params.runId,
        missing: false,
        alreadyTerminal: merged.alreadyTerminal && report.alreadyTerminal,
        rootStatusBefore: merged.rootStatusBefore ?? report.rootStatusBefore,
        subtreeRunIds: [
          ...new Set([...merged.subtreeRunIds, ...report.subtreeRunIds]),
        ],
        cancelledRunIds: [...merged.cancelledRunIds, ...report.cancelledRunIds],
        priorStatusById: {
          ...merged.priorStatusById,
          ...report.priorStatusById,
        },
        closedEdgeChildIds: [
          ...merged.closedEdgeChildIds,
          ...report.closedEdgeChildIds,
        ],
        admissionVoidedReservations:
          (merged.admissionVoidedReservations ?? 0) +
          (report.admissionVoidedReservations ?? 0),
        admissionHeldUnknownReservations:
          (merged.admissionHeldUnknownReservations ?? 0) +
          (report.admissionHeldUnknownReservations ?? 0),
      };
    } finally {
      driver.close();
    }
  }
  return (
    merged ?? {
      runId: params.runId,
      missing: true,
      alreadyTerminal: false,
      rootStatusBefore: null,
      subtreeRunIds: [],
      cancelledRunIds: [],
      priorStatusById: {},
      closedEdgeChildIds: [],
    }
  );
}

function discoverAgenCDaemonStateDatabasePaths(
  daemonHome: string,
  cwd: string,
): StateDatabasePaths[] {
  return uniqueStateDatabasePaths([
    ...discoverStateDatabasePaths(daemonHome),
    resolveStateDatabasePaths({ cwd, agencHome: daemonHome }),
  ]);
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

/**
 * Project the rollout/session disk-retention window out of the agent retention
 * config. Returns undefined (sweep stays DISABLED) unless `rollout_days` is set
 * — the conservative default, since the sweep deletes user data.
 */
function rolloutRetentionPolicy(
  retention: AgentRunRetentionConfig | undefined,
): RolloutRetentionPolicy | undefined {
  const days = retention?.rollout_days;
  if (days === undefined) return undefined;
  return { retention_days: days };
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
  #snapshotRetention: AgentRunRetentionConfig | undefined;
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

  updateSnapshotRetention(
    snapshotRetention: AgentRunRetentionConfig | undefined,
  ): void {
    this.#snapshotRetention = snapshotRetention;
    const rolloutRetention = rolloutRetentionPolicy(snapshotRetention);
    for (const entry of this.#policies.values()) {
      entry.policy.updateSnapshotRetention(snapshotRetention);
      entry.policy.updateRolloutRetention(rolloutRetention);
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
    new StateRunDurabilityRepository(entry.driver).ensureInitialEpoch({
      runId: run.id,
      openedAt: run.startedAt,
    });
    if (run.currentSessionId !== undefined) {
      this.#rememberSession(run.currentSessionId, entry.driver.stateDbPath);
      entry.policy.trackSession(run.currentSessionId, run.id);
    }
  }

  recordRunTerminal(terminal: AgenCDaemonRunTerminalSnapshot): void {
    const entry = this.#policyForRoute(terminal);
    const repository = new StateRunDurabilityRepository(entry.driver);
    const current = repository.currentEpoch(terminal.agentId);
    if (current === undefined) {
      repository.ensureInitialEpoch({
        runId: terminal.agentId,
        openedAt: terminal.openedAt,
      });
    } else if (current.epoch !== terminal.epoch) {
      throw new Error(
        `run ${terminal.agentId} terminal epoch ${terminal.epoch} does not match current epoch ${current.epoch}`,
      );
    }
    if (repository.getJournalBinding(terminal.rolloutPath) === undefined) {
      repository.bindJournalSource({
        runId: terminal.agentId,
        epoch: terminal.epoch,
        childRunId: terminal.agentId,
        sessionId: terminal.sessionId,
        sourcePath: terminal.rolloutPath,
        boundAt: terminal.openedAt,
      });
    }
    hitM4DurabilityFailpoint("before_terminal_commit");
    repository.recordTerminalResult({
      epoch: terminal.epoch,
      result: terminal.result,
      eventId: terminal.eventId,
    });
    hitM4DurabilityFailpoint("after_terminal_commit");
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
      // Rollout/session disk-retention sweep: opt-in via `agent.retention
      // .rollout_days`. The sessions dir for this project sits next to its
      // state DB (`<projectDir>/sessions`). No active-session id is threaded
      // here — the daemon does not own a live foreground session — so the
      // sweep relies purely on the mtime cutoff (which spares any session
      // touched within the window, i.e. anything still in use).
      rolloutRetention: rolloutRetentionPolicy(this.#snapshotRetention),
      rolloutSessionsDir: join(paths.projectDir, "sessions"),
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
    const runtimeRestore = await restoreRecoveredAgentRuntime(
      runner,
      run,
      options,
    );
    const metadata = recoveryMetadataForRun(
      report,
      run,
      runtimeRestore.available,
    );
    let restoredSessionId: string | undefined;
    try {
      if (run.currentSessionId !== undefined) {
        const restoredSession = await sessionManager.restoreSession({
          sessionId: run.currentSessionId,
          agentId: run.id,
          status: sessionStatusForRecoveredRun(run),
          createdAt: run.startedAt,
          ...(run.resumeSource !== undefined
            ? { cwd: run.resumeSource.cwd }
            : {}),
          initialPrompt: run.objective,
          metadata,
        });
        if (restoredSession.agentId === run.id) {
          restoredSessionId = restoredSession.sessionId;
        }
      }
      await agentManager.restoreAgent({
        agentId: run.id,
        objective: run.objective,
        status: agentStatusForRecoveredRun(run),
        createdAt: run.startedAt,
        startedAt: run.startedAt,
        lastActiveAt: run.lastActiveAt,
        ...(run.resumeSource !== undefined
          ? { cwd: run.resumeSource.cwd }
          : {}),
        stateProjectDir: run.projectDir,
        metadata,
        runtimeAvailable: runtimeRestore.available,
        ...(runtimeRestore.restoreAttemptId !== undefined
          ? { restoreAttemptId: runtimeRestore.restoreAttemptId }
          : {}),
        ...(run.currentSessionId !== undefined
          ? { sessionIds: [run.currentSessionId] }
          : {}),
      });
    } catch (error) {
      const cleanupErrors: unknown[] = [];
      if (runtimeRestore.restoreAttemptId !== undefined) {
        try {
          await agentManager.rollbackRestoredAgentRecord(
            run.id,
            runtimeRestore.restoreAttemptId,
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
        try {
          if (runner.rollbackRestoredAgent === undefined) {
            throw new Error(
              "restored runtime has no pre-publication rollback support",
            );
          }
          await runner.rollbackRestoredAgent(
            run.id,
            runtimeRestore.restoreAttemptId,
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (restoredSessionId !== undefined) {
        try {
          await sessionManager.terminateSession({
            sessionId: restoredSessionId,
            reason: "startup_restore_publication_failed",
          });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `startup restore publication failed for run ${run.id}`,
          { cause: error },
        );
      }
      throw error;
    }
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
  const canonicalSource = run.resumeSource;
  return {
    ...(canonicalSource !== undefined
      ? {
          agentPath: canonicalSource.agentPath,
          canonicalRolloutPath: canonicalSource.rolloutPath,
          canonicalRolloutDev: canonicalSource.rolloutIdentity.dev,
          canonicalRolloutIno: canonicalSource.rolloutIdentity.ino,
        }
      : {}),
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
): Promise<{
  readonly available: boolean;
  readonly restoreAttemptId?: string;
}> {
  const resumeSource = run.resumeSource;
  if (!isRecoveredRunRuntimeRestorable(run) || resumeSource === undefined) {
    resumeSource?.close();
    return { available: false };
  }
  if (runner.restoreAgent === undefined) {
    resumeSource.close();
    return { available: false };
  }
  const initialMessages = recoveredInitialMessages(run.latestSnapshot);
  const replayToolCalls = recoveredReplayToolCalls(run.latestSnapshot);
  const restoreAttemptId = randomUUID();
  try {
    const restored = await runner.restoreAgent({
      agentId: run.id,
      objective: run.objective,
      cwd: resumeSource.cwd,
      resumeRolloutPath: resumeSource.rolloutPath,
      resumeRolloutLease: resumeSource.rolloutLease,
      resumeCwdIdentity: resumeSource.cwdIdentity,
      resumeCwdFd: resumeSource.cwdFd,
      explicitColdResume: true,
      restoreAttemptId,
      ...(resumeSource.activeStartupActivationResumeEventId !== undefined
        ? { resumeStartupActivationPending: true }
        : {}),
      ...(resumeSource.activeRuntimeSettings !== undefined
        ? { runtimeSettings: resumeSource.activeRuntimeSettings }
        : {}),
      ...(resumeSource.activeRuntimeSettings === undefined &&
      resumeSource.legacyPermissionMode !== undefined
        ? { permissionMode: resumeSource.legacyPermissionMode }
        : {}),
      ...(resumeSource.lifecycleState === "suspended"
        ? {
            resumeSuspendedRun: true,
            suspendedResumeReason: "daemon_startup_restore" as const,
          }
        : {}),
      startedAt: run.startedAt,
      currentSessionId: run.currentSessionId,
      ...(resumeSource.activeRuntimeSettings !== undefined
        ? {
            model: resumeSource.activeRuntimeSettings.model,
            provider: resumeSource.activeRuntimeSettings.provider,
            ...(resumeSource.activeRuntimeSettings.profile !== null
              ? { profile: resumeSource.activeRuntimeSettings.profile }
              : {}),
          }
        : {
            ...optionalMetadataString(run.metadata, "model"),
            ...optionalMetadataString(run.metadata, "provider"),
            ...optionalMetadataString(run.metadata, "profile"),
          }),
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
    return restored
      ? { available: true, restoreAttemptId }
      : { available: false };
  } catch {
    return { available: false };
  } finally {
    resumeSource.close();
  }
}

function recoveredReplayToolCalls(
  snapshot: RecoveredSessionStateSnapshot | undefined,
): Array<{
  readonly callId: string;
  readonly toolName: string;
  readonly args: JsonValue;
}> {
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
    run.resumeSource !== undefined &&
    run.resumeSource.runId === run.id &&
    run.resumeSource.sessionId === run.id &&
    (run.status === "suspended") ===
      (run.resumeSource.lifecycleState === "suspended") &&
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
    recoveredToolCalls: snapshot.recoveredToolCalls.map(
      recoveryToolCallMetadata,
    ),
  };
}

function recoveredInitialMessages(
  snapshot: RecoveredSessionStateSnapshot | undefined,
): ReadonlyArray<LLMMessage> | undefined {
  const conversation = snapshot?.conversation;
  const conversationMessages = Array.isArray(conversation)
    ? conversation
        .map(recoveredMessage)
        .filter((message): message is LLMMessage => message !== undefined)
        .filter(isUsefulRecoveredMessage)
    : [];
  const messages = appendRecoveredCompletedToolMessages(
    frameUntrustedToolHistoryMessages(conversationMessages),
    snapshot?.toolState,
  );
  return messages.length > 0 ? messages : undefined;
}

function recoveredMessage(value: unknown): LLMMessage | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as {
    readonly role?: unknown;
    readonly content?: unknown;
    readonly delta?: unknown;
    readonly phase?: unknown;
    readonly payload?: unknown;
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
  const content = recoveredMessageContent(candidate);
  return {
    role: candidate.role,
    content: content ?? "",
    ...(candidate.phase === "commentary" || candidate.phase === "final_answer"
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

function recoveredMessageContent(candidate: {
  readonly content?: unknown;
  readonly delta?: unknown;
  readonly payload?: unknown;
}): string | LLMContentPart[] | undefined {
  if (typeof candidate.content === "string") return candidate.content;
  if (Array.isArray(candidate.content)) {
    return recoveredContentParts(candidate.content);
  }
  if (typeof candidate.delta === "string") return candidate.delta;
  const payload = recoveredJsonObject(candidate.payload);
  if (payload === undefined) return undefined;
  if (typeof payload.message === "string") return payload.message;
  if (typeof payload.displayText === "string") return payload.displayText;
  return undefined;
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

function isUsefulRecoveredMessage(message: LLMMessage): boolean {
  if (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.length === 0 &&
    message.toolCallId === undefined &&
    (message.toolCalls?.length ?? 0) === 0
  ) {
    return false;
  }
  return true;
}

function appendRecoveredCompletedToolMessages(
  messages: readonly LLMMessage[],
  toolState: unknown,
): LLMMessage[] {
  const completed = recoveredCompletedToolCalls(toolState);
  if (completed.length === 0) return [...messages];
  const next = messages.map((message) => ({ ...message }));
  for (const toolCall of completed) {
    if (!hasRecoveredAssistantToolCall(next, toolCall.callId)) {
      next.push({
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: toolCall.callId,
            name: toolCall.toolName,
            arguments: stringifyRecoveredJson(toolCall.args ?? {}),
          },
        ],
      });
    }
    if (!hasRecoveredToolResult(next, toolCall.callId)) {
      const rawResult = stringifyRecoveredToolResult(toolCall.result);
      next.push({
        role: "tool",
        content: frameUntrustedToolResultContent(
          toolCall.toolName,
          rawResult,
          classifyUntrustedToolResult(toolCall.toolName),
        ),
        toolCallId: toolCall.callId,
        toolName: toolCall.toolName,
      });
    }
  }
  return next;
}

function recoveredCompletedToolCalls(toolState: unknown): Array<{
  readonly callId: string;
  readonly toolName: string;
  readonly args?: unknown;
  readonly result?: unknown;
}> {
  const completed = recoveredJsonObject(toolState)?.completed;
  const completedObject = recoveredJsonObject(completed);
  if (completedObject === undefined) return [];
  const calls: Array<{
    readonly callId: string;
    readonly toolName: string;
    readonly args?: unknown;
    readonly result?: unknown;
  }> = [];
  for (const [key, value] of Object.entries(completedObject)) {
    const entry = recoveredJsonObject(value);
    if (entry === undefined) continue;
    if (entry.status !== "completed" && entry.status !== "failed") continue;
    const toolName = typeof entry.toolName === "string" ? entry.toolName : "";
    if (toolName.length === 0) continue;
    const callId =
      typeof entry.requestId === "string" && entry.requestId.length > 0
        ? entry.requestId
        : key;
    calls.push({
      callId,
      toolName,
      ...(entry.input !== undefined ? { args: entry.input } : {}),
      ...(entry.result !== undefined ? { result: entry.result } : {}),
    });
  }
  return calls;
}

function hasRecoveredAssistantToolCall(
  messages: readonly LLMMessage[],
  callId: string,
): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.toolCalls?.some((toolCall) => toolCall.id === callId) === true,
  );
}

function hasRecoveredToolResult(
  messages: readonly LLMMessage[],
  callId: string,
): boolean {
  return messages.some(
    (message) => message.role === "tool" && message.toolCallId === callId,
  );
}

function stringifyRecoveredToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  return stringifyRecoveredJson(value ?? null);
}

function stringifyRecoveredJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "null";
  }
}

function recoveredJsonObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
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
  if (report.recoveryExclusions.length > 0) {
    io.stderr.write(
      `agenc: daemon recovery excluded ${report.recoveryExclusions.length} run(s) pending operator recovery action\n`,
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

class AgenCDaemonReloadableAuthBackend implements AuthBackend {
  #current: AuthBackend;

  constructor(initial: AuthBackend) {
    this.#current = initial;
  }

  get kind(): AuthBackend["kind"] {
    return this.#current.kind;
  }

  replace(next: AuthBackend): void {
    this.#current = next;
  }

  login(params?: Parameters<AuthBackend["login"]>[0]) {
    return this.#current.login(params);
  }

  logout(params?: Parameters<AuthBackend["logout"]>[0]) {
    return this.#current.logout(params);
  }

  whoami(params?: Parameters<AuthBackend["whoami"]>[0]) {
    return this.#current.whoami(params);
  }

  vendKey(
    provider: Parameters<AuthBackend["vendKey"]>[0],
    sessionId: Parameters<AuthBackend["vendKey"]>[1],
  ) {
    return this.#current.vendKey(provider, sessionId);
  }

  inferAgencModel(params?: Parameters<AuthBackend["inferAgencModel"]>[0]) {
    return this.#current.inferAgencModel(params);
  }

  getLlmUsage(params?: Parameters<AuthBackend["getLlmUsage"]>[0]) {
    return this.#current.getLlmUsage(params);
  }

  getSubscriptionTier(
    params?: Parameters<AuthBackend["getSubscriptionTier"]>[0],
  ) {
    return this.#current.getSubscriptionTier(params);
  }
}

function createAgenCDaemonDelegateRunnerRuntimeConfig(
  host: AgenCDaemonCliHost,
  config: AgenCConfig,
  authBackend: AuthBackend,
): AgenCDelegateBackgroundAgentRunnerRuntimeConfig {
  const realtimeBaseUrl = resolveAgenCDaemonRealtimeBaseUrl(host.env, config);
  const realtimeHeaders = createAgenCDaemonRealtimeHeaderResolver(
    authBackend,
    host.env,
  );
  const realtimeCallClient = new AgenCRealtimeCallClient({
    baseUrl: realtimeBaseUrl,
    defaultHeaders: realtimeHeaders,
  });
  const realtimeWebSocketTransport =
    new AgenCRealtimeWebSocketTransportConnector({
      baseUrl: realtimeBaseUrl,
      defaultHeaders: realtimeHeaders,
    });
  return {
    authBackend,
    agentBudget: config.agent?.budget,
    realtimeCallClient,
    realtimeConnectTransport: (request) =>
      realtimeWebSocketTransport.connect(request),
  };
}

export function resolveAgenCDaemonRealtimeBaseUrl(
  env: NodeJS.ProcessEnv,
  config?: AgenCConfig,
): string {
  return (
    resolveProviderBaseURL("openai", env) ??
    readNonEmptyString(config?.providers?.openai?.base_url) ??
    BUILT_IN_PROVIDER_BASE_URLS.openai
  );
}

export function createAgenCDaemonRealtimeHeaderResolver(
  authBackend: AuthBackend,
  env: NodeJS.ProcessEnv,
): AgenCRealtimeHeadersProvider {
  const apiKey = readNonEmptyString(env.OPENAI_API_KEY);
  if (apiKey !== undefined) {
    return { authorization: `Bearer ${apiKey}` };
  }

  return async (sessionConfig) => {
    const sessionId = readNonEmptyString(sessionConfig?.sessionId);
    if (sessionId === undefined) {
      throw new Error("realtime provider key vending requires a session id");
    }
    const vended = await authBackend.vendKey("openai", sessionId);
    return { authorization: `Bearer ${vended.apiKey}` };
  };
}

async function tryResolveAgenCDaemonAuthStartup(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
): Promise<AgenCDaemonAuthStartup | null> {
  try {
    return await resolveAgenCDaemonAuthStartup(host, io);
  } catch (error) {
    io.stderr.write(
      `agenc: daemon auth backend initialization failed: ${formatCleanupError(error)}\n`,
    );
    return null;
  }
}

async function resolveAgenCDaemonAuthStartup(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
): Promise<AgenCDaemonAuthStartup> {
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
}

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

export const AGENC_DAEMON_PID_MAX_BYTES = 64;

export async function writeAgenCDaemonPid(
  pidPath: string,
  pid: number,
): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 1) {
    throw new TypeError("daemon pid must be a safe integer greater than one");
  }
  const temporaryPath = `${pidPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeDurableAtomicFile(pidPath, temporaryPath, `${pid}\n`);
}

export async function withAgenCDaemonLifecycleLock<T>(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireAgenCDaemonLifecycleLock(host);
  try {
    return await operation();
  } finally {
    await release();
  }
}

interface AgenCDaemonLifecyclePhases {
  acquire(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Serialize each authority mutation while allowing the daemon to acquire the
 * same lock for cooperative shutdown cleanup between signal/exit phases.
 * Final release failures are aggregated with the operation error so neither
 * half of a failed lifecycle transaction is hidden.
 */
async function withAgenCDaemonLifecyclePhases<T>(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
  operation: (lifecycle: AgenCDaemonLifecyclePhases) => Promise<T>,
): Promise<T> {
  let releaseCurrent: (() => Promise<void>) | null =
    await acquireAgenCDaemonLifecycleLock(host);
  const lifecycle: AgenCDaemonLifecyclePhases = {
    acquire: async () => {
      if (releaseCurrent !== null) return;
      releaseCurrent = await acquireAgenCDaemonLifecycleLock(host);
    },
    release: async () => {
      const release = releaseCurrent;
      if (release === null) return;
      releaseCurrent = null;
      await release();
    },
  };

  let result: T | undefined;
  let operationError: unknown;
  try {
    result = await operation(lifecycle);
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    await lifecycle.release();
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined) {
    if (releaseError !== undefined) {
      throw new AggregateError(
        [operationError, releaseError],
        "daemon lifecycle operation and lock release both failed",
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (releaseError !== undefined) throw releaseError;
  return result as T;
}

export async function acquireAgenCDaemonLifecycleLock(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
): Promise<() => Promise<void>> {
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  await mkdir(daemonHome, { recursive: true, mode: 0o700 });
  const release = await acquireLocalSqliteLock(
    join(daemonHome, "daemon-lifecycle.lock.sqlite"),
    {
      label: "AgenC daemon lifecycle",
      timeoutMs: 120_000,
    },
  );
  return async () => {
    release();
  };
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

async function writeAgenCDaemonSnapshot(
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
  const userHome = homedir();
  const spawnedStartupGuards = new Map<
    number,
    {
      readonly child: ChildProcess;
      readonly controller: AgenCDaemonStartupGuardController;
    }
  >();
  const startupGuardReceiver = createProcessStartupGuardReceiver(process.env);
  return {
    env: process.env,
    userHome,
    entrypointPath,
    execPath: process.execPath,
    pid: process.pid,
    platform: process.platform,
    ...(startupGuardReceiver === undefined ? {} : { startupGuardReceiver }),
    spawnDetachedDaemon: (env) => {
      if (!hasOperatorHeapSnapshotOption(env)) {
        mkdirSync(
          join(resolveAgenCDaemonHome(env, userHome), "oom-snapshots"),
          {
            recursive: true,
            mode: 0o700,
          },
        );
      }
      // Capture the child's raw stderr until its log sink takes over: a
      // crash before the sink installs (loader failure, fatal V8 error,
      // top-level throw) is otherwise unobservable. A plain file fd keeps
      // this short-lived parent decoupled (no pipe); truncated per spawn so
      // it only ever holds the latest attempt's early stderr.
      let stderrFd: number | "ignore" = "ignore";
      try {
        stderrFd = openSync(
          resolveAgenCDaemonSpawnStderrPath(env, userHome),
          "w",
          0o600,
        );
      } catch {
        /* capture is best-effort; spawn proceeds without it */
      }
      const startupGuardToken = randomUUID();
      const childEnv = {
        ...env,
        [AGENC_DAEMON_STARTUP_GUARD_ENV]: startupGuardToken,
      };
      let child: ChildProcess;
      try {
        child = spawn(
          process.execPath,
          buildAgenCDaemonChildNodeArgs(entrypointPath, childEnv, userHome),
          {
            detached: true,
            env: childEnv,
            // stdout stays detached from this short-lived parent; the
            // foreground daemon installs its own size-capped rotating log sink
            // (see installAgenCDaemonLogSink) so daemon.log cannot grow
            // unbounded.
            stdio: ["ignore", "ignore", stderrFd, "ipc"],
          },
        );
      } finally {
        if (stderrFd !== "ignore") closeSync(stderrFd);
      }
      child.unref();
      if (child.pid === undefined) {
        throw new Error("AgenC daemon child process did not expose a pid");
      }
      const childPid = child.pid;
      const controller = createAgenCDaemonStartupGuardController(
        startupGuardToken,
        createChildProcessStartupGuardChannel(child),
      );
      spawnedStartupGuards.set(childPid, { child, controller });
      const forgetGuard = (): void => {
        const current = spawnedStartupGuards.get(childPid);
        if (current?.child === child) spawnedStartupGuards.delete(childPid);
      };
      child.once("exit", forgetGuard);
      child.once("error", forgetGuard);
      return childPid;
    },
    cancelSpawnedDaemon: async (pid) => {
      const guard = spawnedStartupGuards.get(pid);
      if (guard === undefined) {
        throw new Error(
          `exact startup cancellation channel is unavailable for pid ${pid}`,
        );
      }
      await guard.controller.requestCancellation(
        AGENC_DAEMON_STARTUP_CANCELLATION_TIMEOUT_MS,
      );
      spawnedStartupGuards.delete(pid);
    },
    releaseSpawnedDaemonControl: (pid) => {
      const guard = spawnedStartupGuards.get(pid);
      if (guard === undefined) return;
      guard.controller.close();
      spawnedStartupGuards.delete(pid);
    },
    isPidRunning: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    readProcessIdentity: (pid) => readAgenCDaemonProcessStart(pid),
    terminatePid: (pid, signal = "SIGTERM") => {
      process.kill(pid, signal);
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function createProcessStartupGuardReceiver(
  env: NodeJS.ProcessEnv,
): AgenCDaemonStartupGuardReceiver | undefined {
  const token = takeAgenCDaemonStartupGuardToken(env);
  if (token === undefined || typeof process.send !== "function") {
    return undefined;
  }
  const send = process.send.bind(process);
  return createAgenCDaemonStartupGuardReceiver(token, {
    addMessageListener: (listener) => process.on("message", listener),
    removeMessageListener: (listener) => process.off("message", listener),
    addCloseListener: (listener) => process.on("disconnect", listener),
    removeCloseListener: (listener) => process.off("disconnect", listener),
    send: (message) =>
      new Promise<void>((resolve, reject) => {
        send(message as never, (error) => {
          if (error === null) resolve();
          else reject(error);
        });
      }),
    close: () => {
      if (process.connected) process.disconnect?.();
    },
    unref: () => process.channel?.unref(),
  });
}

function createChildProcessStartupGuardChannel(
  child: ChildProcess,
): AgenCDaemonStartupGuardChannel {
  return {
    addMessageListener: (listener) => child.on("message", listener),
    removeMessageListener: (listener) => child.off("message", listener),
    addCloseListener: (listener) => {
      child.on("disconnect", listener);
      child.on("exit", listener);
    },
    removeCloseListener: (listener) => {
      child.off("disconnect", listener);
      child.off("exit", listener);
    },
    send: (message) =>
      new Promise<void>((resolve, reject) => {
        if (typeof child.send !== "function" || !child.connected) {
          reject(new Error("spawned daemon startup guard channel is closed"));
          return;
        }
        child.send(message as never, (error) => {
          if (error === null) resolve();
          else reject(error);
        });
      }),
    close: () => {
      if (child.connected) child.disconnect();
    },
    unref: () => child.channel?.unref(),
  };
}

function asNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error : new Error(String(error));
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}

function isJsonRpcResponse(message: JsonObject): boolean {
  return (
    typeof message.id === "string" ||
    typeof message.id === "number" ||
    message.id === null
  );
}

function isDaemonErrorResponse(
  response: AgenCDaemonResponse,
): response is AgenCDaemonErrorResponse {
  return "error" in response;
}

function assertExpectedDaemonResponse(
  response: AgenCDaemonResponse,
  expectedId: number,
  method: string,
): void {
  if (response.jsonrpc !== JSON_RPC_VERSION) {
    throw new Error(
      `daemon returned an unsupported JSON-RPC version for ${method}`,
    );
  }
  if (response.id !== expectedId) {
    throw new Error(`daemon returned a mismatched response id for ${method}`);
  }
}

function isDaemonReloadResult(
  value: JsonValue | undefined,
): value is DaemonReloadResult {
  if (!isJsonObject(value)) return false;
  if (value.reloaded !== true || typeof value.configReloadedAt !== "string") {
    return false;
  }
  const mcpServer = value.mcpServer;
  if (!isJsonObject(mcpServer)) return false;
  const status = mcpServer.status;
  if (
    status !== "disabled" &&
    status !== "unsupported" &&
    status !== "listening"
  ) {
    return false;
  }
  return mcpServer.url === undefined || typeof mcpServer.url === "string";
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

function daemonConnectionAuthenticationFailedResponse(
  message: JsonObject,
): JsonObject {
  return {
    jsonrpc: JSON_RPC_VERSION,
    ...(message.id !== undefined ? { id: message.id } : {}),
    error: {
      code: -32000,
      message: "daemon connection authentication failed",
      data: { code: "CONNECTION_AUTHENTICATION_FAILED" },
    },
  };
}

function daemonVerifiedIdentityForContext(context: {
  readonly peerUid: number | null;
  readonly privateSocketOwnerUid: number | null;
}) {
  if (typeof process.getuid !== "function") return null;
  const daemonUid = process.getuid();
  if (context.peerUid !== null) {
    return context.peerUid === daemonUid
      ? createAgenCDaemonPeerUidIdentity(context.peerUid)
      : null;
  }
  if (context.privateSocketOwnerUid === daemonUid) {
    return createAgenCDaemonPrivateSocketOwnerIdentity(
      context.privateSocketOwnerUid,
    );
  }
  return null;
}

function daemonTransportConnectionKey(
  transport: "unix" | "websocket",
  connectionId: number,
): string {
  return `${transport}:${connectionId}`;
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

function readNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}
