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
  AgentStopParams,
  AgentStopResult,
  AgentStatus,
  AgentSummary,
  JsonObject,
  MessageContent,
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
import type { AgenCDaemonSessionManager } from "./session-lifecycle.js";

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
  readonly broadcastSessionEvent?: (
    sessionId: string,
    event: JsonObject,
  ) => void | Promise<void>;
}

export const DEFAULT_UNATTENDED_ALLOWLIST = [
  "FileRead",
  "system.grep",
  "system.glob",
  "system.listDir",
  "system.stat",
] as const;

interface MutableAgent {
  agentId: string;
  agentPath?: string;
  objective: string;
  status: AgentStatus;
  createdAt: string;
  startedAt: string;
  lastActiveAt: string;
  cwd?: string;
  metadata?: JsonObject;
  sessionIds: string[];
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
  readonly #broadcastSessionEvent:
    | ((sessionId: string, event: JsonObject) => void | Promise<void>)
    | undefined;
  readonly #state = new AsyncLock<AgentLifecycleState>({
    agents: new Map(),
  });

  constructor(options: AgenCDaemonAgentManagerOptions = {}) {
    this.#defaultCwd = options.defaultCwd ?? (() => process.cwd());
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#runner = options.runner;
    this.#sessionManager = options.sessionManager;
    this.#broadcastSessionEvent = options.broadcastSessionEvent;
  }

  async createAgent(params: AgentCreateParams): Promise<AgentCreateResult> {
    if (this.#runner === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "agent.start requires a background runner",
      );
    }

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
      unattendedAllow,
      unattendedDeny,
    };
    const started = await this.#runner.startAgent({
      objective,
      cwd,
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.provider !== undefined ? { provider: params.provider } : {}),
      ...(params.profile !== undefined ? { profile: params.profile } : {}),
      metadata,
      unattendedAllow,
      unattendedDeny,
    });

    const agent: MutableAgent = {
      agentId: started.agentId,
      ...(started.agentPath !== undefined ? { agentPath: started.agentPath } : {}),
      objective,
      status: started.status,
      createdAt,
      startedAt: started.startedAt,
      lastActiveAt: started.startedAt,
      sessionIds: [],
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
        await this.#runner.attachAgentSessionEvents?.(agent.agentId, {
          sessionId: session.sessionId,
          emit: (event) => this.#broadcastSessionEvent?.(session.sessionId, event),
        });
      }

      return await this.#state.with((state) => {
        state.agents.set(agent.agentId, agent);
        return toAgentCreateResult(agent);
      });
    } catch (error) {
      await this.#runner.stopAgent?.(
        agent.agentId,
        "agent.create rollback after lifecycle failure",
      );
      throw error;
    }
  }

  async listAgents(params: AgentListParams = {}): Promise<AgentListResult> {
    return this.#state.with(async (state) => {
      await this.#refreshAgentsFromRunner(state);
      const cursor = normalizeCursor(params.cursor);
      const limit = normalizeLimit(params.limit);
      const agents = [...state.agents.values()]
        .filter(isActiveAgent)
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
    ).filter((session): session is SessionSummary =>
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
    ).filter((activeSession): activeSession is SessionSummary =>
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
      };
    });

    if (target === null) {
      return { agentId, stopped: false };
    }
    if (stopRunner === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "agent.stop requires a background runner",
      );
    }
    try {
      await stopRunner(agentId, reason);
    } catch (error) {
      await this.#markAgentStopFailed(agentId, transitionAt);
      throw error;
    }

    const stoppedAt = transitionAt ?? this.#now();
    await this.#state.with((state) => {
      const agent = state.agents.get(agentId);
      if (agent === undefined) return;
      agent.status = "stopped";
      agent.lastActiveAt = stoppedAt;
      agent.sessionIds = [];
    });
    await this.#terminateAgentSessions(target.sessionIds, reason);
    return { agentId, stopped: true };
  }

  async approveTool(params: ToolApproveParams): Promise<ToolDecisionResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(params.sessionId);
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
    return { requestId: params.requestId, decision: "approved" };
  }

  async denyTool(params: ToolDenyParams): Promise<ToolDecisionResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(params.sessionId);
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
    return { requestId: params.requestId, decision: "denied" };
  }

  async cancelTool(params: ToolCancelParams): Promise<ToolDecisionResult> {
    const agentId = await this.#resolveActiveAgentIdForSession(params.sessionId, {
      allowCancelTool: true,
    });
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

  async streamAgentMessage(params: {
    readonly sessionId: string;
    readonly content: MessageContent;
    readonly messageId: string;
    readonly streamId: string;
    readonly acceptedAt: string;
    readonly displayUserMessage?: string | null;
  }): Promise<void> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "message.stream requires a daemon session manager",
      );
    }
    if (this.#runner?.submitAgentMessage === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "message.stream requires a background runner",
      );
    }

    const session = await this.#sessionManager.getSession(params.sessionId);
    if (session === null || !isActiveSession(session)) {
      throw new AgenCDaemonAgentLifecycleError(
        "AGENT_NOT_FOUND",
        `AgenC daemon session not found or closed: ${params.sessionId}`,
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
    });

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
  }

  async #refreshAgentsFromRunner(state: AgentLifecycleState): Promise<void> {
    for (const agent of [...state.agents.values()]) {
      await this.#refreshAgentFromRunner(state, agent);
    }
  }

  async #resolveActiveAgentIdForSession(
    sessionId: string,
    options: { readonly allowCancelTool?: boolean } = {},
  ): Promise<string> {
    if (this.#sessionManager === undefined) {
      throw new AgenCDaemonAgentLifecycleError(
        "INVALID_ARGUMENT",
        "tool decision requires a daemon session manager",
      );
    }
    if (
      this.#runner?.resolveToolDecision === undefined &&
      !(options.allowCancelTool === true && this.#runner?.cancelTool !== undefined)
    ) {
      throw new AgenCDaemonAgentLifecycleError(
        "BACKGROUND_RUNNER_UNAVAILABLE",
        "tool decision requires a background runner",
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
    });
    return session.agentId;
  }

  async #refreshAgentFromRunner(
    state: AgentLifecycleState,
    agent: MutableAgent,
  ): Promise<void> {
    if (!isActiveAgent(agent)) return;
    const snapshot = await this.#runner?.getAgentSnapshot?.(agent.agentId);
    if (snapshot === undefined) return;
    if (snapshot === null) {
      state.agents.delete(agent.agentId);
      return;
    }
    applyAgentSnapshot(agent, snapshot);
  }

  async #resolveAttachmentTarget(agentId: string): Promise<AgentAttachmentTarget> {
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
}

function isActiveAgent(agent: MutableAgent): boolean {
  return (
    agent.status !== "stopping" &&
    agent.status !== "stopped" &&
    agent.status !== "error"
  );
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
