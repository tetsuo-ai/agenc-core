/**
 * In-memory daemon lifecycle for user-started background agents.
 *
 * F-06a owns the launch path only: start the background delegate loop, record
 * its daemon-visible agent summary, and seed the first daemon session with the
 * objective. Later F-06 rows add listing, attach, stop, logs, and recovery.
 */

import { AsyncLock } from "../utils/async-lock.js";
import type {
  AgenCBackgroundAgentRunner,
} from "./background-agent-runner.js";
import type {
  AgentCreateParams,
  AgentCreateResult,
  AgentListParams,
  AgentListResult,
  AgentStatus,
  AgentSummary,
  JsonObject,
} from "./protocol/index.js";
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

interface AgentLifecycleState {
  agents: Map<string, MutableAgent>;
}

export class AgenCDaemonAgentManager {
  readonly #defaultCwd: () => string;
  readonly #now: () => string;
  readonly #runner: AgenCBackgroundAgentRunner | undefined;
  readonly #sessionManager: AgenCDaemonSessionManager | undefined;
  readonly #state = new AsyncLock<AgentLifecycleState>({
    agents: new Map(),
  });

  constructor(options: AgenCDaemonAgentManagerOptions = {}) {
    this.#defaultCwd = options.defaultCwd ?? (() => process.cwd());
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#runner = options.runner;
    this.#sessionManager = options.sessionManager;
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
    return this.#state.with((state) => {
      const cursor = parseCursor(params.cursor);
      const limit = normalizeLimit(params.limit);
      const agents = [...state.agents.values()];
      const page = agents.slice(cursor, cursor + limit);
      const nextCursor =
        cursor + limit < agents.length ? String(cursor + limit) : undefined;
      return {
        agents: page.map(toAgentSummary),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    });
  }

  async getAgent(agentId: string): Promise<AgentSummary | null> {
    return this.#state.with((state) => {
      const agent = state.agents.get(agentId);
      return agent === undefined ? null : toAgentSummary(agent);
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

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AgenCDaemonAgentLifecycleError(
      "INVALID_CURSOR",
      `invalid agent list cursor: ${cursor}`,
    );
  }
  return parsed;
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
