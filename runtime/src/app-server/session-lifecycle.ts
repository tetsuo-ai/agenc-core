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
import { ThreadNotFoundError } from "../thread-store/store.js";
import {
  requireAbsoluteWorkspaceCwd,
  WorkspaceCwdError,
} from "./workspace-cwd.js";
import type {
  StoredThread,
  ThreadSource,
  ThreadStore,
} from "../thread-store/store.js";
import { agentIdFromThreadSource } from "../thread-store/thread-source.js";
import { normalizeAgentRoleWorkspace } from "../agents/role-workspace.js";
import type {
  JsonObject,
  JsonValue,
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
  readonly threadStore?: ThreadStore;
}

export interface AgenCSessionRestoreRecord {
  readonly sessionId: string;
  readonly agentId: string;
  readonly status?: SessionStatus;
  readonly createdAt?: string;
  readonly cwd?: string;
  readonly initialPrompt?: string;
  readonly metadata?: JsonObject;
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
  recoveredFromThreadStore?: boolean;
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
  readonly #threadStore: ThreadStore | undefined;

  constructor(options: AgenCSessionLifecycleOptions = {}) {
    this.#createSessionId =
      options.createSessionId ?? (() => `session_${randomUUID()}`);
    this.#createAttachmentId =
      options.createAttachmentId ?? (() => `attachment_${randomUUID()}`);
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#defaultAgentId =
      options.defaultAgentId ?? DEFAULT_AGENC_DAEMON_AGENT_ID;
    this.#threadStore = options.threadStore;
  }

  async createSession(
    params: SessionCreateParams,
  ): Promise<SessionCreateResult> {
    // Validate persisted trust-domain provenance before allocating or storing
    // any session state. A malformed, present provenance field must never be
    // treated as legacy absence and rebound to the execution cwd on attach.
    sessionRoleWorkspaceFromMetadata(params.metadata);
    // DAE-02: cwd is required identity for new sessions (absolute workspace).
    let cwd: string;
    try {
      cwd = requireAbsoluteWorkspaceCwd(params.cwd, "session.create");
    } catch (error) {
      if (error instanceof WorkspaceCwdError) {
        throw new AgenCSessionLifecycleError("INVALID_ARGUMENT", error.message);
      }
      throw error;
    }
    const sessionId = this.#createSessionId();
    const createdAt = this.#now();
    const agentId = nonEmptyString(params.agentId) ?? this.#defaultAgentId;
    const session: MutableSession = {
      sessionId,
      agentId,
      status: "idle",
      createdAt,
      attachments: new Map(),
      cwd,
    };

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

  async restoreSession(
    record: AgenCSessionRestoreRecord,
  ): Promise<SessionSummary> {
    const sessionId = nonEmptyString(record.sessionId);
    const agentId = nonEmptyString(record.agentId);
    if (sessionId === undefined || agentId === undefined) {
      throw new AgenCSessionLifecycleError(
        "INVALID_ARGUMENT",
        "AgenC daemon session restore requires sessionId and agentId",
      );
    }
    sessionRoleWorkspaceFromMetadata(record.metadata);

    const session: MutableSession = {
      sessionId,
      agentId,
      status: record.status ?? "waiting",
      createdAt: nonEmptyString(record.createdAt) ?? this.#now(),
      attachments: new Map(),
    };
    if (record.cwd !== undefined) session.cwd = record.cwd;
    if (record.initialPrompt !== undefined) {
      session.initialPrompt = record.initialPrompt;
    }
    if (record.metadata !== undefined) session.metadata = record.metadata;

    return this.#state.with((state) => {
      const existing = state.sessions.get(sessionId);
      if (existing !== undefined) return toSessionSummary(existing);
      state.sessions.set(sessionId, session);
      return toSessionSummary(session);
    });
  }

  async listSessions(params: SessionListParams = {}): Promise<SessionListResult> {
    return this.#state.with((state) => {
      const cursor = parseCursor(params.cursor);
      const limit = normalizeLimit(params.limit);
      const agentId = nonEmptyString(params.agentId);
      const matchingSessions = [
        ...[...state.sessions.values()]
          .filter(
            (session) => agentId === undefined || session.agentId === agentId,
          )
          .map(toSessionSummary),
        ...this.#listPersistedSessions(state, agentId),
      ];
      const page = matchingSessions.slice(cursor, cursor + limit);
      const nextCursor =
        cursor + limit < matchingSessions.length
          ? String(cursor + limit)
          : undefined;

      return {
        sessions: page,
        ...(nextCursor !== undefined ? { nextCursor } : {}),
      };
    });
  }

  async getSession(sessionId: string): Promise<SessionSummary | null> {
    return this.#state.with((state) => {
      const session = this.#getOrMaterializeSession(state, sessionId);
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
      for (const session of this.#listPersistedSessions(state, undefined)) {
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

  #listPersistedSessions(
    state: SessionLifecycleState,
    agentId: string | undefined,
  ): SessionSummary[] {
    if (this.#threadStore === undefined) return [];
    const result: SessionSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = this.#threadStore.listThreads({
        pageSize: 500,
        archived: false,
        useStateDbOnly: true,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const thread of page.items) {
        if (state.sessions.has(thread.threadId)) continue;
        const summary = storedThreadToSessionSummary(
          thread,
          this.#defaultAgentId,
        );
        if (agentId === undefined || summary.agentId === agentId) {
          result.push(summary);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return result;
  }

  async attachSession(
    params: SessionAttachParams,
  ): Promise<SessionAttachResult> {
    return this.#state.with((state) => {
      const session = this.#requireOpenSession(state, params.sessionId);
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
      const session = this.#requireSession(state, params.sessionId);
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
      const session = this.#requireSession(state, params.sessionId);

      if (session.status === "closed") {
        this.#archiveRecoveredThread(session);
        return toTerminateResult(session, false);
      }

      session.status = "closed";
      session.closedAt = this.#now();
      session.attachments.clear();
      if (params.reason !== undefined) session.terminationReason = params.reason;
      this.#archiveRecoveredThread(session);
      return toTerminateResult(session, true);
    });
  }

  #archiveRecoveredThread(session: MutableSession): void {
    if (!session.recoveredFromThreadStore || this.#threadStore === undefined) {
      return;
    }
    try {
      this.#threadStore.archiveThread({ threadId: session.sessionId });
    } catch (error) {
      if (error instanceof ThreadNotFoundError) return;
      throw error;
    }
  }

  #getOrMaterializeSession(
    state: SessionLifecycleState,
    sessionId: string,
  ): MutableSession | undefined {
    const existing = state.sessions.get(sessionId);
    if (existing !== undefined) return existing;
    if (this.#threadStore === undefined) return undefined;

    let thread: StoredThread;
    try {
      thread = this.#threadStore.readThread({
        threadId: sessionId,
        includeArchived: false,
        includeHistory: false,
      });
    } catch (error) {
      if (error instanceof ThreadNotFoundError) return undefined;
      throw error;
    }

    const session = storedThreadToMutableSession(thread, this.#defaultAgentId);
    state.sessions.set(session.sessionId, session);
    return session;
  }

  #requireSession(
    state: SessionLifecycleState,
    sessionId: string,
  ): MutableSession {
    const session = this.#getOrMaterializeSession(state, sessionId);
    if (session === undefined) {
      throw new AgenCSessionLifecycleError(
        "SESSION_NOT_FOUND",
        `AgenC daemon session not found: ${sessionId}`,
      );
    }
    return session;
  }

  #requireOpenSession(
    state: SessionLifecycleState,
    sessionId: string,
  ): MutableSession {
    const session = this.#requireSession(state, sessionId);
    if (session.status === "closed") {
      throw new AgenCSessionLifecycleError(
        "SESSION_CLOSED",
        `AgenC daemon session is closed: ${sessionId}`,
      );
    }
    return session;
  }
}

function toSessionSummary(session: MutableSession): SessionSummary {
  const roleWorkspace = sessionRoleWorkspaceFromMetadata(session.metadata);
  return {
    sessionId: session.sessionId,
    agentId: session.agentId,
    status: session.status,
    createdAt: session.createdAt,
    ...(session.cwd !== undefined ? { cwd: session.cwd } : {}),
    ...(roleWorkspace !== undefined ? { roleWorkspace } : {}),
    ...(session.metadata !== undefined ? { metadata: session.metadata } : {}),
    ...(session.attachments.size > 0
      ? { activeAttachmentIds: activeAttachmentIds(session) }
      : {}),
    ...(session.closedAt !== undefined ? { closedAt: session.closedAt } : {}),
  };
}

function sessionRoleWorkspaceFromMetadata(
  metadata: JsonObject | undefined,
): { readonly id: string; readonly cwd: string } | undefined {
  if (metadata === undefined) return undefined;
  const hasId = Object.prototype.hasOwnProperty.call(
    metadata,
    "agentRoleWorkspaceId",
  );
  const hasCwd = Object.prototype.hasOwnProperty.call(
    metadata,
    "agentRoleWorkspaceCwd",
  );
  if (!hasId && !hasCwd) return undefined;

  const rawId = metadata.agentRoleWorkspaceId;
  const id = typeof rawId === "string" ? nonEmptyString(rawId) : undefined;
  if (id === undefined) {
    throw invalidRoleWorkspaceProvenance(
      "agentRoleWorkspaceId must be a non-empty absolute path",
    );
  }

  const rawCwd = metadata.agentRoleWorkspaceCwd;
  const cwd = hasCwd
    ? typeof rawCwd === "string"
      ? nonEmptyString(rawCwd)
      : undefined
    : id;
  if (cwd === undefined) {
    throw invalidRoleWorkspaceProvenance(
      "agentRoleWorkspaceCwd must be a non-empty absolute path when present",
    );
  }

  try {
    const normalized = normalizeAgentRoleWorkspace({ id, cwd });
    return { id: normalized.id, cwd: normalized.cwd };
  } catch (error) {
    throw invalidRoleWorkspaceProvenance(
      error instanceof Error ? error.message : String(error),
    );
  }
}

function invalidRoleWorkspaceProvenance(
  detail: string,
): AgenCSessionLifecycleError {
  return new AgenCSessionLifecycleError(
    "INVALID_ARGUMENT",
    `Invalid agent role workspace provenance: ${detail}`,
  );
}

function storedThreadToMutableSession(
  thread: StoredThread,
  defaultAgentId: string,
): MutableSession {
  const summary = storedThreadToSessionSummary(thread, defaultAgentId);
  return {
    sessionId: summary.sessionId,
    agentId: summary.agentId,
    status: summary.status,
    createdAt: summary.createdAt,
    attachments: new Map(),
    recoveredFromThreadStore: true,
    ...(summary.cwd !== undefined ? { cwd: summary.cwd } : {}),
    ...(summary.metadata !== undefined ? { metadata: summary.metadata } : {}),
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

function storedThreadToSessionSummary(
  thread: StoredThread,
  defaultAgentId: string,
): SessionSummary {
  const roleWorkspace = roleWorkspaceFromThreadSource(thread.source);
  const metadata: JsonObject = {
    source:
      thread.source === undefined ? undefined : threadSourceToJson(thread.source),
    model: thread.model,
    modelProvider: thread.modelProvider,
    rolloutPath: thread.rolloutPath,
    recovered: true,
    ...(roleWorkspace !== undefined
      ? {
          agentRoleWorkspaceId: roleWorkspace.id,
          agentRoleWorkspaceCwd: roleWorkspace.cwd,
        }
      : {}),
  };
  return {
    sessionId: thread.threadId,
    agentId: agentIdFromThreadSource(thread.source) ?? defaultAgentId,
    status: "waiting",
    createdAt: thread.createdAt,
    ...(thread.cwd !== undefined ? { cwd: thread.cwd } : {}),
    metadata,
  };
}

function roleWorkspaceFromThreadSource(
  source: ThreadSource | undefined,
): { readonly id: string; readonly cwd: string } | undefined {
  if (typeof source !== "object" || source === null || Array.isArray(source)) {
    return undefined;
  }
  const sourceRecord = source as Record<string, unknown>;
  const nested = sourceRecord.source;
  const spawnSource =
    sourceRecord.kind === "thread_spawn"
      ? sourceRecord
      : typeof nested === "object" &&
          nested !== null &&
          !Array.isArray(nested) &&
          (nested as Record<string, unknown>).kind === "thread_spawn"
        ? (nested as Record<string, unknown>)
        : undefined;
  if (spawnSource === undefined) return undefined;
  const rawId = spawnSource.agentRoleWorkspaceId;
  if (rawId === undefined) return undefined;
  if (typeof rawId !== "string" || nonEmptyString(rawId) === undefined) {
    throw new AgenCSessionLifecycleError(
      "INVALID_ARGUMENT",
      "Recovered agent role workspace provenance is malformed",
    );
  }
  try {
    return normalizeAgentRoleWorkspace({ id: rawId, cwd: rawId });
  } catch (error) {
    throw new AgenCSessionLifecycleError(
      "INVALID_ARGUMENT",
      `Recovered agent role workspace provenance is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function threadSourceToJson(source: ThreadSource): JsonValue {
  return typeof source === "string" ? source : (source as JsonObject);
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
