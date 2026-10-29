/**
 * The daemon's own idle check for `daemon.shutdownIfIdle`.
 *
 * The dispatcher holds every new request while this runs and refuses them
 * once the daemon decides to stop, so no turn, attachment or tool call can
 * start between the check and the shutdown. A client-side check can only
 * narrow that window; this closes it.
 *
 * Everything here reads state that is already in memory: sessions are listed
 * without loading saved ones, and per-session details are read only for
 * sessions that are loaded and not waiting for a restore, so the check never
 * restores a session.
 */

type JsonLike = unknown;

/** Sub-agent statuses that mean the worker is doing work right now. */
const RUNNING_NATIVE_WORKER_STATUSES: ReadonlySet<string> = new Set(["running", "pending_init"]);
const ACTIVE_ROUTINE_RUN_STATUSES: ReadonlySet<string> = new Set(["starting", "running", "waiting_permission"]);
/** Agent and session lookups that mean the session has no live runtime. */
const NO_LIVE_RUNTIME_CODES: ReadonlySet<string> = new Set([
  "AGENT_NOT_FOUND",
  "BACKGROUND_RUNNER_UNAVAILABLE",
  "SESSION_NOT_FOUND",
]);
const SESSION_LIST_PERSISTED_CURSOR_PREFIX = "agenc-session-list-v1:";
const MAX_PAGES = 50;

function objectOf(value: JsonLike): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayOf(value: JsonLike): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: JsonLike): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * Workers in a `session.snapshot` that are doing work. A reusable worker that
 * finished its assignment is parked as `idle`; finished ones report a final
 * status. A worker without a status cannot be shown to be idle.
 */
export function runningNativeWorkerCount(workers: JsonLike): number {
  return arrayOf(workers).filter((worker) => {
    const status = stringOf(objectOf(worker)?.status);
    return status === undefined || RUNNING_NATIVE_WORKER_STATUSES.has(status);
  }).length;
}

/** Whether a routine (from `routine.list`) has a run in progress. */
export function routineRunIsActive(routine: JsonLike): boolean {
  const status = stringOf(objectOf(objectOf(routine)?.lastRun)?.status);
  return status !== undefined && ACTIVE_ROUTINE_RUN_STATUSES.has(status);
}

/**
 * Attachments that count as clients. Only ids that belong to the requester's
 * conversation can be exempt: a second client following the same
 * conversation keeps its own id and still counts.
 */
export function countedAttachments(
  sessions: readonly JsonLike[],
  exempt?: { readonly attachmentIds: readonly string[]; readonly agentId: string },
): number {
  const exemptIds = new Set(exempt?.attachmentIds ?? []);
  let count = 0;
  for (const session of sessions) {
    const record = objectOf(session);
    const own = exempt !== undefined && stringOf(record?.agentId) === exempt.agentId;
    for (const id of arrayOf(record?.activeAttachmentIds)) {
      if (own && typeof id === "string" && exemptIds.has(id)) continue;
      count += 1;
    }
  }
  return count;
}

/** In-memory daemon state the check reads. */
export interface DaemonIdleSources {
  /** One `session.list` page (never loads saved sessions). */
  readonly listSessions: (cursor: string | undefined) => Promise<{ readonly sessions: readonly JsonLike[]; readonly nextCursor?: string }>;
  /** One `agent.list` page. */
  readonly listAgents: (cursor: string | undefined) => Promise<{ readonly agents: readonly JsonLike[]; readonly nextCursor?: string }>;
  readonly inFlightToolCalls: () => Promise<number>;
  /** Routines whose last run is still in progress (synchronous). */
  readonly activeRoutineRuns: () => number;
  /** Connected remote devices (synchronous). */
  readonly connectedRemoteDevices: () => number;
  /** A loaded session's sub-agents, goal and background processes. */
  readonly sessionDetail: (sessionId: string) => Promise<{
    readonly nativeWorkers: JsonLike;
    readonly goalStatus?: string;
    readonly processes: JsonLike;
  }>;
}

function errorCode(error: unknown): string | undefined {
  const record = objectOf(error);
  return stringOf(record?.code) ?? stringOf(objectOf(record?.data)?.code);
}

/**
 * Why the daemon is busy, or undefined when nothing runs. `exempt` names the
 * requester's own attachments (see {@link countedAttachments}).
 */
export async function daemonBusyReason(
  sources: DaemonIdleSources,
  exempt?: { readonly attachmentIds: readonly string[]; readonly agentId: string },
): Promise<string | undefined> {
  const loaded: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await sources.listSessions(cursor);
    const attached = countedAttachments(result.sessions, exempt);
    if (attached > 0) return `${plural(attached, "client", "clients")} attached`;
    for (const session of result.sessions) {
      const record = objectOf(session);
      const sessionId = stringOf(record?.sessionId);
      const restorePending = objectOf(objectOf(record?.metadata)?.recovery)?.loaded === false;
      if (sessionId !== undefined && !restorePending) loaded.push(sessionId);
    }
    cursor = result.nextCursor;
    // Saved sessions on disk carry no attachment and run nothing.
    if (cursor === undefined || cursor.startsWith(SESSION_LIST_PERSISTED_CURSOR_PREFIX)) break;
    if (page === MAX_PAGES - 1) return "too many sessions to check";
  }
  cursor = undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await sources.listAgents(cursor);
    const working = result.agents.filter((agent) => stringOf(objectOf(agent)?.status) !== "idle").length;
    if (working > 0) return `${plural(working, "agent", "agents")} working`;
    cursor = result.nextCursor;
    if (cursor === undefined) break;
    if (page === MAX_PAGES - 1) return "too many agents to check";
  }
  const toolCalls = await sources.inFlightToolCalls();
  if (toolCalls > 0) return `${plural(toolCalls, "tool call", "tool calls")} in flight`;
  const routines = sources.activeRoutineRuns();
  if (routines > 0) return `${plural(routines, "routine run", "routine runs")} active`;
  const devices = sources.connectedRemoteDevices();
  if (devices > 0) return `${plural(devices, "remote device", "remote devices")} connected`;
  for (const sessionId of loaded) {
    let detail: Awaited<ReturnType<DaemonIdleSources["sessionDetail"]>>;
    try {
      detail = await sources.sessionDetail(sessionId);
    } catch (error) {
      if (NO_LIVE_RUNTIME_CODES.has(errorCode(error) ?? "")) continue;
      // The runner reports a session whose agent is not running this way.
      if (error instanceof Error && error.message.startsWith("AgenC daemon agent not running")) continue;
      return `session ${sessionId} could not be checked`;
    }
    const workers = runningNativeWorkerCount(detail.nativeWorkers);
    if (workers > 0) return `${plural(workers, "sub-agent", "sub-agents")} running`;
    if (detail.goalStatus === "active") return "a goal is active";
    const processes = arrayOf(detail.processes).filter(
      (entry) => stringOf(objectOf(entry)?.status) === "running",
    ).length;
    if (processes > 0) {
      return `${plural(processes, "background process", "background processes")} running`;
    }
  }
  return undefined;
}
