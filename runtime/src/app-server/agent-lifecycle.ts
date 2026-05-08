/**
 * In-memory daemon lifecycle for user-started background agents.
 *
 * F-06a owns the launch path: start the background delegate loop, record its
 * daemon-visible agent summary, and seed the first daemon session with the
 * objective. F-06d adds explicit stop while keeping the final stopped summary
 * available for follow-up inspection.
 */

import { AsyncLock } from "../utils/async-lock.js";
import type {
  AgenCBackgroundAgentSnapshot,
  AgenCBackgroundAgentRunner,
} from "./background-agent-runner.js";
import type {
  AgentAttachParams,
  AgentAttachResult,
  AgentCreateParams,
  AgentCreateResult,
  AgentListParams,
  AgentListResult,
  AgentLogSession,
  AgentLogsParams,
  AgentLogsResult,
  AgentStopParams,
  AgentStopResult,
  AgentStatus,
  AgentSummary,
  AgentToolOutputLog,
  ElicitationRespondParams,
  ElicitationRespondResult,
  JsonObject,
  JsonValue,
  MessageContent,
  PermissionListParams,
  PermissionListResult,
  SessionClearParams,
  SessionClearResult,
  SessionPartialCompactFromMessageParams,
  SessionPartialCompactFromMessageResult,
  SessionRewindConversationToMessageParams,
  SessionRewindConversationToMessageResult,
  SessionSummary,
  ToolApproveParams,
  ToolCancelParams,
  ToolDecisionResult,
  ToolDenyParams,
} from "./protocol/index.js";
import {
  ABORT,
  APPROVED,
  APPROVED_FOR_SESSION,
  DENIED,
} from "../permissions/review-decision.js";
import {
  recordPermissionAuditEvent,
  type PermissionAuditErrorHandler,
  type PermissionAuditLogger,
} from "../permissions/permission-audit-log.js";
import { DEFAULT_UNATTENDED_ALLOWLIST } from "../permissions/unattended-policy.js";
import type { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import {
  ThreadNotFoundError,
  ThreadStoreInvalidRequestError,
  type StoredThread,
  type ThreadSource,
  type ThreadStore,
} from "../thread-store/store.js";
import type { Event } from "../session/event-log.js";
import type { ResponseItem, RolloutItem } from "../session/rollout-item.js";
import type { AgenCStateAgentRunRecord } from "../state/agent-runs.js";

export type AgenCDaemonAgentLifecycleErrorCode =
  | "AGENT_NOT_FOUND"
  | "BACKGROUND_RUNNER_UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR";

export class AgenCDaemonAgentLifecycleError extends Error {
  readonly code: AgenCDaemonAgentLifecycleErrorCode;

  constructor(code: AgenCDaemonAgentLifecycleErrorCode, message: string) {
    super(message);
    this.name = "AgenCDaemonAgentLifecycleError";
    this.code = code;
  }
}

export interface AgenCDaemonAgentManagerOptions {
  readonly defaultCwd?: () => string;
  readonly now?: () => string;
  readonly runner?: AgenCBackgroundAgentRunner;
  readonly sessionManager?: AgenCDaemonSessionManager;
  readonly threadStore?: ThreadStore;
  readonly threadStoreForAgentLogs?: (
    route: AgenCDaemonAgentLogThreadStoreRoute,
  ) => ThreadStore | undefined;
  readonly readAgentToolOutputs?: (
    params: AgenCDaemonAgentToolOutputReadParams,
  ) => Promise<readonly AgentToolOutputLog[]> | readonly AgentToolOutputLog[];
  readonly snapshotFlush?: (
    snapshot: AgenCDaemonAgentSnapshotFlush,
  ) => void | Promise<void>;
  readonly broadcastSessionEvent?: (
    sessionId: string,
    event: JsonObject,
  ) => void | Promise<void>;
  readonly recordMessageExchange?: (
    exchange: AgenCDaemonMessageExchangeSnapshot,
  ) => void | Promise<void>;
  readonly recordAgentStatusTransition?: (
    transition: AgenCDaemonAgentStatusSnapshot,
  ) => void | Promise<void>;
  readonly recordAgentRun?: (
    run: AgenCDaemonAgentRunSnapshot,
  ) => void | Promise<void>;
  readonly registerSnapshotSession?: (
    session: AgenCDaemonSnapshotSessionRoute,
  ) => void | Promise<void>;
  readonly onSnapshotError?: (error: unknown) => void;
  readonly permissionAuditLogger?: PermissionAuditLogger;
  readonly onPermissionAuditError?: PermissionAuditErrorHandler;
}

export interface AgenCDaemonAgentToolOutputReadParams {
  readonly agentId: string;
  readonly sessionIds: readonly string[];
}

export interface AgenCDaemonAgentLogThreadStoreRoute {
  readonly agentId: string;
  readonly sessionIds: readonly string[];
  readonly cwd?: string;
  readonly stateProjectDir?: string;
}

export interface AgenCDaemonMessageExchangeSnapshot {
  readonly sessionId: string;
  readonly agentId: string;
  readonly cwd?: string;
  readonly stateProjectDir?: string;
  readonly content: JsonValue;
  readonly messageId: string;
  readonly streamId: string;
  readonly acceptedAt: string;
}

export interface AgenCDaemonAgentStatusSnapshot {
  readonly sessionId: string;
  readonly agentId: string;
  readonly cwd?: string;
  readonly stateProjectDir?: string;
  readonly status: AgentStatus;
  readonly runStatus?: string;
  readonly transitionAt: string;
  readonly reason?: string;
  readonly metadataPatch?: JsonObject;
}

export interface AgenCDaemonAgentRunSnapshot
  extends AgenCStateAgentRunRecord {
  readonly cwd?: string;
  readonly stateProjectDir?: string;
}

export interface AgenCDaemonSnapshotSessionRoute {
  readonly sessionId: string;
  readonly agentId: string;
  readonly cwd?: string;
  readonly stateProjectDir?: string;
}

export interface AgenCDaemonAgentSnapshotFlush extends JsonObject {
  readonly reason: string;
  readonly flushedAt: string;
  readonly agents: readonly AgentSummary[];
}

export interface AgenCDaemonAgentRestoreRecord {
  readonly agentId: string;
  readonly objective: string;
  readonly status?: AgentStatus;
  readonly createdAt?: string;
  readonly startedAt?: string;
  readonly lastActiveAt?: string;
  readonly cwd?: string;
  readonly stateProjectDir?: string;
  readonly metadata?: JsonObject;
  readonly sessionIds?: readonly string[];
  readonly runtimeAvailable?: boolean;
}

interface MutableAgent {
  agentId: string;
  agentPath?: string;
  objective: string;
  status: AgentStatus;
  createdAt: string;
  startedAt: string;
  lastActiveAt: string;
  cwd?: string;
  stateProjectDir?: string;
  metadata?: JsonObject;
  sessionIds: string[];
  logSessionIds: string[];
  recovered?: boolean;
  runtimeAvailable?: boolean;
}

interface AgenCDaemonSnapshotRoute {
  readonly cwd?: string;
  readonly stateProjectDir?: string;
}

interface AgentAttachmentTarget {
  readonly agentId: string;
  readonly sessionIds: readonly string[];
}

interface AgentLifecycleState {
  agents: Map<string, MutableAgent>;
}

export class AgenCDaemonAgentManager {
  readonly #defaultCwd: () => string;
  readonly #now: () => string;
  readonly #runner: AgenCBackgroundAgentRunner | undefined;
  readonly #sessionManager: AgenCDaemonSessionManager | undefined;
  readonly #threadStore: ThreadStore | undefined;
  readonly #threadStoreForAgentLogs:
    | ((route: AgenCDaemonAgentLogThreadStoreRoute) => ThreadStore | undefined)
    | undefined;
  readonly #readAgentToolOutputs:
    | ((
        params: AgenCDaemonAgentToolOutputReadParams,
      ) =>
        | Promise<readonly AgentToolOutputLog[]>
        | readonly AgentToolOutputLog[])
    | undefined;
  readonly #snapshotFlush:
    | ((snapshot: AgenCDaemonAgentSnapshotFlush) => void | Promise<void>)
    | undefined;
  readonly #broadcastSessionEvent:
    | ((sessionId: string, event: JsonObject) => void | Promise<void>)
    | undefined;
  readonly #recordMessageExchange:
    | ((exchange: AgenCDaemonMessageExchangeSnapshot) => void | Promise<void>)
    | undefined;
  readonly #recordAgentStatusTransition:
    | ((transition: AgenCDaemonAgentStatusSnapshot) => void | Promise<void>)
    | undefined;
  readonly #recordAgentRun:
    | ((run: AgenCDaemonAgentRunSnapshot) => void | Promise<void>)
    | undefined;
  readonly #registerSnapshotSession:
    | ((session: AgenCDaemonSnapshotSessionRoute) => void | Promise<void>)
    | undefined;
  readonly #onSnapshotError: (error: unknown) => void;
  readonly #permissionAuditLogger: PermissionAuditLogger | undefined;
  readonly #onPermissionAuditError: PermissionAuditErrorHandler | undefined;
  #shuttingDown = false;
  #activeCreates = 0;
  readonly #createWaiters = new Set<() => void>();
  readonly #state = new AsyncLock<AgentLifecycleState>({
    agents: new Map(),
  });

  constructor(options: AgenCDaemonAgentManagerOptions = {}) {
    this.#defaultCwd = options.defaultCwd ?? (() => process.cwd());
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#runner = options.runner;
    this.#sessionManager = options.sessionManager;
    this.#threadStore = options.threadStore;
    this.#threadStoreForAgentLogs = options.threadStoreForAgentLogs;
    this.#readAgentToolOutputs = options.readAgentToolOutputs;
    this.#snapshotFlush = options.snapshotFlush;
    this.#broadcastSessionEvent = options.broadcastSessionEvent;
    this.#recordMessageExchange = options.recordMessageExchange;
    this.#recordAgentStatusTransition = options.recordAgentStatusTransition;
    this.#recordAgentRun = options.recordAgentRun;
    this.#registerSnapshotSession = options.registerSnapshotSession;
    this.#onSnapshotError = options.onSnapshotError ?? (() => {});
    this.#permissionAuditLogger = options.permissionAuditLogger;
    this.#onPermissionAuditError = options.onPermissionAuditError;
  }

  async createAgent(params: AgentCreateParams): Promise<AgentCreateResult> {
    const finishCreate = this.#beginCreate();
    if (this.#runner === undefined) {
      finishCreate();
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "agent.start requires a background runner",
      );
    }
    try {
      const objective = normalizeObjective(params);
      const createdAt = this.#now();
      const cwd = normalizeNonEmpty(params.cwd) ?? this.#defaultCwd();
      const unattendedAllow = normalizeStringList(
        params.unattendedAllow,
        DEFAULT_UNATTENDED_ALLOWLIST,
      );
      const unattendedDeny = normalizeStringList(params.unattendedDeny, []);
      const metadata: JsonObject = {
        ...(params.metadata ?? {}),
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.provider !== undefined ? { provider: params.provider } : {}),
        ...(params.profile !== undefined ? { profile: params.profile } : {}),
        unattendedAllow,
        unattendedDeny,
      };
      const started = await this.#runner.startAgent({
        objective,
        cwd,
        ...(params.model !== undefined ? { model: params.model } : {}),
        ...(params.provider !== undefined ? { provider: params.provider } : {}),
        ...(params.profile !== undefined ? { profile: params.profile } : {}),
        ...(params.initialContent !== undefined
          ? { initialContent: params.initialContent }
          : {}),
        metadata,
        unattendedAllow,
        unattendedDeny,
        ...(params.permissionMode !== undefined
          ? { permissionMode: params.permissionMode }
          : {}),
      });

      if (this.#shuttingDown) {
        await this.#runner.stopAgent?.(started.agentId, "daemon_shutdown");
        throw new AgenCDaemonAgentLifecycleError(
          "INVALID_ARGUMENT",
          "agent.start cancelled because the daemon is shutting down",
        );
      }

      const agent: MutableAgent = {
        agentId: started.agentId,
        ...(started.agentPath !== undefined
          ? { agentPath: started.agentPath }
          : {}),
        objective,
        status: started.status,
        createdAt,
        startedAt: started.startedAt,
        lastActiveAt: started.startedAt,
        sessionIds: [],
        logSessionIds: [],
        cwd,
        metadata,
      };

      try {
        if (this.#sessionManager !== undefined) {
          const session = await this.#sessionManager.createSession({
            agentId: agent.agentId,
            cwd: agent.cwd,
            initialPrompt: objective,
            metadata: {
              ...(params.metadata ?? {}),
              objective,
              source: "agent.start",
              unattendedAllow,
              unattendedDeny,
            },
          });
          agent.sessionIds.push(session.sessionId);
          agent.logSessionIds.push(session.sessionId);
          await this.#registerSnapshotSessionRoute(session.sessionId, agent);
        }
        await this.#recordAgentRunSnapshot(agent, { required: true });
        await this.#recordAgentStatusSnapshots(
          agent.sessionIds,
          agent.agentId,
          agent.status,
          agent.lastActiveAt,
          undefined,
          snapshotRouteForAgent(agent),
        );
        if (this.#sessionManager !== undefined) {
          for (const sessionId of agent.sessionIds) {
            await this.#runner.attachAgentSessionEvents?.(agent.agentId, {
              sessionId,
              emit: (event) => this.#broadcastSessionEvent?.(sessionId, event),
            });
          }
        }

        const result = await this.#state.with((state) => {
          state.agents.set(agent.agentId, agent);
          return toAgentCreateResult(agent);
        });
        return result;
      } catch (error) {
        await this.#runner.stopAgent?.(
          agent.agentId,
          "agent.create rollback after lifecycle failure",
        );
        await this.#recordAgentStatusSnapshots(
          agent.sessionIds,
          agent.agentId,
          "error",
          this.#now(),
          "agent.create rollback after lifecycle failure",
          snapshotRouteForAgent(agent),
        );
        throw error;
      }
    } finally {
      finishCreate();
    }
  }

  async restoreAgent(
    record: AgenCDaemonAgentRestoreRecord,
  ): Promise<AgentSummary> {
    const agentId = normalizeNonEmpty(record.agentId);
    const objective = normalizeNonEmpty(record.objective);
    if (agentId === undefined || objective === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "agent restore requires agentId and objective",
      );
    }
    const createdAt = normalizeNonEmpty(record.createdAt) ?? this.#now();
    const startedAt = normalizeNonEmpty(record.startedAt) ?? createdAt;
    const lastActiveAt = normalizeNonEmpty(record.lastActiveAt) ?? startedAt;
    const agent: MutableAgent = {
      agentId,
      objective,
      status: record.status ?? "running",
      createdAt,
      startedAt,
      lastActiveAt,
      sessionIds: normalizeStringList(record.sessionIds, []),
      logSessionIds: normalizeStringList(record.sessionIds, []),
      recovered: true,
      runtimeAvailable: record.runtimeAvailable === true,
    };
    if (record.cwd !== undefined) agent.cwd = record.cwd;
    if (record.stateProjectDir !== undefined) {
      agent.stateProjectDir = record.stateProjectDir;
    }
    if (record.metadata !== undefined) agent.metadata = record.metadata;

    let inserted: MutableAgent | undefined;
    const summary = await this.#state.with((state) => {
      const existing = state.agents.get(agentId);
      if (existing !== undefined) return toAgentSummary(existing);
      state.agents.set(agentId, agent);
      inserted = agent;
      return toAgentSummary(agent);
    });
    if (inserted?.runtimeAvailable === true) {
      for (const sessionId of inserted.sessionIds) {
        await this.#runner?.attachAgentSessionEvents?.(inserted.agentId, {
          sessionId,
          emit: (event) => this.#broadcastSessionEvent?.(sessionId, event),
        });
      }
    }
    return summary;
  }

  #beginCreate(): () => void {
    if (this.#shuttingDown) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "agent.start rejected because the daemon is shutting down",
      );
    }
    this.#activeCreates += 1;
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      this.#activeCreates -= 1;
      if (this.#activeCreates === 0) {
        for (const waiter of this.#createWaiters) {
          waiter();
        }
        this.#createWaiters.clear();
      }
    };
  }

  async #waitForActiveCreates(): Promise<void> {
    if (this.#activeCreates === 0) return;
    await new Promise<void>((resolve) => {
      this.#createWaiters.add(resolve);
    });
  }

  async listAgents(params: AgentListParams = {}): Promise<AgentListResult> {
    return this.#state.with(async (state) => {
      await this.#refreshAgentsFromRunner(state);
      const cursor = normalizeCursor(params.cursor);
      const limit = normalizeLimit(params.limit);
      const agents = [...state.agents.values()]
        .filter(isActiveAgent)
        .concat(this.#listPersistedAgents(state))
        .sort(compareAgentsForList);
      const pageStart =
        cursor === undefined
          ? 0
          : agents.findIndex((agent) => agent.agentId > cursor);
      const page =
        pageStart < 0 ? [] : agents.slice(pageStart, pageStart + limit);
      const nextCursor =
        pageStart >= 0 && pageStart + limit < agents.length
          ? page.at(-1)?.agentId
          : undefined;
      return {
        agents: page.map(toAgentSummary),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    });
  }

  #listPersistedAgents(state: AgentLifecycleState): MutableAgent[] {
    if (this.#threadStore === undefined) return [];
    const result: MutableAgent[] = [];
    let cursor: string | undefined;
    do {
      const page = this.#threadStore.listThreads({
        pageSize: 500,
        archived: false,
        useStateDbOnly: true,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const thread of page.items) {
        const agent = storedThreadToAgent(thread);
        if (agent === undefined || state.agents.has(agent.agentId)) continue;
        result.push(agent);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return result;
  }

  async attachAgent(params: AgentAttachParams): Promise<AgentAttachResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "agent.attach requires a daemon session manager",
      );
    }

    const target = await this.#resolveAttachmentTarget(params.agentId);
    const sessions = (
      await Promise.all(
        target.sessionIds.map((sessionId) =>
          this.#sessionManager!.getSession(sessionId),
        ),
      )
    ).filter(
      (session): session is SessionSummary =>
        session !== null && isActiveSession(session),
    );
    const session = newestSession(sessions);
    if (session === null) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon agent has no active session: ${params.agentId}`,
      );
    }

    const attachment = await this.#sessionManager.attachSession({
      sessionId: session.sessionId,
      ...(params.clientId !== undefined ? { clientId: params.clientId } : {}),
    });
    const orderedSessionIds = [
      session.sessionId,
      ...sessions
        .map((activeSession) => activeSession.sessionId)
        .filter((sessionId) => sessionId !== session.sessionId),
    ];
    const attachedSessions = (
      await Promise.all(
        orderedSessionIds.map((sessionId) =>
          this.#sessionManager!.getSession(sessionId),
        ),
      )
    ).filter(
      (activeSession): activeSession is SessionSummary =>
        activeSession !== null && isActiveSession(activeSession),
    );
    return {
      agentId: target.agentId,
      attachmentId: attachment.attachmentId,
      sessionIds: orderedSessionIds,
      runtimeSessionId: target.agentId,
      sessions: attachedSessions,
    };
  }

  async getAgent(agentId: string): Promise<AgentSummary | null> {
    return this.#state.with(async (state) => {
      const agent = state.agents.get(agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(agentId);
      return refreshed === undefined ? null : toAgentSummary(refreshed);
    });
  }

  async getAgentLogs(params: AgentLogsParams): Promise<AgentLogsResult> {
    const agentId = normalizeRequiredAgentId(params.agentId, "agent.logs");
    const target = await this.#state.with(async (state) => {
      const agent = state.agents.get(agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(agentId);
      if (refreshed !== undefined) {
        return {
          sessionIds: logSessionIdsForAgent(refreshed),
          ...snapshotRouteForAgent(refreshed),
        };
      }
      const persisted = this.#listPersistedAgents(state).find(
        (agent) => agent.agentId === agentId,
      );
      return persisted === undefined
        ? null
        : {
            sessionIds: logSessionIdsForAgent(persisted),
            ...snapshotRouteForAgent(persisted),
          };
    });
    if (target === null) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon agent not found: ${agentId}`,
      );
    }

    const sessionIds = uniqueNonEmptyStrings([agentId, ...target.sessionIds]);
    const sessions = this.#readLogSessions({
      agentId,
      sessionIds,
      ...(target.cwd !== undefined ? { cwd: target.cwd } : {}),
      ...(target.stateProjectDir !== undefined
        ? { stateProjectDir: target.stateProjectDir }
        : {}),
    });

    const toolOutputs =
      this.#readAgentToolOutputs === undefined
        ? []
        : [
            ...(await this.#readAgentToolOutputs({
              agentId,
              sessionIds,
            })),
          ];
    const transcript = formatAgentLogsTranscript(
      agentId,
      sessions,
      toolOutputs,
    );
    return {
      agentId,
      transcript,
      sessions,
      ...(toolOutputs.length > 0 ? { toolOutputs } : {}),
    };
  }

  #readLogSessions(
    route: AgenCDaemonAgentLogThreadStoreRoute,
  ): AgentLogSession[] {
    const threadStore =
      this.#threadStoreForAgentLogs?.(route) ?? this.#threadStore;
    if (threadStore === undefined) return [];
    const sessions: AgentLogSession[] = [];
    const seen = new Set<string>();
    for (const sessionId of route.sessionIds) {
      if (seen.has(sessionId)) continue;
      seen.add(sessionId);
      try {
        const thread = threadStore.readThread({
          threadId: sessionId,
          includeArchived: true,
          includeHistory: true,
        });
        sessions.push(storedThreadToAgentLogSession(thread));
      } catch (error) {
        if (isThreadLogReadMiss(error)) continue;
        throw error;
      }
    }
    return sessions;
  }

  async stopAgent(params: AgentStopParams): Promise<AgentStopResult> {
    const agentId = normalizeRequiredAgentId(params.agentId, "agent.stop");
    const reason = normalizeNonEmpty(params.reason) ?? "agent.stop";
    const runner = this.#runner;
    const stopRunner = runner?.stopAgent?.bind(runner);
    let transitionAt: string | undefined;
    const target = await this.#state.with(async (state) => {
      const agent = state.agents.get(agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(agentId);
      if (refreshed === undefined) {
        throw new AgenCDaemonAgentLifecycleError(
          "AGENT_NOT_FOUND",
          `AgenC daemon agent not found: ${agentId}`,
        );
      }
      if (!isActiveAgent(refreshed)) {
        return null;
      }
      if (stopRunner === undefined) {
        throw new AgenCDaemonAgentLifecycleError(
          "BACKGROUND_RUNNER_UNAVAILABLE",
          "agent.stop requires a background runner",
        );
      }
      transitionAt = this.#now();
      refreshed.status = "stopping";
      refreshed.lastActiveAt = transitionAt;
      return {
        sessionIds: [...refreshed.sessionIds],
        route: snapshotRouteForAgent(refreshed),
      };
    });

    if (target === null) {
      return { agentId, stopped: false };
    }
    await this.#recordAgentStatusSnapshots(
      target.sessionIds,
      agentId,
      "stopping",
      transitionAt ?? this.#now(),
      reason,
      target.route,
    );
    if (stopRunner === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "agent.stop requires a background runner",
      );
    }
    try {
      await stopRunner(agentId, reason);
    } catch (error) {
      const failedAt = transitionAt ?? this.#now();
      await this.#markAgentStopFailed(agentId, failedAt);
      await this.#recordAgentStatusSnapshots(
        target.sessionIds,
        agentId,
        "error",
        failedAt,
        reason,
        target.route,
      );
      throw error;
    }

    const stoppedAt = transitionAt ?? this.#now();
    await this.#state.with((state) => {
      const agent = state.agents.get(agentId);
      if (agent === undefined) return;
      agent.status = "stopped";
      agent.lastActiveAt = stoppedAt;
      agent.logSessionIds = uniqueNonEmptyStrings([
        ...agent.logSessionIds,
        ...agent.sessionIds,
      ]);
      agent.sessionIds = [];
    });
    await this.#recordAgentStatusSnapshots(
      target.sessionIds,
      agentId,
      "stopped",
      stoppedAt,
      reason,
      target.route,
    );
    await this.#terminateAgentSessions(target.sessionIds, reason);
    return { agentId, stopped: true };
  }

  async stopAll(reason = "daemon_shutdown"): Promise<number> {
    this.#shuttingDown = true;
    await this.#waitForActiveCreates();
    const targets = await this.#state.with(async (state) => {
      await this.#refreshAgentsFromRunner(state);
      return [...state.agents.values()].filter(isActiveAgent).map((agent) => ({
        agentId: agent.agentId,
        sessionIds: [...agent.sessionIds],
        route: snapshotRouteForAgent(agent),
      }));
    });
    const failures: Array<{
      readonly agentId: string;
      readonly error: unknown;
    }> = [];
    let stopped = 0;
    for (const target of targets) {
      const stopRunner = this.#runner?.stopAgent?.bind(this.#runner);
      let stopFailed = false;
      if (stopRunner !== undefined) {
        try {
          await stopRunner(target.agentId, reason);
        } catch (error) {
          stopFailed = true;
          failures.push({ agentId: target.agentId, error });
        }
      }
      const stoppedAt = this.#now();
      const finalStatus = stopFailed ? "error" : "stopped";
      await this.#state.with((state) => {
        const agent = state.agents.get(target.agentId);
        if (agent === undefined) return;
        agent.status = finalStatus;
        agent.lastActiveAt = stoppedAt;
        agent.logSessionIds = uniqueNonEmptyStrings([
          ...agent.logSessionIds,
          ...agent.sessionIds,
        ]);
        agent.sessionIds = [];
      });
      await this.#recordAgentStatusSnapshots(
        target.sessionIds,
        target.agentId,
        finalStatus,
        stoppedAt,
        reason,
        target.route,
      );
      try {
        await this.#terminateAgentSessions(target.sessionIds, reason);
      } catch (error) {
        failures.push({ agentId: target.agentId, error });
      }
      stopped += 1;
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.error),
        `AgenC daemon cleanup failed for ${failures.length} agent(s): ${failures
          .map((failure) => failure.agentId)
          .join(", ")}`,
      );
    }
    return stopped;
  }

  async flushSnapshots(reason = "daemon_shutdown"): Promise<number> {
    const flushedAt = this.#now();
    const agents = await this.#state.with((state) =>
      [...state.agents.values()].map(toAgentSummary),
    );
    await this.#snapshotFlush?.({ reason, flushedAt, agents });
    return agents.length;
  }

  async listPermissions(
    params: PermissionListParams = {},
  ): Promise<PermissionListResult> {
    if (this.#runner?.listPermissions === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "permission.list requires a background runner",
      );
    }
    const agentId = await this.#resolvePermissionListAgentId(params);
    const result = await this.#runner.listPermissions(agentId);
    if (result === null) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon agent not found: ${agentId}`,
      );
    }
    return result;
  }

  async approveTool(params: ToolApproveParams): Promise<ToolDecisionResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
    );
    const resolved = await this.#runner!.resolveToolDecision!(agentId, {
      requestId: params.requestId,
      decision:
        params.scope === "session" || params.scope === "agent"
          ? APPROVED_FOR_SESSION
          : APPROVED,
    });
    if (!resolved) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `AgenC daemon tool request is not pending: ${params.requestId}`,
      );
    }
    await this.#recordToolDecisionAudit({
      decision: "approved",
      sessionId: params.sessionId,
      agentId,
      requestId: params.requestId,
      ...(params.scope !== undefined ? { scope: params.scope } : {}),
      reasonCode:
        params.scope === "session" || params.scope === "agent"
          ? "rpc_approved_for_scope"
          : "rpc_approved_once",
    });
    return { requestId: params.requestId, decision: "approved" };
  }

  async denyTool(params: ToolDenyParams): Promise<ToolDecisionResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
    );
    const resolved = await this.#runner!.resolveToolDecision!(agentId, {
      requestId: params.requestId,
      decision: DENIED,
    });
    if (!resolved) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `AgenC daemon tool request is not pending: ${params.requestId}`,
      );
    }
    await this.#recordToolDecisionAudit({
      decision: "denied",
      sessionId: params.sessionId,
      agentId,
      requestId: params.requestId,
      reasonCode: "rpc_denied",
    });
    return { requestId: params.requestId, decision: "denied" };
  }

  async cancelTool(params: ToolCancelParams): Promise<ToolDecisionResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      {
        allowCancelTool: true,
      },
    );
    let resolved = false;
    if (this.#runner!.cancelTool !== undefined) {
      resolved = await this.#runner!.cancelTool(agentId, {
        requestId: params.requestId,
        ...(params.reason !== undefined ? { reason: params.reason } : {}),
      });
    }
    if (!resolved && this.#runner!.resolveToolDecision !== undefined) {
      resolved = await this.#runner!.resolveToolDecision(agentId, {
        requestId: params.requestId,
        decision: ABORT,
      });
    }
    if (!resolved) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `AgenC daemon tool request is not pending: ${params.requestId}`,
      );
    }
    return { requestId: params.requestId, decision: "cancelled" };
  }

  async respondToElicitation(
    params: ElicitationRespondParams,
  ): Promise<ElicitationRespondResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowElicitationResponse: true },
    );
    const resolved = await this.#runner!.respondToElicitation!(agentId, {
      requestId: params.requestId,
      kind: params.kind,
      ...(params.serverName !== undefined ? { serverName: params.serverName } : {}),
      response: params.response,
    });
    if (!resolved) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `AgenC daemon elicitation request is not pending: ${String(params.requestId)}`,
      );
    }
    return { requestId: params.requestId, resolved };
  }

  async clearSessionHistory(
    params: SessionClearParams,
  ): Promise<SessionClearResult> {
    const clearedAt = this.#now();
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.clear requires a daemon session manager",
      );
    }
    if (this.#runner?.clearAgentSession === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.clear requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowClearSession: true },
    );
    await this.#runner.clearAgentSession(agentId, {
      sessionId: params.sessionId,
      clearedAt,
    });
    return {
      sessionId: params.sessionId,
      cleared: true,
      clearedAt,
    };
  }

  async partialCompactFromMessage(
    params: SessionPartialCompactFromMessageParams,
    signal?: AbortSignal,
  ): Promise<SessionPartialCompactFromMessageResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.partialCompactFromMessage requires a daemon session manager",
      );
    }
    if (this.#runner?.partialCompactFromMessage === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.partialCompactFromMessage requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowPartialCompact: true },
    );
    return await this.#runner.partialCompactFromMessage(agentId, {
      sessionId: params.sessionId,
      messageOrdinal: params.messageOrdinal,
      direction: params.direction,
      ...(params.feedback !== undefined ? { feedback: params.feedback } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
  }

  async rewindConversationToMessage(
    params: SessionRewindConversationToMessageParams,
  ): Promise<SessionRewindConversationToMessageResult> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "session.rewindConversationToMessage requires a daemon session manager",
      );
    }
    if (this.#runner?.rewindConversationToMessage === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session.rewindConversationToMessage requires a background runner",
      );
    }
    const agentId = await this.#resolveActiveAgentIdForSession(
      params.sessionId,
      { allowConversationRewind: true },
    );
    return await this.#runner.rewindConversationToMessage(agentId, {
      sessionId: params.sessionId,
      messageOrdinal: params.messageOrdinal,
    });
  }

  async streamAgentMessage(params: {
    readonly sessionId: string;
    readonly content: MessageContent;
    readonly messageId: string;
    readonly streamId: string;
    readonly acceptedAt: string;
    readonly displayUserMessage?: string | null;
    readonly methodName?: "message.send" | "message.stream";
  }): Promise<void> {
    const methodName = params.methodName ?? "message.stream";
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        `${methodName} requires a daemon session manager`,
      );
    }
    if (this.#runner?.submitAgentMessage === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        `${methodName} requires a background runner`,
      );
    }

    const session = await this.#sessionManager.getSession(params.sessionId);
    if (session === null || !isActiveSession(session)) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon session not found or closed: ${params.sessionId}`,
      );
    }

    const messageTarget = await this.#state.with(async (state) => {
      const agent = state.agents.get(session.agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(session.agentId);
      if (refreshed === undefined || !isActiveAgent(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "AGENT_NOT_FOUND",
          `AgenC daemon agent not found: ${session.agentId}`,
        );
      }
      return {
        recoveredRuntimeUnavailable: isRecoveredRuntimeUnavailable(refreshed),
        route: snapshotRouteForAgent(refreshed),
      };
    });
    if (messageTarget.recoveredRuntimeUnavailable) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        `AgenC daemon agent recovered without a live runtime: ${session.agentId}`,
      );
    }

    await this.#runner.submitAgentMessage(session.agentId, {
      sessionId: params.sessionId,
      content: params.content,
      originalContent: params.content,
      ...(params.displayUserMessage !== undefined
        ? { displayUserMessage: params.displayUserMessage }
        : {}),
      messageId: params.messageId,
      streamId: params.streamId,
      acceptedAt: params.acceptedAt,
    });
    await this.#recordMessageExchangeSnapshot({
      sessionId: params.sessionId,
      agentId: session.agentId,
      ...messageTarget.route,
      content: params.content as JsonValue,
      messageId: params.messageId,
      streamId: params.streamId,
      acceptedAt: params.acceptedAt,
    });
  }

  async #refreshAgentsFromRunner(state: AgentLifecycleState): Promise<void> {
    for (const agent of [...state.agents.values()]) {
      await this.#refreshAgentFromRunner(state, agent);
    }
  }

  async #recordAgentStatusSnapshots(
    sessionIds: readonly string[],
    agentId: string,
    status: AgentStatus,
    transitionAt: string,
    reason?: string,
    route: AgenCDaemonSnapshotRoute = {},
    metadataPatch?: JsonObject,
  ): Promise<void> {
    if (this.#recordAgentStatusTransition === undefined) return;
    for (const sessionId of sessionIds) {
      try {
        await this.#recordAgentStatusTransition({
          sessionId,
          agentId,
          ...route,
          status,
          transitionAt,
          ...(reason !== undefined ? { reason } : {}),
          ...(metadataPatch !== undefined ? { metadataPatch } : {}),
        });
      } catch (error) {
        this.#onSnapshotError(error);
      }
    }
  }

  async #recordAgentRunSnapshot(
    agent: MutableAgent,
    options: { readonly required?: boolean } = {},
  ): Promise<void> {
    if (this.#recordAgentRun === undefined) return;
    try {
      const currentSessionId = latestSessionIdForAgentRun(agent);
      await this.#recordAgentRun({
        id: agent.agentId,
        objective: agent.objective,
        status: "running",
        startedAt: agent.startedAt,
        lastActiveAt: agent.lastActiveAt,
        ...(currentSessionId !== undefined ? { currentSessionId } : {}),
        metadata: agentRunMetadata(agent),
        ...snapshotRouteForAgent(agent),
      });
    } catch (error) {
      if (options.required === true) throw error;
      this.#onSnapshotError(error);
    }
  }

  async #recordMessageExchangeSnapshot(
    exchange: AgenCDaemonMessageExchangeSnapshot,
  ): Promise<void> {
    if (this.#recordMessageExchange === undefined) return;
    try {
      await this.#recordMessageExchange(exchange);
    } catch (error) {
      this.#onSnapshotError(error);
    }
  }

  async #registerSnapshotSessionRoute(
    sessionId: string,
    agent: MutableAgent,
  ): Promise<void> {
    if (this.#registerSnapshotSession === undefined) return;
    try {
      await this.#registerSnapshotSession({
        sessionId,
        agentId: agent.agentId,
        ...snapshotRouteForAgent(agent),
      });
    } catch (error) {
      this.#onSnapshotError(error);
    }
  }

  async #resolveActiveAgentIdForSession(
    sessionId: string,
    options: {
      readonly allowCancelTool?: boolean;
      readonly allowClearSession?: boolean;
      readonly allowElicitationResponse?: boolean;
      readonly allowListPermissions?: boolean;
      readonly allowPartialCompact?: boolean;
      readonly allowConversationRewind?: boolean;
    } = {},
  ): Promise<string> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "tool decision requires a daemon session manager",
      );
    }
    const hasToolDecisionRunner = this.#runner?.resolveToolDecision !== undefined;
    const hasCancelRunner =
      options.allowCancelTool === true &&
      this.#runner?.cancelTool !== undefined;
    const hasElicitationRunner =
      options.allowElicitationResponse === true &&
      this.#runner?.respondToElicitation !== undefined;
    const hasClearSessionRunner =
      options.allowClearSession === true &&
      this.#runner?.clearAgentSession !== undefined;
    const hasPermissionListRunner =
      options.allowListPermissions === true &&
      this.#runner?.listPermissions !== undefined;
    const hasPartialCompactRunner =
      options.allowPartialCompact === true &&
      this.#runner?.partialCompactFromMessage !== undefined;
    const hasConversationRewindRunner =
      options.allowConversationRewind === true &&
      this.#runner?.rewindConversationToMessage !== undefined;
    if (
      !hasToolDecisionRunner &&
      !hasCancelRunner &&
      !hasElicitationRunner &&
      !hasClearSessionRunner &&
      !hasPermissionListRunner &&
      !hasPartialCompactRunner &&
      !hasConversationRewindRunner
    ) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "session request requires a background runner",
      );
    }

    const session = await this.#sessionManager.getSession(sessionId);
    if (session === null || !isActiveSession(session)) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon session not found or closed: ${sessionId}`,
      );
    }
    await this.#state.with(async (state) => {
      const agent = state.agents.get(session.agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(session.agentId);
      if (refreshed === undefined || !isActiveAgent(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "AGENT_NOT_FOUND",
          `AgenC daemon agent not found: ${session.agentId}`,
        );
      }
      if (isRecoveredRuntimeUnavailable(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "BACKGROUND_RUNNER_UNAVAILABLE",
          `AgenC daemon agent recovered without a live runtime: ${session.agentId}`,
        );
      }
    });
    return session.agentId;
  }

  async #recordToolDecisionAudit(params: {
    readonly decision: "approved" | "denied";
    readonly sessionId: string;
    readonly agentId: string;
    readonly requestId: string;
    readonly reasonCode: string;
    readonly scope?: string;
  }): Promise<void> {
    await recordPermissionAuditEvent(
      this.#permissionAuditLogger,
      {
        eventKind: "user_decision",
        decision: params.decision,
        source: "daemon-rpc",
        subjectType: "tool_request",
        sessionId: params.sessionId,
        agentId: params.agentId,
        requestId: params.requestId,
        reasonCode: params.reasonCode,
        ...(params.scope !== undefined ? { scope: params.scope } : {}),
      },
      this.#onPermissionAuditError,
    );
  }

  async #resolvePermissionListAgentId(
    params: PermissionListParams,
  ): Promise<string> {
    const agentId = normalizeNonEmpty(params.agentId);
    const sessionId = normalizeNonEmpty(params.sessionId);
    if (agentId !== undefined && sessionId !== undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "permission.list accepts agentId or sessionId, not both",
      );
    }
    if (sessionId !== undefined) {
      return this.#resolveActiveAgentIdForSession(sessionId, {
        allowListPermissions: true,
      });
    }
    if (agentId === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "permission.list requires agentId or sessionId",
      );
    }
    await this.#state.with(async (state) => {
      const agent = state.agents.get(agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(agentId);
      if (refreshed === undefined || !isActiveAgent(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "AGENT_NOT_FOUND",
          `AgenC daemon agent not found: ${agentId}`,
        );
      }
      if (isRecoveredRuntimeUnavailable(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "BACKGROUND_RUNNER_UNAVAILABLE",
          `AgenC daemon agent recovered without a live runtime: ${agentId}`,
        );
      }
    });
    return agentId;
  }

  async #refreshAgentFromRunner(
    state: AgentLifecycleState,
    agent: MutableAgent,
  ): Promise<void> {
    if (!isActiveAgent(agent)) return;
    const snapshot = await this.#runner?.getAgentSnapshot?.(agent.agentId);
    if (snapshot === undefined) return;
    if (snapshot === null) {
      if (agent.recovered === true) return;
      state.agents.delete(agent.agentId);
      return;
    }
    const previousStatus = agent.status;
    const sessionIds = [...agent.sessionIds];
    agent.recovered = false;
    agent.runtimeAvailable = true;
    applyAgentSnapshot(agent, snapshot);
    if (agent.status !== previousStatus) {
      await this.#recordAgentStatusSnapshots(
        sessionIds,
        agent.agentId,
        agent.status,
        agent.lastActiveAt,
        undefined,
        snapshotRouteForAgent(agent),
        snapshot.metadata,
      );
    }
  }

  async #resolveAttachmentTarget(
    agentId: string,
  ): Promise<AgentAttachmentTarget> {
    return this.#state.with(async (state) => {
      const agent = state.agents.get(agentId);
      if (agent !== undefined) {
        await this.#refreshAgentFromRunner(state, agent);
      }
      const refreshed = state.agents.get(agentId);
      if (refreshed === undefined || !isActiveAgent(refreshed)) {
        throw new AgenCDaemonAgentLifecycleError(
          "AGENT_NOT_FOUND",
          `AgenC daemon agent not found: ${agentId}`,
        );
      }
      return {
        agentId: refreshed.agentId,
        sessionIds: [...refreshed.sessionIds],
      };
    });
  }

  async #terminateAgentSessions(
    sessionIds: readonly string[],
    reason: string,
  ): Promise<void> {
    if (this.#sessionManager === undefined) return;
    for (const sessionId of sessionIds) {
      await this.#sessionManager.terminateSession({ sessionId, reason });
    }
  }

  async #markAgentStopFailed(
    agentId: string,
    failedAt: string | undefined,
  ): Promise<void> {
    await this.#state.with((state) => {
      const agent = state.agents.get(agentId);
      if (agent === undefined || agent.status !== "stopping") return;
      agent.status = "error";
      agent.lastActiveAt = failedAt ?? this.#now();
    });
  }
}

function normalizeObjective(params: AgentCreateParams): string {
  const objective = normalizeNonEmpty(params.objective ?? params.instructions);
  if (objective === undefined) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      "agent.start requires a non-empty objective",
    );
  }
  return objective;
}

function normalizeNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

function normalizeRequiredAgentId(value: string, methodName: string): string {
  const normalized = normalizeNonEmpty(value);
  if (normalized === undefined) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      `${methodName} requires agentId`,
    );
  }
  return normalized;
}

function normalizeStringList(
  value: readonly string[] | undefined,
  fallback: readonly string[],
): string[] {
  const raw = value === undefined ? fallback : value;
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of raw) {
    const trimmed = item.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeCursor(cursor: string | undefined): string | undefined {
  return cursor === undefined || cursor.length === 0 ? undefined : cursor;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 100;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_ARGUMENT",
      "agent list limit must be a positive integer",
    );
  }
  return Math.min(limit, 500);
}

function applyAgentSnapshot(
  agent: MutableAgent,
  snapshot: AgenCBackgroundAgentSnapshot,
): void {
  agent.status = snapshot.status;
  agent.lastActiveAt = snapshot.lastActiveAt;
  if (snapshot.metadata !== undefined) {
    agent.metadata = {
      ...(agent.metadata ?? {}),
      ...snapshot.metadata,
    };
  }
}

function agentRunMetadata(agent: MutableAgent): JsonObject {
  return {
    ...agent.metadata,
    ...(agent.agentPath !== undefined ? { agentPath: agent.agentPath } : {}),
  };
}

function snapshotRouteForAgent(agent: MutableAgent): AgenCDaemonSnapshotRoute {
  return {
    ...(agent.cwd !== undefined ? { cwd: agent.cwd } : {}),
    ...(agent.stateProjectDir !== undefined
      ? { stateProjectDir: agent.stateProjectDir }
      : {}),
  };
}

function logSessionIdsForAgent(agent: MutableAgent): string[] {
  return uniqueNonEmptyStrings([...agent.logSessionIds, ...agent.sessionIds]);
}

function latestSessionIdForAgentRun(agent: MutableAgent): string | undefined {
  return agent.sessionIds.at(-1) ?? agent.logSessionIds.at(-1);
}

function isActiveAgent(agent: MutableAgent): boolean {
  return (
    agent.status !== "stopping" &&
    agent.status !== "stopped" &&
    agent.status !== "error"
  );
}

function isRecoveredRuntimeUnavailable(agent: MutableAgent): boolean {
  return agent.recovered === true && agent.runtimeAvailable !== true;
}

function compareAgentsForList(left: MutableAgent, right: MutableAgent): number {
  return left.agentId.localeCompare(right.agentId);
}

function isActiveSession(session: SessionSummary): boolean {
  return session.status !== "closed" && session.status !== "error";
}

function newestSession(
  sessions: readonly SessionSummary[],
): SessionSummary | null {
  if (sessions.length === 0) return null;
  return [...sessions].sort(compareNewestSessionFirst)[0] ?? null;
}

function compareNewestSessionFirst(
  left: SessionSummary,
  right: SessionSummary,
): number {
  const rightTime = Date.parse(right.createdAt);
  const leftTime = Date.parse(left.createdAt);
  if (Number.isFinite(rightTime) && Number.isFinite(leftTime)) {
    return rightTime - leftTime;
  }
  return right.createdAt.localeCompare(left.createdAt);
}

function storedThreadToAgent(thread: StoredThread): MutableAgent | undefined {
  if (!isAgentThreadSource(thread.source)) return undefined;
  const agentId = agentIdForThread(thread);
  const metadata: JsonObject = {
    source:
      thread.source === undefined
        ? undefined
        : threadSourceToJson(thread.source),
    model: thread.model,
    modelProvider: thread.modelProvider,
    rolloutPath: thread.rolloutPath,
    recovered: true,
  };
  return {
    agentId,
    objective:
      thread.name ??
      firstStringMetadataField(thread.source, "objective") ??
      thread.threadId,
    status: "idle",
    createdAt: thread.createdAt,
    startedAt: thread.createdAt,
    lastActiveAt: thread.updatedAt,
    sessionIds: [thread.threadId],
    logSessionIds: [thread.threadId],
    recovered: true,
    runtimeAvailable: false,
    ...(thread.cwd !== undefined ? { cwd: thread.cwd } : {}),
    metadata,
  };
}

function isAgentThreadSource(source: ThreadSource | undefined): boolean {
  if (source === "agent" || source === "agent_thread") return true;
  if (source === undefined || typeof source === "string") return false;
  const kind = stringField(source, "kind");
  if (kind === "agent" || kind === "agent_thread" || kind === "thread_spawn") {
    return true;
  }
  const nested = source["source"];
  return isRecord(nested) && stringField(nested, "kind") === "thread_spawn";
}

function agentIdForThread(thread: StoredThread): string {
  if (thread.source !== undefined && typeof thread.source !== "string") {
    const direct =
      stringField(thread.source, "agentId") ??
      stringField(thread.source, "agent_id");
    if (direct !== undefined) return direct;
  }
  return thread.threadId;
}

function firstStringMetadataField(
  source: ThreadSource | undefined,
  key: string,
): string | undefined {
  if (source === undefined || typeof source === "string") return undefined;
  return stringField(source, key);
}

function threadSourceToJson(source: ThreadSource): JsonValue {
  return typeof source === "string" ? source : (source as JsonObject);
}

function stringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toAgentCreateResult(agent: MutableAgent): AgentCreateResult {
  const summary = toAgentSummary(agent);
  const sessionId = agent.sessionIds[0];
  return {
    ...summary,
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

function toAgentSummary(agent: MutableAgent): AgentSummary {
  return {
    agentId: agent.agentId,
    ...(agent.agentPath !== undefined ? { agentPath: agent.agentPath } : {}),
    objective: agent.objective,
    status: agent.status,
    createdAt: agent.createdAt,
    startedAt: agent.startedAt,
    lastActiveAt: agent.lastActiveAt,
    ...(agent.cwd !== undefined ? { cwd: agent.cwd } : {}),
    ...(agent.sessionIds.length > 0
      ? { activeSessionIds: [...agent.sessionIds] }
      : {}),
    ...(agent.metadata !== undefined ? { metadata: agent.metadata } : {}),
  };
}

function storedThreadToAgentLogSession(thread: StoredThread): AgentLogSession {
  const items = [...(thread.history?.items ?? [])];
  return {
    sessionId: thread.threadId,
    itemCount: items.length,
    transcript: formatRolloutItemsForAgentLog(items),
    ...(thread.rolloutPath !== undefined
      ? { rolloutPath: thread.rolloutPath }
      : {}),
    ...(thread.source !== undefined
      ? { source: formatThreadSourceForLog(thread.source) }
      : {}),
  };
}

function formatAgentLogsTranscript(
  agentId: string,
  sessions: readonly AgentLogSession[],
  toolOutputs: readonly AgentToolOutputLog[],
): string {
  if (sessions.length === 0 && toolOutputs.length === 0) {
    return [`agent_id\t${agentId}`, "No transcript entries"].join("\n");
  }
  const sections: string[] = [];
  for (const session of sessions) {
    const header = [
      `agent_id\t${agentId}`,
      `session_id\t${session.sessionId}`,
      ...(session.rolloutPath !== undefined
        ? [`rollout_path\t${session.rolloutPath}`]
        : []),
    ];
    sections.push(
      [
        ...header,
        "",
        session.transcript.length > 0
          ? session.transcript
          : "No transcript entries",
      ].join("\n"),
    );
  }
  if (toolOutputs.length > 0) {
    sections.push(formatToolOutputSection(toolOutputs));
  }
  return sections.join("\n\n");
}

function formatRolloutItemsForAgentLog(items: readonly RolloutItem[]): string {
  const lines: string[] = [];
  let assistantDelta = "";
  const flushAssistantDelta = (): void => {
    if (assistantDelta.length === 0) return;
    lines.push(formatTranscriptLine("assistant", assistantDelta));
    assistantDelta = "";
  };

  for (const item of items) {
    if (item.type === "event_msg") {
      const line = formatEventMessageForLog(item.payload, {
        appendAssistantDelta: (delta) => {
          assistantDelta += delta;
        },
        flushAssistantDelta,
      });
      if (line !== null) lines.push(line);
      continue;
    }
    flushAssistantDelta();
    if (item.type === "response_item") {
      lines.push(formatResponseItemForLog(item.payload));
    } else if (item.type === "compacted") {
      lines.push(
        formatTranscriptLine(
          "system",
          `context compacted${item.payload.message ? `: ${item.payload.message}` : ""}`,
        ),
      );
    } else if (item.type === "unknown") {
      lines.push(
        formatTranscriptLine(
          "unknown",
          `skipped rollout item ${item.payload.originalType}`,
        ),
      );
    } else {
      lines.push(formatGenericRolloutItemForLog(item));
    }
  }
  flushAssistantDelta();
  return lines.join("\n\n");
}

function formatEventMessageForLog(
  event: Event,
  delta: {
    readonly appendAssistantDelta: (delta: string) => void;
    readonly flushAssistantDelta: () => void;
  },
): string | null {
  const msg = event.msg;
  switch (msg.type) {
    case "agent_message_delta":
      delta.appendAssistantDelta(msg.payload.delta);
      return null;
    case "agent_message":
      delta.flushAssistantDelta();
      return formatTranscriptLine("assistant", msg.payload.message);
    case "user_message":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "user",
        messageContentText(msg.payload.displayText ?? msg.payload.message),
      );
    case "turn_complete":
      delta.flushAssistantDelta();
      return msg.payload.lastAgentMessage
        ? formatTranscriptLine("assistant", msg.payload.lastAgentMessage)
        : formatTranscriptLine("system", `turn complete ${msg.payload.turnId}`);
    case "turn_aborted":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "system",
        `turn aborted: ${msg.payload.reason}`,
      );
    case "tool_call_started":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "tool",
        `${msg.payload.toolName} started (${msg.payload.callId})\n${msg.payload.args}`,
      );
    case "tool_call_completed":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "tool",
        `completed (${msg.payload.callId})${msg.payload.isError ? " with error" : ""}\n${msg.payload.result}`,
      );
    case "tool_progress":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "tool",
        `${msg.payload.toolName} progress (${msg.payload.callId})\n${msg.payload.chunk}`,
      );
    case "exec_command_begin":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "exec",
        `started (${msg.payload.callId})\n${msg.payload.command}`,
      );
    case "exec_command_end":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "exec",
        [
          `completed (${msg.payload.callId}) exit=${String(msg.payload.exitCode)}`,
          msg.payload.stdout ? `stdout:\n${msg.payload.stdout}` : "",
          msg.payload.stderr ? `stderr:\n${msg.payload.stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    case "mcp_tool_call_begin":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "tool",
        `${msg.payload.server}.${msg.payload.toolName} started (${msg.payload.callId})\n${msg.payload.args}`,
      );
    case "mcp_tool_call_end":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "tool",
        `completed (${msg.payload.callId})${msg.payload.isError ? " with error" : ""}\n${msg.payload.result}`,
      );
    case "warning":
      delta.flushAssistantDelta();
      return formatTranscriptLine("warning", msg.payload.message);
    case "error":
    case "stream_error":
      delta.flushAssistantDelta();
      return formatTranscriptLine("error", msg.payload.message);
    case "context_compacted":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "system",
        `context compacted${msg.payload.summary ? `: ${msg.payload.summary}` : ""}`,
      );
    case "plan_started":
      delta.flushAssistantDelta();
      return formatTranscriptLine("plan", msg.payload.title ?? "started");
    case "plan_delta":
      delta.flushAssistantDelta();
      return formatTranscriptLine("plan", msg.payload.delta);
    case "plan_item_completed":
      delta.flushAssistantDelta();
      return formatTranscriptLine(
        "plan",
        `completed: ${msg.payload.finalText}`,
      );
    case "plan_exited":
      delta.flushAssistantDelta();
      return formatTranscriptLine("plan", "exited");
    default:
      delta.flushAssistantDelta();
      return formatGenericEventForLog(event);
  }
}

function formatResponseItemForLog(item: ResponseItem): string {
  return formatTranscriptLine(item.role, messageContentText(item.content));
}

function formatGenericEventForLog(event: Event): string {
  return formatTranscriptLine(
    `event:${event.msg.type}`,
    stringifyJsonForLog({
      id: event.id,
      ...(event.seq !== undefined ? { seq: event.seq } : {}),
      payload: event.msg.payload,
    }),
  );
}

function formatGenericRolloutItemForLog(item: RolloutItem): string {
  return formatTranscriptLine(
    `rollout:${item.type}`,
    stringifyJsonForLog(
      item.eventVersion === undefined
        ? item.payload
        : {
            eventVersion: item.eventVersion,
            payload: item.payload,
          },
    ),
  );
}

function formatToolOutputSection(
  toolOutputs: readonly AgentToolOutputLog[],
): string {
  return [
    "tool_outputs",
    ...toolOutputs.map((output) =>
      [
        `session_id\t${output.sessionId}`,
        `tool_call_id\t${output.toolCallId}`,
        `tool_name\t${output.toolName}`,
        `status\t${output.status}`,
        ...(output.outputLogPath !== undefined
          ? [`output_log_path\t${output.outputLogPath}`]
          : []),
        "",
        output.output,
      ].join("\n"),
    ),
  ].join("\n\n");
}

function formatTranscriptLine(role: string, content: string): string {
  return `${role}:\n${content.trimEnd()}`;
}

function messageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (
          part !== null &&
          typeof part === "object" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          return (part as { text: string }).text;
        }
        return stringifyJsonForLog(part);
      })
      .join("\n");
  }
  return stringifyJsonForLog(content);
}

function stringifyJsonForLog(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatThreadSourceForLog(source: ThreadSource): string {
  return typeof source === "string" ? source : (JSON.stringify(source) ?? "");
}

function uniqueNonEmptyStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isThreadLogReadMiss(error: unknown): boolean {
  return (
    error instanceof ThreadNotFoundError ||
    error instanceof ThreadStoreInvalidRequestError
  );
}
