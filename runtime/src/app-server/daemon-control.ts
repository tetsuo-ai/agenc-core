/** Canonical daemon lifecycle/control surface. Foreground runtime loads only on run. */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rm,
} from "node:fs/promises";
import { createConnection, isIP } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT } from "../app-server-protocol/index.js";
import { flushAgenCCompileCache } from "../bin/compile-cache.js";
import { resolveHomeContext } from "../config/home.js";
import type { AgenCSignalProcess } from "../lifecycle/signal-handlers.js";
import { discoverStateDatabasePaths } from "../state/sqlite-driver.js";
import { BoundedRegularFileError, readBoundedRegularFile } from "../utils/bounded-regular-file.js";
import { writeDurableAtomicFile } from "../utils/durable-atomic-file.js";
import { createSizeCappedFileLogSink, type SizeCappedFileLogSink } from "../utils/logger.js";
import { isRecord } from "../utils/record.js";
import { userRuntimeEnvironment } from "../utils/runtimeEnvironment.js";
import { acquireLocalSqliteLock } from "../utils/sqlite-lock.js";
import { type AgenCBackgroundAgentRunner } from "./background-agent-runner.js";
import {
  AGENC_DAEMON_HEARTBEAT_FRESH_MS,
  AGENC_DAEMON_PREVIOUS_HEARTBEAT_FILENAME,
  describeAbandonedDaemonExit,
  describeClaimedDaemonExit,
  describeUnboundDaemonHeartbeat,
  heartbeatAgeSeconds,
  isDaemonHeartbeatFresh,
  readAgenCDaemonHeartbeat,
  reportLastDaemonHeartbeat,
  resolveAgenCDaemonHeartbeatPath,
  resolveAgenCDaemonPreviousHeartbeatPath,
  type DaemonHeartbeat,
} from "./daemon-heartbeat.js";
import {
  findLinuxAgenCDaemonProcesses,
  inspectLinuxAgenCDaemonProcess,
  isAgenCDaemonInstanceIdentity,
  readAgenCDaemonProcessStart,
  sameAgenCDaemonInstanceIdentity,
  type AgenCDaemonInstanceIdentity,
  type AgenCDaemonProcessIdentity,
} from "./daemon-instance-identity.js";
import { resolveAgenCDaemonRequestTimeoutMs } from "./daemon-request-policy.js";
import {
  daemonInstanceIdentityFromRuntimeInfo,
  readDaemonRuntimeInfo,
  removeDaemonRuntimeInfo,
  resolveAgenCDaemonRuntimeInfoPath,
} from "./daemon-runtime-info.js";
import {
  AGENC_DAEMON_STARTUP_GUARD_ENV,
  createAgenCDaemonStartupGuardController,
  createAgenCDaemonStartupGuardReceiver,
  takeAgenCDaemonStartupGuardToken,
  type AgenCDaemonStartupGuardChannel,
  type AgenCDaemonStartupGuardController,
  type AgenCDaemonStartupGuardReceiver,
} from "./daemon-startup-guard.js";
import {
  JSON_RPC_VERSION,
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
} from "./protocol/index.js";
import type { AgenCNativePeerCredentialBinding } from "./transport/peer-credentials.js";
import { agenCDaemonLocalEndpoint, canConnectToUnixSocket, isAgenCWindowsNamedPipePath } from "./transport/unix-socket.js";


export const AGENC_DAEMON_PID_FILENAME = "daemon.pid";

export const AGENC_DAEMON_COOKIE_FILENAME = "daemon.cookie";

export const AGENC_DAEMON_SNAPSHOT_FILENAME = "daemon-snapshot.json";

export const AGENC_DAEMON_LOG_FILENAME = "daemon.log";

export const AGENC_DAEMON_FORCE_STOP_GRACE_MS = 2_000;


/**
 * Env override (megabytes) for the detached daemon's V8 old-space cap, and the
 * default applied when unset. Without an explicit `--max-old-space-size`, V8
 * picks a heuristic ceiling (~4GB on 64-bit hosts) and a runaway allocation
 * crashes the whole process unpredictably. Setting a generous explicit cap
 * keeps a leak bounded and surfaced (OOM error) instead of taking down the host.
 */
export const AGENC_DAEMON_MAX_OLD_SPACE_MB_ENV = "AGENC_DAEMON_MAX_OLD_SPACE_MB";

export const DEFAULT_DAEMON_MAX_OLD_SPACE_MB = 4096;


export function hasOperatorHeapSnapshotOption(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_OPTIONS?.includes("heapsnapshot-near-heap-limit") ?? false;
}

/**
 * Minimum young-generation size (megabytes per semi-space) for the daemon.
 * V8 starts the young generation at about 1 MB and grows it only after
 * scavenges, so loading the daemon's code ran several scavenges while it
 * started. With this minimum they do not happen during start-up. It stays a
 * minimum for the life of the process: when the daemon is idle, V8 does not
 * shrink the young generation below it. A semi-space option the operator sets
 * in NODE_OPTIONS, in either spelling, wins.
 */
export const DAEMON_MIN_SEMI_SPACE_MB = 16;

function hasOperatorSemiSpaceOption(env: NodeJS.ProcessEnv): boolean {
  // Node accepts V8 options with `_` or `-` between words.
  return env.NODE_OPTIONS?.replaceAll("_", "-").includes("semi-space-size") ?? false;
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
  const youngGenerationArgs = hasOperatorSemiSpaceOption(env)
    ? []
    : [`--min-semi-space-size=${DAEMON_MIN_SEMI_SPACE_MB}`];
  return [
    `--max-old-space-size=${maxOldSpaceMb}`,
    ...diagnosticArgs,
    ...youngGenerationArgs,
    entrypointPath,
    "daemon",
    "start",
    "--foreground",
  ];
}

export const AGENC_DAEMON_WEBSOCKET_HOST_ENV = "AGENC_DAEMON_WEBSOCKET_HOST";

export const AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK_ENV =
  "AGENC_DAEMON_WEBSOCKET_ALLOW_NONLOOPBACK";

export const AGENC_DAEMON_WEBSOCKET_PORT_ENV = "AGENC_DAEMON_WEBSOCKET_PORT";

export const AGENC_DAEMON_WEBSOCKET_PATH_ENV = "AGENC_DAEMON_WEBSOCKET_PATH";

export const AGENC_DAEMON_STARTUP_DEBUG_ENV = "TUI_E2E_DEBUG";

export const DEFAULT_DAEMON_REQUEST_TIMEOUT_MS = 2_000;

// Identity, health, reload and shutdown use the protocol 1.0 control surface
// (no newer method-capability floor). Older peers must still return the full
// authenticated instance proof. Session clients negotiate the current version.
export const AGENC_DAEMON_CONTROL_PROTOCOL_VERSION = "1.0.0";

export const DEFAULT_DAEMON_STOP_TIMEOUT_MS = 10_000;

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

export const DEFAULT_DAEMON_READY_POLL_MS = 25;


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


/**
 * Env override (ms) for the total time `daemon start` keeps waiting for a
 * spawned daemon that is still hydrating past the readiness budget.
 */
export const AGENC_DAEMON_START_MAX_WAIT_MS_ENV =
  "AGENC_DAEMON_START_MAX_WAIT_MS";


/**
 * Bound for that extended wait. A home with hundreds of sessions takes longer
 * than {@link DEFAULT_DAEMON_READY_TIMEOUT_MS} to open its state and recover
 * its runs (observed: 60 s for 877 sessions). Cancelling such a daemon at the
 * deadline and letting the caller start another one produced a loop in which
 * no daemon ever finished starting. While the startup log keeps advancing the
 * wait continues, in readiness-budget steps, up to this total.
 */
export const DEFAULT_DAEMON_START_MAX_WAIT_MS = 600_000;


export function resolveAgenCDaemonStartMaxWaitMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const envValue = env[AGENC_DAEMON_START_MAX_WAIT_MS_ENV];
  if (envValue !== undefined && envValue.trim().length > 0) {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_DAEMON_START_MAX_WAIT_MS;
}


export const DEFAULT_DAEMON_WEBSOCKET_URL = new URL(
  AGENC_PORTAL_DEFAULT_LOCAL_DAEMON_ENDPOINT,
);

// Windows' identity-proved PowerShell creation-time query has a 45s cold-start
// ceiling. Startup cancellation checkpoints bracket that query and every
// other slow phase, so the parent allowance includes bounded cleanup margin.
export const AGENC_DAEMON_STARTUP_CANCELLATION_TIMEOUT_MS = 60_000;

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
  /** Readiness hint for this exact owned child; never replaces instance proof. */
  waitSpawnedDaemonReady?(
    pid: number,
    timeoutMs: number,
  ): Promise<"ready" | "closed" | "timeout"> | undefined;
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
  /**
   * Make a foreground daemon work from its home instead of the caller's
   * directory (#2149). Set by the real CLI entry; library callers and tests
   * that run the daemon inside their own process leave it unset.
   */
  readonly enterDaemonHome?: boolean;
  readonly signalProcess?: AgenCSignalProcess;
  readonly beforeDaemonReady?: () => void | Promise<void>;
  /** @internal Reload/shutdown interposition contract-test seam. */
  readonly beforeDaemonReloadAdoption?: () => void | Promise<void>;
  /** @internal Deterministic lifecycle-cleanup interposition test seam. */
  readonly beforeDaemonAuthorityCleanup?: () => void | Promise<void>;
  /** Test seam: per-task bound for the cleanup of a cancelled startup. */
  readonly startupCancelCleanupTaskTimeoutMs?: number;
  /**
   * Test seam: how long shutdown lets a session restore that is still running
   * finish, and then how long it waits once it aborted it.
   */
  readonly startupRestoreShutdownGraceMs?: number;
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
  readonly #onShutdownReady: () => void;
  readonly #acknowledgementTimeoutMs: number;

  constructor(onShutdownReady: () => void, acknowledgementTimeoutMs = 5_000) {
    if (!Number.isSafeInteger(acknowledgementTimeoutMs) || acknowledgementTimeoutMs <= 0) {
      throw new TypeError("daemon shutdown acknowledgement timeout must be a positive integer");
    }
    this.#onShutdownReady = onShutdownReady;
    this.#acknowledgementTimeoutMs = acknowledgementTimeoutMs;
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sending = send(response);
      if (acceptedShutdown) {
        await Promise.race([
          sending,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error(
              `daemon shutdown acknowledgement exceeded ${this.#acknowledgementTimeoutMs} ms`,
            )), this.#acknowledgementTimeoutMs);
          }),
        ]);
      } else {
        await sending;
      }
    } catch (error) {
      if (acceptedShutdown && !this.#completed) {
        // Shutdown acceptance already fenced daemon ingress and cannot be
        // rolled back by a disconnected requester. Give any other pending
        // acknowledgement its flush opportunity; if none remain, clean up
        // even though every requester lost its connection.
        this.#pendingAcknowledgements -= 1;
        if (this.#pendingAcknowledgements === 0) {
          this.#completed = true;
          this.#onShutdownReady();
        }
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (!acceptedShutdown || this.#completed) return;

    // The transport's write callback is the causal flush barrier. Cleanup
    // waits for an acknowledgement to reach it or for all sends to fail. A
    // failed concurrent send cannot reopen a completed shutdown.
    this.#pendingAcknowledgements -= 1;
    this.#completed = true;
    this.#onShutdownReady();
  }
}


export function defaultAgenCDaemonPidPath(userHome = homedir()): string {
  return join(
    resolveHomeContext({}, { platformHome: userHome }).path,
    AGENC_DAEMON_PID_FILENAME,
  );
}


export function resolveAgenCDaemonHome(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return resolveHomeContext(env, { platformHome: userHome }).path;
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
  if (!resolveHomeContext(env).isDefault) {
    return { host, port: 0, path, fallbackToEphemeralPortOnAddrInUse: false };
  }
  return {
    host,
    port: AGENC_DAEMON_WEBSOCKET_DEFAULT_PORT,
    path,
    fallbackToEphemeralPortOnAddrInUse: true,
  };
}


export function parseAgenCDaemonWebSocketPort(value: string): number {
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


/**
 * A browser page may open the daemon WebSocket only from a loopback origin.
 * Non-browser clients send no Origin and pass. Remote pages, including AgenC's
 * own web origin, are refused at the handshake: browser access to a daemon goes
 * through the pairing relay, never straight to the loopback listener.
 */
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
  return url.protocol === "http:" && isLoopbackHostname(url.hostname);
}


export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1"
  );
}


export function isLoopbackListenHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const ipFamily = isIP(normalized);
  if (ipFamily === 4) return normalized.startsWith("127.");
  return false;
}


export function allowsNonLoopbackDaemonWebSocketHost(env: NodeJS.ProcessEnv): boolean {
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


/**
 * The previous spawn's stderr capture. Each spawn moves the current file here
 * before it opens a fresh one, so a daemon that died silently and was
 * replaced by an autostart three seconds later still leaves its last words
 * on disk instead of having them truncated by the spawn that replaced it.
 */
export const AGENC_DAEMON_SPAWN_STDERR_PREVIOUS_FILENAME =
  "daemon-spawn-stderr.prev.log";


export function resolveAgenCDaemonSpawnStderrPreviousPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return join(
    resolveAgenCDaemonHome(env, userHome),
    AGENC_DAEMON_SPAWN_STDERR_PREVIOUS_FILENAME,
  );
}


/**
 * Open the stderr capture for a daemon spawn: keep the previous capture as
 * the `.prev.log` sibling, then open the current path truncated. Best-effort:
 * a failure to keep or to open returns `"ignore"` and the spawn proceeds
 * without the capture, as before.
 */
export function openDaemonSpawnStderrCapture(
  path: string,
  previousPath: string,
): number | "ignore" {
  try {
    renameSync(path, previousPath);
  } catch {
    /* no previous capture, or it cannot be kept; the current one still opens */
  }
  try {
    return openSync(path, "w", 0o600);
  } catch {
    return "ignore";
  }
}


export function resolveAgenCDaemonSpawnStderrPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return join(
    resolveAgenCDaemonHome(env, userHome),
    AGENC_DAEMON_SPAWN_STDERR_FILENAME,
  );
}


/**
 * Milliseconds since the daemon last wrote to a startup log (the spawn stderr
 * capture or the daemon log), or undefined when neither file exists. A daemon
 * that is hydrating writes to one of them every few seconds; a hung one goes
 * quiet.
 */
export function daemonStartupLogAgeMs(
  host: AgenCDaemonCliHost,
  now = Date.now(),
): number | undefined {
  let latest: number | undefined;
  for (const path of [
    resolveAgenCDaemonSpawnStderrPath(host.env, host.userHome),
    resolveAgenCDaemonLogPath(host.env, host.userHome),
  ]) {
    try {
      const { mtimeMs } = statSync(path);
      if (latest === undefined || mtimeMs > latest) latest = mtimeMs;
    } catch {
      /* a missing capture is no evidence either way */
    }
  }
  return latest === undefined ? undefined : Math.max(0, now - latest);
}


export const DAEMON_SPAWN_STDERR_TAIL_BYTES = 2_048;


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


export function writeAgenCDaemonStartupDebug(
  host: Pick<AgenCDaemonCliHost, "env">,
  io: AgenCDaemonCliIo,
  startedAt: number,
  phase: string,
): void {
  if (host.env[AGENC_DAEMON_STARTUP_DEBUG_ENV] !== "1") return;
  io.stderr.write(
    `[agenc:daemon-startup +${Date.now() - startedAt}ms] ${phase}\n`,
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


export function resolveAgenCDaemonLogPath(
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
): string {
  return join(resolveAgenCDaemonHome(env, userHome), AGENC_DAEMON_LOG_FILENAME);
}


export const AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_ROOT = "/usr/lib/agenc";

export const AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_MARKER = join(
  AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_ROOT,
  "peer-credentials-required",
);

export const AGENC_SYSTEM_NATIVE_PEER_CREDENTIAL_ADDON = join(
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


export type DaemonExitDiagnosticsProcess = Pick<NodeJS.Process, "on" | "off" | "pid" | "kill">;


export const DAEMON_EXIT_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const;


/**
 * Record how the detached daemon's process ends, in its own log, before the
 * process is gone.
 *
 * The soak saw a daemon exit mid-turn with no line in `daemon.log`, no crash
 * report and nothing in the system log; the app autostarted a replacement in
 * three seconds and the only trace was a turn that ended with "connection
 * closed" (#2199). Node prints an uncaught exception to stderr and dies on a
 * signal without a word; neither reaches the log sink. This writes one line
 * for each: the exit code on `exit`, the signal on SIGTERM/SIGINT/SIGHUP
 * (then re-raised so the default termination and its exit code stand), and
 * the error with its stack on an uncaught exception or unhandled rejection
 * (then exit 1, as node would). Writes never throw: a sink already closed by
 * cleanup swallows the line rather than failing the exit.
 */
export function installAgenCDaemonExitDiagnostics(options: {
  readonly sink: Pick<SizeCappedFileLogSink, "write">;
  readonly proc?: DaemonExitDiagnosticsProcess;
  readonly now?: () => string;
  readonly exit?: (code: number) => void;
}): () => void {
  const proc = options.proc ?? (process as DaemonExitDiagnosticsProcess);
  const now = options.now ?? (() => new Date().toISOString());
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const line = (text: string): void => {
    try {
      options.sink.write(`agenc: daemon ${text} (pid ${proc.pid}) at ${now()}\n`);
    } catch {
      /* the sink may already be closed; the exit must not fail on its own log */
    }
  };
  const describe = (thrown: unknown): string =>
    thrown instanceof Error ? (thrown.stack ?? thrown.message) : String(thrown);
  const onExit = (code: number): void => line(`process exit code=${code}`);
  const onUncaught = (error: unknown): void => {
    line(`uncaught exception: ${describe(error)}`);
    exit(1);
  };
  const onRejection = (reason: unknown): void => {
    line(`unhandled rejection: ${describe(reason)}`);
    exit(1);
  };
  const signalHandlers = new Map<NodeJS.Signals, () => void>();
  const removeSignalHandlers = (): void => {
    for (const [signal, handler] of signalHandlers) proc.off(signal, handler);
    signalHandlers.clear();
  };
  for (const signal of DAEMON_EXIT_SIGNALS) {
    const handler = (): void => {
      line(`received ${signal}`);
      // Re-raise with our handlers gone so the default termination, and the
      // exit code that goes with it, stands.
      removeSignalHandlers();
      proc.kill(proc.pid, signal);
    };
    signalHandlers.set(signal, handler);
    proc.on(signal, handler);
  }
  proc.on("exit", onExit);
  proc.on("uncaughtException", onUncaught);
  proc.on("unhandledRejection", onRejection);
  return () => {
    removeSignalHandlers();
    proc.off("exit", onExit);
    proc.off("uncaughtException", onUncaught);
    proc.off("unhandledRejection", onRejection);
  };
}


export function safeStringifyLogArg(arg: unknown): string {
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
    action === "restart"
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
  if (action === "run") {
    return {
      kind: "error",
      message:
        "unknown daemon command: run. Use 'agenc daemon start --foreground' instead.",
    };
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


export async function runAgenCDaemonAction(
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
        enterDaemonHome: options.enterDaemonHome,
        signalProcess: options.signalProcess,
        beforeDaemonReady: options.beforeDaemonReady,
        beforeDaemonReloadAdoption: options.beforeDaemonReloadAdoption,
        beforeDaemonAuthorityCleanup: options.beforeDaemonAuthorityCleanup,
        startupCancelCleanupTaskTimeoutMs: options.startupCancelCleanupTaskTimeoutMs,
        startupRestoreShutdownGraceMs: options.startupRestoreShutdownGraceMs,
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
export async function isAgenCDaemonControlSocketReady(
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
 * Waits for an owned child's IPC hint, then checks its control socket. Hosts
 * without that capability retain bounded polling. IPC time counts against the
 * same budget. Uses `host.sleep` so tests can drive the fallback clock.
 * When `singleShot` is true, the readiness is checked exactly once with no
 * polling (used by `status`, which must not block on a slow/absent socket).
 */
export async function defaultWaitForAgenCDaemonReady(
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
  const hint = await host.waitSpawnedDaemonReady?.(pid, timeoutMs);
  if (hint === "ready" && await isAgenCDaemonControlSocketReady(host, pid)) {
    return true;
  }
  while (Date.now() - startedAt < timeoutMs) {
    if (await isAgenCDaemonControlSocketReady(host, pid)) return true;
    if (!host.isPidRunning(pid)) return false;
    await host.sleep(DEFAULT_DAEMON_READY_POLL_MS);
  }
  return isAgenCDaemonControlSocketReady(host, pid);
}


export type UntrackedAgenCDaemonSingleton =
  | {
      readonly kind: "legacy-process";
      readonly process: AgenCDaemonProcessIdentity;
    }
  | { readonly kind: "unbound-socket" };


export async function discoverUntrackedAgenCDaemonSingleton(
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


export async function startAgenCDaemon(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  options: RunAgenCDaemonCliOptions = {},
): Promise<number> {
  const startupStartedAt = Date.now();
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
    const childPid = host.spawnDetachedDaemon({
      ...userRuntimeEnvironment(host.env),
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
  let release: (() => Promise<void>) | null = null;
  if (options.lifecycleLockHeld === true) {
    writeAgenCDaemonStartupDebug(
      host,
      io,
      startupStartedAt,
      "lifecycle lock already held",
    );
  } else {
    writeAgenCDaemonStartupDebug(
      host,
      io,
      startupStartedAt,
      "lifecycle lock acquisition started",
    );
    release = await acquireAgenCDaemonLifecycleLock(host, (phase) => {
      writeAgenCDaemonStartupDebug(host, io, startupStartedAt, phase);
    });
    writeAgenCDaemonStartupDebug(
      host,
      io,
      startupStartedAt,
      "lifecycle lock acquired",
    );
  }
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
  if (options.deferDaemonReadyWaitToCaller === true) return 0;

  const targetPid = decision.pid;
  const waitForReady =
    options.waitForDaemonReady ?? defaultWaitForAgenCDaemonReady;
  let ready = await waitForReady(host, false);
  if (!ready) {
    // A daemon that is alive and still writing its startup log at the
    // deadline is hydrating, not hung. Keep waiting in readiness-budget
    // steps while the log advances, up to DEFAULT_DAEMON_START_MAX_WAIT_MS;
    // a quiet log or a dead pid falls through to the failure path below.
    const budgetMs = resolveAgenCDaemonReadyTimeoutMs(host.env);
    const extensions = Math.max(
      0,
      Math.ceil(resolveAgenCDaemonStartMaxWaitMs(host.env) / budgetMs) - 1,
    );
    for (
      let extension = 1;
      !ready && extension <= extensions && host.isPidRunning(targetPid);
      extension += 1
    ) {
      const ageMs = daemonStartupLogAgeMs(host);
      if (ageMs === undefined || ageMs > budgetMs) break;
      io.stderr.write(
        `agenc: daemon process (pid ${targetPid}) is still starting; its ` +
          `startup log advanced ${Math.round(ageMs / 1000)} s ago, waiting ` +
          `another ${Math.round(budgetMs / 1000)} s (${extension}/${extensions})\n`,
      );
      ready = await waitForReady(host, false);
    }
  }
  if (!ready) {
    const wasRunning = host.isPidRunning(targetPid);
    if (wasRunning) {
      const stderrTail =
        host.env[AGENC_DAEMON_STARTUP_DEBUG_ENV] === "1"
          ? readAgenCDaemonSpawnStderrTail(host.env, host.userHome)
          : "";
      io.stderr.write(
        `agenc: daemon process active (pid ${targetPid}) but its control ` +
          `socket did not become ready before timeout` +
          (stderrTail.length > 0 ? `: ${stderrTail}` : "") +
          `\n`,
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


export async function cancelDirectSpawnFailure(
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


export async function removeDirectExitedDaemonMetadata(
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


export async function stopAgenCDaemon(
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
            if (!(await waitForBoundPidExit(host, bound.process, 0))) {
              io.stderr.write(
                `agenc: refusing Linux numeric shutdown for pid ${boundPid} because its authenticated instance could not be rebound: ${formatCleanupError(error)}\n`,
              );
              return 1;
            }
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
    if (
      !reportLastDaemonHeartbeat(
        io,
        resolveAgenCDaemonHeartbeatPath(daemonHome),
        pid,
      )
    ) {
      reportKeptDaemonExit(io, daemonHome);
    }
    io.stdout.write(`AgenC daemon stopped (pid ${pid})\n`);
    return 0;
  });
}


export interface BoundAgenCDaemonCliInstance {
  readonly identity: AgenCDaemonInstanceIdentity;
  readonly process: AgenCDaemonProcessIdentity;
}


export async function rebindAgenCDaemonCliInstanceForLinuxSignal(
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


export async function proveAgenCDaemonCliInstance(
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


export async function revalidateBoundAgenCDaemonCliInstance(
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


export async function waitForBoundPidExit(
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


/**
 * The spawn capture that belongs to this exit, or null. Every spawn rotates
 * the capture but only an unexplained exit rotates the heartbeat, so the two
 * agree at the autostart that replaced the dead daemon and drift apart at the
 * next restart. A capture written after the dead daemon's last beat is a later
 * spawn's, and naming it here would send an operator to the wrong file.
 */
export function spawnStderrCaptureOfExit(
  heartbeat: DaemonHeartbeat,
  path: string,
): string | null {
  let writtenAtMs: number;
  try {
    writtenAtMs = statSync(path).mtimeMs;
  } catch {
    return null; // never captured, or already cleaned up
  }
  // The dead daemon stopped writing when it died, which is its last beat plus
  // at most the beats it never sent.
  const lastItCouldHaveWrittenMs =
    Date.parse(heartbeat.at) + AGENC_DAEMON_HEARTBEAT_FRESH_MS;
  return writtenAtMs <= lastItCouldHaveWrittenMs ? path : null;
}


/**
 * The unexplained exit the running daemon replaced, kept until it is
 * diagnosed. The heartbeat says what the dead process last reported about
 * itself; the spawn capture holds whatever it managed to write to stderr.
 */
export function reportReplacedDaemonExit(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
): void {
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  const previousPath = resolveAgenCDaemonPreviousHeartbeatPath(daemonHome);
  const heartbeat = readAgenCDaemonHeartbeat(previousPath);
  if (heartbeat === null) return;
  io.stdout.write(
    `  replaced: ${describeAbandonedDaemonExit(heartbeat, Date.now())}\n`,
  );
  const spawnStderrPath = spawnStderrCaptureOfExit(
    heartbeat,
    resolveAgenCDaemonSpawnStderrPreviousPath(host.env, host.userHome),
  );
  io.stdout.write(
    `  evidence: ${previousPath}` +
      `${spawnStderrPath === null ? "" : `, ${spawnStderrPath}`} ` +
      `(remove ${AGENC_DAEMON_PREVIOUS_HEARTBEAT_FILENAME} once the exit is diagnosed)\n`,
  );
}


/**
 * The kept exit, for the branches that report a daemon which is not running.
 * They read the live heartbeat path, which the claim empties, so a daemon that
 * was replaced and then stopped or died without beating would otherwise leave
 * those branches with nothing to say (#2199).
 */
export function reportKeptDaemonExit(
  io: AgenCDaemonCliIo,
  daemonHome: string,
): boolean {
  const keptPath = resolveAgenCDaemonPreviousHeartbeatPath(daemonHome);
  const heartbeat = readAgenCDaemonHeartbeat(keptPath);
  if (heartbeat === null) return false;
  io.stderr.write(
    `agenc: ${describeClaimedDaemonExit({ heartbeat, keptPath }, Date.now())}\n`,
  );
  return true;
}


export async function statusAgenCDaemon(
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
    const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
    const heartbeatPath = resolveAgenCDaemonHeartbeatPath(daemonHome);
    if (legacyPid === null) {
      const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
      if (await canConnectToUnixSocket(socketPath)) {
        // A daemon that is serving but has not committed its identity yet
        // (still recovering its agent runs) is beating; say so instead of
        // leaving the operator with "indeterminate" (#2225).
        const heartbeat = readAgenCDaemonHeartbeat(heartbeatPath);
        const nowMs = Date.now();
        if (
          heartbeat !== null &&
          host.isPidRunning(heartbeat.pid) &&
          isDaemonHeartbeatFresh(heartbeat, nowMs)
        ) {
          io.stdout.write(describeUnboundDaemonHeartbeat(heartbeat, nowMs));
          return 1;
        }
        io.stderr.write(
          "agenc: daemon control socket is active but no process identity is recorded; status is indeterminate\n",
        );
        return 1;
      }
      if (!reportLastDaemonHeartbeat(io, heartbeatPath, null)) {
        reportKeptDaemonExit(io, daemonHome);
      }
      io.stdout.write("AgenC daemon stopped\n");
      return 1;
    }
    if ((host.platform ?? process.platform) !== "linux") {
      const heartbeat = readAgenCDaemonHeartbeat(heartbeatPath);
      if (heartbeat !== null && heartbeat.pid === legacyPid) {
        const nowMs = Date.now();
        if (isDaemonHeartbeatFresh(heartbeat, nowMs)) {
          io.stdout.write(describeUnboundDaemonHeartbeat(heartbeat, nowMs));
          return 1;
        }
        io.stderr.write(
          `agenc: daemon status is indeterminate for unbound pid ${legacyPid}; ` +
            `its last heartbeat is ${heartbeatAgeSeconds(heartbeat, nowMs)} s old (at ${heartbeat.at}), so the process may be hung\n`,
        );
        return 1;
      }
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
    // The project state databases are read from disk, not over the socket, so
    // their footprint is reported even when health.stats is unavailable. A
    // database that keeps growing is how a long-lived home gets slow to start
    // and heavy to recover (#2228); this line makes that growth visible.
    try {
      const databasesLine = formatAgenCDaemonStateDatabasesLine(
        measureAgenCDaemonStateDatabases(
          resolveAgenCDaemonHome(host.env, host.userHome),
        ),
      );
      if (databasesLine !== null) io.stdout.write(`${databasesLine}\n`);
    } catch {
      // A projects directory that cannot be listed is not a status failure.
    }
    // The autostart hides the event: the app reconnects within seconds and the
    // user's only trace is a turn that ended with connection closed. Status is
    // where they can still learn that a daemon was replaced, and where its
    // last words are (#2199).
    reportReplacedDaemonExit(host, io);
    return 0;
  }
  io.stdout.write("AgenC daemon stopped\n");
  return 1;
}


export async function requestAgenCDaemonHealthStats(
  host: AgenCDaemonCliHost,
): Promise<HealthStatsResult> {
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
  const authCookie = await readAgenCDaemonCookie(cookiePath);
  const timeoutMs = resolveAgenCDaemonRequestTimeoutMs(
    host.env,
    DEFAULT_DAEMON_REQUEST_TIMEOUT_MS,
  );
  const responses = await sendAgenCDaemonJsonLineRequests(
    socketPath,
    timeoutMs,
    [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: AGENC_DAEMON_CONTROL_PROTOCOL_VERSION,
          protocol: { version: AGENC_DAEMON_CONTROL_PROTOCOL_VERSION },
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
    resolveAgenCDaemonRequestTimeoutMs(
      host.env,
      DEFAULT_DAEMON_REQUEST_TIMEOUT_MS,
    ),
    [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: AGENC_DAEMON_CONTROL_PROTOCOL_VERSION,
          protocol: { version: AGENC_DAEMON_CONTROL_PROTOCOL_VERSION },
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
    resolveAgenCDaemonRequestTimeoutMs(
      host.env,
      DEFAULT_DAEMON_REQUEST_TIMEOUT_MS,
    ),
    [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: AGENC_DAEMON_CONTROL_PROTOCOL_VERSION,
          protocol: { version: AGENC_DAEMON_CONTROL_PROTOCOL_VERSION },
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
    (response, responseIndex) => {
      if (responseIndex === 0) assertDaemonInstanceBeforeControl(response, expected, "shutdown");
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


export function assertDaemonInstanceBeforeControl(
  response: AgenCDaemonResponse,
  expected: AgenCDaemonInstanceIdentity,
  action: "shutdown" | "reload",
): void {
  assertExpectedDaemonResponse(response, 1, "initialize");
  if (isDaemonErrorResponse(response)) throw new Error(response.error.message);
  const observed = (response as AgenCDaemonSuccessResponse<"initialize">).result.daemonIdentity;
  if (!isAgenCDaemonInstanceIdentity(observed) || !sameAgenCDaemonInstanceIdentity(observed, expected)) {
    throw new Error(`daemon instance changed before ${action}`);
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


export interface AgenCDaemonStateDatabaseFootprint {
  /** Projects whose state database (plus WAL) occupies any bytes on disk. */
  readonly projects: number;
  readonly totalBytes: number;
  readonly largestBytes: number;
  /** Project directory name of the largest database, when there is one. */
  readonly largestProject: string | null;
}


export function fileSizeOrZero(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}


/**
 * Sum every project's state database and its WAL under `<home>/projects`.
 * Read from disk so `status` can report it without the daemon's help.
 */
export function measureAgenCDaemonStateDatabases(
  daemonHome: string,
  sizeOf: (path: string) => number = fileSizeOrZero,
): AgenCDaemonStateDatabaseFootprint {
  let projects = 0;
  let totalBytes = 0;
  let largestBytes = 0;
  let largestProject: string | null = null;
  for (const paths of discoverStateDatabasePaths(daemonHome)) {
    const bytes =
      sizeOf(paths.stateDbPath) + sizeOf(`${paths.stateDbPath}-wal`);
    if (bytes === 0) continue;
    projects += 1;
    totalBytes += bytes;
    if (bytes > largestBytes) {
      largestBytes = bytes;
      largestProject = basename(paths.projectDir);
    }
  }
  return { projects, totalBytes, largestBytes, largestProject };
}


/** The status line for the footprint, or null when no project has a database. */
export function formatAgenCDaemonStateDatabasesLine(
  footprint: AgenCDaemonStateDatabaseFootprint,
): string | null {
  if (footprint.projects === 0) return null;
  const largest =
    footprint.largestProject === null
      ? ""
      : ` (largest ${formatDaemonMebibytes(footprint.largestBytes)}: ${footprint.largestProject})`;
  return (
    `  databases: ${footprint.projects} project state DB(s), ` +
    `${formatDaemonMebibytes(footprint.totalBytes)} on disk${largest}`
  );
}


export function formatDaemonUptime(uptimeMs: number): string {
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


export function formatDaemonMebibytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}


export function isHealthStatsResult(
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


export function isHealthSessionStats(
  value: JsonValue | undefined,
): value is HealthSessionStats {
  return (
    isJsonObject(value) &&
    typeof value.active === "number" &&
    typeof value.closed === "number" &&
    typeof value.total === "number"
  );
}


export function isHealthMemoryStats(
  value: JsonValue | undefined,
): value is HealthMemoryStats {
  return (
    isJsonObject(value) &&
    typeof value.rss === "number" &&
    typeof value.heapTotal === "number" &&
    typeof value.heapUsed === "number"
  );
}


export function isHealthStateStats(
  value: JsonValue | undefined,
): value is HealthStateStats {
  return (
    isJsonObject(value) &&
    typeof value.agentRuns === "number" &&
    typeof value.sessionStateSnapshots === "number" &&
    typeof value.inFlightToolCalls === "number"
  );
}


export async function reloadAgenCDaemon(
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
  let reloaded: DaemonReloadResult | undefined;
  try {
    bound = await proveAgenCDaemonCliInstance(
      host,
      recorded.pid,
      runtimeInfoPath,
      options.requestDaemonInstanceIdentity,
    );
    const requestReload =
      options.requestDaemonReload ?? requestAgenCDaemonReload;
    reloaded = await Promise.resolve(requestReload(host, bound.identity));
  } catch (error) {
    io.stderr.write(
      `agenc: daemon reload failed (pid ${recorded.pid}): ${formatCleanupError(error)}\n`,
    );
    return 1;
  }
  io.stdout.write(
    `AgenC daemon reloaded configuration (pid ${bound.identity.pid})\n`,
  );
  for (const failure of reloaded?.crossProviderSettings?.failed ?? []) {
    io.stderr.write(crossProviderSettingsFailureLine(failure));
  }
  return 0;
}


export async function requestAgenCDaemonReload(
  host: AgenCDaemonCliHost,
  expected: AgenCDaemonInstanceIdentity,
): Promise<DaemonReloadResult> {
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  const cookiePath = resolveAgenCDaemonCookiePath(host.env, host.userHome);
  const authCookie = await readAgenCDaemonCookie(cookiePath);
  const timeoutMs = resolveAgenCDaemonRequestTimeoutMs(
    host.env,
    DEFAULT_DAEMON_REQUEST_TIMEOUT_MS,
  );
  const responses = await sendAgenCDaemonJsonLineRequests(
    socketPath,
    timeoutMs,
    [
      {
        jsonrpc: JSON_RPC_VERSION,
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: AGENC_DAEMON_CONTROL_PROTOCOL_VERSION,
          protocol: { version: AGENC_DAEMON_CONTROL_PROTOCOL_VERSION },
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
      if (responseIndex === 0) assertDaemonInstanceBeforeControl(response, expected, "reload");
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


export async function readAgenCDaemonCookie(cookiePath: string): Promise<string> {
  try {
    const cookie = (await readFile(cookiePath, "utf8")).trim();
    if (cookie.length > 0) return cookie;
  } catch (error) {
    if (asNodeError(error).code !== "ENOENT") throw error;
  }
  throw new Error(`daemon cookie is not available at ${cookiePath}`);
}


export function sendAgenCDaemonJsonLineRequests(
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


export interface AgenCDaemonLifecyclePhases {
  acquire(): Promise<void>;
  release(): Promise<void>;
}


/**
 * Serialize each authority mutation while allowing the daemon to acquire the
 * same lock for cooperative shutdown cleanup between signal/exit phases.
 * Final release failures are aggregated with the operation error so neither
 * half of a failed lifecycle transaction is hidden.
 */
export async function withAgenCDaemonLifecyclePhases<T>(
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


export function reportAgenCDaemonLifecycleLockProgress(
  onProgress:
    | ((phase: string) => void | PromiseLike<void>)
    | undefined,
  phase: string,
): void {
  try {
    const result = onProgress?.(phase);
    if (result !== undefined) {
      void Promise.resolve(result).catch(() => {});
    }
  } catch {
    // Diagnostics must never change daemon lifecycle lock semantics.
  }
}


export async function acquireAgenCDaemonLifecycleLock(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
  onProgress?: (phase: string) => void | PromiseLike<void>,
): Promise<() => Promise<void>> {
  reportAgenCDaemonLifecycleLockProgress(
    onProgress,
    "daemon home resolution started",
  );
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  reportAgenCDaemonLifecycleLockProgress(
    onProgress,
    "daemon home resolution complete",
  );
  await mkdir(daemonHome, { recursive: true, mode: 0o700 });
  reportAgenCDaemonLifecycleLockProgress(
    onProgress,
    "daemon home creation complete",
  );
  const release = await acquireLocalSqliteLock(
    join(daemonHome, "daemon-lifecycle.lock.sqlite"),
    {
      label: "AgenC daemon lifecycle",
      timeoutMs: 120_000,
      ...(onProgress === undefined ? {} : { onProgress }),
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


export function createNodeDaemonCliHost(
  deps: { readonly spawnProcess?: typeof spawn } = {},
): AgenCDaemonCliHost {
  const spawnProcess = deps.spawnProcess ?? spawn;
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
      const daemonHome = resolveAgenCDaemonHome(env, userHome);
      // The child works from its home, never from this caller's directory,
      // which may be a scratch or eval workspace that is deleted while the
      // daemon keeps running (#2149).
      try {
        mkdirSync(daemonHome, { recursive: true, mode: 0o700 });
      } catch {
        /* the pid path below fails with a clearer error if the home is unusable */
      }
      if (!hasOperatorHeapSnapshotOption(env)) {
        mkdirSync(join(daemonHome, "oom-snapshots"), {
          recursive: true,
          mode: 0o700,
        });
      }
      // Capture the child's raw stderr until its log sink takes over: a
      // crash before the sink installs (loader failure, fatal V8 error,
      // top-level throw) is otherwise unobservable, and the fd stays the
      // daemon's stderr for its whole life, so a late fatal lands here too.
      // A plain file fd keeps this short-lived parent decoupled (no pipe).
      // The previous attempt's capture is kept as the `.prev.log` sibling.
      const stderrFd = openDaemonSpawnStderrCapture(
        resolveAgenCDaemonSpawnStderrPath(env, userHome),
        resolveAgenCDaemonSpawnStderrPreviousPath(env, userHome),
      );
      const startupGuardToken = randomUUID();
      const childEnv = {
        ...env,
        [AGENC_DAEMON_STARTUP_GUARD_ENV]: startupGuardToken,
      };
      let child: ChildProcess;
      try {
        // The CLI stays alive while the daemon starts, so Node's exit flush
        // would arrive too late for the child to reuse these compiled modules.
        flushAgenCCompileCache();
        child = spawnProcess(
          process.execPath,
          buildAgenCDaemonChildNodeArgs(entrypointPath, childEnv, userHome),
          {
            detached: true,
            cwd: daemonHome,
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
      // A failed spawn (the executable replaced by an update, EAGAIN) reports
      // on the next tick. Listen before the throw below, or that report is an
      // uncaught exception in this CLI or TUI process.
      child.on("error", () => {});
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
        if (current?.child === child) {
          controller.close();
          spawnedStartupGuards.delete(childPid);
        }
      };
      child.once("exit", forgetGuard);
      child.once("error", forgetGuard);
      return childPid;
    },
    waitSpawnedDaemonReady: (pid, timeoutMs) =>
      spawnedStartupGuards.get(pid)?.controller.waitUntilReady(timeoutMs),
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


export function createProcessStartupGuardReceiver(
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


export function createChildProcessStartupGuardChannel(
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


export function asNodeError(error: unknown): NodeJS.ErrnoException {
  return error instanceof Error ? error : new Error(String(error));
}


export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return isRecord(value);
}


export function isJsonRpcResponse(message: JsonObject): boolean {
  return (
    typeof message.id === "string" ||
    typeof message.id === "number" ||
    message.id === null
  );
}


export function isDaemonErrorResponse(
  response: AgenCDaemonResponse,
): response is AgenCDaemonErrorResponse {
  return "error" in response;
}


export function assertExpectedDaemonResponse(
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


export function isDaemonReloadResult(
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
  if (mcpServer.url !== undefined && typeof mcpServer.url !== "string") {
    return false;
  }
  const crossProviderSettings = value.crossProviderSettings;
  if (crossProviderSettings === undefined) return true;
  return isJsonObject(crossProviderSettings) &&
    Array.isArray(crossProviderSettings.failed) &&
    crossProviderSettings.failed.every((failure) =>
      isJsonObject(failure) &&
      typeof failure.sessionId === "string" &&
      typeof failure.reason === "string" &&
      (failure.timedOut === undefined || failure.timedOut === true)
    );
}


/**
 * What the daemon and `agenc daemon reload` say about a session that could
 * not read its cross-provider subagent settings again.
 */
export function crossProviderSettingsFailureLine(failure: {
  readonly sessionId: string;
  readonly reason: string;
  readonly timedOut?: boolean;
}): string {
  const retry = failure.timedOut === true
    ? " Its read still runs once its config is free."
    : "";
  return `agenc: session ${failure.sessionId} could not read its cross-provider subagent settings again. Until it can, it keeps its earlier settings without what the save took away from the daemon's settings.${retry} Reason: ${failure.reason}\n`;
}


export function formatCleanupError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runAgenCDaemonForeground(...args: Parameters<typeof import("./daemon-cli.js").runAgenCDaemonForeground>): Promise<number> {
  const runtime = await import("./daemon-cli.js");
  return runtime.runAgenCDaemonForeground(...args);
}
