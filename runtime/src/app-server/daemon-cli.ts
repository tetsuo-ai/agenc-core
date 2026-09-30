/**
 * AgenC daemon CLI controls.
 *
 * F-03i owns the local process controls only: start, stop, status, reload,
 * restart, and the pid file. Request dispatch and health probes are wired by
 * later daemon rows.
 */


import { crossProviderConsentAvailability, LiveApprovalBroker } from "./live-approval-broker.js";


import { enterDaemonWorkingDirectory } from "./daemon-working-directory.js";

import { randomUUID } from "node:crypto";

import { createDaemonWorkflowController } from "./workflow/daemon-wiring.js";

import { DaemonWorkflowStartService } from "./workflow/run-start-service.js";

import { DaemonWorkflowControlService } from "./workflow/run-control-service.js";

import { existsSync, statSync } from "node:fs";

import { mkdir, rm, writeFile } from "node:fs/promises";



import { dirname, isAbsolute, join } from "node:path";

import { resolveHomeContext } from "../config/home.js";

import { LocalWhisperService } from "../audio/whisper.js";

import { RemoteService } from "../remote/service.js";

import { createRemoteBackend } from "../remote/backend.js";

import { remoteAuthSessionTokenSync } from "../auth/session-state.js";

import { OwnerTelegramService } from "../gateway/owner-telegram.js";

import { createOwnerTelegramStorage } from "../gateway/owner-telegram-storage.js";

import { RemoteError } from "../remote/types.js";

import { assertSafeRemoteSessionPolicy } from "../remote/session-policy.js";

import {
  AgenCDaemonAgentManager,
  type AgenCDaemonAgentLogThreadStoreRoute,
  type AgenCDaemonAgentRunSnapshot,
  type AgenCDaemonAgentSnapshotFlush,
  type AgenCDaemonAgentStatusSnapshot,
  type AgenCDaemonMessageExchangeSnapshot,
  type AgenCDaemonRunTerminalSnapshot,
  type AgenCDaemonSnapshotSessionRoute,
} from "./agent-lifecycle.js";

import { AgenCDelegateBackgroundAgentRunner, type AgenCBackgroundAgentRunner, type AgenCDelegateBackgroundAgentRunnerRuntimeConfig } from "./background-agent-runner.js";

import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";

import { AgenCCommandExecService } from "./command-exec.js";

import { CsvAgentJobsRepositoryAuthority } from "./csv-agent-jobs-authority.js";

import { AgenCCsvJobReviewStateService } from "./csv-job-review.js";


import { DAEMON_AGENT_STOP_TIMEOUT_MS } from "./operation-deadline.js";

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
  claimAbandonedDaemonHeartbeat,
  describeClaimedDaemonExit,
  installAgenCDaemonHeartbeat,
  resolveAgenCDaemonHeartbeatPath,
  resolveAgenCDaemonPreviousHeartbeatPath,
} from "./daemon-heartbeat.js";

import {
  inspectLinuxAgenCDaemonProcess,
  readAgenCDaemonProcessStart,
  sameAgenCDaemonInstanceIdentity,
  type AgenCDaemonInstanceIdentity,
} from "./daemon-instance-identity.js";

import { AgenCDaemonJsonRpcDispatcher, type AgenCDaemonJsonRpcConnection } from "./daemon-dispatcher.js";

import { AgenCRealtimeRpcService } from "./realtime.js";

import { AgenCRealtimeCallClient, AgenCRealtimeWebSocketTransportConnector, type AgenCRealtimeHeadersProvider } from "./realtime-transport.js";

import {
  AGENC_PENDING_APPROVALS_LIST_CAPABILITY,
  JSON_RPC_VERSION,
  type AgentStatus,
  type AgentToolOutputLog,
  type DaemonReloadResult,
  type JsonObject,
  type JsonValue,
  type SessionStatus,
} from "./protocol/index.js";

import { sessionEventDelivery } from "./approval-delivery.js";

import { AgenCDaemonSessionManager } from "./session-lifecycle.js";

import {
  StartupSessionRestoreAbandonedError,
  StartupSessionRestores,
  type StartupSessionRestoreContext,
  type StartupSessionRestoreSettlement,
  type StartupSessionRestoreSummary,
} from "./startup-session-restores.js";

import { AgenCUnixSocketServer } from "./transport/unix-socket.js";

import { AgenCWebSocketServer } from "./transport/websocket.js";

import {
  AgenCDaemonCookieAuthenticator,
  createAgenCDaemonPeerUidIdentity,
  createAgenCDaemonPrivateSocketOwnerIdentity,
  ensureAgenCDaemonCookie,
} from "./transport/auth.js";

import type { AgenCNativePeerCredentialBinding } from "./transport/peer-credentials.js";


import { AgenCDaemonHealthService } from "./health.js";

import { AgenCDaemonRunInspectionService } from "./run-inspection.js";

import { AgenCProjectTrustService } from "./project-trust.js";

import { PluginSettingsService } from "../plugins/settings-service.js";

import { AgenCCleanupRegistry } from "../lifecycle/cleanup-registry.js";

import { closeAllBrowserManagers } from "../browser/manager.js";

import { installAgenCShutdownSignalHandlers } from "../lifecycle/signal-handlers.js";

import { summarizeAgenCShutdown } from "../lifecycle/shutdown-message.js";

import type { AgenCSignalProcess } from "../lifecycle/signal-handlers.js";

import { createAuthBackend } from "../auth/selection.js";

import type { AuthBackend } from "../auth/backend.js";

import type { ToolRecoveryCategory } from "../tools/types.js";





import { createPermissionAuditFileLogger } from "../permissions/permission-audit-log.js";

import { readRecoverableCommandEnvironment } from "./client-env-snapshot.js";

import { loadCanonicalDaemonConfig } from "../config/repository.js";

import { resolveProviderBaseURL } from "../config/env.js";

import {
  resolveAgentRuntimeOptions,
  resolvePluginStorageRootAtIngress,
  resolveSessionTempRootAtIngress,
  validateAgentRuntimeOptions,
  type AgentRuntimeOptions,
} from "../session/runtime-options.js";

import { RoutineService } from "../routines/service.js";

import { createDaemonRoutineExecutor } from "../routines/daemon-executor.js";

import { RoutineSessionPreparation } from "../routines/session-preparation.js";

import type { AgenCConfig, AgentRunRetentionConfig } from "../config/schema.js";

import { BUILT_IN_PROVIDER_BASE_URLS, resolveBuiltInProviderSlug } from "../llm/registry/provider-info.js";

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
  type RecoveredAgentRun,
  type RecoveredInFlightToolCall,
  type RecoveredSessionStateSnapshot,
  type ToolRecoveryAction,
} from "../state/recovery.js";

import {
  pruneSessionSnapshotsPerSession,
  pruneSessionStateSnapshots,
  pruneTerminalAgentRuns,
  SESSION_SNAPSHOT_HARD_CAP,
  type RolloutPruningReport,
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
  type StateFreePageReclaim,
  type StateSqliteDriver,
} from "../state/sqlite-driver.js";

import { FileThreadStore } from "../thread-store/store.js";

import { MultiProjectFileThreadStore } from "../thread-store/multi-project-store.js";

import { resolveDaemonDefaultCwd } from "./daemon-workspace.js";

import type { LLMContentPart, LLMMessage } from "../llm/types.js";

import { classifyUntrustedToolResult, frameUntrustedToolHistoryMessages, frameUntrustedToolResultContent } from "../tools/untrusted-tool-result-framing.js";



import { logForDebugging } from "../utils/debug.js";

import { installAgenCDaemonErrorLogSink } from "./daemon-error-log.js";

import { startHeapWatchdog } from "../services/heapWatchdog/heapWatchdog.js";
import {
  acquireAgenCDaemonLifecycleLock,
  type AgenCDaemonCliHost,
  type AgenCDaemonCliIo,
  AgenCDaemonRpcShutdownCoordinator,
  type AgenCDaemonWebSocketListenOptions,
  crossProviderSettingsFailureLine,
  discoverUntrackedAgenCDaemonSingleton,
  formatCleanupError,
  installAgenCDaemonExitDiagnostics,
  installAgenCDaemonLogSink,
  proveAgenCDaemonCliInstance,
  readAgenCDaemonPid,
  removeAgenCDaemonPid,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonHome,
  resolveAgenCDaemonLogPath,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonSnapshotPath,
  resolveAgenCDaemonSocketPath,
  resolveAgenCDaemonWebSocketListenOptions,
  resolveSystemNativePeerCredentialAddonPath,
  type RunAgenCDaemonCliOptions,
  type UntrackedAgenCDaemonSingleton,
  validateAgenCDaemonWebSocketOrigin,
  withAgenCDaemonLifecycleLock,
  writeAgenCDaemonPid,
  writeAgenCDaemonStartupDebug,
} from "./daemon-control.js";

// A daemon whose startup was cancelled has served nobody, so its cleanup only
// has to be safe, not complete: each task gets this long before the run moves
// on. Without the bound one hung task kept a cancelled daemon alive for eight
// minutes while every autostart refused to replace it (#2232).
const AGENC_DAEMON_STARTUP_CANCEL_CLEANUP_TASK_TIMEOUT_MS = 5_000;


export async function runAgenCDaemonForeground(
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  options: {
    readonly enterDaemonHome?: boolean;
    readonly signalProcess?: AgenCSignalProcess;
    readonly beforeDaemonReady?: () => void | Promise<void>;
    readonly beforeDaemonReloadAdoption?: () => void | Promise<void>;
    readonly beforeDaemonAuthorityCleanup?: () => void | Promise<void>;
    readonly startupCancelCleanupTaskTimeoutMs?: number;
    readonly startupRestoreShutdownGraceMs?: number;
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
  const startupStartedAt = Date.now();
  // Leave the caller's directory before anything else: it may not outlive
  // this process, and a dead cwd breaks every later child spawn (#2149).
  if (options.enterDaemonHome === true) {
    enterDaemonWorkingDirectory(
      resolveAgenCDaemonHome(host.env, host.userHome),
      io,
    );
  }
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "lifecycle lock acquisition started",
  );
  const release = await acquireAgenCDaemonLifecycleLock(host, (phase) => {
    writeAgenCDaemonStartupDebug(host, io, startupStartedAt, phase);
  });
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "lifecycle lock acquired",
  );
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
    readonly startupCancelCleanupTaskTimeoutMs?: number;
    readonly startupRestoreShutdownGraceMs?: number;
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
  const startupStartedAt = Date.now();
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "foreground admission started",
  );
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
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "singleton admission complete",
  );
  const authStartup = await tryResolveAgenCDaemonAuthStartup(host, io);
  if (authStartup === null) {
    return 1;
  }
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "canonical configuration and auth ready",
  );
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
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "daemon cookie ready",
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
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "process identity query complete",
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
      (message) => io.stderr.write(`agenc: ${message}\n`),
    );
    reportAgenCDaemonStartupRecovery(io, startupRecovery);
    writeAgenCDaemonStartupDebug(
      host,
      io,
      startupStartedAt,
      "startup recovery complete",
    );
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
    const sessionManager = new AgenCDaemonSessionManager({ threadStore });
    // Forward declaration: set once the connection registry below exists. Lets
    // the multiplexer ask the transport to tear down a slow consumer's socket
    // when that client's pending delivery backlog trips the per-client cap.
    let destroyEvictedClientConnection:
      ((clientId: string, deliveryKey?: string) => void) | undefined;
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager,
      onClientEvicted: (clientId, deliveryKey) => {
        destroyEvictedClientConnection?.(clientId, deliveryKey);
      },
    });
    const commandExec = new AgenCCommandExecService({
      agencLinuxSandboxExe: resolveDefaultLinuxSandboxExecutable(),
      sessionTempRoot: resolveSessionTempRootAtIngress(host.env),
      allowGpu: activeConfig.sandbox?.allow_gpu === true,
    });
    const closeCommandExec = async () => {
      await commandExec.closeAll("daemon_shutdown");
    };
    const unregisterCommandExecCleanup = cleanup.register("daemon-command-exec", closeCommandExec);
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
        // Journal projections are reused only by the exact build that
        // validated them; the first start of any other build redoes them.
        ...(distVersion !== null
          ? {
              canonicalProjectionEpoch: `${distVersion.runtimeVersion}+${distVersion.commit}+${distVersion.buildTime}`,
            }
          : {}),
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
    // Claimed before the heartbeat below writes its first beat: the daemon
    // this one replaced left its last state there, and overwriting it was how
    // an exit nothing else recorded became undiagnosable (#2199).
    const replacedDaemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
    const replacedDaemon = claimAbandonedDaemonHeartbeat({
      path: resolveAgenCDaemonHeartbeatPath(replacedDaemonHome),
      previousPath: resolveAgenCDaemonPreviousHeartbeatPath(replacedDaemonHome),
      pid: host.pid,
      isPidRunning: (pid) => host.isPidRunning(pid),
    });
    let writeErrorLog = (line: string): void => {
      io.stderr.write(line);
    };
    let writeErrorDebugLog = (line: string): void => {
      logForDebugging(line);
    };
    // Only the spawned, detached daemon (AGENC_DAEMON_RUN=1) redirects console
    // output into the size-capped rotating sink; a `--foreground` invocation run
    // directly by a user keeps writing to the inherited terminal.
    if (host.env.AGENC_DAEMON_RUN === "1") {
      const logSink = installAgenCDaemonLogSink({
        path: resolveAgenCDaemonLogPath(host.env, host.userHome),
      });
      if (logSink !== null) {
        writeErrorLog = (line) => logSink.sink.write(line);
        writeErrorDebugLog = writeErrorLog;
        const disposeExitDiagnostics = installAgenCDaemonExitDiagnostics({
          sink: logSink.sink,
        });
        cleanup.register("daemon-log-sink", () => {
          disposeExitDiagnostics();
          logSink.dispose();
        });
      }
      // The heartbeat outlives every handler: a daemon killed without warning
      // leaves its last pid, memory and event-loop lag on disk for `status`.
      const disposeHeartbeat = installAgenCDaemonHeartbeat({
        path: resolveAgenCDaemonHeartbeatPath(
          resolveAgenCDaemonHome(host.env, host.userHome),
        ),
        onError: (error) => {
          logSink?.sink.write(
            `agenc: daemon heartbeat write failed: ${formatCleanupError(error)}\n`,
          );
        },
      });
      cleanup.register("daemon-heartbeat", disposeHeartbeat);
    }
    // daemon.log appends across daemons, so this is the durable record that a
    // daemon was replaced; a foreground run writes it to its terminal instead.
    if (replacedDaemon !== null) {
      writeErrorLog(
        `agenc: ${describeClaimedDaemonExit(replacedDaemon, Date.now())}\n`,
      );
    }
    cleanup.register("daemon-error-log-sink", installAgenCDaemonErrorLogSink({
      path: resolveAgenCDaemonLogPath(host.env, host.userHome),
      write: writeErrorLog,
      writeDebug: writeErrorDebugLog,
    }));
    let shuttingDown = false;
    let startupCancelled = false;
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
    // A session restored after the daemon started serving whose publication
    // failed and could not be rolled back. The daemon stops rather than serve
    // a session it may have published in part.
    let resolveStartupRestoreFailure!: (error: unknown) => void;
    const startupRestoreFailureCompleted = new Promise<unknown>((resolve) => {
      resolveStartupRestoreFailure = resolve;
    });
    let runner = options.runner;
    const approvalBroker: LiveApprovalBroker = new LiveApprovalBroker({
      canAnswerCrossProviderConsent: crossProviderConsentAvailability({
        sessionIdsForAgent: (agentId): Promise<readonly string[]> => agentManager.sessionIdsForAgent(agentId),
        hasAttachedClientWithCapability: (sessionId, capability) =>
          clientMultiplexer.hasAttachedClientWithCapability(sessionId, capability),
      }),
      // A session that was still starting during a reload reads the settings
      // again when it registers. No reload result can name it, so log it.
      onCrossProviderRefreshFailed: (failure) => {
        io.stderr.write(crossProviderSettingsFailureLine(failure));
      },
    });
    let configuredRunner: AgenCDelegateBackgroundAgentRunner | undefined;
    if (runner === undefined) {
      configuredRunner = new AgenCDelegateBackgroundAgentRunner({
        approvalBroker,
        ...(activeConfig.daemon?.agent_stop_timeout_ms !== undefined
          ? { agentStopTimeoutMs: activeConfig.daemon.agent_stop_timeout_ms }
          : {}),
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
        log: (message) => io.stderr.write(`agenc: ${message}\n`),
      });
    } catch (error) {
      io.stderr.write(
        `agenc: daemon snapshot policy initialization failed: ${formatCleanupError(error)}\n`,
      );
      return 1;
    }
    // The resolved retention was previously invisible: the live daemon grew a
    // 1.3 GB snapshot table without one log line saying which caps applied.
    io.stderr.write(
      `agenc: daemon snapshot retention ${describeSnapshotRetention(activeConfig.agent?.retention)}\n`,
    );
    cleanup.register("daemon-snapshot-policy", async () => {
      snapshotPolicies.close();
    });
    // The sessions open at the last shutdown are restored after the daemon
    // starts serving. Each is registered here, before the socket listens, so
    // no request can name one before the daemon knows it is still restoring.
    const startupRestores: StartupSessionRestores<StartupSessionRestoreRunTarget> =
      new StartupSessionRestores<StartupSessionRestoreRunTarget>({
      targets: startupRecovery.recoveredRuns.map((run) => ({
        runId: run.id,
        ...(run.currentSessionId !== undefined
          ? { sessionId: run.currentSessionId }
          : {}),
        run,
      })),
      concurrency: STARTUP_RUNTIME_RESTORE_CONCURRENCY,
      task: ({ run }, context): Promise<"published" | "unavailable"> =>
        restoreAndPublishRecoveredRun(
          sessionManager,
          agentManager,
          runner,
          startupRecovery,
          run,
          context,
          {
            recordReplayToolResult: (result) =>
              recordStartupReplayToolResult(snapshotPolicies, result),
            onResumeSourceCloseError: (error) => {
              io.stderr.write(
                `agenc: startup restore of run ${run.id} could not close its resume source: ${formatCleanupError(error)}\n`,
              );
            },
          },
        ),
      onSettled: (settled) => {
        writeAgenCDaemonStartupDebug(
          host,
          io,
          startupStartedAt,
          describeStartupSessionRestoreSettlement(settled),
        );
        if (settled.outcome !== "failed") return;
        const { run } = settled.target;
        if (
          settled.error instanceof StartupSessionPublicationError &&
          !settled.error.rolledBack
        ) {
          io.stderr.write(
            `agenc: startup restore of run ${run.id} failed to publish and could not be rolled back; stopping the daemon: ${formatCleanupError(settled.error)}\n`,
          );
          shuttingDown = true;
          // Requests waiting for this session get the shutdown answer instead
          // of running against what the failed rollback left.
          startupRestores.stop();
          resolveStartupRestoreFailure(settled.error);
          return;
        }
        io.stderr.write(
          `agenc: startup restore of run ${run.id}${
            run.currentSessionId !== undefined
              ? ` (session ${run.currentSessionId})`
              : ""
          } failed; it was not published and can be resumed again: ${formatCleanupError(settled.error)}\n`,
        );
      },
    });
    let routines: RoutineService | undefined;
    let remote: RemoteService | undefined;
    let ownerTelegram: OwnerTelegramService | undefined;
    const agentManager: AgenCDaemonAgentManager = new AgenCDaemonAgentManager({
      approvalBroker,
      agencHome: authStartup.daemonHome,
      runner,
      sessionManager,
      waitForStartupRestore: (ids, signal): Promise<void> | undefined =>
        startupRestores.waitFor(ids, signal),
      terminateSession: async (params) => {
        try {
          return await clientMultiplexer.terminateSession(params);
        } finally {
          // Session teardown owns the last live reference to the project's
          // snapshot and log databases. This is also reached on Stop/error.
          snapshotPolicies.releaseSession(params.sessionId);
        }
      },
      threadStore,
      // DAE-02: prefer client/workspace env over frozen OS cwd when params omit cwd.
      defaultCwd: () => resolveDaemonDefaultCwd(host.env),
      snapshotFlush: (snapshot) =>
        writeAgenCDaemonSnapshot(snapshotPath, snapshot),
      broadcastSessionEvent: async (sessionId, event) => {
        routines?.observeSessionEvent(sessionId, event);
        remote?.observeSessionEvent(sessionId, event);
        ownerTelegram?.observeSessionEvent(sessionId, event);
        try {
          snapshotPolicies.recordSessionEvent(sessionId, event);
        } catch (error) {
          io.stderr.write(
            `agenc: daemon snapshot policy failed: ${formatCleanupError(error)}\n`,
          );
        }
        // The result reaches the approval broker: a forwarded sub-agent
        // request that nobody received and nobody will list is denied.
        return await sessionEventDelivery(
          event,
          await clientMultiplexer.broadcastSessionEvent(sessionId, event),
          async () =>
            (await clientMultiplexer.hasClientWithCapability(
              AGENC_PENDING_APPROVALS_LIST_CAPABILITY,
            )) || (remote?.status().connectedDevices ?? 0) > 0,
        );
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
      releaseThreadStoreForAgentLogs: (route) =>
        snapshotPolicies.releaseThreadStoreForAgentLogs(route),
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
    const stopAgents = async () => {
      await agentManager.stopAll("daemon_shutdown", {
        disposition: "suspend_idle",
      });
    };
    const unregisterAgentsCleanup = cleanup.register("daemon-agents", stopAgents);
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
    if (host.startupGuardReceiver?.wasRequested() === true) return 1;
    // M5 verified-change workflow controller. Constructed over the shared
    // admission kernel + durable state, with the Phase 5 session-backed seams
    // (per-run daemon session, rollout journal, sandbox-brokered worktrees and
    // verification commands, delegate spawner, one-shot reviewer). Open
    // workflow runs are resumed (D3 recovery) after admission recovery and
    // startup journal recovery so adopted/re-executed effects observe fully
    // recovered budget state. They are also resumed after the sessions open
    // at the last shutdown are restored, the order they always ran in: those
    // restores now finish after the daemon starts serving (see below).
    const workflowWiring = createDaemonWorkflowController({
      approvalBroker,
      agencHome: authStartup.daemonHome,
      primaryCwd,
      kernel: executionAdmissionKernel,
      warn: (message) => io.stderr.write(`agenc: ${message}\n`),
      env: host.env,
      config: () => activeConfig,
      argv: [host.execPath, host.entrypointPath],
      authBackend: reloadableAuthBackend,
      stateDatabasePaths: () =>
        discoverAgenCDaemonStateDatabasePaths(
          authStartup.daemonHome,
          primaryCwd,
        ),
    });
    cleanup.register("daemon-workflow-controller", () => workflowWiring.close());
    const resumeOpenWorkflows = (): void => {
      void workflowWiring.resumeOpenWorkflows().catch((error) => {
        io.stderr.write(
          `agenc: workflow startup recovery failed: ${formatCleanupError(error)}\n`,
        );
      });
    };
    // With no session to restore, nothing is left to order them after.
    if (startupRestores.total === 0) resumeOpenWorkflows();
    const workflowStartService = new DaemonWorkflowStartService({
      controller: workflowWiring.controller,
      primaryCwd,
      recordAgentRun: (run) => {
        snapshotPolicies.recordAgentRun(run);
      },
      warn: (message) => io.stderr.write(`agenc: ${message}\n`),
    });
    const workflowControlService = new DaemonWorkflowControlService(workflowWiring.controller);
    const health = new AgenCDaemonHealthService({
      sessionCounter: sessionManager,
      stateCounter: new StateSqliteHealthStatsReader(
        discoverAgenCDaemonStateDatabasePaths(
          authStartup.daemonHome,
          process.cwd(),
        ),
      ),
      ready: () => !shuttingDown,
      restoringSessions: () => startupRestores.unsettled,
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
          // The daemon's own [agents] view before this save: a session that
          // cannot read its settings again loses only what the save took
          // away from that view.
          const previousAgents = activeConfig.agents;
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
          // Open sessions keep the config they started with, except the
          // cross-provider subagent settings: a provider the user turned off
          // must stop taking spawns now, not after a restart. A session that
          // cannot read them again loses what the save took away from the
          // daemon's own view, which no workspace file can make unreadable.
          const crossProvider = await approvalBroker.refreshCrossProviderPolicy({
            previous: previousAgents,
            next: next.config.agents,
          });
          for (const failure of crossProvider.failed) {
            io.stderr.write(crossProviderSettingsFailureLine(failure));
          }
          const result: DaemonReloadResult = {
            reloaded: true,
            configReloadedAt: new Date().toISOString(),
            mcpServer: daemonMcpServerReloadResult(activeMcpServer),
            ...(crossProvider.failed.length > 0
              ? {
                  crossProviderSettings: {
                    failed: crossProvider.failed.map(({ sessionId, reason, timedOut }) => ({
                      sessionId,
                      reason,
                      ...(timedOut === true ? { timedOut } : {}),
                    })),
                  },
                }
              : {}),
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
    const routinePreparation = new RoutineSessionPreparation(clientMultiplexer);
    try {
      routines = new RoutineService({
        home: authStartup.daemonHome,
        executor: createDaemonRoutineExecutor({
          agentManager,
          prepareSession: (input, signal) => routinePreparation.prepare(input, signal),
          environment: host.env,
          defaultProvider: () => resolveBuiltInProviderSlug(activeConfig.model_provider),
          runtimeOptions: resolveAgentRuntimeOptions(
            { ...host.env, AGENC_HOME: authStartup.daemonHome },
            { dangerouslyBypassApprovalsAndSandbox: false, allowUntrustedHooks: false, remoteMode: false, stdinDataMode: false },
          ),
        }),
        onRunFailure: ({ routineId, runId, reason, errorCode, errorName }) => {
          io.stderr.write(`agenc: routine ${routineId} run ${runId} could not run: ${reason}${errorCode ? ` ${errorCode}` : ""}${errorName ? ` (${errorName})` : ""}\n`);
        },
      });
      routines.start();
      cleanup.register("daemon-routines", () => routines?.close());
    } catch {
      await routines?.close();
      routines = undefined;
      io.stderr.write("agenc: local routines are unavailable; routine storage was preserved\n");
    }
    const remoteContext = { home: resolveHomeContext({ ...host.env, AGENC_HOME: authStartup.daemonHome }), environment: Object.freeze({ ...host.env }) };
    const assertRemoteControlSession = async (sessionId: string): Promise<void> => {
      const session = await sessionManager.getSession(sessionId);
      if (!session) throw new RemoteError("REMOTE_SESSION_UNAVAILABLE");
      const snapshot = await runner.getAgentSnapshot?.(session.agentId);
      assertSafeRemoteSessionPolicy(snapshot?.runtimeSettings, session.metadata?.runtimeOptions);
    };
    const createRemoteSession = async (workspacePath: string, title: string, signal: AbortSignal, selection?: import("../gateway/owner-telegram.js").TelegramSessionOptions) => {
        signal.throwIfAborted();
        const agent = await agentManager.createAgent({
          cwd: workspacePath, objective: title, deferInitialTurn: true, permissionMode: "default",
          ...(selection ? { provider: selection.provider, model: selection.model, envOverrides: selection.envOverrides } : {}),
          runtimeOptions: resolveAgentRuntimeOptions(
            { ...host.env, AGENC_HOME: authStartup.daemonHome },
            { dangerouslyBypassApprovalsAndSandbox: false, allowUntrustedHooks: false, remoteMode: true, stdinDataMode: false },
          ),
        });
        if (signal.aborted || !agent.sessionId) {
          await agentManager.stopAgent({ agentId: agent.agentId, reason: "Remote session creation cancelled" });
          throw new Error("Remote session creation cancelled");
        }
        return { sessionId: agent.sessionId, agentId: agent.agentId };
      };
    remote = new RemoteService({
      home: authStartup.daemonHome,
      backend: createRemoteBackend({ backendUrl: host.env.AGENC_BACKEND_URL || "https://id.agenc.ag", token: () => remoteAuthSessionTokenSync(remoteContext) }),
      lookupSession: (sessionId) => sessionManager.getSession(sessionId),
      createConnection: (remoteAccess, remoteCid) => dispatcher.createConnection({ remoteAccess, remoteCid }),
      createSession: createRemoteSession,
      assertControlSession: assertRemoteControlSession,
    });
    cleanup.register("daemon-browser-remote", () => remote?.close());
    try {
      ownerTelegram = new OwnerTelegramService({
        home: authStartup.daemonHome,
        storage: createOwnerTelegramStorage(remoteContext.home),
        onSessionFailure: (diagnostic) => writeErrorLog(`agenc: Telegram session.create failed: ${diagnostic}\n`),
        lookupSession: (sessionId) => sessionManager.getSession(sessionId),
        createConnection: (remoteAccess) => dispatcher.createConnection({ remoteAccess }),
        createSession: createRemoteSession,
        assertControlSession: assertRemoteControlSession,
      });
    } catch {
      // Preserve malformed/unreadable metadata and keep unrelated local sessions usable.
      ownerTelegram = undefined;
      io.stderr.write("agenc: Telegram agents are unavailable; existing configuration was preserved\n");
    }
    cleanup.register("daemon-owner-telegram", () => ownerTelegram?.close());
    const dispatcher: AgenCDaemonJsonRpcDispatcher = new AgenCDaemonJsonRpcDispatcher({
      pluginSettings: new PluginSettingsService({
        home: authStartup.daemonHome,
        pluginStorageRoot: resolvePluginStorageRootAtIngress({ ...host.env, AGENC_HOME: authStartup.daemonHome }),
        workspaceRoot: primaryCwd,
        env: { ...host.env, AGENC_HOME: authStartup.daemonHome },
      }),
      remote,
      ownerTelegram,
      agentManager,
      routines,
      clientMultiplexer,
      routinePreparation,
      sessionManager,
      startupRestores,
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
      whisper: new LocalWhisperService({ home: authStartup.daemonHome, env: host.env }),
      runInspection: new AgenCDaemonRunInspectionService({
        runtimeFailure: (runId) => workflowWiring.controller.currentRuntimeFailure(runId),
        effectivePermissionMode: (runId) => workflowWiring.controller.currentPermissionMode(runId),
        providerWait: (runId, stepId) => workflowWiring.controller.currentProviderWait(runId, stepId),
        pendingApprovals: (runId) => approvalBroker.list(runId),
        stateDatabasePaths: () =>
          discoverAgenCDaemonStateDatabasePaths(
            authStartup.daemonHome,
            primaryCwd,
          ),
        agencHome: authStartup.daemonHome,
      }),
      workflow: {
        supportsContinuation: true,
        startRun: (params) => workflowStartService.startRun(params),
        cancelDetachedRun: (params) => workflowStartService.cancelDetachedRun(params),
        pauseRun: (params) => workflowControlService.pauseRun(params),
        resumeRun: (params) => workflowControlService.resumeRun(params),
      },
      csvJobReview: new AgenCCsvJobReviewStateService(csvAgentJobsRepositories),
      // Sessions this daemon starts read trust from its home, with the
      // operator's root markers; a reload replaces activeConfig.
      projectTrust: new AgenCProjectTrustService({
        agencHome: authStartup.daemonHome,
        projectRootMarkers: () => activeConfig.project_root_markers,
      }),
      daemonIdentity,
      initializeAuthenticator: (params) =>
        cookieAuthenticator.authenticateInitializeParams(params),
    });
    const connections = new Map<string, AgenCDaemonJsonRpcConnection>();
    const socketConnections = new Map<
      string,
      {
        readonly send: (message: JsonObject) => Promise<void>;
        readonly terminate: () => void;
      }
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
    destroyEvictedClientConnection = (clientId, deliveryKey): void => {
      for (const [connectionKey, connection] of connections) {
        if (
          (deliveryKey !== undefined && connection.cancellationScope !== deliveryKey) ||
          !connection.trackedClientIds.includes(clientId)
        ) {
          continue;
        }
        const wasSoleClient = connection.untrackClientId(clientId);
        if (wasSoleClient) {
          socketConnections.get(connectionKey)?.terminate();
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
    const resolveRoutineSessionId = (id: string) => agentManager.peekRoutineSessionId(id);
    const socketServer = new AgenCUnixSocketServer({
      socketPath,
      resolveRoutineSessionId,
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
          terminate: () => context.terminate(),
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
      resolveRoutineSessionId,
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
          terminate: () => context.terminate(),
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
    writeAgenCDaemonStartupDebug(
      host,
      io,
      startupStartedAt,
      "daemon services constructed",
    );
    cleanup.register("daemon-browser", async () => {
      await closeAllBrowserManagers();
    });
    cleanup.register("daemon-fuzzy-file-index", async () => {
      await dispatcher.close();
    });
    cleanup.register("daemon-authority", async () => {
      await options.beforeDaemonAuthorityCleanup?.();
      await runAgenCDaemonAuthorityCleanup({
        host,
        lifecycleLockHeld: !lifecycleLockReleased,
        closeSocket: () => socketServer.close({ drainTimeoutMs: 5_000 }),
        removeMetadata: () =>
          removeOwnedForegroundDaemonMetadata({
            expected: daemonIdentity,
            pidPath,
            runtimeInfoPath: existingRuntimeInfoPath,
          }),
      });
    });
    cleanup.register("daemon-websocket", async () => {
      await webSocketServer.close({ drainTimeoutMs: 5_000 });
    });
    cleanup.register("daemon-mcp-server", async () => {
      await activeMcpServer.close();
    });
    // Shutdown already fenced new RPC work. Cancel connection jobs and stop
    // daemon-owned execution before transport.close drains their handlers;
    // otherwise a runner-backed request waits for a stop scheduled behind it.
    // Keep the earlier registrations until construction reaches this point so
    // startup failures still release partially constructed actors.
    unregisterAgentsCleanup();
    cleanup.register("daemon-agents", stopAgents);
    // Runs before daemon-agents (cleanup runs in reverse order). Restores
    // that never started are dropped and their waiters answered with the
    // shutdown error. The ones already running finish and publish first, so
    // stopAll then suspends them like every other idle session. One that
    // does not finish in time is aborted, and one still running after that
    // can no longer publish: no session is published after stopAll.
    cleanup.register("daemon-startup-restores", async () => {
      const graceMs =
        options.startupRestoreShutdownGraceMs ??
        STARTUP_RESTORE_SHUTDOWN_GRACE_MS;
      const givenUp = await startupRestores.shutdown({
        graceMs,
        abortGraceMs: graceMs,
      });
      if (givenUp.length > 0) {
        throw new Error(
          `startup session restore did not stop for run(s) ${givenUp
            .map(({ run }) => run.id)
            .join(", ")}`,
        );
      }
    });
    unregisterCommandExecCleanup();
    cleanup.register("daemon-command-exec", closeCommandExec);
    cleanup.register("daemon-connections", async () => {
      const activeConnections = [...connections.values()];
      connections.clear();
      socketConnections.clear();
      const results = await Promise.allSettled(
        activeConnections.map((connection) => connection.close()),
      );
      const failed = results.filter((result) => result.status === "rejected");
      if (failed.length > 0) {
        throw new AggregateError(
          failed.map((result) => result.reason),
          "daemon connection cleanup failed",
        );
      }
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
        writeAgenCDaemonStartupDebug(
          host,
          io,
          startupStartedAt,
          "MCP startup complete",
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
      writeAgenCDaemonStartupDebug(
        host,
        io,
        startupStartedAt,
        "control socket listening",
      );
      if (host.startupGuardReceiver?.wasRequested() === true) {
        exitCode = 1;
        return exitCode;
      }
      const webSocketAddress = await webSocketServer.listen();
      writeAgenCDaemonStartupDebug(
        host,
        io,
        startupStartedAt,
        "websocket listening",
      );
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
          writeAgenCDaemonStartupDebug(
            host,
            io,
            startupStartedAt,
            "readiness identity published",
          );
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
        // The daemon serves from here on. The sessions open at its last
        // shutdown are rebuilt in the background, four at a time; a request
        // naming one waits for it (see StartupSessionRestores).
        void startupRestores.settled.then((summary) => {
          reportStartupSessionRestoreSummary(host, io, startupStartedAt, summary);
          if (summary.total > 0 && summary.abandoned === 0 && !shuttingDown) {
            resumeOpenWorkflows();
          }
        });
        startupRecovery.recoveredRuns.forEach((run, index, runs) => {
          writeAgenCDaemonStartupDebug(
            host,
            io,
            startupStartedAt,
            `startup session restore ${index + 1}/${runs.length} queued: run ${run.id}` +
              (run.currentSessionId !== undefined
                ? ` session ${run.currentSessionId}`
                : ""),
          );
        });
        startupRestores.start();
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
        startupRestoreFailureCompleted.then((error) => ({
          kind: "startup_restore_failure" as const,
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
      } else if (
        termination.kind === "peer_credential_failure" ||
        termination.kind === "startup_restore_failure"
      ) {
        cleanupContext = { reason: "daemon_shutdown" };
        exitCode = 1;
      } else {
        cleanupContext = { reason: "daemon_shutdown" };
        startupCancelled = termination.kind === "startup_cancel";
        exitCode = startupCancelled ? 1 : 0;
        if (termination.kind === "rpc_shutdown") {
          // A clean stop used to leave nothing in daemon.log, only a removed
          // heartbeat, so the log could not tell it from a kill. On Windows
          // this request is the only graceful stop: SIGTERM does not exist
          // there, and killing the process runs no handler at all.
          writeErrorLog(
            `agenc: daemon stopping at a client's daemon.shutdown request (pid ${host.pid}) at ${new Date().toISOString()}\n`,
          );
        }
      }
    } finally {
      shuttingDown = true;
      try {
        // Any reload admitted before the ingress fence must either finish or
        // reject its prepared resources before MCP/socket cleanup begins.
        await reloadChain.catch(() => null);
        const results = await cleanup.run(
          cleanupContext,
          startupCancelled
            ? {
                taskTimeoutMs:
                  options.startupCancelCleanupTaskTimeoutMs ??
                  AGENC_DAEMON_STARTUP_CANCEL_CLEANUP_TASK_TIMEOUT_MS,
              }
            : {},
        );
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
      } finally {
        shutdownSignal.dispose();
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


function describeFileSizeMb(path: string): string {
  try {
    return `${(statSync(path).size / 1_048_576).toFixed(1)} MB`;
  } catch {
    return "absent";
  }
}


function describeSnapshotRetention(
  retention: AgentRunRetentionConfig | undefined,
): string {
  const configured =
    retention === undefined
      ? "unconfigured"
      : `snapshot_days=${retention.snapshot_days ?? "off"} ` +
        `snapshot_max_count=${retention.snapshot_max_count ?? "off"} ` +
        `snapshot_max_bytes=${retention.snapshot_max_bytes ?? "off"} ` +
        `completed_days=${retention.completed_days ?? "off"} ` +
        `failed_days=${retention.failed_days ?? "off"} ` +
        `rollout_days=${retention.rollout_days ?? "off"}`;
  return `${configured} (hard cap ${SESSION_SNAPSHOT_HARD_CAP} rows per session)`;
}


function describeStateReclaim(
  report: StateFreePageReclaim,
  stateDbPath: string,
): string {
  const pages = report.freePagesBefore - report.freePagesAfter;
  const mib = ((pages * report.pageSize) / (1024 * 1024)).toFixed(1);
  const how = report.mode === "full" ? "full vacuum, now incremental" : "incremental";
  return `daemon state reclaimed ${pages} free page(s) (${mib} MiB, ${how}) in ${stateDbPath}`;
}


/**
 * A retention sweep deletes session directories permanently and unattended, so
 * the ids it removed must survive in the log. Sessions are named, not counted:
 * "which of my sessions went" is the only question this line has to answer.
 */
function describeRolloutRetentionPrune(
  report: RolloutPruningReport,
  projectDir: string,
): string {
  const NAMED = 20;
  const ids = report.prunedSessionIds.slice(0, NAMED).join(", ");
  const rest = report.prunedSessionIds.length - NAMED;
  const named = ids.length > 0 ? `: ${ids}${rest > 0 ? `, and ${rest} more` : ""}` : "";
  return (
    `daemon rollout retention deleted ${report.prunedSessions} session(s) ` +
    `(${report.prunedRolloutFiles} rollout file(s), ${report.prunedMirrorRows} mirror row(s)) ` +
    `in ${projectDir}${named}`
  );
}


function recoverAgenCDaemonStartupState(
  daemonHome: string,
  cwd: string,
  config: AgenCConfig,
  log: (message: string) => void = () => {},
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
        const walPath = `${pathSet.stateDbPath}-wal`;
        log(
          `daemon opened state DB ${pathSet.stateDbPath} (${describeFileSizeMb(pathSet.stateDbPath)}, wal ${describeFileSizeMb(walPath)})`,
        );
        const prunedRuns = pruneTerminalAgentRuns(
          driver,
          config.agent?.retention,
        );
        // Per-session hard cap first, so the table-wide agent-grouped sweep
        // below only measures the rows that survive it.
        const prunedPerSession = pruneSessionSnapshotsPerSession(
          driver,
          config.agent?.retention,
        );
        const prunedTable = pruneSessionStateSnapshots(
          driver,
          config.agent?.retention,
        );
        // Before the socket opens is the one moment a full VACUUM cannot stall a
        // client; a database created without auto-vacuum is converted here once.
        const reclaimed = driver.reclaimFreePages({ allowFullVacuum: true });
        if (reclaimed.mode !== "none") {
          log(describeStateReclaim(reclaimed, pathSet.stateDbPath));
        }
        const prunedSnapshots =
          prunedRuns.prunedSnapshots +
          prunedPerSession.prunedSnapshots +
          prunedTable.prunedSnapshots;
        if (prunedRuns.prunedRuns > 0 || prunedSnapshots > 0) {
          log(
            `daemon retention pruned ${prunedRuns.prunedRuns} terminal run(s) and ` +
              `${prunedSnapshots} snapshot row(s) across ` +
              `${new Set([...prunedRuns.prunedSessionIds, ...prunedPerSession.prunedSessionIds, ...prunedTable.prunedSessionIds]).size} session(s) in ${pathSet.projectDir}`,
          );
        }
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
 * config. Returns undefined (sweep stays DISABLED) when `rollout_days` is unset
 * or 0. The config default is 30 days (#2228); the sweep deletes user data, so
 * 0 is the documented way to keep every session.
 */
export function rolloutRetentionPolicy(
  retention: AgentRunRetentionConfig | undefined,
): RolloutRetentionPolicy | undefined {
  const days = retention?.rollout_days;
  // 0 (or anything that is not a positive number) keeps every session: a
  // zero-day window handed to the sweep would delete everything but the
  // active session at the first tick.
  if (days === undefined || !Number.isFinite(days) || days <= 0) {
    return undefined;
  }
  return { retention_days: days };
}


interface AgenCDaemonSnapshotPolicyRegistryOptions {
  readonly agencHome: string;
  readonly defaultCwd: string;
  readonly snapshotRetention?: AgentRunRetentionConfig;
  readonly periodicIntervalMs?: number;
  readonly onError: (error: unknown) => void;
  readonly log?: (message: string) => void;
}


interface AgenCDaemonSnapshotPolicyEntry {
  readonly driver: StateSqliteDriver;
  readonly policy: AgenCSessionSnapshotPolicy;
}


export class AgenCDaemonSnapshotPolicyRegistry {
  readonly #agencHome: string;
  readonly #defaultCwd: string;
  #snapshotRetention: AgentRunRetentionConfig | undefined;
  readonly #periodicIntervalMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #log: (message: string) => void;
  readonly #policies = new Map<string, AgenCDaemonSnapshotPolicyEntry>();
  readonly #sessionPolicyKeys = new Map<string, string>();
  readonly #liveSessions = new Set<string>();
  readonly #endedSessions = new Set<string>();
  readonly #threadStores = new Map<string, FileThreadStore>();
  #periodicTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: AgenCDaemonSnapshotPolicyRegistryOptions) {
    this.#agencHome = options.agencHome;
    this.#defaultCwd = options.defaultCwd;
    this.#snapshotRetention = options.snapshotRetention;
    this.#periodicIntervalMs = options.periodicIntervalMs ?? 30_000;
    this.#onError = options.onError;
    this.#log = options.log ?? (() => {});
    this.#policyForCwd(this.#defaultCwd);
  }

  hydrateStartupRecovery(report: DaemonStartupRecoveryReport): void {
    const reconciledSessionIds = new Set(
      report.recoveredToolCalls.map((call) => call.sessionId),
    );
    for (const run of report.recoveredRuns) {
      if (run.currentSessionId === undefined) continue;
      const policy = this.#policyForProjectDir(run.projectDir);
      this.#rememberSession(run.currentSessionId, policy.driver.stateDbPath);
      this.#liveSessions.add(run.currentSessionId);
      policy.policy.trackSession(run.currentSessionId, run.id);
      if (run.latestSnapshot !== undefined) {
        policy.policy.hydrateSession({
          sessionId: run.currentSessionId,
          snapshotAt: run.latestSnapshot.snapshotAt,
          conversation: run.latestSnapshot.conversation,
          toolState: run.latestSnapshot.toolState,
          mcpConnectionState: run.latestSnapshot.mcpConnectionState,
        });
        // Startup recovery reconciled this session's stale tool calls
        // (replayed, poisoned or cancelled) into the hydrated state: write
        // that outcome now, before the daemon advertises readiness, instead
        // of leaving it to the first periodic tick. A session recovery left
        // untouched keeps its rows exactly as startup pruning left them.
        if (reconciledSessionIds.has(run.currentSessionId)) {
          policy.policy.flushSession(run.currentSessionId);
        }
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
    const errors: unknown[] = [];
    for (const entry of this.#policies.values()) {
      try {
        entry.policy.flushPeriodic();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      for (const error of errors) this.#onError(error);
      throw new AggregateError(errors, "daemon periodic snapshot flush failed");
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
    const errors: unknown[] = [];
    for (const [key, entry] of this.#policies) {
      // Flush dirty sessions synchronously before the state DB goes away.
      try {
        entry.policy.close();
        entry.driver.close();
        this.#policies.delete(key);
      } catch (error) {
        errors.push(error);
        this.#onError(error);
      }
    }
    for (const store of this.#threadStores.values()) {
      try {
        store.close();
      } catch (error) {
        errors.push(error);
        this.#onError(error);
      }
    }
    for (const [sessionId, key] of this.#sessionPolicyKeys) {
      if (!this.#policies.has(key)) this.#sessionPolicyKeys.delete(sessionId);
    }
    this.#threadStores.clear();
    if (errors.length > 0) {
      throw new AggregateError(errors, "daemon snapshot policies retained unpersisted sessions");
    }
  }

  recordSessionEvent(sessionId: string, event: JsonObject): void {
    if (this.#endedSessions.has(sessionId)) return;
    const entry = this.#policyForSession(sessionId);
    entry.policy.recordSessionEvent(sessionId, event);
  }

  /** Write the session's snapshot now if it has unflushed changes. */
  flushSession(sessionId: string): void {
    if (this.#endedSessions.has(sessionId)) return;
    const entry = this.#policyForSession(sessionId);
    entry.policy.flushSession(sessionId);
  }

  registerSession(session: AgenCDaemonSnapshotSessionRoute): void {
    this.#endedSessions.delete(session.sessionId);
    const entry = this.#policyForRoute(session);
    this.#rememberSession(session.sessionId, entry.driver.stateDbPath);
    this.#liveSessions.add(session.sessionId);
    entry.policy.trackSession(session.sessionId, session.agentId);
  }

  recordMessageExchange(exchange: AgenCDaemonMessageExchangeSnapshot): void {
    if (this.#endedSessions.has(exchange.sessionId)) return;
    const entry = this.#policyForRoute(exchange);
    this.#rememberSession(exchange.sessionId, entry.driver.stateDbPath);
    entry.policy.recordMessageExchange(exchange);
  }

  recordAgentStatusTransition(
    transition: AgenCDaemonAgentStatusSnapshot,
  ): void {
    if (this.#endedSessions.has(transition.sessionId)) return;
    const entry = this.#policyForRoute(transition);
    this.#rememberSession(transition.sessionId, entry.driver.stateDbPath);
    entry.policy.recordAgentStatusTransition(transition);
  }

  recordAgentRun(run: AgenCDaemonAgentRunSnapshot): void {
    if (run.currentSessionId !== undefined) this.#endedSessions.delete(run.currentSessionId);
    const entry = this.#policyForRoute(run);
    upsertAgentRun(entry.driver, run);
    new StateRunDurabilityRepository(entry.driver).ensureInitialEpoch({
      runId: run.id,
      openedAt: run.startedAt,
    });
    if (run.currentSessionId !== undefined) {
      this.#rememberSession(run.currentSessionId, entry.driver.stateDbPath);
      this.#liveSessions.add(run.currentSessionId);
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
    // The lifecycle still has to project the final agent status. Its session
    // termination callback releases the snapshot after that projection.
  }

  /** Drop a project's daemon handles after its final live session ends. */
  releaseSession(sessionId: string): void {
    this.#liveSessions.delete(sessionId);
    this.#endedSessions.add(sessionId);
    const key = this.#sessionPolicyKeys.get(sessionId);
    if (key === undefined) return;
    const entry = this.#policies.get(key);
    try {
      entry?.policy.flushSession(sessionId);
      entry?.policy.forgetSession(sessionId);
    } catch (error) {
      throw new AggregateError([error], "session snapshot release failed");
    }
    if (this.#projectHasLiveSession(key)) return;
    const errors = this.#closeProjectHandles(key, entry);
    if (errors.length > 0) throw new AggregateError(errors, "session snapshot release failed");
  }

  #projectHasLiveSession(key: string): boolean {
    for (const liveId of this.#liveSessions) {
      if (this.#sessionPolicyKeys.get(liveId) === key) return true;
    }
    return false;
  }

  /** Close a project's snapshot policy, driver and agent-log stores. */
  #closeProjectHandles(key: string, entry: AgenCDaemonSnapshotPolicyEntry | undefined): unknown[] {
    const errors: unknown[] = [];
    if (entry !== undefined) {
      try {
        entry.policy.close();
        entry.driver.close();
        this.#policies.delete(key);
      } catch (error) {
        errors.push(error);
      }
    }
    for (const [storeKey, store] of this.#threadStores) {
      if (store.getProjectDir() !== dirname(key)) continue;
      this.#threadStores.delete(storeKey);
      try {
        store.close();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  threadStoreForAgentLogs(
    route: AgenCDaemonAgentLogThreadStoreRoute,
  ): FileThreadStore {
    return this.#threadStoreForRoute(route);
  }

  releaseThreadStoreForAgentLogs(route: AgenCDaemonAgentLogThreadStoreRoute): void {
    const key = route.stateProjectDir !== undefined
      ? `project:${route.stateProjectDir}`
      : `cwd:${route.cwd ?? this.#defaultCwd}`;
    const store = this.#threadStores.get(key);
    if (store === undefined) return;
    const projectDir = store.getProjectDir();
    for (const sessionId of this.#liveSessions) {
      const statePath = this.#sessionPolicyKeys.get(sessionId);
      if (statePath !== undefined && dirname(statePath) === projectDir) return;
    }
    this.#threadStores.delete(key);
    store.close();
  }

  readAgentToolOutputs(params: {
    readonly agentId: string;
    readonly sessionIds: readonly string[];
  }): readonly AgentToolOutputLog[] {
    void params.agentId;
    const outputs: AgentToolOutputLog[] = [];
    try {
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
    } finally {
      for (const sessionId of params.sessionIds) {
        if (this.#endedSessions.has(sessionId)) this.releaseSession(sessionId);
      }
    }
  }

  #policyForSession(sessionId: string): AgenCDaemonSnapshotPolicyEntry {
    const key = this.#sessionPolicyKeys.get(sessionId);
    if (key !== undefined) {
      const entry = this.#policies.get(key);
      if (entry !== undefined) return entry;
      return this.#policyForProjectDir(dirname(key));
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
      onPruneReport: (report) =>
        this.#log(
          `daemon snapshot retention pruned ${report.prunedSnapshots} row(s) ` +
            `across ${report.prunedSessionIds.length} session(s) in ${paths.projectDir}`,
        ),
      onReclaimReport: (report) =>
        this.#log(describeStateReclaim(report, paths.stateDbPath)),
      onRolloutPruneReport: (report) =>
        this.#log(describeRolloutRetentionPrune(report, paths.projectDir)),
    });
    const entry = { driver, policy };
    this.#policies.set(paths.stateDbPath, entry);
    return entry;
  }

  #rememberSession(sessionId: string, stateDbPath: string): void {
    this.#sessionPolicyKeys.set(sessionId, stateDbPath);
  }
}


/**
 * How many recovered sessions have their runtime rebuilt at the same time.
 * A rebuild is a full session bootstrap, and most of it waits on the disk and
 * the network, which a few rebuilds in flight overlap. On 32 sessions whose
 * bootstraps waited on catalog downloads it took 14 to 21 s one at a time,
 * 6.3 to 7.7 s four at a time and 6.0 to 6.3 s eight at a time. Without those
 * waits every bound from one to eight took 5.1 to 5.7 s. Four keeps most of
 * the gain with fewer bootstraps in flight. The rebuilds now run while the
 * daemon serves, so the bound also caps how much they compete with the first
 * requests of the clients that connect.
 */
const STARTUP_RUNTIME_RESTORE_CONCURRENCY = 4;


/**
 * How long shutdown lets a session restore that is already running finish,
 * and then how long it waits for one it aborted. A restore is one session
 * bootstrap; this is the bound an agent stop gets.
 */
const STARTUP_RESTORE_SHUTDOWN_GRACE_MS = DAEMON_AGENT_STOP_TIMEOUT_MS;


type StartupRuntimeRestore = Awaited<
  ReturnType<typeof restoreRecoveredAgentRuntime>
>;


/** One session the daemon restores after it starts serving. */
interface StartupSessionRestoreRunTarget {
  readonly runId: string;
  readonly sessionId?: string;
  readonly run: RecoveredAgentRun;
}


/**
 * A recovered session whose publication failed. What it had published was
 * rolled back when `rolledBack` is true. When it is false, undoing it failed
 * too, the daemon may hold part of that session, and the daemon stops rather
 * than serve it.
 */
class StartupSessionPublicationError extends AggregateError {
  readonly rolledBack: boolean;

  constructor(
    runId: string,
    primary: unknown,
    cleanupErrors: readonly unknown[],
  ) {
    super(
      [primary, ...cleanupErrors],
      [
        `startup restore publication failed for run ${runId}: ${formatCleanupError(primary)}`,
        ...cleanupErrors.map(
          (cleanupError) =>
            `rollback also failed: ${formatCleanupError(cleanupError)}`,
        ),
      ].join("; "),
      { cause: primary },
    );
    this.name = "StartupSessionPublicationError";
    this.rolledBack = cleanupErrors.length === 0;
  }
}


/**
 * Rebuild one recovered session's runtime, then publish the session and its
 * agent. A rebuild that fails still publishes them, without a runtime, as it
 * always did. A publication that fails is rolled back and reported with
 * {@link StartupSessionPublicationError}.
 */
async function restoreAndPublishRecoveredRun(
  sessionManager: AgenCDaemonSessionManager,
  agentManager: AgenCDaemonAgentManager,
  runner: AgenCBackgroundAgentRunner,
  report: DaemonStartupRecoveryReport,
  run: RecoveredAgentRun,
  context: StartupSessionRestoreContext,
  options: {
    readonly recordReplayToolResult?: (
      result: RecoveredReplayToolResult,
    ) => void | Promise<void>;
    readonly onResumeSourceCloseError?: (error: unknown) => void;
  } = {},
): Promise<"published" | "unavailable"> {
  let runtimeRestore: StartupRuntimeRestore;
  try {
    runtimeRestore = await restoreRecoveredAgentRuntime(runner, run, {
      ...options,
      signal: context.signal,
    });
  } catch (error) {
    // Every path restoreRecoveredAgentRuntime reaches closes the run's resume
    // source itself. This covers a failure before it could, so the pinned
    // rollout does not stay held while a client resumes the session.
    try {
      run.resumeSource?.close();
    } catch (closeError) {
      options.onResumeSourceCloseError?.(closeError);
    }
    throw error;
  }
  if (context.signal.aborted || !context.beginPublication()) {
    // Shutdown aborted this restore, or stopped waiting for it and has
    // suspended the daemon's sessions, or is about to. Nothing is published
    // then, so a runtime it still rebuilt is retired instead.
    if (runtimeRestore.restoreAttemptId !== undefined) {
      await runner.rollbackRestoredAgent?.(
        run.id,
        runtimeRestore.restoreAttemptId,
      );
    }
    throw new StartupSessionRestoreAbandonedError();
  }
  await publishRecoveredAgentRun(
    sessionManager,
    agentManager,
    runner,
    report,
    run,
    runtimeRestore,
  );
  return runtimeRestore.available ? "published" : "unavailable";
}


function recordStartupReplayToolResult(
  snapshotPolicies: AgenCDaemonSnapshotPolicyRegistry,
  result: RecoveredReplayToolResult,
): void {
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
  });
  // A recovery outcome is written at once. The replay or poison of a stale
  // tool call is a startup event, not part of a live tool burst: the latest
  // snapshot must show it the moment the call's in-flight row turns terminal,
  // not after the coalesce window.
  snapshotPolicies.flushSession(result.sessionId);
}


function describeStartupSessionRestoreSettlement(
  settled: StartupSessionRestoreSettlement<StartupSessionRestoreRunTarget>,
): string {
  const { run } = settled.target;
  return (
    `startup session restore ${settled.order}/${settled.total} ` +
    `${settled.outcome}: run ${run.id}` +
    (run.currentSessionId !== undefined
      ? ` session ${run.currentSessionId}`
      : "") +
    ` in ${settled.durationMs}ms` +
    (settled.requested ? " (requested)" : "")
  );
}


function reportStartupSessionRestoreSummary(
  host: Pick<AgenCDaemonCliHost, "env">,
  io: AgenCDaemonCliIo,
  startupStartedAt: number,
  summary: StartupSessionRestoreSummary,
): void {
  if (summary.abandoned > 0) {
    writeAgenCDaemonStartupDebug(
      host,
      io,
      startupStartedAt,
      "startup session restore stopped",
    );
    io.stderr.write(
      `agenc: daemon shutdown stopped restoring the sessions open at its last shutdown; ` +
        `${summary.abandoned} of ${summary.total} were not restored and will be at the next start\n`,
    );
    return;
  }
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "startup session restore complete",
  );
  if (summary.total === 0) return;
  io.stderr.write(
    `agenc: daemon restored ${summary.total} session(s) open at its last shutdown ` +
      `in ${summary.elapsedMs}ms: ${summary.published} with a live runtime, ` +
      `${summary.unavailable} without one, ${summary.failed} not published\n`,
  );
}


async function publishRecoveredAgentRun(
  sessionManager: AgenCDaemonSessionManager,
  agentManager: AgenCDaemonAgentManager,
  runner: AgenCBackgroundAgentRunner,
  report: DaemonStartupRecoveryReport,
  run: RecoveredAgentRun,
  runtimeRestore: StartupRuntimeRestore,
): Promise<void> {
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
    throw new StartupSessionPublicationError(run.id, error, cleanupErrors);
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
  const runtimeOptions = runtimeOptionsForRecoveredRun(run);
  return {
    ...(typeof run.metadata?.routineId === "string" ? { routineId: run.metadata.routineId } : {}),
    ...(typeof run.metadata?.routineRunId === "string" ? { routineRunId: run.metadata.routineRunId } : {}),
    ...(canonicalSource !== undefined
      ? {
          agentPath: canonicalSource.agentPath,
          canonicalRolloutPath: canonicalSource.rolloutPath,
          canonicalRolloutDev: canonicalSource.rolloutIdentity.dev,
          canonicalRolloutIno: canonicalSource.rolloutIdentity.ino,
        }
      : {}),
    ...(runtimeOptions !== null ? { runtimeOptions, lightMode: runtimeOptions.lightMode === true } : {}),
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


/** @internal Shared startup recovery seam, exported for hermetic regression coverage. */
export async function restoreRecoveredAgentRuntime(
  runner: AgenCBackgroundAgentRunner,
  run: RecoveredAgentRun,
  options: {
    readonly recordReplayToolResult?: (
      result: RecoveredReplayToolResult,
    ) => void | Promise<void>;
    /** Aborts the rebuild; it then fails and the run is unavailable. */
    readonly signal?: AbortSignal;
    /**
     * Reports a failure to close the run's resume source after its rebuild
     * instead of throwing it, which would lose a runtime already rebuilt.
     */
    readonly onResumeSourceCloseError?: (error: unknown) => void;
  } = {},
): Promise<{
  readonly available: boolean;
  readonly restoreAttemptId?: string;
}> {
  const resumeSource = run.resumeSource;
  // Workflow stages own their child adoption and checkpoint resume. Generic
  // conversation restoration must never reopen a user-paused Goal or run hooks.
  if (run.metadata?.kind === "verified-change-workflow") {
    resumeSource?.close();
    return { available: false };
  }
  // Routine invocations are one-shot. Rehydrating their ordinary runtime here
  // would replay tools/startup hooks before the routine owner records interruption.
  if (typeof run.metadata?.routineId === "string" || typeof run.metadata?.routineRunId === "string") {
    resumeSource?.close();
    return { available: false };
  }
  const runtimeOptions = runtimeOptionsForRecoveredRun(run);
  if (!isRecoveredRunRuntimeRestorable(run) || resumeSource === undefined) {
    resumeSource?.close();
    return { available: false };
  }
  const commandEnvironment = readRecoverableCommandEnvironment(
    run.metadata?.commandEnvironment,
  );
  if (runtimeOptions === null || commandEnvironment === undefined) {
    resumeSource.close();
    return { available: false };
  }
  if (runner.restoreAgent === undefined) {
    resumeSource.close();
    return { available: false };
  }
  const initialMessages = recoveredInitialMessages(run.latestSnapshot);
  const replayToolCalls = recoveredReplayToolCalls(run.latestSnapshot);
  const restoreAttemptId = randomUUID();
  let outcome: { readonly available: boolean; readonly restoreAttemptId?: string };
  try {
    const restored = await runner.restoreAgent({
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      agentId: run.id,
      objective: run.objective,
      cwd: resumeSource.cwd,
      resumeRolloutPath: resumeSource.rolloutPath,
      resumeRolloutLease: resumeSource.rolloutLease,
      resumeCwdIdentity: resumeSource.cwdIdentity,
      resumeCwdFd: resumeSource.cwdFd,
      explicitColdResume: true,
      restoreAttemptId,
      runtimeOptions,
      envOverrides: commandEnvironment,
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
      ...optionalAbsoluteMetadataPath(run.metadata, "configPath"),
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
    outcome = restored
      ? { available: true, restoreAttemptId }
      : { available: false };
  } catch {
    outcome = { available: false };
  }
  // The catch above takes every failure, so the source is always closed here.
  // A caller that handles close errors keeps the restore's outcome; without a
  // handler the close error propagates, as it did from the old finally.
  try {
    resumeSource.close();
  } catch (error) {
    if (options.onResumeSourceCloseError === undefined) throw error;
    options.onResumeSourceCloseError(error);
  }
  return outcome;
}


/**
 * Recover the immutable operator inputs recorded with the run. Runs created
 * before this required protocol field cannot be restored safely: substituting
 * the daemon's current environment would silently change shell, hook, temp, or
 * plugin authority after a restart.
 */
function runtimeOptionsForRecoveredRun(
  run: RecoveredAgentRun,
): AgentRuntimeOptions | null {
  const value = run.metadata?.runtimeOptions;
  if (value === undefined) return null;
  try {
    return validateAgentRuntimeOptions(value);
  } catch {
    return null;
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
    run.metadata.agentPath.trim().length > 0 &&
    (run.metadata.configPath === undefined ||
      (typeof run.metadata.configPath === "string" &&
        run.metadata.configPath.trim().length > 0 &&
        isAbsolute(run.metadata.configPath.trim())))
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


function optionalAbsoluteMetadataPath(
  metadata: JsonObject | undefined,
  key: string,
): Record<string, string> {
  const value = metadata?.[key];
  if (typeof value !== "string") return {};
  const trimmed = value.trim();
  return trimmed.length > 0 && isAbsolute(trimmed) ? { [key]: trimmed } : {};
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
      `agenc: daemon recovery excluded ${report.recoveryExclusions.length} run(s) pending operator recovery action (${describeRecoveryExclusionReasons(report.recoveryExclusions)})\n`,
    );
  }
}


/**
 * "deferred recovery_lock_unavailable x3": the count alone sent the Windows
 * diagnosis through the state database, while the reason says at once
 * whether the runs or the platform are at fault.
 */
function describeRecoveryExclusionReasons(
  exclusions: DaemonStartupRecoveryReport["recoveryExclusions"],
): string {
  const counts = new Map<string, number>();
  for (const exclusion of exclusions) {
    const key = `${exclusion.kind} ${exclusion.reasonCode ?? "without a reason code"}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, count]) => `${key} x${count}`)
    .join(", ");
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
    if (vended.kind !== "api-key") {
      throw new Error(
        "realtime provider credential vending returned non-API-key credentials",
      );
    }
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
  const startupStartedAt = Date.now();
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "canonical configuration load started",
  );
  const loadedConfig = await loadCanonicalDaemonConfig({
    env: host.env,
    home: daemonHome,
    onWarn: (message) => io.stderr.write(`${message}\n`),
  });
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "canonical configuration load complete",
  );
  const authBackend = createAuthBackend(loadedConfig.config, {
    agencHome: daemonHome,
    env: host.env,
  });
  writeAgenCDaemonStartupDebug(
    host,
    io,
    startupStartedAt,
    "auth backend constructed",
  );
  return {
    daemonHome,
    config: loadedConfig.config,
    authBackend,
  };
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


export {
  acquireAgenCDaemonLifecycleLock,
  AGENC_DAEMON_PID_MAX_BYTES,
  AGENC_DAEMON_READY_TIMEOUT_MS_ENV,
  AGENC_DAEMON_SPAWN_STDERR_FILENAME,
  AGENC_DAEMON_SPAWN_STDERR_PREVIOUS_FILENAME,
  AGENC_DAEMON_START_MAX_WAIT_MS_ENV,
  AGENC_DAEMON_WEBSOCKET_DEFAULT_HOST,
  AGENC_DAEMON_WEBSOCKET_DEFAULT_PATH,
  AGENC_DAEMON_WEBSOCKET_DEFAULT_PORT,
  AGENC_DAEMON_WEBSOCKET_PORT_ENV,
  type AgenCDaemonCliAction,
  type AgenCDaemonCliCommand,
  type AgenCDaemonCliHost,
  type AgenCDaemonCliIo,
  AgenCDaemonRpcShutdownCoordinator,
  type AgenCDaemonStateDatabaseFootprint,
  type AgenCDaemonWebSocketListenOptions,
  buildAgenCDaemonChildNodeArgs,
  createNodeDaemonCliHost,
  DEFAULT_DAEMON_READY_TIMEOUT_MS,
  DEFAULT_DAEMON_START_MAX_WAIT_MS,
  defaultAgenCDaemonPidPath,
  formatAgenCDaemonCliHelpText,
  formatAgenCDaemonHealthStatsLines,
  formatAgenCDaemonStateDatabasesLine,
  installAgenCDaemonExitDiagnostics,
  installAgenCDaemonLogSink,
  measureAgenCDaemonStateDatabases,
  openDaemonSpawnStderrCapture,
  parseAgenCDaemonCliArgs,
  readAgenCDaemonPid,
  readAgenCDaemonSpawnStderrTail,
  removeAgenCDaemonPid,
  requestAgenCDaemonInstanceIdentity,
  requestAgenCDaemonShutdown,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonHome,
  resolveAgenCDaemonLogPath,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonReadyTimeoutMs,
  resolveAgenCDaemonSnapshotPath,
  resolveAgenCDaemonSocketPath,
  resolveAgenCDaemonSpawnStderrPath,
  resolveAgenCDaemonSpawnStderrPreviousPath,
  resolveAgenCDaemonStartMaxWaitMs,
  resolveAgenCDaemonWebSocketListenOptions,
  resolveSystemNativePeerCredentialAddonPath,
  runAgenCDaemonCli,
  type RunAgenCDaemonCliOptions,
  validateAgenCDaemonWebSocketOrigin,
  withAgenCDaemonLifecycleLock,
  writeAgenCDaemonPid,
} from "./daemon-control.js";
export { ensureAgenCDaemonCookie } from "./transport/auth.js";


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


function readNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed !== undefined && trimmed.length > 0 ? trimmed : undefined;
}
