/**
 * Ports the donor app-server's server-owned thread state manager shape onto
 * AgenC daemon sessions.
 *
 * Why this lives here:
 *   - F-03f owns session lifecycle state only. Later rows wire live request
 *     dispatch, event fan-out, and disconnect recovery onto this manager.
 *
 * Cross-cuts deliberately NOT carried:
 *   - live turn listeners, interrupt queues, and rollout history builders are
 *     runtime execution concerns owned by later daemon/session rows.
 */

import { randomUUID } from "node:crypto";
import { AsyncLock } from "../utils/async-lock.js";
import type {
  JsonObject,
  SessionAttachParams,
  SessionAttachResult,
  SessionCreateParams,
  SessionCreateResult,
  SessionDetachParams,
  SessionDetachResult,
  SessionListParams,
  SessionListResult,
  SessionStatus,
  SessionSummary,
  SessionTerminateParams,
  SessionTerminateResult,
} from "./protocol/index.js";

export const DEFAULT_AGENC_DAEMON_AGENT_ID = "agent_default";

export type AgenCSessionLifecycleErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_CURSOR"
  | "SESSION_CLOSED"
  | "SESSION_NOT_FOUND";

export class AgenCSessionLifecycleError extends Error {
  readonly code: AgenCSessionLifecycleErrorCode;

  constructor(code: AgenCSessionLifecycleErrorCode, message: string) {
    super(message);
    this.name = "AgenCSessionLifecycleError";
    this.code = code;
  }
}

export interface AgenCSessionAttachment extends JsonObject {
  readonly attachmentId: string;
  readonly sessionId: string;
  readonly attachedAt: string;
  readonly clientId?: string;
}

export interface AgenCSessionLifecycleOptions {
  readonly createSessionId?: () => string;
  readonly createAttachmentId?: () => string;
  readonly now?: () => string;
  readonly defaultAgentId?: string;
}

export interface AgenCSessionCounts {
  readonly active: number;
  readonly closed: number;
  readonly total: number;
}

interface MutableSession {
  sessionId: string;
  agentId: string;
  status: SessionStatus;
  createdAt: string;
  cwd?: string;
  initialPrompt?: string;
  metadata?: JsonObject;
  closedAt?: string;
  terminationReason?: string;
  attachments: Map<string, AgenCSessionAttachment>;
}

interface SessionLifecycleState {
  sessions: Map<string, MutableSession>;
}

export class AgenCDaemonSessionManager {
  readonly #state = new AsyncLock<SessionLifecycleState>({
    sessions: new Map(),
  });
  readonly #createSessionId: () => string;
  readonly #createAttachmentId: () => string;
  readonly #now: () => string;
  readonly #defaultAgentId: string;

  constructor(options: AgenCSessionLifecycleOptions = {}) {
    this.#createSessionId =
      options.createSessionId ?? (() => `session_${randomUUID()}`);
    this.#createAttachmentId =
      options.createAttachmentId ?? (() => `attachment_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#defaultAgentId =
      options.defaultAgentId ?? DEFAULT_AGENC_DAEMON_AGENT_ID;
  }

  async createSession(
    params: SessionCreateParams = {},
  ): Promise<SessionCreateResult> {
    const sessionId = this.#createSessionId();
    const createdAt = this.#now();
    const agentId = nonEmptyString(params.agentId) ?? this.#defaultAgentId;
    const session: MutableSession = {
      sessionId,
      agentId,
      status: "idle",
      createdAt,
      attachments: new Map(),
    };

    if (params.cwd !== undefined) session.cwd = params.cwd;
    if (params.initialPrompt !== undefined) {
      session.initialPrompt = params.initialPrompt;
    }
    if (params.metadata !== undefined) session.metadata = params.metadata;

    return this.#state.with((state) => {
      if (state.sessions.has(sessionId)) {
        throw new AgenCSessionLifecycleError(
          "INVALID_ARGUMENT",
          `AgenC daemon session already exists: ${sessionId}`,
        );
      }
      state.sessions.set(sessionId, session);
      return toSessionSummary(session);
    });
  }

  async listSessions(params: SessionListParams = {}): Promise<SessionListResult> {
    return this.#state.with((state) => {
      const cursor = parseCursor(params.cursor);
      const limit = normalizeLimit(params.limit);
      const agentId = nonEmptyString(params.agentId);
      const matchingSessions = [...state.sessions.values()].filter(
        (session) => agentId === undefined || session.agentId === agentId,
      );
      const page = matchingSessions.slice(cursor, cursor + limit);
      const nextCursor =
        cursor + limit < matchingSessions.length
          ? String(cursor + limit)
          : undefined;

      return {
        sessions: page.map(toSessionSummary),
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    });
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    return this.#state.with((state) => {
      const session = state.sessions.get(sessionId);
      return session === undefined ? null : toSessionSummary(session);
    });
  }

  async countSessions(): Promise<AgenCSessionCounts> {
    return this.#state.with((state) => {
      let active = 0;
      let closed = 0;
      for (const session of state.sessions.values()) {
        if (session.status === "closed") {
          closed += 1;
        } else {
          active += 1;
        }
      }
      return {
        active,
        closed,
        total: active + closed,
      };
    });
  }

  async attachSession(
    params: SessionAttachParams,
  ): Promise<SessionAttachResult> {
    return this.#state.with((state) => {
      const session = requireOpenSession(state, params.sessionId);
      const existing =
        params.clientId !== undefined
          ? findAttachmentByClientId(session, params.clientId)
          : undefined;

      if (existing !== undefined) {
        return toAttachResult(session, existing);
      }

      const attachment: AgenCSessionAttachment = {
        attachmentId: this.#createAttachmentId(),
        sessionId: session.sessionId,
        attachedAt: this.#now(),
        ...(params.clientId !== undefined ? { clientId: params.clientId } : {}),
      };
      session.attachments.set(attachment.attachmentId, attachment);
      return toAttachResult(session, attachment);
    });
  }

  async detachSession(
    params: SessionDetachParams,
  ): Promise<SessionDetachResult> {
    return this.#state.with((state) => {
      const session = requireSession(state, params.sessionId);
      const attachment = findAttachment(session, params);

      if (attachment === undefined) {
        return {
          sessionId: session.sessionId,
          detached: false,
          remainingAttachmentIds: activeAttachmentIds(session),
        };
      }

      session.attachments.delete(attachment.attachmentId);
      return {
        sessionId: session.sessionId,
        attachmentId: attachment.attachmentId,
        detached: true,
        remainingAttachmentIds: activeAttachmentIds(session),
      };
    });
  }

  async terminateSession(
    params: SessionTerminateParams,
  ): Promise<SessionTerminateResult> {
    return this.#state.with((state) => {
      const session = requireSession(state, params.sessionId);

      if (session.status === "closed") {
        return toTerminateResult(session, false);
      }

      session.status = "closed";
      session.closedAt = this.#now();
      session.attachments.clear();
      if (params.reason !== undefined) session.terminationReason = params.reason;
      return toTerminateResult(session, true);
    });
  }
}

function requireSession(
  state: SessionLifecycleState,
  sessionId: string,
): MutableSession {
  const session = state.sessions.get(sessionId);
  if (session === undefined) {
    throw new AgenCSessionLifecycleError(
      "SESSION_NOT_FOUND",
      `AgenC daemon session not found: ${sessionId}`,
    );
  }
  return session;
}

function requireOpenSession(
  state: SessionLifecycleState,
  sessionId: string,
): MutableSession {
  const session = requireSession(state, sessionId);
  if (session.status === "closed") {
    throw new AgenCSessionLifecycleError(
      "SESSION_CLOSED",
      `AgenC daemon session is closed: ${sessionId}`,
    );
  }
  return session;
}

function toSessionSummary(session: MutableSession): SessionSummary {
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    status: session.status,
    createdAt: session.createdAt,
    ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
    ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
    ...(session.attachments.size > 0
      ? { activeAttachmentIds: activeAttachmentIds(session) }
      : {}),
    ...(session.closedAt !== undefined ? { closedAt: session.closedAt } : {}),
  };
}

function toAttachResult(
  session: MutableSession,
  attachment: AgenCSessionAttachment,
): SessionAttachResult {
  return {
    sessionId: session.sessionId,
    attachmentId: attachment.attachmentId,
    ...(attachment.clientId !== undefined ? { clientId: attachment.clientId } : {}),
    attachedAt: attachment.attachedAt,
    activeAttachmentIds: activeAttachmentIds(session),
  };
}

function toTerminateResult(
  session: MutableSession,
  terminated: boolean,
): SessionTerminateResult {
  return {
    sessionId: session.sessionId,
    terminated,
    status: "closed",
    closedAt: session.closedAt ?? session.createdAt,
    ...(session.terminationReason !== undefined
      ? { reason: session.terminationReason }
      : {}),
  };
}

function activeAttachmentIds(session: MutableSession): readonly string[] {
  return [...session.attachments.keys()];
}

function findAttachment(
  session: MutableSession,
  params: SessionDetachParams,
): AgenCSessionAttachment | undefined {
  if (params.attachmentId !== undefined) {
    return session.attachments.get(params.attachmentId);
  }
  if (params.clientId !== undefined) {
    return findAttachmentByClientId(session, params.clientId);
  }
  throw new AgenCSessionLifecycleError(
    "INVALID_ARGUMENT",
    "AgenC daemon session detach requires attachmentId or clientId",
  );
}

function findAttachmentByClientId(
  session: MutableSession,
  clientId: string,
): AgenCSessionAttachment | undefined {
  return [...session.attachments.values()].find(
    (attachment) => attachment.clientId === clientId,
  );
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined || cursor.length === 0) return 0;
  const parsed = Number(cursor);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AgenCSessionLifecycleError(
      "INVALID_CURSOR",
      `Invalid AgenC daemon session cursor: ${cursor}`,
    );
  }
  return parsed;
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return 50;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new AgenCSessionLifecycleError(
      "INVALID_ARGUMENT",
      "AgenC daemon session list limit must be a positive integer",
    );
  }
  return Math.min(limit, 100);
}

function nonEmptyString(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}
