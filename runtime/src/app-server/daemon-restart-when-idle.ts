/**
 * `agenc daemon restart --when-idle`: move the daemon onto the installed
 * runtime without cutting off work.
 *
 * `agenc update` runs this through the wrapper it just repointed, so the
 * checks, the restart and any later wait all use the new runtime, and a
 * detached start launches the new build. The daemon being replaced is an older
 * build that has none of this code, so every check runs from outside it, over
 * its authenticated control socket, with requests daemons have answered since
 * protocol 1.14 (AgenC 0.19.0).
 *
 * Idle means all of the following (see {@link probeAgenCDaemonIdle}):
 * the daemon reports ready; every agent in `agent.list` is idle (a turn sets
 * `running`); no loaded session has an attached client (TUI, `agenc -p`,
 * Desktop, SDK); no opened session has a sub-agent, an active goal or a
 * running background process; no routine run is active; no remote device is
 * connected; `health.stats` counts no tool call in flight; no other AgenC
 * process runs from an older runtime of this home (an old TUI that is not
 * attached right now would otherwise stop the new daemon on its next session
 * start); and no agent was active in the last {@link AGENC_DAEMON_RESTART_QUIET_MS}.
 *
 * Idle now: the existing restart path, `stop` then `start`. `stop` repeats the
 * whole check under the lifecycle lock immediately before it sends
 * `daemon.shutdown`, and leaves the daemon alone if anything changed. The
 * replacement must then report this runtime's build.
 *
 * One restart at a time: each holds the daemon restart lock from its first
 * look at the daemon until the replacement reported its build, and a waiter
 * holds it for each check, so no restart sees the daemon between another
 * one's stop and spawn (two updates at once). Only a pinned downgrade moves a
 * daemon to an older build, so the newest build wins whatever the order.
 *
 * Busy: one record, `<AGENC_HOME>/daemon-restart-pending.json`, and one
 * detached waiter (`restart --when-idle --wait <token>`). The waiter checks
 * every {@link AGENC_DAEMON_RESTART_POLL_MS}, restarts after two idle checks
 * in a row, and gives up after {@link AGENC_DAEMON_RESTART_MAX_WAIT_MS}. A
 * newer update replaces the record and the older waiter leaves at its next
 * check. A waiter also leaves when the daemon stopped, was replaced (for
 * example by a newer client's build check) or already runs this build.
 * Giving up stops nothing. Outcomes are written to
 * `<AGENC_HOME>/daemon-restart.log`, and how each restart request ended to
 * `<AGENC_HOME>/daemon-restart-results.json` (keyed by the TUI's request id)
 * for a TUI that stopped waiting for it, before the pending record goes.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { order as semverOrder } from "../utils/semver.js";
import { userRuntimeEnvironment } from "../utils/runtimeEnvironment.js";
import { writeDurableAtomicFileSync } from "../utils/durable-atomic-file.js";
import {
  AGENC_DAEMON_STOP_DECLINED_EXIT,
  acquireAgenCDaemonLifecycleLock,
  formatCleanupError,
  isDaemonErrorResponse,
  proveAgenCDaemonCliInstance,
  readAgenCDaemonCookie,
  readAgenCDaemonPid,
  requestAgenCDaemonInstanceIdentity,
  resolveAgenCDaemonCookiePath,
  resolveAgenCDaemonHome,
  resolveAgenCDaemonPidPath,
  resolveAgenCDaemonSocketPath,
  sendAgenCDaemonJsonLineRequests,
  startAgenCDaemon,
  stopAgenCDaemon,
  withAgenCDaemonLifecycleLock,
  type AgenCDaemonShutdownDeclined,
  type AgenCDaemonCliCommand,
  type AgenCDaemonCliHost,
  type AgenCDaemonCliIo,
  type RunAgenCDaemonCliOptions,
} from "./daemon-control.js";
import {
  isAgenCDaemonInstanceIdentity,
  type AgenCDaemonInstanceIdentity,
} from "./daemon-instance-identity.js";
import {
  AGENC_DAEMON_LIFECYCLE_LOCK_FILENAME,
  AGENC_DAEMON_LIFECYCLE_LOCK_LABEL,
  acquireAgenCDaemonRestartLock,
} from "./daemon-lifecycle-lock.js";
import {
  AGENC_DAEMON_RESTART_LOCK_FILENAME,
  AGENC_DAEMON_RESTART_LOCK_FIRST_TRY_MS,
  AGENC_DAEMON_RESTART_LOCK_LABEL,
  AGENC_DAEMON_RESTART_LOCK_WAIT_MS,
  AGENC_DAEMON_RESTART_MAX_WAIT_MS,
  describeAgenCDaemonRestartLockFailure,
  formatAgenCDaemonRestartWait,
  formatAgenCDaemonRestartWaitingLine,
  isLocalSqliteLockBusyTimeout,
} from "./daemon-restart-handoff.js";
import {
  daemonInstanceIdentityFromRuntimeInfo,
  readDaemonRuntimeInfo,
  readDistVersion,
  resolveAgenCDaemonRuntimeInfoPath,
  resolveRuntimePackageRootFromUrl,
} from "./daemon-runtime-info.js";
import {
  DAEMON_AGENT_HARD_STOP_TIMEOUT_MS,
  DAEMON_AGENT_STOP_TIMEOUT_MS,
} from "./operation-deadline.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  JSON_RPC_VERSION,
  type AgenCDaemonResponse,
  type JsonObject,
  type JsonValue,
} from "./protocol/index.js";
import { canConnectToUnixSocket } from "./transport/unix-socket.js";
import { countedAttachments, runningNativeWorkerCount } from "./daemon-idle-check.js";
import {
  AGENC_DAEMON_RESTART_RESULTS_FILENAME,
  addAgenCDaemonRestartResult,
  formatAgenCDaemonRestartOutcome,
  isAgenCDaemonRestartRequestId,
  type AgenCDaemonRestartOutcome,
  type AgenCDaemonRestartResult,
} from "./daemon-restart-outcome.js";
import { acquireLocalSqliteLock } from "../utils/sqlite-lock.js";

export type { AgenCDaemonRestartOutcome } from "./daemon-restart-outcome.js";

/** How often a deferred restart checks the daemon again. */
export const AGENC_DAEMON_RESTART_POLL_MS = 15_000;
/** A deferred restart gives up after this long and changes nothing. */
export { AGENC_DAEMON_RESTART_MAX_WAIT_MS };
/** An agent active more recently than this may still be finishing work. */
export const AGENC_DAEMON_RESTART_QUIET_MS = 15_000;
/** Consecutive idle checks a deferred restart needs before it restarts. */
export const AGENC_DAEMON_RESTART_IDLE_CHECKS = 2;
export const AGENC_DAEMON_RESTART_PENDING_FILENAME = "daemon-restart-pending.json";
export const AGENC_DAEMON_RESTART_LOG_FILENAME = "daemon-restart.log";
/**
 * A waiting process only looks at the restart lock: when another restart
 * holds it, the daemon is being restarted right now, so it checks again later.
 */
const WAITER_RESTART_LOCK_WAIT_MS = 1_000;
const RESTART_LOCK = {
  label: AGENC_DAEMON_RESTART_LOCK_LABEL,
  filename: AGENC_DAEMON_RESTART_LOCK_FILENAME,
} as const;
const LIFECYCLE_LOCK = {
  label: AGENC_DAEMON_LIFECYCLE_LOCK_LABEL,
  filename: AGENC_DAEMON_LIFECYCLE_LOCK_FILENAME,
} as const;
/**
 * `session.processes.list` (1.13) and `session.goal` (1.14) are the newest
 * requests the check needs. Older daemons cannot be shown to be idle.
 */
export const AGENC_DAEMON_RESTART_MIN_PROTOCOL_MINOR = 14;
/** Same allowance the autostart build check gives an old daemon to stop. */
const RESTART_STOP_TIMEOUT_MS =
  DAEMON_AGENT_STOP_TIMEOUT_MS + DAEMON_AGENT_HARD_STOP_TIMEOUT_MS + 5_000;
/** One check request batch; a large home lists hundreds of saved agents. */
const PROBE_BATCH_TIMEOUT_MS = 30_000;
const PROBE_MAX_PAGES = 50;
const AGENT_LIST_PAGE_LIMIT = 500;
const SESSION_LIST_PAGE_LIMIT = 100;
const SESSION_LIST_PERSISTED_CURSOR_PREFIX = "agenc-session-list-v1:";
/** The routine contract that lists routines of every permission mode. */
const ROUTINE_PERMISSION_MODES_CAPABILITY = "routine.permissionModes.v2";
const PROBE_CLIENT_NAME = "agenc-daemon-restart-check";
const PENDING_RECORD_MAX_BYTES = 16 * 1_024;
const LOG_LINE_MAX_CHARS = 1_000;
const ACTIVE_ROUTINE_RUN_STATUSES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "waiting_permission",
]);
/** A session that has no live runtime cannot be running anything. */
const NO_LIVE_RUNTIME_CODES: ReadonlySet<string> = new Set([
  "AGENT_NOT_FOUND",
  "BACKGROUND_RUNNER_UNAVAILABLE",
  "SESSION_NOT_FOUND",
]);

// --- idle check ---------------------------------------------------------------

export type AgenCDaemonIdleVerdict =
  | { readonly idle: true }
  | {
      readonly idle: false;
      readonly reason: string;
      /** The check can never pass for this daemon: waiting cannot help. */
      readonly permanent?: true;
      /** Set when the daemon is too old to stop only when idle. */
      readonly tooOld?: true;
    };

const IDLE: AgenCDaemonIdleVerdict = { idle: true };

function busy(reason: string): AgenCDaemonIdleVerdict {
  return { idle: false, reason };
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The fields of an `agent.list` entry the check reads. */
export interface AgenCDaemonProbeAgent {
  readonly agentId?: string;
  readonly status: string;
  readonly lastActiveAt?: string;
}

/**
 * The client that asked for the restart (a TUI updating itself). Its own
 * conversation does not hold the restart up: neither its attachment nor its
 * recent activity counts, and neither does its process. Work still does: a
 * running turn, sub-agent, goal or tool keeps its daemon busy.
 */
export interface AgenCDaemonRestartRequester {
  readonly pid: number;
  /** The requester's conversation (the agent id it would resume). */
  readonly agentId?: string;
  /**
   * The requester's own attachments, as it reported them. Only these ids, and
   * only on its own conversation, are exempt; any other client on the same
   * conversation (an SDK client following it) still counts.
   */
  readonly attachmentIds?: readonly string[];
}

/** Agents: any non-idle status is work; so is activity within the quiet window. */
export function busyReasonFromAgents(
  agents: readonly AgenCDaemonProbeAgent[],
  nowMs: number,
  quietMs: number,
  requesterAgentId?: string,
): AgenCDaemonIdleVerdict {
  const working = agents.filter((agent) => agent.status !== "idle").length;
  if (working > 0) return busy(`${plural(working, "agent", "agents")} working`);
  let latest = Number.NEGATIVE_INFINITY;
  for (const agent of agents) {
    if (requesterAgentId !== undefined && agent.agentId === requesterAgentId) continue;
    const at = agent.lastActiveAt === undefined ? Number.NaN : Date.parse(agent.lastActiveAt);
    if (Number.isFinite(at) && at > latest) latest = at;
  }
  const sinceMs = nowMs - latest;
  if (sinceMs < quietMs) {
    return busy(`an agent was active ${Math.max(0, Math.round(sinceMs / 1_000))} s ago`);
  }
  return IDLE;
}

/** The fields of a `session.list` entry the check reads. */
export interface AgenCDaemonProbeSession {
  readonly sessionId: string;
  readonly agentId?: string;
  readonly status: string;
  readonly activeAttachmentIds?: readonly string[];
  /** Restore still pending: naming it in a request would restore it. */
  readonly restorePending: boolean;
}

/** Any attached client (TUI, `agenc -p`, Desktop, SDK) keeps the daemon busy. */
export function busyReasonFromSessions(
  sessions: readonly AgenCDaemonProbeSession[],
  exempt?: { readonly attachmentIds: readonly string[]; readonly agentId: string },
): AgenCDaemonIdleVerdict {
  const attached = countedAttachments(sessions, exempt);
  return attached > 0
    ? busy(`${plural(attached, "client", "clients")} attached`)
    : IDLE;
}

/** What one opened session reports about work that outlives a turn. */
export interface AgenCDaemonProbeSessionDetail {
  readonly nativeWorkers: number;
  readonly goalStatus?: string;
  readonly runningProcesses: number;
}

export function busyReasonFromSessionDetail(
  detail: AgenCDaemonProbeSessionDetail,
): AgenCDaemonIdleVerdict {
  if (detail.nativeWorkers > 0) {
    return busy(`${plural(detail.nativeWorkers, "sub-agent", "sub-agents")} running`);
  }
  if (detail.goalStatus === "active") return busy("a goal is active");
  if (detail.runningProcesses > 0) {
    return busy(
      `${plural(detail.runningProcesses, "background process", "background processes")} running`,
    );
  }
  return IDLE;
}

export interface AgenCDaemonProbeServices {
  readonly activeRoutineRuns: number;
  readonly connectedRemoteDevices: number;
  readonly inFlightToolCalls: number;
}

export function busyReasonFromServices(
  services: AgenCDaemonProbeServices,
): AgenCDaemonIdleVerdict {
  if (services.activeRoutineRuns > 0) {
    return busy(`${plural(services.activeRoutineRuns, "routine", "routines")} running`);
  }
  if (services.connectedRemoteDevices > 0) {
    return busy(
      `${plural(services.connectedRemoteDevices, "remote device", "remote devices")} connected`,
    );
  }
  if (services.inFlightToolCalls > 0) {
    return busy(`${plural(services.inFlightToolCalls, "tool call", "tool calls")} in flight`);
  }
  return IDLE;
}

// --- other AgenC processes ------------------------------------------------------

export interface AgenCProcessEntry {
  readonly pid: number;
  readonly ppid: number;
  readonly uid: number;
  readonly command: string;
}

/** Parse `ps -A -ww -o pid=,ppid=,uid=,args=` output. */
export function parseAgenCProcessList(output: string): AgenCProcessEntry[] {
  const entries: AgenCProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null) continue;
    entries.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      uid: Number(match[3]),
      command: match[4]!,
    });
  }
  return entries;
}

export interface AgenCRuntimeClientScan {
  readonly entries: readonly AgenCProcessEntry[];
  readonly selfPid: number;
  readonly uid: number;
  readonly daemonPid: number;
  /** `<AGENC_HOME>/runtime/`, in every spelling the home has (link and real path). */
  readonly homeRuntimeRoots: readonly string[];
  /**
   * This runtime's install tree (`<AGENC_HOME>/runtime/<version>/<tree>`);
   * processes that run from it are not older clients.
   */
  readonly ownRuntimeTree?: string;
  /** The TUI that asked for the restart; it follows on its own. */
  readonly requesterPid?: number;
}

function ancestorsOf(pid: number, parents: ReadonlyMap<number, number>): Set<number> {
  const seen = new Set<number>();
  let current = parents.get(pid);
  while (current !== undefined && current > 1 && !seen.has(current)) {
    seen.add(current);
    current = parents.get(current);
  }
  return seen;
}

function descendantsOf(
  pid: number,
  entries: readonly AgenCProcessEntry[],
): Set<number> {
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const found = new Set<number>();
  const queue = [...(children.get(pid) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (found.has(next)) continue;
    found.add(next);
    queue.push(...(children.get(next) ?? []));
  }
  return found;
}

/**
 * AgenC processes of this home that still run another runtime: an older TUI,
 * `agenc -p` or CLI. The daemon itself, its descendants (its own tools), this
 * process and its parents (the updater that started it) are not counted, nor
 * is a second foreground daemon.
 */
export function findOtherAgenCRuntimeClients(scan: AgenCRuntimeClientScan): number[] {
  const parents = new Map(scan.entries.map((entry) => [entry.pid, entry.ppid]));
  const ancestors = ancestorsOf(scan.selfPid, parents);
  const daemonDescendants = descendantsOf(scan.daemonPid, scan.entries);
  const ownTree = scan.ownRuntimeTree === undefined ? undefined : `${scan.ownRuntimeTree}/`;
  return scan.entries
    .filter((entry) =>
      entry.uid === scan.uid &&
      entry.pid !== scan.selfPid &&
      entry.pid !== scan.requesterPid &&
      entry.pid !== scan.daemonPid &&
      !ancestors.has(entry.pid) &&
      !daemonDescendants.has(entry.pid) &&
      scan.homeRuntimeRoots.some((root) => entry.command.includes(root)) &&
      (ownTree === undefined || !entry.command.includes(ownTree)) &&
      !/\sdaemon\s+start\s+--foreground(?:\s|$)/.test(entry.command))
    .map((entry) => entry.pid);
}

const LABELLED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "update", "daemon", "run", "mcp", "gateway", "remote",
]);

/**
 * `agenc` plus its first flag or a known subcommand, for a busy reason. A
 * command line can hold a prompt, so nothing else from it is ever shown.
 */
export function agenCCommandLabel(command: string): string {
  const first = /\/bin\/agenc(?:\.js)?\s+(\S+)/.exec(command)?.[1];
  if (first === undefined) return "agenc";
  if (/^-{1,2}[a-z][a-z-]{0,30}$/.test(first) || LABELLED_SUBCOMMANDS.has(first)) {
    return `agenc ${first}`;
  }
  return "agenc";
}

export interface LinuxProcReaders {
  readonly listPids: () => readonly string[];
  readonly readText: (path: string) => string;
  readonly readLink: (path: string) => string;
}

const LINUX_PROC_MAX_ENTRIES = 16_384;

const nodeLinuxProcReaders: LinuxProcReaders = {
  listPids: () => readdirSync("/proc").filter((name) => /^\d+$/.test(name)),
  readText: (path) => readFileSync(path, "utf8"),
  readLink: (path) => readlinkSync(path),
};

/**
 * The process list from /proc. AgenC sets its process title on Linux, which
 * rewrites /proc/<pid>/cmdline to "agenc", so each command starts with the
 * executable path (the runtime's private Node inside its install tree).
 */
export function listLinuxAgenCProcesses(
  readers: LinuxProcReaders = nodeLinuxProcReaders,
): AgenCProcessEntry[] | null {
  let pids: readonly string[];
  try {
    pids = readers.listPids();
  } catch {
    return null;
  }
  if (pids.length > LINUX_PROC_MAX_ENTRIES) return null;
  const entries: AgenCProcessEntry[] = [];
  for (const pid of pids) {
    try {
      const status = readers.readText(`/proc/${pid}/status`);
      const ppid = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
      const uid = /^Uid:\s+(\d+)/m.exec(status)?.[1];
      if (ppid === undefined || uid === undefined) continue;
      let exe = "";
      try {
        exe = readers.readLink(`/proc/${pid}/exe`);
      } catch {
        // Kernel threads and other users' processes have no readable exe.
      }
      const args = readers.readText(`/proc/${pid}/cmdline`).replaceAll("\0", " ").trim();
      entries.push({
        pid: Number(pid),
        ppid: Number(ppid),
        uid: Number(uid),
        command: `${exe} ${args}`.trim(),
      });
    } catch {
      // The process exited while it was being read.
    }
  }
  return entries;
}

/** The running process list, or null when it cannot be read. */
export function listAgenCProcesses(
  platform: NodeJS.Platform = process.platform,
): AgenCProcessEntry[] | null {
  if (platform === "linux") return listLinuxAgenCProcesses();
  if (platform !== "darwin") return null;
  const result = spawnSync("/bin/ps", ["-A", "-ww", "-o", "pid=,ppid=,uid=,args="], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 32 * 1_024 * 1_024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && typeof result.stdout === "string"
    ? parseAgenCProcessList(result.stdout)
    : null;
}

/**
 * A Homebrew keg keeps its runtime in `<prefix>/Cellar/agenc/<version>/`, and
 * its service runs `<prefix>/opt/agenc/`. When this runtime is such a keg,
 * those are this install's runtime roots too, next to the home's.
 */
export function homebrewAgenCRuntimeRoots(packageRoot: string | null): string[] {
  if (packageRoot === null) return [];
  const match = /^(.*)\/Cellar\/agenc\/[^/]+\//.exec(`${packageRoot}/`);
  return match === null ? [] : [`${match[1]}/Cellar/agenc/`, `${match[1]}/opt/agenc/`];
}

function defaultInstallRuntimeRoots(): string[] {
  return homebrewAgenCRuntimeRoots(resolveRuntimePackageRootFromUrl(import.meta.url));
}

/** Spellings of `<home>/runtime/` that a process command line can carry. */
export function agenCHomeRuntimeRoots(home: string): string[] {
  const roots = new Set([`${join(home, "runtime")}/`]);
  try {
    roots.add(`${join(realpathSync(home), "runtime")}/`);
  } catch {
    // The home path as given is the only spelling.
  }
  return [...roots];
}

// --- control socket requests ----------------------------------------------------

export class AgenCDaemonProbeError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "AgenCDaemonProbeError";
    this.code = code;
  }
}

interface ProbeRequest {
  readonly method: string;
  readonly params?: JsonObject;
}

interface ProbeBatchResult {
  readonly initialize: JsonObject;
  readonly results: readonly JsonObject[];
}

function protocolMinor(version: unknown): number | undefined {
  if (typeof version !== "string") return undefined;
  const match = /^1\.(\d+)(?:\.\d+)?$/.exec(version);
  return match === null ? undefined : Number(match[1]);
}

const OWN_PROTOCOL_MINOR = protocolMinor(AGENC_DAEMON_PROTOCOL_VERSION) ?? 0;

function errorCodeOf(response: AgenCDaemonResponse): string | undefined {
  if (!isDaemonErrorResponse(response)) return undefined;
  const data = response.error.data as JsonObject | undefined;
  return typeof data?.code === "string" ? data.code : undefined;
}

/**
 * Send `initialize` and then `requests` on one authenticated connection. The
 * connection must belong to the expected daemon instance before anything
 * else is sent.
 */
/** The daemon refused, or the last check before `daemon.shutdown` found work. */
class ShutdownDeclined extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "ShutdownDeclined";
  }
}

/**
 * Stop the daemon only if it is idle, deciding as late as possible: the
 * daemon itself checks with `daemon.shutdownIfIdle`, holding every new
 * request meanwhile, so nothing can start between its check and its
 * decision. A daemon without that method is never stopped here.
 *
 * Anything short of an explicit decision (a reset, a timeout, a closed
 * connection) is a refusal to retry later, never a failed shutdown: the stop
 * path must not escalate to a signal for a daemon that never accepted.
 */
export async function requestAgenCDaemonShutdownWhenIdle(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
  expected: AgenCDaemonInstanceIdentity,
  /** The live requester's own attachments, checked by the daemon. */
  exempt?: { readonly attachmentIds: readonly string[]; readonly agentId: string },
): Promise<AgenCDaemonShutdownDeclined | void> {
  const request = (id: number, method: string, params: JsonObject = {}): JsonObject => ({
    jsonrpc: JSON_RPC_VERSION,
    id,
    method,
    params,
  });
  let responses: readonly AgenCDaemonResponse[];
  let tooOld = false;
  try {
    const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
    const authCookie = await readAgenCDaemonCookie(
      resolveAgenCDaemonCookiePath(host.env, host.userHome),
    );
    const messages: JsonObject[] = [
      request(1, "initialize", {
        protocolVersion: "1.0.0",
        protocol: { version: "1.0.0" },
        clientName: PROBE_CLIENT_NAME,
        authCookie,
        capabilities: {},
      }),
      request(2, "daemon.shutdownIfIdle", {
        instanceId: expected.instanceId,
        ...(exempt === undefined
          ? {}
          : { exemptAttachmentIds: [...exempt.attachmentIds], requesterAgentId: exempt.agentId }),
      }),
    ];
    responses = await sendAgenCDaemonJsonLineRequests(socketPath, PROBE_BATCH_TIMEOUT_MS, messages, (response, index) => {
      if (index !== 0) return;
      const result = (response as { readonly result?: JsonObject }).result;
      const identity = result?.daemonIdentity;
      if (!isAgenCDaemonInstanceIdentity(identity) || identity.instanceId !== expected.instanceId) {
        throw new ShutdownDeclined("the daemon was replaced");
      }
      const methods = objectOf(objectOf(result?.capabilities)?.["daemon.methods"]);
      if (methods?.["daemon.shutdownIfIdle"] !== true) {
        tooOld = true;
        throw new ShutdownDeclined(
          `the daemon runs AgenC ${expected.runtimeVersion}, which cannot stop only when idle (that starts with 0.19.25)`,
        );
      }
    });
  } catch (error) {
    if (error instanceof ShutdownDeclined) {
      return { declined: error.reason, ...(tooOld ? { permanent: true, tooOld: true } : {}) };
    }
    return { declined: `the daemon did not answer the restart check (${formatCleanupError(error)}); it is checked again later` };
  }
  const last = responses[responses.length - 1];
  if (last === undefined || responses.length !== 2) {
    return { declined: "the daemon closed the connection before deciding; it is checked again later" };
  }
  if (isDaemonErrorResponse(last)) return { declined: last.error.message };
  const result = objectOf((last as { readonly result?: JsonValue }).result);
  if (result?.shuttingDown !== true || result.instanceId !== expected.instanceId) {
    return { declined: stringOf(result?.reason) ?? "the daemon is busy" };
  }
}

export async function requestAgenCDaemonProbeBatch(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
  expectedInstanceId: string,
  protocolVersion: string,
  requests: readonly ProbeRequest[],
): Promise<ProbeBatchResult> {
  const socketPath = resolveAgenCDaemonSocketPath(host.env, host.userHome);
  const authCookie = await readAgenCDaemonCookie(
    resolveAgenCDaemonCookiePath(host.env, host.userHome),
  );
  const messages = [
    {
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion,
        protocol: { version: protocolVersion },
        clientName: PROBE_CLIENT_NAME,
        authCookie,
        capabilities: { [ROUTINE_PERMISSION_MODES_CAPABILITY]: true },
      },
    },
    ...requests.map((request, index) => ({
      jsonrpc: JSON_RPC_VERSION,
      id: index + 2,
      method: request.method,
      params: request.params ?? {},
    })),
  ];
  const responses = await sendAgenCDaemonJsonLineRequests(
    socketPath,
    PROBE_BATCH_TIMEOUT_MS,
    messages,
    (response, index) => {
      if (index !== 0) return;
      const identity = (response as { readonly result?: JsonObject }).result?.daemonIdentity;
      if (
        !isAgenCDaemonInstanceIdentity(identity) ||
        identity.instanceId !== expectedInstanceId
      ) {
        throw new AgenCDaemonProbeError("the daemon was replaced during the check", "DAEMON_REPLACED");
      }
    },
  );
  const results: JsonObject[] = [];
  for (const [index, response] of responses.entries()) {
    const method = index === 0 ? "initialize" : requests[index - 1]!.method;
    if (response.id !== index + 1) {
      throw new AgenCDaemonProbeError(`${method} answered out of order`);
    }
    if (isDaemonErrorResponse(response)) {
      throw new AgenCDaemonProbeError(
        `${method} failed: ${response.error.message}`,
        errorCodeOf(response),
      );
    }
    const result = (response as { readonly result?: JsonValue }).result;
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new AgenCDaemonProbeError(`${method} returned no result`);
    }
    results.push(result as JsonObject);
  }
  if (results.length !== messages.length) {
    throw new AgenCDaemonProbeError("the daemon closed the check before answering");
  }
  // A batch of initialize alone never reaches the hook above.
  const identity = results[0]!.daemonIdentity;
  if (!isAgenCDaemonInstanceIdentity(identity) || identity.instanceId !== expectedInstanceId) {
    throw new AgenCDaemonProbeError("the daemon was replaced during the check", "DAEMON_REPLACED");
  }
  return { initialize: results[0]!, results: results.slice(1) };
}

export type AgenCDaemonProbeBatch = typeof requestAgenCDaemonProbeBatch;

function arrayOf(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : [];
}

function objectOf(value: JsonValue | undefined): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringOf(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toProbeAgent(value: JsonValue): AgenCDaemonProbeAgent & {
  readonly sessionIds: readonly string[];
} {
  const agent = objectOf(value) ?? {};
  const lastActiveAt = stringOf(agent.lastActiveAt);
  const agentId = stringOf(agent.agentId);
  return {
    ...(agentId === undefined ? {} : { agentId }),
    // An entry without a status cannot be shown to be idle.
    status: stringOf(agent.status) ?? "unknown",
    ...(lastActiveAt === undefined ? {} : { lastActiveAt }),
    sessionIds: arrayOf(agent.activeSessionIds).filter(
      (id): id is string => typeof id === "string",
    ),
  };
}

function toProbeSession(value: JsonValue): AgenCDaemonProbeSession {
  const session = objectOf(value) ?? {};
  const recovery = objectOf(objectOf(session.metadata)?.recovery);
  const agentId = stringOf(session.agentId);
  return {
    sessionId: stringOf(session.sessionId) ?? "",
    ...(agentId === undefined ? {} : { agentId }),
    status: stringOf(session.status) ?? "unknown",
    activeAttachmentIds: arrayOf(session.activeAttachmentIds).filter(
      (id): id is string => typeof id === "string",
    ),
    restorePending: recovery?.loaded === false,
  };
}

export interface AgenCDaemonProbeOptions {
  readonly nowMs?: () => number;
  readonly quietMs?: number;
  readonly requestBatch?: AgenCDaemonProbeBatch;
  /** Null when the process list cannot be read (then the daemon counts as busy). */
  readonly listProcesses?: () => readonly AgenCProcessEntry[] | null;
  readonly selfPid?: number;
  readonly uid?: number;
  /** This runtime's install tree; see {@link AgenCRuntimeClientScan}. */
  readonly ownRuntimeTree?: string;
  /** A live requester; see {@link AgenCDaemonRestartRequester}. */
  readonly requester?: AgenCDaemonRestartRequester;
  /** Runtime roots of this install besides the home's (a Homebrew keg). */
  readonly installRuntimeRoots?: readonly string[];
}

/**
 * Check whether the daemon `expected` names is idle. Checks run from cheap to
 * expensive and stop at the first sign of work. Anything that cannot be read
 * counts as busy.
 */
export async function probeAgenCDaemonIdle(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome" | "pid">,
  expected: AgenCDaemonInstanceIdentity,
  options: AgenCDaemonProbeOptions = {},
): Promise<AgenCDaemonIdleVerdict> {
  try {
    return await probeAgenCDaemonIdleOrThrow(host, expected, options);
  } catch (error) {
    if (error instanceof AgenCDaemonProbeError && error.code === "DAEMON_REPLACED") {
      return busy("the daemon was replaced during the check");
    }
    if (error instanceof AgenCDaemonProbeError && error.code === "PROTOCOL_TOO_OLD") {
      return { idle: false, reason: error.message, permanent: true, tooOld: true };
    }
    return busy(`the check could not finish: ${formatCleanupError(error)}`);
  }
}

async function probeAgenCDaemonIdleOrThrow(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome" | "pid">,
  expected: AgenCDaemonInstanceIdentity,
  options: AgenCDaemonProbeOptions,
): Promise<AgenCDaemonIdleVerdict> {
  const request = options.requestBatch ?? requestAgenCDaemonProbeBatch;
  const nowMs = options.nowMs ?? Date.now;
  const quietMs = options.quietMs ?? AGENC_DAEMON_RESTART_QUIET_MS;
  const selfPid = options.selfPid ?? host.pid;
  const requesterAgentId = options.requester?.agentId;
  const exempt = requesterExemption(options.requester);

  // 1. Negotiate the newest protocol both sides speak.
  const first = await request(host, expected.instanceId, "1.0.0", []);
  const serverMinor = protocolMinor(first.initialize.protocolVersion);
  if (serverMinor === undefined || serverMinor < AGENC_DAEMON_RESTART_MIN_PROTOCOL_MINOR) {
    throw new AgenCDaemonProbeError(
      `daemon protocol ${String(first.initialize.protocolVersion)} is too old to check`,
      "PROTOCOL_TOO_OLD",
    );
  }
  const version = `1.${Math.min(serverMinor, OWN_PROTOCOL_MINOR)}.0`;

  // 2. Turns, attachments and readiness.
  const core = await request(host, expected.instanceId, version, [
    { method: "health.ready" },
    { method: "agent.list", params: { limit: AGENT_LIST_PAGE_LIMIT } },
    { method: "session.list", params: { limit: SESSION_LIST_PAGE_LIMIT } },
  ]);
  if (objectOf(core.results[0])?.ready !== true) {
    return busy("the daemon is starting or stopping");
  }
  const methods = objectOf(objectOf(core.initialize.capabilities)?.["daemon.methods"]) ?? {};
  // Only a daemon that decides itself, holding new work while it checks, is
  // ever restarted automatically. An older one keeps running for a manual
  // restart: a client could start work between any outside check and stop.
  if (methods["daemon.shutdownIfIdle"] !== true) {
    throw new AgenCDaemonProbeError(
      `the daemon runs AgenC ${expected.runtimeVersion}, which cannot stop only when idle (that starts with 0.19.25)`,
      "PROTOCOL_TOO_OLD",
    );
  }
  const agents = arrayOf(core.results[1]?.agents).map(toProbeAgent);
  let agentCursor = stringOf(core.results[1]?.nextCursor);
  const sessions = arrayOf(core.results[2]?.sessions).map(toProbeSession);
  let sessionCursor = stringOf(core.results[2]?.nextCursor);
  // Attachments first: an open TUI reads as a client, which is what a person
  // sees, even though its unused session also lists its agent as running.
  let verdict = busyReasonFromSessions(sessions, exempt);
  if (!verdict.idle) return verdict;
  verdict = busyReasonFromAgents(agents, nowMs(), quietMs, requesterAgentId);
  if (!verdict.idle) return verdict;
  for (let page = 1; agentCursor !== undefined; page += 1) {
    if (page >= PROBE_MAX_PAGES) return busy("too many agents to check");
    const next = await request(host, expected.instanceId, version, [
      { method: "agent.list", params: { limit: AGENT_LIST_PAGE_LIMIT, cursor: agentCursor } },
    ]);
    const pageAgents = arrayOf(next.results[0]?.agents).map(toProbeAgent);
    verdict = busyReasonFromAgents(pageAgents, nowMs(), quietMs, requesterAgentId);
    if (!verdict.idle) return verdict;
    agents.push(...pageAgents);
    agentCursor = stringOf(next.results[0]?.nextCursor);
  }
  // Loaded sessions come first; saved ones on disk (persisted cursor) never
  // carry an attachment.
  for (
    let page = 1;
    sessionCursor !== undefined &&
    !sessionCursor.startsWith(SESSION_LIST_PERSISTED_CURSOR_PREFIX);
    page += 1
  ) {
    if (page >= PROBE_MAX_PAGES) return busy("too many sessions to check");
    const next = await request(host, expected.instanceId, version, [
      { method: "session.list", params: { limit: SESSION_LIST_PAGE_LIMIT, cursor: sessionCursor } },
    ]);
    const pageSessions = arrayOf(next.results[0]?.sessions).map(toProbeSession);
    verdict = busyReasonFromSessions(pageSessions, exempt);
    if (!verdict.idle) return verdict;
    sessions.push(...pageSessions);
    sessionCursor = stringOf(next.results[0]?.nextCursor);
  }

  // 3. Routines, remote devices and tool calls in flight.
  const serviceRequests: ProbeRequest[] = [{ method: "health.stats" }];
  if (methods["routine.list"] === true) serviceRequests.push({ method: "routine.list" });
  if (methods["remote.status"] === true) serviceRequests.push({ method: "remote.status" });
  const services = await request(host, expected.instanceId, version, serviceRequests);
  const stats = objectOf(services.results[0]?.state);
  const routines = methods["routine.list"] === true
    ? arrayOf(services.results[1]?.routines)
    : [];
  const remote = methods["remote.status"] === true
    ? services.results[services.results.length - 1]
    : undefined;
  verdict = busyReasonFromServices({
    activeRoutineRuns: routines.filter((routine) => {
      const status = stringOf(objectOf(objectOf(routine)?.lastRun)?.status);
      return status !== undefined && ACTIVE_ROUTINE_RUN_STATUSES.has(status);
    }).length,
    connectedRemoteDevices:
      typeof remote?.connectedDevices === "number" ? remote.connectedDevices : 0,
    inFlightToolCalls:
      typeof stats?.inFlightToolCalls === "number" ? stats.inFlightToolCalls : 0,
  });
  if (!verdict.idle) return verdict;

  // 4. Sub-agents, goals and background processes of each opened session.
  // A session whose restore is still pending is never named: naming it would
  // restore it, and nothing runs in it until then.
  const opened = new Set(
    sessions
      .filter((session) =>
        session.sessionId.length > 0 &&
        !session.restorePending &&
        session.status !== "closed")
      .map((session) => session.sessionId),
  );
  const agentSessions = new Set(agents.flatMap((agent) => agent.sessionIds));
  for (const sessionId of opened) {
    if (!agentSessions.has(sessionId)) continue;
    const detailRequests: ProbeRequest[] = [
      { method: "session.snapshot", params: { sessionId } },
    ];
    if (methods["session.goal"] === true) {
      detailRequests.push({ method: "session.goal", params: { sessionId, action: "get" } });
    }
    if (methods["session.processes.list"] === true) {
      detailRequests.push({ method: "session.processes.list", params: { sessionId } });
    }
    let detail: ProbeBatchResult;
    try {
      detail = await request(host, expected.instanceId, version, detailRequests);
    } catch (error) {
      if (
        error instanceof AgenCDaemonProbeError &&
        error.code !== undefined &&
        NO_LIVE_RUNTIME_CODES.has(error.code)
      ) {
        continue;
      }
      throw error;
    }
    let index = 0;
    const snapshot = detail.results[index++];
    const goal = methods["session.goal"] === true ? detail.results[index++] : undefined;
    const processesResult = methods["session.processes.list"] === true
      ? detail.results[index++]
      : undefined;
    const goalStatus = stringOf(objectOf(goal?.goal)?.status);
    verdict = busyReasonFromSessionDetail({
      nativeWorkers: runningNativeWorkerCount(snapshot?.nativeWorkers),
      ...(goalStatus === undefined ? {} : { goalStatus }),
      runningProcesses: arrayOf(processesResult?.processes).filter(
        (entry) => stringOf(objectOf(entry)?.status) === "running",
      ).length,
    });
    if (!verdict.idle) return verdict;
  }

  // 5. Older AgenC processes of this home, read locally. An older TUI that
  // is not attached right now would stop the new daemon at its next session
  // start, because its build check sees a different build.
  const processes = (options.listProcesses ?? listAgenCProcesses)();
  if (processes === null) return busy("the process list could not be read");
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  const ancestors = ancestorsOf(selfPid, new Map(processes.map((entry) => [entry.pid, entry.ppid])));
  if (ancestors.has(expected.pid)) {
    // Stopping the daemon would end this process with it.
    return busy("the update runs inside a daemon session");
  }
  const others = findOtherAgenCRuntimeClients({
    entries: processes,
    selfPid,
    uid: options.uid ?? process.getuid?.() ?? -1,
    daemonPid: expected.pid,
    homeRuntimeRoots: [...agenCHomeRuntimeRoots(daemonHome), ...(options.installRuntimeRoots ?? [])],
    ...(options.ownRuntimeTree === undefined ? {} : { ownRuntimeTree: options.ownRuntimeTree }),
    ...(options.requester === undefined ? {} : { requesterPid: options.requester.pid }),
  });
  if (others.length > 0) {
    const first = processes.find((entry) => entry.pid === others[0]);
    return busy(
      `an older AgenC process is still running (pid ${others[0]}, ${agenCCommandLabel(first?.command ?? "")}` +
        `${others.length > 1 ? ` and ${others.length - 1} more` : ""})`,
    );
  }
  return IDLE;
}

// --- daemon state ------------------------------------------------------------------

export type AgenCDaemonRestartState =
  | { readonly kind: "not-running" }
  | { readonly kind: "unproven"; readonly reason: string }
  | { readonly kind: "running"; readonly identity: AgenCDaemonInstanceIdentity };

/** Which daemon serves this home, proven by its authenticated identity. */
export async function readAgenCDaemonRestartState(
  host: AgenCDaemonCliHost,
  options: Pick<RunAgenCDaemonCliOptions, "requestDaemonInstanceIdentity"> = {},
): Promise<AgenCDaemonRestartState> {
  const pidPath = resolveAgenCDaemonPidPath(host.env, host.userHome);
  const runtimeInfoPath = resolveAgenCDaemonRuntimeInfoPath(dirname(pidPath));
  const runtimeInfo = readDaemonRuntimeInfo(runtimeInfoPath);
  const recorded = daemonInstanceIdentityFromRuntimeInfo(runtimeInfo);
  if (recorded !== null && host.isPidRunning(recorded.pid)) {
    try {
      const bound = await proveAgenCDaemonCliInstance(
        host,
        recorded.pid,
        runtimeInfoPath,
        options.requestDaemonInstanceIdentity,
      );
      return { kind: "running", identity: bound.identity };
    } catch (error) {
      return {
        kind: "unproven",
        reason: `the daemon (pid ${recorded.pid}) could not be verified: ${formatCleanupError(error)}`,
      };
    }
  }
  const pid = await readAgenCDaemonPid(pidPath);
  if (
    (pid !== null && host.isPidRunning(pid)) ||
    (runtimeInfo !== null && host.isPidRunning(runtimeInfo.pid))
  ) {
    return { kind: "unproven", reason: "a daemon is running without a verified identity" };
  }
  if (await canConnectToUnixSocket(resolveAgenCDaemonSocketPath(host.env, host.userHome))) {
    return { kind: "unproven", reason: "a daemon is answering without a verified identity" };
  }
  return { kind: "not-running" };
}

export interface AgenCRuntimeBuild {
  readonly runtimeVersion: string;
  readonly commit: string;
  readonly buildTime: string;
}

function sameBuild(identity: AgenCRuntimeBuild, build: AgenCRuntimeBuild): boolean {
  return identity.runtimeVersion === build.runtimeVersion &&
    identity.commit === build.commit &&
    identity.buildTime === build.buildTime;
}

/**
 * Order two builds: by version, then (same version, a rebuild) by build time.
 * Undefined when that cannot be told, for example an unparsable version.
 */
export function compareAgenCRuntimeBuilds(
  left: AgenCRuntimeBuild,
  right: AgenCRuntimeBuild,
): -1 | 0 | 1 | undefined {
  let byVersion: -1 | 0 | 1;
  try {
    byVersion = semverOrder(left.runtimeVersion, right.runtimeVersion);
  } catch {
    return undefined;
  }
  if (byVersion !== 0) return byVersion;
  const leftTime = Date.parse(left.buildTime);
  const rightTime = Date.parse(right.buildTime);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return undefined;
  return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
}

/**
 * The daemon's executable and command line, or null when they cannot be
 * read. On Linux the command line is the process title, so the executable
 * path carries the install tree.
 */
export function readAgenCProcessCommand(
  pid: number,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (platform === "linux") {
    try {
      const exe = readlinkSync(`/proc/${pid}/exe`);
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
      return `${exe} ${args}`.trim();
    } catch {
      return null;
    }
  }
  if (platform !== "darwin") return null;
  const result = spawnSync("/bin/ps", ["-ww", "-o", "args=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 && typeof result.stdout === "string"
    ? result.stdout.trim()
    : null;
}

// --- pending restart record --------------------------------------------------------

export interface AgenCDaemonPendingRestart {
  readonly schemaVersion: 1;
  readonly token: string;
  readonly createdAt: string;
  readonly notAfter: string;
  /** The daemon instance this restart replaces; any other instance ends it. */
  readonly daemon: { readonly pid: number; readonly instanceId: string };
  readonly target: AgenCRuntimeBuild;
  /** The TUI that asked; its own conversation never holds the restart up. */
  readonly requester?: AgenCDaemonRestartRequester;
  /** The request whose end this restart publishes (see daemon-restart-results.json). */
  readonly requestId?: string;
}

function requesterOf(value: unknown): AgenCDaemonRestartRequester | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { pid, agentId, attachmentIds } = value as { pid?: unknown; agentId?: unknown; attachmentIds?: unknown };
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) return undefined;
  if (typeof agentId !== "string" || agentId.length === 0) return { pid };
  const ids = Array.isArray(attachmentIds)
    ? attachmentIds.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 200).slice(0, 16)
    : [];
  return ids.length === 0 ? { pid, agentId } : { pid, agentId, attachmentIds: ids };
}

export function resolveAgenCDaemonPendingRestartPath(daemonHome: string): string {
  return join(daemonHome, AGENC_DAEMON_RESTART_PENDING_FILENAME);
}

export function readAgenCDaemonPendingRestart(
  daemonHome: string,
): AgenCDaemonPendingRestart | null {
  try {
    const raw = readFileSync(resolveAgenCDaemonPendingRestartPath(daemonHome), "utf8");
    if (raw.length > PENDING_RECORD_MAX_BYTES) return null;
    const value = JSON.parse(raw) as Partial<AgenCDaemonPendingRestart>;
    if (
      value.schemaVersion !== 1 ||
      typeof value.token !== "string" ||
      typeof value.createdAt !== "string" ||
      typeof value.notAfter !== "string" ||
      typeof value.daemon?.pid !== "number" ||
      typeof value.daemon.instanceId !== "string" ||
      typeof value.target?.runtimeVersion !== "string" ||
      typeof value.target.commit !== "string" ||
      typeof value.target.buildTime !== "string"
    ) {
      return null;
    }
    const { requester, requestId, ...rest } = value as AgenCDaemonPendingRestart;
    const sane = requesterOf(requester);
    return {
      ...rest,
      ...(sane === undefined ? {} : { requester: sane }),
      ...(isAgenCDaemonRestartRequestId(requestId) ? { requestId } : {}),
    };
  } catch {
    return null;
  }
}

export function writeAgenCDaemonPendingRestart(
  daemonHome: string,
  record: AgenCDaemonPendingRestart,
): void {
  const path = resolveAgenCDaemonPendingRestartPath(daemonHome);
  writeDurableAtomicFileSync(
    path,
    `${path}.${process.pid}.${randomUUID()}.tmp`,
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/**
 * The requesting TUI reports its current attachment ids into a pending record
 * it asked for, under the lifecycle lock (record changes are serialized with
 * a waiter's final decision). Returns whether the record changed.
 */
export async function updateAgenCDaemonRestartRequesterAttachments(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
  requesterPid: number,
  attachmentIds: readonly string[],
): Promise<boolean> {
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  const unchanged = (record: AgenCDaemonPendingRestart | null): boolean =>
    record?.requester?.pid !== requesterPid ||
    record.requester.agentId === undefined ||
    JSON.stringify(record.requester.attachmentIds ?? []) === JSON.stringify(attachmentIds);
  if (unchanged(readAgenCDaemonPendingRestart(daemonHome))) return false;
  return withAgenCDaemonLifecycleLock(host as AgenCDaemonCliHost, async () => {
    const record = readAgenCDaemonPendingRestart(daemonHome);
    if (record === null || unchanged(record)) return false;
    const { attachmentIds: _previous, ...requester } = record.requester!;
    writeAgenCDaemonPendingRestart(daemonHome, {
      ...record,
      requester: attachmentIds.length === 0 ? requester : { ...requester, attachmentIds: [...attachmentIds] },
    });
    return true;
  });
}

/**
 * Remove the record only while it still belongs to `token`. The caller holds
 * the lifecycle lock, which every record change takes, so no newer record
 * can be published between the check and the unlink. Throws when the record
 * is there and cannot be removed: a record left behind keeps its restart
 * alive, so every caller must say so.
 */
export function removeAgenCDaemonPendingRestartLocked(daemonHome: string, token: string): void {
  if (readAgenCDaemonPendingRestart(daemonHome)?.token !== token) return;
  rmSync(resolveAgenCDaemonPendingRestartPath(daemonHome), { force: true });
}

/** {@link removeAgenCDaemonPendingRestartLocked}, taking the lifecycle lock. */
export async function removeAgenCDaemonPendingRestart(
  host: AgenCDaemonCliHost,
  token: string,
  withLock: <T>(host: AgenCDaemonCliHost, operation: () => Promise<T>) => Promise<T> = withAgenCDaemonLifecycleLock,
): Promise<void> {
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  await withLock(host, async () => removeAgenCDaemonPendingRestartLocked(daemonHome, token));
}

function logLine(daemonHome: string, message: string, now: Date): void {
  try {
    const text = message.replaceAll(/[\r\n]+/g, " ").slice(0, LOG_LINE_MAX_CHARS);
    appendFileSync(
      join(daemonHome, AGENC_DAEMON_RESTART_LOG_FILENAME),
      `${now.toISOString()} ${text}\n`,
      { mode: 0o600 },
    );
  } catch {
    // The log is a convenience; the record and the daemon are the state.
  }
}

const RESULTS_LOCK = {
  filename: "daemon-restart-results.lock.sqlite",
  label: "AgenC daemon restart results",
  waitMs: 10_000,
} as const;

/**
 * Publish how a restart request ended (see AGENC_DAEMON_RESTART_RESULTS_FILENAME):
 * one atomic rewrite of the bounded file, under a short lock of its own so two
 * ends never drop each other. Callers publish before they clear the pending
 * record, so a follower never sees the restart gone without its end. Best
 * effort: a failure is logged.
 */
export async function publishAgenCDaemonRestartResult(
  daemonHome: string,
  result: AgenCDaemonRestartResult,
): Promise<void> {
  let release: (() => void) | undefined;
  try {
    release = await acquireLocalSqliteLock(join(daemonHome, RESULTS_LOCK.filename), {
      label: RESULTS_LOCK.label,
      timeoutMs: RESULTS_LOCK.waitMs,
    });
    const path = join(daemonHome, AGENC_DAEMON_RESTART_RESULTS_FILENAME);
    let existing: string | null = null;
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = null;
    }
    const next = addAgenCDaemonRestartResult(existing, result);
    if (next !== null) writeDurableAtomicFileSync(path, `${path}.${process.pid}.${randomUUID()}.tmp`, next);
  } catch (error) {
    logLine(daemonHome, `the end of request ${result.requestId} could not be recorded (${formatCleanupError(error)})`, new Date());
  } finally {
    release?.();
  }
}

/** Publish the end of `requestId`; a request without an id has nobody following it. */
async function publishEnd(
  daemonHome: string,
  requestId: string | undefined,
  outcome: AgenCDaemonRestartOutcome,
  now: Date,
  continuedBy?: string,
): Promise<void> {
  if (requestId === undefined) return;
  await publishAgenCDaemonRestartResult(daemonHome, {
    requestId,
    finishedAt: now.toISOString(),
    outcome,
    ...(continuedBy === undefined || continuedBy === requestId ? {} : { continuedBy }),
  });
}

/** Start a fresh log for a new pending restart, so it never grows unbounded. */
function startLog(daemonHome: string, message: string, now: Date): void {
  try {
    rmSync(join(daemonHome, AGENC_DAEMON_RESTART_LOG_FILENAME), { force: true });
  } catch {
    // Appending to the old log is fine.
  }
  logLine(daemonHome, message, now);
}

// --- restart --------------------------------------------------------------------------

export interface AgenCDaemonRestartWhenIdleDeps {
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** This runtime's build; null when it cannot be read. */
  readonly ownBuild?: () => AgenCRuntimeBuild | null;
  /** This runtime's install tree, excluded from the older-process scan. */
  readonly ownRuntimeTree?: () => string | undefined;
  readonly readState?: (host: AgenCDaemonCliHost) => Promise<AgenCDaemonRestartState>;
  readonly probe?: (
    host: AgenCDaemonCliHost,
    expected: AgenCDaemonInstanceIdentity,
    requester?: AgenCDaemonRestartRequester,
  ) => Promise<AgenCDaemonIdleVerdict>;
  /** The daemon process's command line, for the ownership check. */
  readonly daemonCommand?: (pid: number) => string | null;
  readonly stopDaemon?: typeof stopAgenCDaemon;
  /** The final step; see {@link requestAgenCDaemonShutdownWhenIdle}. */
  readonly requestShutdownWhenIdle?: (
    host: AgenCDaemonCliHost,
    expected: AgenCDaemonInstanceIdentity,
    exempt?: { readonly attachmentIds: readonly string[]; readonly agentId: string },
  ) => Promise<AgenCDaemonShutdownDeclined | void>;
  /** Serializes pending-record changes with the final shutdown decision. */
  readonly withLifecycleLock?: <T>(host: AgenCDaemonCliHost, operation: () => Promise<T>) => Promise<T>;
  /** The same lock for a waiter's start: held from its last check through the spawn. */
  readonly acquireLifecycleLock?: (host: AgenCDaemonCliHost) => Promise<() => Promise<void>>;
  /**
   * The daemon restart lock (see acquireAgenCDaemonRestartLock), waiting at
   * most `timeoutMs` for another restart to finish.
   */
  readonly acquireRestartLock?: (host: AgenCDaemonCliHost, timeoutMs: number) => Promise<() => Promise<void>>;
  /**
   * One line for the person while this restart waits for another one; the
   * CLI writes it to stderr, where `agenc update` picks it up.
   */
  readonly onProgress?: (line: string) => void;
  readonly startDaemon?: typeof startAgenCDaemon;
  readonly requestIdentity?: (host: AgenCDaemonCliHost) => Promise<AgenCDaemonInstanceIdentity>;
  /** Start the detached waiter; returns its pid. */
  readonly spawnWaiter?: (host: AgenCDaemonCliHost, token: string, requestId?: string) => number;
  readonly pollMs?: number;
  readonly maxWaitMs?: number;
  readonly idleChecks?: number;
  /**
   * Restart only a daemon whose build is older than this runtime's. `agenc
   * update` sets it when it finds itself up to date, so it never starts an
   * older runtime over a newer daemon.
   */
  readonly onlyOlderDaemon?: boolean;
  /** The TUI that asked for the restart, while it runs. */
  readonly requester?: AgenCDaemonRestartRequester;
  /**
   * A pinned downgrade (`agenc update --pin` to an older version). It ends a
   * pending restart onto a newer build instead of leaving that one in place.
   */
  readonly downgrade?: boolean;
  /** Runtime roots of this install besides the home's (a Homebrew keg). */
  readonly installRuntimeRoots?: () => readonly string[];
  /** The TUI's id for this restart request (`--request-id`); its end is published under it. */
  readonly requestId?: string;
}

interface RestartContext {
  readonly host: AgenCDaemonCliHost;
  readonly options: RunAgenCDaemonCliOptions;
  readonly deps: AgenCDaemonRestartWhenIdleDeps;
  readonly daemonHome: string;
  readonly build: AgenCRuntimeBuild;
  readonly now: () => Date;
  /** Set from the deps, and by the waiter from its record. */
  readonly requester: { current: AgenCDaemonRestartRequester | undefined };
  readonly requestId?: string;
}

function defaultOwnBuild(): AgenCRuntimeBuild | null {
  const root = resolveRuntimePackageRootFromUrl(import.meta.url);
  return root === null ? null : readDistVersion(root);
}

/**
 * `<tree>` for a package root `<tree>/node_modules/@tetsuo-ai/runtime`; the
 * package root itself when it is not installed that way (a checkout).
 */
export function agenCRuntimeTreeOf(packageRoot: string): string {
  const suffix = "/node_modules/@tetsuo-ai/runtime";
  return packageRoot.endsWith(suffix) ? packageRoot.slice(0, -suffix.length) : packageRoot;
}

function defaultOwnRuntimeTree(): string | undefined {
  const root = resolveRuntimePackageRootFromUrl(import.meta.url);
  return root === null ? undefined : agenCRuntimeTreeOf(root);
}

function collectingIo(): { readonly io: AgenCDaemonCliIo; readonly tail: () => string } {
  const chunks: string[] = [];
  const write = (chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  return {
    io: { stdout: { write }, stderr: { write } } as unknown as AgenCDaemonCliIo,
    tail: () =>
      chunks
        .join("")
        .split("\n")
        .map((line) => line.replace(/^agenc: /, "").trim())
        .filter((line) => line.length > 0)
        .slice(-2)
        .join("; ")
        .slice(0, 600),
  };
}

function probeFor(ctx: RestartContext): (
  expected: AgenCDaemonInstanceIdentity,
) => Promise<AgenCDaemonIdleVerdict> {
  if (ctx.deps.probe !== undefined) {
    const probe = ctx.deps.probe;
    return (expected) => probe(ctx.host, expected, liveRequester(ctx));
  }
  const ownRuntimeTree = (ctx.deps.ownRuntimeTree ?? defaultOwnRuntimeTree)();
  const installRuntimeRoots = (ctx.deps.installRuntimeRoots ?? defaultInstallRuntimeRoots)();
  return (expected) => {
    const requester = liveRequester(ctx);
    return probeAgenCDaemonIdle(ctx.host, expected, {
      ...(ownRuntimeTree === undefined ? {} : { ownRuntimeTree }),
      ...(installRuntimeRoots.length === 0 ? {} : { installRuntimeRoots }),
      ...(requester === undefined ? {} : { requester }),
    });
  };
}

/** The attachments a requester may have exempt: its own ids on its own conversation. */
export function requesterExemption(
  requester: AgenCDaemonRestartRequester | undefined,
): { readonly attachmentIds: readonly string[]; readonly agentId: string } | undefined {
  if (requester?.agentId === undefined || requester.attachmentIds === undefined) return undefined;
  if (requester.attachmentIds.length === 0) return undefined;
  return { attachmentIds: requester.attachmentIds, agentId: requester.agentId };
}

/** The requester counts only while its process runs. */
function liveRequester(ctx: RestartContext): AgenCDaemonRestartRequester | undefined {
  const requester = ctx.requester.current;
  if (requester === undefined) return undefined;
  try {
    return ctx.host.isPidRunning(requester.pid) ? requester : undefined;
  } catch {
    return undefined;
  }
}

type RestartAttempt =
  | { readonly kind: "declined"; readonly reason: string; readonly permanent: boolean; readonly tooOld?: boolean }
  | { readonly kind: "done"; readonly outcome: AgenCDaemonRestartOutcome };

/**
 * The start. For a waiter, its ownership check (`lastCheck`) runs first,
 * under the lifecycle lock. A newer update writes its record under the same
 * lock, so the record lands either before the check (this waiter stands
 * down) or once the new daemon exists (the newer waiter then restarts that
 * one). The start keeps the lock through the spawn and releases it before
 * its readiness waits, since the new daemon takes it to publish itself.
 */
async function startUnlessSuperseded(
  ctx: RestartContext,
  io: AgenCDaemonCliIo,
  start: typeof startAgenCDaemon,
  lastCheck: (() => string | undefined) | undefined,
): Promise<{ readonly superseded: string; readonly exit?: undefined } | { readonly superseded?: undefined; readonly exit: number }> {
  if (lastCheck === undefined) return { exit: await start(ctx.host, io, ctx.options) };
  const acquire = ctx.deps.acquireLifecycleLock ??
    ((host: AgenCDaemonCliHost) => acquireAgenCDaemonLifecycleLock(host));
  const release = await acquire(ctx.host);
  let held = true;
  const releaseOnce = async (): Promise<void> => {
    if (!held) return;
    held = false;
    await release();
  };
  let result: { readonly superseded: string } | { readonly exit: number };
  try {
    const superseded = lastCheck();
    result = superseded !== undefined
      ? { superseded }
      : {
          exit: await start(ctx.host, io, {
            ...ctx.options,
            lifecycleLockHeld: true,
            releaseLifecycleLockAfterStartMutation: releaseOnce,
          }),
        };
  } catch (error) {
    await releaseOnce().catch(() => undefined);
    throw error;
  }
  await releaseOnce();
  return result;
}

/**
 * The existing restart path, `stop` then `start`, with the idle check
 * repeated under the lifecycle lock right before `daemon.shutdown`.
 */
async function restartIfStillIdle(
  ctx: RestartContext,
  expected: AgenCDaemonInstanceIdentity,
  lastCheck?: () => string | undefined,
): Promise<RestartAttempt> {
  const stop = ctx.deps.stopDaemon ?? stopAgenCDaemon;
  const requestWhenIdle = ctx.deps.requestShutdownWhenIdle ?? requestAgenCDaemonShutdownWhenIdle;
  const start = ctx.deps.startDaemon ?? startAgenCDaemon;
  const requestIdentity = ctx.deps.requestIdentity ??
    ((host: AgenCDaemonCliHost) => requestAgenCDaemonInstanceIdentity(host));
  const output = collectingIo();
  let declined: string | undefined;
  let permanent = false;
  let tooOld = false;
  const stopExit = await stop(ctx.host, output.io, RESTART_STOP_TIMEOUT_MS, {
    ...ctx.options,
    quietWhenStopped: true,
    // Signals only ever follow a shutdown the daemon explicitly accepted.
    signalOnlyAfterAcceptedShutdown: true,
    // Under the lifecycle lock, after the identity proof. Ownership is the
    // last thing checked here; pending-record changes take the same lock, so
    // none can land between this check and the daemon's decision.
    beforeShutdownRequest: async (identity) => {
      if (identity.instanceId !== expected.instanceId) {
        declined = "the daemon was replaced";
        return declined;
      }
      declined = lastCheck?.();
      return declined;
    },
    // The daemon decides whether it is idle, holding new requests meanwhile;
    // an older daemon gets the strict last check on the same connection.
    requestDaemonShutdown: async (host, identity) => {
      const result = await requestWhenIdle(host, identity, requesterExemption(liveRequester(ctx)));
      if (result !== undefined) {
        declined = result.declined;
        permanent = result.permanent === true;
        tooOld = result.tooOld === true;
      }
      return result;
    },
  });
  if (stopExit === AGENC_DAEMON_STOP_DECLINED_EXIT) {
    return {
      kind: "declined",
      reason: declined ?? "the daemon has no verified identity",
      permanent: permanent || declined === undefined,
      ...(tooOld ? { tooOld: true } : {}),
    };
  }
  const fromVersion = expected.runtimeVersion;
  const toVersion = ctx.build.runtimeVersion;
  if (stopExit !== 0) {
    const detail = output.tail();
    return {
      kind: "done",
      outcome: {
        status: "failed",
        reason: `the daemon could not be stopped${detail.length > 0 ? ` (${detail})` : ""}`,
        fromVersion,
        toVersion,
      },
    };
  }
  // A newer update that arrived after this daemon stopped owns the start:
  // starting this runtime would put an older build back.
  const started = await startUnlessSuperseded(ctx, output.io, start, lastCheck);
  if (started.superseded !== undefined) {
    return {
      kind: "done",
      outcome: {
        status: "skipped",
        reason: `${started.superseded}; the daemon stopped and its next start uses the newest runtime`,
        fromVersion,
        toVersion,
      },
    };
  }
  const startExit = started.exit;
  if (startExit !== 0) {
    const detail = output.tail();
    return {
      kind: "done",
      outcome: {
        status: "failed",
        reason: `the daemon stopped but did not start again${detail.length > 0 ? ` (${detail})` : ""}. The next agenc command starts it`,
        fromVersion,
        toVersion,
      },
    };
  }
  let replacement: AgenCDaemonInstanceIdentity;
  try {
    replacement = await requestIdentity(ctx.host);
  } catch (error) {
    return {
      kind: "done",
      outcome: {
        status: "failed",
        reason: `the new daemon did not report its version: ${formatCleanupError(error)}`,
        fromVersion,
        toVersion,
      },
    };
  }
  if (!sameBuild(replacement, ctx.build)) {
    return {
      kind: "done",
      outcome: {
        status: "failed",
        reason: `the daemon came back on ${replacement.runtimeVersion} instead of ${toVersion}`,
        fromVersion,
        toVersion,
        pid: replacement.pid,
      },
    };
  }
  return {
    kind: "done",
    outcome: { status: "restarted", fromVersion, toVersion, pid: replacement.pid },
  };
}

type Preflight =
  | { readonly kind: "not-running" }
  /** A daemon is there but its identity cannot be proven (yet). */
  | { readonly kind: "unproven"; readonly reason: string }
  | { readonly kind: "current"; readonly identity: AgenCDaemonInstanceIdentity }
  /** Not older than this runtime, with `onlyOlderDaemon`. */
  | { readonly kind: "newer"; readonly identity: AgenCDaemonInstanceIdentity }
  /** Not started from this install's runtime, or not inspectable. */
  | { readonly kind: "foreign"; readonly reason: string; readonly identity: AgenCDaemonInstanceIdentity }
  | { readonly kind: "candidate"; readonly identity: AgenCDaemonInstanceIdentity };

/** Not running, not ours, already current, or a daemon to restart. */
async function preflight(ctx: RestartContext): Promise<Preflight> {
  const state = await (ctx.deps.readState ??
    ((host: AgenCDaemonCliHost) => readAgenCDaemonRestartState(host, ctx.options)))(ctx.host);
  if (state.kind !== "running") return state;
  const identity = state.identity;
  if (sameBuild(identity, ctx.build)) return { kind: "current", identity };
  if (ctx.deps.onlyOlderDaemon === true && compareAgenCRuntimeBuilds(identity, ctx.build) !== -1) {
    return { kind: "newer", identity };
  }
  // Only a daemon this install started: never one the Desktop app or a
  // development checkout runs from its own runtime, even in a shared home.
  const command = (ctx.deps.daemonCommand ?? readAgenCProcessCommand)(identity.pid);
  const roots = [
    ...agenCHomeRuntimeRoots(ctx.daemonHome),
    ...(ctx.deps.installRuntimeRoots ?? defaultInstallRuntimeRoots)(),
  ];
  if (command === null) {
    return { kind: "foreign", reason: "the daemon process could not be inspected", identity };
  }
  if (!roots.some((root) => command.includes(root))) {
    return {
      kind: "foreign",
      reason: "the daemon runs from outside this install (for example the Desktop app)",
      identity,
    };
  }
  return { kind: "candidate", identity };
}

/** What the immediate path reports when there is nothing to restart. */
function preflightOutcome(
  ctx: RestartContext,
  checked: Exclude<Preflight, { readonly kind: "candidate" }>,
): AgenCDaemonRestartOutcome {
  const toVersion = ctx.build.runtimeVersion;
  switch (checked.kind) {
    case "not-running":
      return { status: "not-running", toVersion };
    case "unproven":
      return { status: "skipped", reason: checked.reason, toVersion };
    case "current":
      return {
        status: "skipped",
        code: "already-current",
        reason: `the daemon already runs ${toVersion}`,
        fromVersion: checked.identity.runtimeVersion,
        toVersion,
        pid: checked.identity.pid,
      };
    case "newer":
      return {
        status: "skipped",
        code: "newer-daemon",
        reason: `the daemon runs ${checked.identity.runtimeVersion}, which is not older than ${toVersion}`,
        fromVersion: checked.identity.runtimeVersion,
        toVersion,
        pid: checked.identity.pid,
      };
    case "foreign":
      return {
        status: "skipped",
        reason: checked.reason,
        fromVersion: checked.identity.runtimeVersion,
        toVersion,
      };
  }
}

function defaultSpawnWaiter(host: AgenCDaemonCliHost, token: string, requestId?: string): number {
  const child = spawn(
    host.execPath,
    [
      host.entrypointPath, "daemon", "restart", "--when-idle", "--wait", token,
      ...(requestId === undefined ? [] : ["--request-id", requestId]),
    ],
    {
      detached: true,
      cwd: resolveAgenCDaemonHome(host.env, host.userHome),
      env: userRuntimeEnvironment(host.env),
      stdio: "ignore",
      windowsHide: true,
    },
  );
  child.on("error", () => {});
  child.unref();
  if (child.pid === undefined) throw new Error("the waiting process did not start");
  return child.pid;
}

/** Arrange a restart for when the daemon is idle. */
async function deferRestart(
  ctx: RestartContext,
  identity: AgenCDaemonInstanceIdentity,
  reason: string,
): Promise<AgenCDaemonRestartOutcome> {
  const withLock = ctx.deps.withLifecycleLock ?? withAgenCDaemonLifecycleLock;
  // Serialized with any waiter's final shutdown decision (see restartIfStillIdle).
  return withLock(ctx.host, async () => deferRestartLocked(ctx, identity, reason));
}

function deferRestartLocked(
  ctx: RestartContext,
  identity: AgenCDaemonInstanceIdentity,
  reason: string,
): AgenCDaemonRestartOutcome {
  const now = ctx.now();
  const maxWaitMs = ctx.deps.maxWaitMs ?? AGENC_DAEMON_RESTART_MAX_WAIT_MS;
  const notAfter = new Date(now.getTime() + maxWaitMs).toISOString();
  const token = randomUUID();
  const fromVersion = identity.runtimeVersion;
  const toVersion = ctx.build.runtimeVersion;
  const pending = readAgenCDaemonPendingRestart(ctx.daemonHome);
  if (pending !== null && ctx.deps.downgrade !== true && pendingRestartIsNewer(pending, ctx.build, now)) {
    // An update to a newer build already waits for this daemon (an older
    // updater that was slower to get here). Its restart goes further, so it
    // stays; this TUI, when it asked, is exempt from it like from its own.
    const requester = ctx.requester.current;
    const takeRequester = requester !== undefined && !requesterIsLive(ctx, pending.requester);
    // A pending restart without a request id publishes its end under this one.
    const takeRequestId = pending.requestId === undefined && ctx.requestId !== undefined;
    if (takeRequester || takeRequestId) {
      writeAgenCDaemonPendingRestart(ctx.daemonHome, {
        ...pending,
        ...(takeRequester ? { requester } : {}),
        ...(takeRequestId ? { requestId: ctx.requestId } : {}),
      });
    }
    const followed = pending.requestId ?? ctx.requestId;
    logLine(
      ctx.daemonHome,
      `kept: a restart onto ${pending.target.runtimeVersion} already waits for the daemon; ${toVersion} is older`,
      now,
    );
    return {
      status: "deferred",
      reason,
      fromVersion,
      toVersion: pending.target.runtimeVersion,
      waitUntil: pending.notAfter,
      ...(followed === undefined ? {} : { requestId: followed }),
    };
  }
  // A step without a request id (`agenc update`) carries on the request of the
  // restart it replaces, so that request's follower still gets an end.
  const requestId = ctx.requestId ?? pending?.requestId;
  try {
    // Replacing the record ends any earlier waiter at its next check.
    writeAgenCDaemonPendingRestart(ctx.daemonHome, {
      schemaVersion: 1,
      token,
      createdAt: now.toISOString(),
      notAfter,
      daemon: { pid: identity.pid, instanceId: identity.instanceId },
      target: ctx.build,
      ...(ctx.requester.current === undefined ? {} : { requester: ctx.requester.current }),
      ...(requestId === undefined ? {} : { requestId }),
    });
    startLog(
      ctx.daemonHome,
      `deferred: daemon pid ${identity.pid} on ${fromVersion} is busy (${reason}); restarting on ${toVersion} once idle, until ${notAfter}`,
      now,
    );
    const waiterPid = (ctx.deps.spawnWaiter ?? defaultSpawnWaiter)(ctx.host, token, requestId);
    logLine(ctx.daemonHome, `waiting process pid ${waiterPid}`, ctx.now());
  } catch (error) {
    let leftBehind = "";
    try {
      removeAgenCDaemonPendingRestartLocked(ctx.daemonHome, token);
    } catch (removeError) {
      leftBehind = `; its record could not be removed either (${formatCleanupError(removeError)}), ` +
        `delete ${resolveAgenCDaemonPendingRestartPath(ctx.daemonHome)}`;
    }
    return {
      status: "failed",
      reason: `the daemon is busy (${reason}) and a later restart could not be arranged: ${formatCleanupError(error)}${leftBehind}`,
      fromVersion,
      toVersion,
    };
  }
  return {
    status: "deferred",
    reason,
    fromVersion,
    toVersion,
    waitUntil: notAfter,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

/** A pending restart, still in time, onto a build newer than `build`. */
function pendingRestartIsNewer(
  pending: AgenCDaemonPendingRestart,
  build: AgenCRuntimeBuild,
  now: Date,
): boolean {
  const notAfter = Date.parse(pending.notAfter);
  return Number.isFinite(notAfter) && notAfter > now.getTime() &&
    compareAgenCRuntimeBuilds(pending.target, build) === 1;
}

function requesterIsLive(ctx: RestartContext, requester: AgenCDaemonRestartRequester | undefined): boolean {
  if (requester === undefined) return false;
  try {
    return ctx.host.isPidRunning(requester.pid);
  } catch {
    return false;
  }
}

type PendingRestartCancel =
  | { readonly kind: "none" }
  | { readonly kind: "cancelled"; readonly version: string }
  /** Still pending: `why` says what stopped the cancellation. */
  | { readonly kind: "failed"; readonly version: string; readonly why: string };

/**
 * Busy means another holder kept the lock; any other failure, such as a lock
 * path that could not be validated in time, keeps its own message.
 */
function describeLifecycleLockFailure(error: unknown): string {
  return isLocalSqliteLockBusyTimeout(error, LIFECYCLE_LOCK)
    ? `the daemon lifecycle lock stayed busy for ${formatAgenCDaemonRestartWait(error.timeoutMs)}`
    : `the daemon lifecycle lock could not be taken: ${formatCleanupError(error)}`;
}

/** What a person reads when a pending restart onto a newer build stays. */
function cancelFailedReason(
  daemonHome: string,
  failed: Extract<PendingRestartCancel, { readonly kind: "failed" }>,
): string {
  return `a restart onto ${failed.version} is still pending and could not be cancelled (${failed.why}). ` +
    `The daemon was left as it is, and that restart can still move it to ${failed.version}. ` +
    `To cancel it, delete ${resolveAgenCDaemonPendingRestartPath(daemonHome)}`;
}

/**
 * End the pending restart `above` selects, for a pinned downgrade to
 * `targetVersion`, under the lifecycle lock. One that stays is logged and
 * returned as failed, never as cancelled. When the lock cannot be taken the
 * record is only read: with nothing above the target, a busy lock costs the
 * downgrade nothing.
 */
async function cancelPendingRestartAbove<H extends Pick<AgenCDaemonCliHost, "env" | "userHome">>(
  host: H,
  withLock: <T>(host: H, operation: () => Promise<T>) => Promise<T>,
  above: (pending: AgenCDaemonPendingRestart) => boolean,
  targetVersion: string,
  now: () => Date,
): Promise<PendingRestartCancel> {
  const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
  let result: PendingRestartCancel;
  try {
    result = await withLock(host, async (): Promise<PendingRestartCancel> => {
      const pending = readAgenCDaemonPendingRestart(daemonHome);
      if (pending === null || !above(pending)) return { kind: "none" };
      try {
        removeAgenCDaemonPendingRestartLocked(daemonHome, pending.token);
      } catch (error) {
        return {
          kind: "failed",
          version: pending.target.runtimeVersion,
          why: `the record could not be removed: ${formatCleanupError(error)}`,
        };
      }
      return { kind: "cancelled", version: pending.target.runtimeVersion };
    });
  } catch (error) {
    const pending = readAgenCDaemonPendingRestart(daemonHome);
    if (pending === null || !above(pending)) return { kind: "none" };
    result = { kind: "failed", version: pending.target.runtimeVersion, why: describeLifecycleLockFailure(error) };
  }
  if (result.kind === "cancelled") {
    logLine(daemonHome, `cancelled: the restart onto ${result.version}, for a downgrade to ${targetVersion}`, now());
  } else if (result.kind === "failed") {
    logLine(
      daemonHome,
      `cancel failed: the restart onto ${result.version}, for a downgrade to ${targetVersion}, is still pending: ${result.why}`,
      now(),
    );
  }
  return result;
}

/**
 * A pinned downgrade ends a pending restart onto a newer build first, so
 * that restart's waiting process cannot move the daemon back up later.
 * Returns the outcome to report when that restart stays: then the daemon is
 * left as it is, since restarting it now would only be undone later.
 */
async function cancelNewerPendingRestart(ctx: RestartContext): Promise<AgenCDaemonRestartOutcome | undefined> {
  const result = await cancelPendingRestartAbove(
    ctx.host,
    ctx.deps.withLifecycleLock ?? withAgenCDaemonLifecycleLock,
    (pending) => compareAgenCRuntimeBuilds(pending.target, ctx.build) === 1,
    ctx.build.runtimeVersion,
    ctx.now,
  );
  return result.kind === "failed"
    ? { status: "failed", reason: cancelFailedReason(ctx.daemonHome, result), toVersion: ctx.build.runtimeVersion }
    : undefined;
}

/**
 * For `agenc update --pin` to an older version, run by the updater itself
 * before it hands the restart to that runtime, which may be too old to know
 * `--downgrade`: end a pending restart onto a version above the target.
 * Returns the version of the restart it ended. Rejects, with a reason a
 * person can read, when such a restart exists and could not be ended.
 */
export async function cancelAgenCDaemonPendingRestartAbove(
  host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
  targetVersion: string,
  now: () => Date = () => new Date(),
  options: {
    readonly withLifecycleLock?: <T>(
      host: Pick<AgenCDaemonCliHost, "env" | "userHome">,
      operation: () => Promise<T>,
    ) => Promise<T>;
  } = {},
): Promise<string | undefined> {
  const result = await cancelPendingRestartAbove(
    host,
    options.withLifecycleLock ?? withAgenCDaemonLifecycleLock,
    (pending) => {
      try {
        return semverOrder(pending.target.runtimeVersion, targetVersion) === 1;
      } catch {
        return false;
      }
    },
    targetVersion,
    now,
  );
  if (result.kind === "failed") {
    throw new Error(cancelFailedReason(resolveAgenCDaemonHome(host.env, host.userHome), result));
  }
  return result.kind === "cancelled" ? result.version : undefined;
}

/** A daemon the check can never prove idle (too old, no identity). */
function cannotCheckOutcome(
  ctx: RestartContext,
  identity: AgenCDaemonInstanceIdentity,
  reason: string,
  tooOld = false,
): AgenCDaemonRestartOutcome {
  return {
    status: "skipped",
    code: tooOld ? "daemon-too-old" : "unsupported",
    reason,
    fromVersion: identity.runtimeVersion,
    toVersion: ctx.build.runtimeVersion,
  };
}

function restartContext(
  host: AgenCDaemonCliHost,
  options: RunAgenCDaemonCliOptions,
  deps: AgenCDaemonRestartWhenIdleDeps,
): RestartContext | AgenCDaemonRestartOutcome {
  const build = (deps.ownBuild ?? defaultOwnBuild)();
  if (build === null) {
    return {
      status: "skipped",
      code: "unsupported",
      reason: "this runtime's build identity is unavailable",
    };
  }
  return {
    host,
    options,
    deps,
    daemonHome: resolveAgenCDaemonHome(host.env, host.userHome),
    build,
    now: deps.now ?? (() => new Date()),
    requester: { current: deps.requester },
    ...(deps.requestId === undefined ? {} : { requestId: deps.requestId }),
  };
}

/**
 * Restart the daemon now when it is idle; otherwise arrange a restart for
 * when it is. Never interrupts work.
 */
export async function restartAgenCDaemonWhenIdle(
  host: AgenCDaemonCliHost,
  options: RunAgenCDaemonCliOptions = {},
  deps: AgenCDaemonRestartWhenIdleDeps = {},
): Promise<AgenCDaemonRestartOutcome> {
  const platform = host.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "linux") {
    return {
      status: "skipped",
      code: "unsupported",
      reason: "automatic restart is not available on this platform yet",
    };
  }
  const ctx = restartContext(host, options, deps);
  if (!("host" in ctx)) return ctx;
  return restartWhenIdleSerialized(ctx);
}

/**
 * Publish the end of this step's request. A deferral is not an end (the
 * waiting process publishes the end it reaches), unless it joined a pending
 * restart of another request: this request then goes on as that one.
 */
async function ended(ctx: RestartContext, outcome: AgenCDaemonRestartOutcome): Promise<AgenCDaemonRestartOutcome> {
  if (outcome.status !== "deferred") {
    await publishEnd(ctx.daemonHome, ctx.requestId, outcome, ctx.now());
  } else if (outcome.requestId !== undefined && outcome.requestId !== ctx.requestId) {
    await publishEnd(ctx.daemonHome, ctx.requestId, outcome, ctx.now(), outcome.requestId);
  }
  return outcome;
}

async function restartWhenIdleSerialized(ctx: RestartContext): Promise<AgenCDaemonRestartOutcome> {
  const { host, deps } = ctx;
  // One restart at a time. Another one may have stopped the daemon and not
  // spawned the next yet, which would read as no daemon at all.
  const acquire = deps.acquireRestartLock ?? acquireAgenCDaemonRestartLock;
  let release: () => Promise<void>;
  try {
    release = await acquire(host, AGENC_DAEMON_RESTART_LOCK_FIRST_TRY_MS);
  } catch (busy) {
    if (!isLocalSqliteLockBusyTimeout(busy, RESTART_LOCK)) {
      return ended(ctx, { status: "failed", reason: describeAgenCDaemonRestartLockFailure(busy), toVersion: ctx.build.runtimeVersion });
    }
    // Another restart runs: say so once, so the update does not look stuck.
    try {
      deps.onProgress?.(formatAgenCDaemonRestartWaitingLine());
    } catch {
      // Progress is best effort.
    }
    try {
      release = await acquire(host, AGENC_DAEMON_RESTART_LOCK_WAIT_MS);
    } catch (error) {
      return ended(ctx, { status: "failed", reason: describeAgenCDaemonRestartLockFailure(error), toVersion: ctx.build.runtimeVersion });
    }
  }
  try {
    // Published before the lock goes, so ends land in the order restarts end.
    return await ended(ctx, await restartWhenIdleLocked(ctx));
  } finally {
    // The lock goes with this process at the latest.
    await release().catch(() => undefined);
  }
}

async function restartWhenIdleLocked(ctx: RestartContext): Promise<AgenCDaemonRestartOutcome> {
  if (ctx.deps.downgrade === true) {
    const failed = await cancelNewerPendingRestart(ctx);
    if (failed !== undefined) return failed;
  }
  const checked = await preflight(ctx);
  if (checked.kind !== "candidate") return preflightOutcome(ctx, checked);
  if (ctx.deps.downgrade !== true && compareAgenCRuntimeBuilds(checked.identity, ctx.build) === 1) {
    // Only a pinned downgrade moves a daemon down. Two updates at once can
    // restart in either order; the newest build wins either way.
    return preflightOutcome(ctx, { kind: "newer", identity: checked.identity });
  }
  const verdict = await probeFor(ctx)(checked.identity);
  if (!verdict.idle) {
    return verdict.permanent === true
      ? cannotCheckOutcome(ctx, checked.identity, verdict.reason, verdict.tooOld === true)
      : deferRestart(ctx, checked.identity, verdict.reason);
  }
  const attempt = await restartIfStillIdle(ctx, checked.identity);
  if (attempt.kind === "declined") {
    return attempt.permanent
      ? cannotCheckOutcome(ctx, checked.identity, attempt.reason, attempt.tooOld === true)
      : deferRestart(ctx, checked.identity, attempt.reason);
  }
  return attempt.outcome;
}

/**
 * The detached waiter. Exits once the restart is done, superseded, no longer
 * needed, or past its deadline. Returns the final outcome (also logged).
 */
export async function runAgenCDaemonRestartWaiter(
  host: AgenCDaemonCliHost,
  token: string,
  options: RunAgenCDaemonCliOptions = {},
  deps: AgenCDaemonRestartWhenIdleDeps = {},
): Promise<AgenCDaemonRestartOutcome> {
  const created = restartContext(host, options, deps);
  if (!("host" in created)) return created;
  const ctx = created;
  const sleep = deps.sleep ?? host.sleep;
  const pollMs = deps.pollMs ?? AGENC_DAEMON_RESTART_POLL_MS;
  const idleChecksNeeded = deps.idleChecks ?? AGENC_DAEMON_RESTART_IDLE_CHECKS;
  const hardDeadline = ctx.now().getTime() + (deps.maxWaitMs ?? AGENC_DAEMON_RESTART_MAX_WAIT_MS);
  /** This restart's request: from `--request-id`, or from its record. */
  let requestId: string | undefined = ctx.requestId;
  const finish = async (outcome: AgenCDaemonRestartOutcome, removeRecord: boolean): Promise<AgenCDaemonRestartOutcome> => {
    // A newer restart that replaced this one carries its request on.
    const current = outcome.status === "skipped" ? readAgenCDaemonPendingRestart(ctx.daemonHome) : null;
    const successor = current !== null && current.token !== token ? current : null;
    // Published before the record goes: a follower never sees the restart
    // gone without its end. When the successor carries this same request,
    // its end is the one to publish.
    if (successor?.requestId === undefined || successor.requestId !== requestId) {
      await publishEnd(ctx.daemonHome, requestId, outcome, ctx.now(), successor?.requestId);
    }
    if (removeRecord) {
      try {
        await removeAgenCDaemonPendingRestart(ctx.host, token, ctx.deps.withLifecycleLock ?? withAgenCDaemonLifecycleLock);
      } catch (error) {
        // An older update keeps a record onto a newer build, so say how to clear it.
        logLine(
          ctx.daemonHome,
          `this restart's record could not be removed (${formatCleanupError(error)}); delete ${resolveAgenCDaemonPendingRestartPath(ctx.daemonHome)}`,
          ctx.now(),
        );
      }
    }
    logLine(
      ctx.daemonHome,
      `${outcome.status}: ${outcome.reason ?? formatAgenCDaemonRestartOutcome(outcome)}`,
      ctx.now(),
    );
    return outcome;
  };
  const superseded = (): string | undefined =>
    readAgenCDaemonPendingRestart(ctx.daemonHome)?.token === token
      ? undefined
      : "a newer update replaced this restart";
  let lockProblemLogged = false;
  /** The restart lock, or nothing while another restart holds it. */
  const restartLock = async (): Promise<(() => Promise<void>) | undefined> => {
    try {
      return await (ctx.deps.acquireRestartLock ?? acquireAgenCDaemonRestartLock)(ctx.host, WAITER_RESTART_LOCK_WAIT_MS);
    } catch (error) {
      if (!isLocalSqliteLockBusyTimeout(error, RESTART_LOCK) && !lockProblemLogged) {
        lockProblemLogged = true;
        logLine(ctx.daemonHome, `the daemon restart lock could not be taken (${formatCleanupError(error)}); checking again later`, ctx.now());
      }
      return undefined;
    }
  };
  let idleChecks = 0;
  for (;;) {
    const record = readAgenCDaemonPendingRestart(ctx.daemonHome);
    if (record === null || record.token !== token) {
      return finish({ status: "skipped", reason: "a newer update replaced this restart", toVersion: ctx.build.runtimeVersion }, false);
    }
    ctx.requester.current = record.requester;
    requestId = record.requestId ?? requestId;
    const nowMs = ctx.now().getTime();
    const notAfter = Date.parse(record.notAfter);
    if (!Number.isFinite(notAfter) || nowMs > notAfter || nowMs > hardDeadline) {
      return finish({
        status: "skipped",
        reason: "the daemon stayed busy until the waiting time ran out; it keeps running its current version",
        toVersion: ctx.build.runtimeVersion,
      }, true);
    }
    // Look only while no other restart runs: one that stopped the daemon and
    // has not spawned the next yet would read as no daemon at all.
    const release = await restartLock();
    if (release === undefined) {
      idleChecks = 0;
      await sleep(pollMs);
      continue;
    }
    try {
      const checked = await preflight(ctx);
      if (checked.kind === "unproven") {
        // A daemon that is still starting or stopping; check again later.
        idleChecks = 0;
      } else if (checked.kind !== "candidate") {
        // Stopped (the next start uses this runtime), already current, or not
        // ours to restart.
        return await finish(preflightOutcome(ctx, checked), true);
      } else if (checked.identity.instanceId !== record.daemon.instanceId) {
        // Restarted by something else. Still older than this target (an
        // earlier waiter finished first): keep going with the new instance.
        if (compareAgenCRuntimeBuilds(checked.identity, ctx.build) !== -1) {
          return await finish({
            status: "skipped",
            reason: "the daemon was restarted by something else",
            fromVersion: checked.identity.runtimeVersion,
            toVersion: ctx.build.runtimeVersion,
          }, true);
        }
        const adopted = await (ctx.deps.withLifecycleLock ?? withAgenCDaemonLifecycleLock)(ctx.host, async () => {
          if (readAgenCDaemonPendingRestart(ctx.daemonHome)?.token !== token) return false;
          writeAgenCDaemonPendingRestart(ctx.daemonHome, {
            ...record,
            daemon: { pid: checked.identity.pid, instanceId: checked.identity.instanceId },
          });
          return true;
        });
        if (!adopted) continue;
        logLine(ctx.daemonHome, `daemon pid ${checked.identity.pid} on ${checked.identity.runtimeVersion} replaced the one this restart waited for; waiting for it instead`, ctx.now());
        idleChecks = 0;
      } else {
        const verdict = await probeFor(ctx)(checked.identity);
        if (!verdict.idle && verdict.permanent === true) {
          return await finish(cannotCheckOutcome(ctx, checked.identity, verdict.reason, verdict.tooOld === true), true);
        }
        idleChecks = verdict.idle ? idleChecks + 1 : 0;
        if (idleChecks >= idleChecksNeeded) {
          const attempt = await restartIfStillIdle(ctx, checked.identity, superseded);
          if (attempt.kind === "done") return await finish(attempt.outcome, true);
          if (attempt.permanent) {
            return await finish(cannotCheckOutcome(ctx, checked.identity, attempt.reason, attempt.tooOld === true), true);
          }
          idleChecks = 0;
        }
      }
    } finally {
      // Released after the record is gone, so a restart that comes next
      // never keeps a record whose waiting process has finished.
      await release().catch(() => undefined);
    }
    await sleep(pollMs);
  }
}

// --- CLI ---------------------------------------------------------------------------------

/** This runtime's version for an outcome after an unexpected error, when known. */
function ownVersion(deps: AgenCDaemonRestartWhenIdleDeps): { readonly toVersion?: string } {
  try {
    const build = (deps.ownBuild ?? defaultOwnBuild)();
    return build === null ? {} : { toVersion: build.runtimeVersion };
  } catch {
    return {};
  }
}

export async function runAgenCDaemonRestartWhenIdleCli(
  command: Extract<AgenCDaemonCliCommand, { kind: "restart-when-idle" }>,
  host: AgenCDaemonCliHost,
  io: AgenCDaemonCliIo,
  options: RunAgenCDaemonCliOptions = {},
  deps: AgenCDaemonRestartWhenIdleDeps = {},
): Promise<number> {
  if (command.waitToken !== undefined) {
    // Detached with no terminal: the log and the record are its only output.
    const daemonHome = resolveAgenCDaemonHome(host.env, host.userHome);
    const waiterDeps = command.requestId === undefined ? deps : { ...deps, requestId: command.requestId };
    try {
      const outcome = await runAgenCDaemonRestartWaiter(host, command.waitToken, options, waiterDeps);
      return outcome.status === "failed" ? 1 : 0;
    } catch (error) {
      const reason = `the waiting process stopped: ${formatCleanupError(error)}`;
      const record = readAgenCDaemonPendingRestart(daemonHome);
      // Published before the record goes, like every other end.
      await publishEnd(
        daemonHome,
        (record?.token === command.waitToken ? record.requestId : undefined) ?? command.requestId,
        { status: "failed", reason, ...ownVersion(deps) },
        new Date(),
      );
      await removeAgenCDaemonPendingRestart(host, command.waitToken).catch(() => undefined);
      logLine(daemonHome, `failed: ${reason}`, new Date());
      return 1;
    }
  }
  let outcome: AgenCDaemonRestartOutcome;
  const requester: AgenCDaemonRestartRequester | undefined = command.requesterPid === undefined
    ? undefined
    : {
        pid: command.requesterPid,
        ...(command.requesterAgentId === undefined ? {} : { agentId: command.requesterAgentId }),
      };
  try {
    outcome = await restartAgenCDaemonWhenIdle(host, options, {
      // `agenc update` reads this line from stderr and shows it.
      onProgress: (line) => {
        io.stderr.write(`agenc: ${line}\n`);
      },
      ...deps,
      ...(requester === undefined ? {} : { requester }),
      ...(command.downgrade === true ? { downgrade: true } : {}),
      ...(command.requestId === undefined ? {} : { requestId: command.requestId }),
    });
  } catch (error) {
    outcome = { status: "failed", reason: formatCleanupError(error), ...ownVersion(deps) };
    await publishEnd(resolveAgenCDaemonHome(host.env, host.userHome), command.requestId ?? deps.requestId, outcome, new Date());
  }
  if (command.json) {
    io.stdout.write(`${JSON.stringify(outcome)}\n`);
  } else {
    io.stdout.write(`${formatAgenCDaemonRestartOutcome(outcome)}\n`);
  }
  return outcome.status === "failed" ? 1 : 0;
}
