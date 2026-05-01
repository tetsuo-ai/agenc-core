/**
 * Daemon reattach selection for thin clients.
 *
 * F-04c keeps the cwd/agent selection policy beside the daemon-owned session
 * registry so TUI, SDK, and future CLI attach paths share one rule.
 */

import { resolve } from "node:path";
import type {
  AgentAttachParams,
  JsonObject,
  SessionAttachResult,
  SessionSummary,
} from "./protocol/index.js";
import type { AgenCDaemonSessionManager } from "./session-lifecycle.js";

export type AgenCReattachMode = "agent" | "cwd";
export type AgenCReattachMissReason =
  | "NO_ACTIVE_SESSION_FOR_AGENT"
  | "NO_ACTIVE_SESSION_FOR_CWD";

export interface AgenCReattachHit extends JsonObject {
  readonly reattached: true;
  readonly mode: AgenCReattachMode;
  readonly session: SessionSummary;
  readonly attachment: SessionAttachResult;
}

export interface AgenCReattachMiss extends JsonObject {
  readonly reattached: false;
  readonly mode: AgenCReattachMode;
  readonly reason: AgenCReattachMissReason;
  readonly agentId?: string;
  readonly cwd?: string;
}

export type AgenCReattachResult = AgenCReattachHit | AgenCReattachMiss;

export interface AgenCDaemonReattachResolverOptions {
  readonly sessionManager: AgenCDaemonSessionManager;
}

export interface AttachCurrentCwdOptions {
  readonly cwd: string;
  readonly clientId?: string;
}

export interface AttachAgentOptions extends AgentAttachParams {
  readonly preferCwd?: string;
}

export class AgenCDaemonReattachResolver {
  readonly #sessionManager: AgenCDaemonSessionManager;

  constructor(options: AgenCDaemonReattachResolverOptions) {
    this.#sessionManager = options.sessionManager;
  }

  async attachCurrentCwd(
    options: AttachCurrentCwdOptions,
  ): Promise<AgenCReattachResult> {
    const session = await this.findActiveSessionForCwd(options.cwd);
    if (session === null) {
      return {
        reattached: false,
        mode: "cwd",
        reason: "NO_ACTIVE_SESSION_FOR_CWD",
        cwd: normalizeCwd(options.cwd),
      };
    }
    return this.attachSession("cwd", session, options.clientId);
  }

  async attachAgent(
    options: AttachAgentOptions,
  ): Promise<AgenCReattachResult> {
    const session = await this.findActiveSessionForAgent(
      options.agentId,
      options.preferCwd,
    );
    if (session === null) {
      return {
        reattached: false,
        mode: "agent",
        reason: "NO_ACTIVE_SESSION_FOR_AGENT",
        agentId: options.agentId,
        ...(options.preferCwd !== undefined
          ? { cwd: normalizeCwd(options.preferCwd) }
          : {}),
      };
    }
    return this.attachSession("agent", session, options.clientId);
  }

  async findActiveSessionForCwd(cwd: string): Promise<SessionSummary | null> {
    const normalized = normalizeCwd(cwd);
    const { sessions } = await this.#sessionManager.listSessions();
    return newestReattachableSession(
      sessions.filter(
        (session) =>
          session.cwd !== undefined && normalizeCwd(session.cwd) === normalized,
      ),
    );
  }

  async findActiveSessionForAgent(
    agentId: string,
    preferCwd?: string,
  ): Promise<SessionSummary | null> {
    const { sessions } = await this.#sessionManager.listSessions({ agentId });
    const reattachable = sessions.filter(isReattachableSession);
    if (preferCwd !== undefined) {
      const normalized = normalizeCwd(preferCwd);
      const preferred = newestReattachableSession(
        reattachable.filter(
          (session) =>
            session.cwd !== undefined &&
            normalizeCwd(session.cwd) === normalized,
        ),
      );
      if (preferred !== null) return preferred;
    }
    return newestReattachableSession(reattachable);
  }

  async attachSession(
    mode: AgenCReattachMode,
    session: SessionSummary,
    clientId?: string,
  ): Promise<AgenCReattachHit> {
    const attachment = await this.#sessionManager.attachSession({
      sessionId: session.sessionId,
      ...(clientId !== undefined ? { clientId } : {}),
    });
    const attachedSession =
      (await this.#sessionManager.getSession(session.sessionId)) ?? session;
    return {
      reattached: true,
      mode,
      session: attachedSession,
      attachment,
    };
  }
}

function newestReattachableSession(
  sessions: readonly SessionSummary[],
): SessionSummary | null {
  const reattachable = sessions.filter(isReattachableSession);
  if (reattachable.length === 0) return null;
  return [...reattachable].sort(compareNewestFirst)[0] ?? null;
}

function compareNewestFirst(
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

function isReattachableSession(session: SessionSummary): boolean {
  return session.status !== "closed" && session.status !== "error";
}

function normalizeCwd(cwd: string): string {
  return resolve(cwd);
}
