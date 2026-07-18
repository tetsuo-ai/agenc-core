/**
 * Typed AgenC daemon client for embedders.
 *
 * The client is transport-agnostic: anything that can frame a JSON-RPC
 * request/response pair satisfies {@link AgencTransport}. Server-to-client
 * notifications are pushed in through {@link AgencClient.dispatchNotification}
 * — socket transports wire this automatically; in-process embedders pass it
 * as the dispatcher transport's `sendNotification` callback.
 */

import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import {
  AGENC_SDK_DAEMON_PROTOCOL_VERSION,
  AGENC_SDK_JSON_RPC_VERSION,
  isJsonObject,
  type AgencDaemonErrorObject,
  type AgencDaemonMethod,
  type AgencDaemonRequest,
  type AgencDaemonResponse,
  type AgencParamsByMethod,
  type AgencResultByMethod,
  type AgentAttachResult,
  type AgentCreateParams,
  type AgentCreateResult,
  type AgentListParams,
  type AgentListResult,
  type AgentLogsResult,
  type AgentStopResult,
  type InitializeParams,
  type InitializeResult,
  type JsonObject,
  type MessageContent,
  type RequestId,
  type RunCancelResult,
  type RunEvidenceParams,
  type RunEvidenceResult,
  type RunReplayParams,
  type RunReplayResult,
  type RunResultResult,
  type RunStatusResult,
  type SessionCreateParams,
  type SessionSnapshotResult,
  type SessionTranscriptResult,
} from "./protocol.js";
import {
  promptEventFromNotification,
  sessionIdFromNotification,
  stopReasonFromExitCode,
  terminalStatusFromNotification,
  type AgencPromptEvent,
  type AgencPromptResult,
} from "./events.js";

/**
 * Minimal transport contract. The runtime's
 * `AgenCInProcessDaemonTransport` (exported from `@tetsuo-ai/runtime`)
 * satisfies this structurally, as does the built-in socket transport.
 */
export interface AgencTransport {
  request<Method extends AgencDaemonMethod>(
    request: AgencDaemonRequest<Method>,
  ): Promise<AgencDaemonResponse<Method>>;
  close?(): Promise<void>;
}

export class AgencRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly method: AgencDaemonMethod;
  readonly requestId: RequestId | null;

  constructor(
    error: AgencDaemonErrorObject,
    method: AgencDaemonMethod,
    requestId: RequestId | null,
  ) {
    super(error.message);
    this.name = "AgencRpcError";
    this.code = error.code;
    this.data = error.data;
    this.method = method;
    this.requestId = requestId;
  }
}

export class AgencMalformedResponseError extends Error {
  readonly response: unknown;

  constructor(message: string, response: unknown) {
    super(message);
    this.name = "AgencMalformedResponseError";
    this.response = response;
  }
}

/** Decision returned by a permission callback. */
export type AgencPermissionDecision =
  | { readonly behavior: "allow"; readonly scope?: "once" | "session" | "agent" }
  | { readonly behavior: "deny"; readonly reason?: string };

export type AgencPermissionRequest = Extract<
  AgencPromptEvent,
  { type: "permission_request" }
> & { readonly sessionId: string };

export type AgencElicitationRequest = Extract<
  AgencPromptEvent,
  { type: "elicitation_request" }
> & { readonly sessionId: string };

export type AgencPermissionCallback = (
  request: AgencPermissionRequest,
) => AgencPermissionDecision | Promise<AgencPermissionDecision>;

/**
 * Return the response payload for `elicitation.respond`, or `null` to leave
 * the request unanswered (the embedder handles it out of band).
 */
export type AgencElicitationCallback = (
  request: AgencElicitationRequest,
) => JsonObject | null | Promise<JsonObject | null>;

export interface AgencClientOptions {
  readonly transport: AgencTransport;
  readonly clientId?: string;
  readonly clientName?: string;
  readonly createRequestId?: () => RequestId;
  /** Default permission handler for every prompt run on this client. */
  readonly onPermissionRequest?: AgencPermissionCallback;
  /** Default elicitation handler for every prompt run on this client. */
  readonly onElicitationRequest?: AgencElicitationCallback;
}

export interface AgencPromptOptions {
  readonly signal?: AbortSignal;
  /**
   * Fetch `session.snapshot` after the turn completes so the result carries
   * token usage and cost. Defaults to `true`; snapshot failures are ignored.
   */
  readonly includeUsage?: boolean;
  readonly metadata?: JsonObject;
  readonly onPermissionRequest?: AgencPermissionCallback;
  readonly onElicitationRequest?: AgencElicitationCallback;
}

/** Cap on internally buffered, not-yet-consumed prompt events. */
const MAX_BUFFERED_PROMPT_EVENTS = 1_000;

interface EventChannel {
  push(event: AgencPromptEvent): void;
  end(result: AgencPromptResult): void;
  fail(error: Error): void;
  iterate(): AsyncGenerator<AgencPromptEvent, AgencPromptResult>;
  readonly result: Promise<AgencPromptResult>;
}

function createEventChannel(): EventChannel {
  const buffered: AgencPromptEvent[] = [];
  let done = false;
  let finalResult: AgencPromptResult | null = null;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  let resolveResult!: (value: AgencPromptResult) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<AgencPromptResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // A prompt run that is only awaited via `.result()` never iterates, so a
  // rejected result promise would otherwise surface as an unhandled
  // rejection even though `iterate()` reports the same failure. Attach a
  // no-op handler; `.result()` callers still observe the rejection.
  result.catch(() => {});
  const notify = () => {
    wake?.();
    wake = null;
  };
  return {
    push(event) {
      if (done) return;
      buffered.push(event);
      while (buffered.length > MAX_BUFFERED_PROMPT_EVENTS) buffered.shift();
      notify();
    },
    end(value) {
      if (done) return;
      done = true;
      finalResult = value;
      resolveResult(value);
      notify();
    },
    fail(error) {
      if (done) return;
      done = true;
      failure = error;
      rejectResult(error);
      notify();
    },
    result,
    async *iterate() {
      for (;;) {
        while (buffered.length > 0) {
          yield buffered.shift()!;
        }
        if (done) {
          if (failure !== null) throw failure;
          return finalResult!;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}

/**
 * One in-flight (or finished) prompt turn: an async iterable of typed
 * events plus a promise for the final result.
 */
export interface AgencPromptRun extends AsyncIterable<AgencPromptEvent> {
  readonly sessionId: string;
  /** Resolves once the daemon acknowledged `message.send`. */
  readonly accepted: Promise<{ messageId: string }>;
  /** Final outcome; resolves even when the events are never iterated. */
  result(): Promise<AgencPromptResult>;
  /** Interrupt the active turn (`session.cancelTurn`). */
  cancel(reason?: string): Promise<void>;
}

export class AgencSession {
  readonly sessionId: string;
  readonly agentId: string | undefined;
  readonly #client: AgencClient;

  constructor(client: AgencClient, sessionId: string, agentId?: string) {
    this.#client = client;
    this.sessionId = sessionId;
    this.agentId = agentId;
  }

  /** Send one message and stream the turn's events. */
  prompt(content: MessageContent, options: AgencPromptOptions = {}): AgencPromptRun {
    return this.#client.runPrompt(this.sessionId, content, options);
  }

  transcript(): Promise<SessionTranscriptResult> {
    return this.#client.request("session.transcript", {
      sessionId: this.sessionId,
    });
  }

  snapshot(): Promise<SessionSnapshotResult> {
    return this.#client.request("session.snapshot", {
      sessionId: this.sessionId,
    });
  }

  async cancelTurn(reason?: string): Promise<void> {
    await this.#client.request("session.cancelTurn", {
      sessionId: this.sessionId,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  async terminate(reason?: string): Promise<void> {
    await this.#client.request("session.terminate", {
      sessionId: this.sessionId,
      ...(reason !== undefined ? { reason } : {}),
    });
  }
}

export class AgencClient {
  readonly #transport: AgencTransport;
  readonly #createRequestId: () => RequestId;
  readonly #clientId: string;
  readonly #clientName: string;
  readonly #onPermissionRequest: AgencPermissionCallback | undefined;
  readonly #onElicitationRequest: AgencElicitationCallback | undefined;
  readonly #notificationListeners = new Set<(message: JsonObject) => void>();
  readonly #sessionListeners = new Map<
    string,
    Set<(message: JsonObject) => void>
  >();
  readonly #attachedSessionIds = new Set<string>();
  #initialized = false;
  #closed = false;

  constructor(options: AgencClientOptions) {
    this.#transport = options.transport;
    this.#createRequestId = options.createRequestId ?? numericIdFactory();
    this.#clientId = options.clientId ?? `agenc-sdk-${process.pid}-${randomUUID()}`;
    this.#clientName = options.clientName ?? "agenc-sdk";
    this.#onPermissionRequest = options.onPermissionRequest;
    this.#onElicitationRequest = options.onElicitationRequest;
  }

  get clientId(): string {
    return this.#clientId;
  }

  get initialized(): boolean {
    return this.#initialized;
  }

  /**
   * Feed a server-to-client notification into the client. Socket transports
   * call this automatically; in-process embedders wire it as the runtime
   * transport's `sendNotification` callback.
   */
  dispatchNotification(message: JsonObject): void {
    for (const listener of this.#notificationListeners) {
      safeNotify(listener, message);
    }
    const sessionId = sessionIdFromNotification(message);
    if (sessionId === null) return;
    const listeners = this.#sessionListeners.get(sessionId);
    if (listeners === undefined) return;
    for (const listener of listeners) {
      safeNotify(listener, message);
    }
  }

  /** Subscribe to every raw daemon notification. */
  onNotification(listener: (message: JsonObject) => void): () => void {
    this.#notificationListeners.add(listener);
    return () => {
      this.#notificationListeners.delete(listener);
    };
  }

  /** Subscribe to raw notifications for one session. */
  onSessionNotification(
    sessionId: string,
    listener: (message: JsonObject) => void,
  ): () => void {
    let listeners = this.#sessionListeners.get(sessionId);
    if (listeners === undefined) {
      listeners = new Set();
      this.#sessionListeners.set(sessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      const current = this.#sessionListeners.get(sessionId);
      current?.delete(listener);
      if (current?.size === 0) this.#sessionListeners.delete(sessionId);
    };
  }

  async request<Method extends AgencDaemonMethod>(
    method: Method,
    params?: AgencParamsByMethod[Method],
  ): Promise<AgencResultByMethod[Method]> {
    if (this.#closed) throw new Error("AgenC SDK client is closed");
    const id = this.#createRequestId();
    const request: AgencDaemonRequest<Method> =
      params === undefined
        ? { jsonrpc: AGENC_SDK_JSON_RPC_VERSION, id, method }
        : { jsonrpc: AGENC_SDK_JSON_RPC_VERSION, id, method, params };
    const response = await this.#transport.request(request);
    return parseResponse(response, method, id);
  }

  async initialize(params: InitializeParams = {}): Promise<InitializeResult> {
    const result = await this.request("initialize", {
      protocolVersion: AGENC_SDK_DAEMON_PROTOCOL_VERSION,
      protocol: { version: AGENC_SDK_DAEMON_PROTOCOL_VERSION },
      clientName: this.#clientName,
      capabilities: {},
      ...params,
    });
    this.#initialized = true;
    return result;
  }

  /**
   * Create a runnable daemon session and attach this client to it.
   * Prefer gateway-style `agent.create` first so `message.send` has a live
   * agent (todo-133). Falls back to bare `session.create` when `agentId` is
   * already supplied.
   */
  async createSession(params: SessionCreateParams = {}): Promise<AgencSession> {
    const existingAgentId =
      typeof (params as { agentId?: unknown }).agentId === "string"
        ? String((params as { agentId: string }).agentId).trim()
        : "";
    // DAE-02: always send absolute client workspace cwd on the wire.
    const cwd = resolveClientCwd(
      typeof (params as { cwd?: unknown }).cwd === "string"
        ? String((params as { cwd: string }).cwd)
        : undefined,
    );
    if (existingAgentId.length === 0) {
      const agent = await this.spawnAgent({
        objective:
          typeof (params as { objective?: unknown }).objective === "string" &&
          String((params as { objective: string }).objective).trim().length > 0
            ? String((params as { objective: string }).objective).trim()
            : "Interactive session",
        cwd,
        initialContent: [],
      } as AgentCreateParams);
      const attached = await this.attachAgent(agent.agentId);
      if (attached.session !== null) {
        return attached.session;
      }
    }
    const created = await this.request("session.create", {
      ...params,
      cwd,
    });
    await this.#attachSession(created.sessionId);
    return new AgencSession(this, created.sessionId, created.agentId);
  }

  /** Attach to an existing daemon-owned session by id. */
  async resumeSession(sessionId: string): Promise<AgencSession> {
    await this.#attachSession(sessionId);
    return new AgencSession(this, sessionId);
  }

  /** Spawn a long-lived background agent (`agent.create`). */
  spawnAgent(params: AgentCreateParams): Promise<AgentCreateResult> {
    return this.request("agent.create", {
      ...params,
      // DAE-02: client fills absolute cwd when callers omit it; daemon still
      // rejects empty/relative paths.
      cwd: resolveClientCwd(
        typeof params.cwd === "string" ? params.cwd : undefined,
      ),
    });
  }

  /**
   * Attach to a running background agent. Returns the raw attach result and
   * an {@link AgencSession} bound to the agent's first active session (or
   * `null` when the agent has none).
   */
  async attachAgent(agentId: string): Promise<{
    readonly attach: AgentAttachResult;
    readonly session: AgencSession | null;
  }> {
    const attach = await this.request("agent.attach", {
      agentId,
      clientId: this.#clientId,
    });
    const sessionId = attach.sessionIds[0];
    if (sessionId === undefined) return { attach, session: null };
    this.#attachedSessionIds.add(sessionId);
    return { attach, session: new AgencSession(this, sessionId, agentId) };
  }

  listAgents(params: AgentListParams = {}): Promise<AgentListResult> {
    return this.request("agent.list", params);
  }

  stopAgent(agentId: string, reason?: string): Promise<AgentStopResult> {
    return this.request("agent.stop", {
      agentId,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  agentLogs(agentId: string): Promise<AgentLogsResult> {
    return this.request("agent.logs", { agentId });
  }

  /** Read durable run state and its aggregate M3 admission state. */
  runStatus(runId: string): Promise<RunStatusResult> {
    return this.request("run.status", { runId });
  }

  /** Read a terminal outcome. Nonterminal runs reject with RUN_NOT_TERMINAL. */
  runResult(runId: string): Promise<RunResultResult> {
    return this.request("run.result", { runId });
  }

  /** Replay a bounded page of the existing execution-admission journal. */
  replayRun(params: RunReplayParams): Promise<RunReplayResult> {
    return this.request("run.replay", params);
  }

  /** Export a bounded, hashed M3 admission evidence page. */
  runEvidence(params: RunEvidenceParams): Promise<RunEvidenceResult> {
    return this.request("run.evidence", params);
  }

  /** Tree-scoped durable run cancellation. */
  cancelRun(runId: string, reason?: string): Promise<RunCancelResult> {
    return this.request("run.cancel", {
      runId,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  /**
   * Internal engine behind {@link AgencSession.prompt}. Exposed on the
   * client so sessions stay thin data holders.
   */
  runPrompt(
    sessionId: string,
    content: MessageContent,
    options: AgencPromptOptions = {},
  ): AgencPromptRun {
    const channel = createEventChannel();
    const onPermissionRequest =
      options.onPermissionRequest ?? this.#onPermissionRequest;
    const onElicitationRequest =
      options.onElicitationRequest ?? this.#onElicitationRequest;
    const deniedPermissionRequestIds = new Set<string>();
    const handledPermissionRequestIds = new Set<string>();
    let assistantOutput = "";
    let finishing = false;

    const finish = async (status: { code: number; message?: string }) => {
      if (finishing) return;
      finishing = true;
      unsubscribe();
      let usageFields: Pick<AgencPromptResult, "usage" | "cacheStats"> = {};
      if (options.includeUsage !== false) {
        try {
          const snapshot = await this.request("session.snapshot", { sessionId });
          usageFields = {
            usage: snapshot.tokenUsage,
            cacheStats: snapshot.cacheStats,
          };
        } catch {
          /* usage is best-effort */
        }
      }
      channel.end({
        stopReason: stopReasonFromExitCode(status.code),
        exitCode: status.code,
        finalMessage: status.message ?? assistantOutput.trimEnd(),
        deniedPermissionRequestIds: [...deniedPermissionRequestIds],
        ...usageFields,
      });
    };

    const respondToPermission = async (
      event: Extract<AgencPromptEvent, { type: "permission_request" }>,
    ): Promise<void> => {
      if (handledPermissionRequestIds.has(event.requestId)) return;
      handledPermissionRequestIds.add(event.requestId);
      // Mirror `agenc -p`: an unanswered permission request suspends the turn
      // forever, so without a handler the SDK denies (never grants).
      let decision: AgencPermissionDecision = {
        behavior: "deny",
        reason: "agenc-sdk: no permission handler registered",
      };
      if (onPermissionRequest !== undefined) {
        try {
          decision = await onPermissionRequest({ ...event, sessionId });
        } catch {
          decision = {
            behavior: "deny",
            reason: "agenc-sdk: permission handler threw",
          };
        }
      }
      try {
        if (decision.behavior === "allow") {
          await this.request("tool.approve", {
            sessionId,
            requestId: event.requestId,
            ...(decision.scope !== undefined ? { scope: decision.scope } : {}),
          });
        } else {
          deniedPermissionRequestIds.add(event.requestId);
          await this.request("tool.deny", {
            sessionId,
            requestId: event.requestId,
            ...(decision.reason !== undefined
              ? { reason: decision.reason }
              : {}),
          });
        }
      } catch {
        /* stale/already-resolved requests are harmless */
      }
    };

    const respondToElicitation = async (
      event: Extract<AgencPromptEvent, { type: "elicitation_request" }>,
    ): Promise<void> => {
      if (onElicitationRequest === undefined) return;
      let response: JsonObject | null = null;
      try {
        response = await onElicitationRequest({ ...event, sessionId });
      } catch {
        return;
      }
      if (response === null) return;
      try {
        await this.request("elicitation.respond", {
          sessionId,
          requestId: event.requestId,
          kind: event.kind,
          ...(event.serverName !== undefined
            ? { serverName: event.serverName }
            : {}),
          response,
        });
      } catch {
        /* stale/already-resolved requests are harmless */
      }
    };

    const unsubscribe = this.onSessionNotification(sessionId, (message) => {
      const event = promptEventFromNotification(message);
      if (event !== null) {
        if (event.type === "text") assistantOutput += event.delta;
        channel.push(event);
        if (event.type === "permission_request") void respondToPermission(event);
        if (event.type === "elicitation_request") {
          void respondToElicitation(event);
        }
      }
      const terminal = terminalStatusFromNotification(message);
      if (terminal !== null) void finish(terminal);
    });

    if (options.signal !== undefined) {
      const signal = options.signal;
      const onAbort = () => {
        void this.request("session.cancelTurn", {
          sessionId,
          reason: String(signal.reason ?? "aborted"),
        }).catch(() => {});
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const accepted = (async () => {
      await this.#attachSession(sessionId);
      const sendResult = await this.request("message.send", {
        sessionId,
        content,
        ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      });
      return { messageId: sendResult.messageId };
    })();
    accepted.catch((error: unknown) => {
      unsubscribe();
      channel.fail(error instanceof Error ? error : new Error(String(error)));
    });

    const self = this;
    return {
      sessionId,
      accepted,
      result: () => channel.result,
      cancel: async (reason?: string) => {
        await self.request("session.cancelTurn", {
          sessionId,
          ...(reason !== undefined ? { reason } : {}),
        });
      },
      [Symbol.asyncIterator]: () => channel.iterate(),
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#notificationListeners.clear();
    this.#sessionListeners.clear();
    await this.#transport.close?.();
  }

  async #attachSession(sessionId: string): Promise<void> {
    if (this.#attachedSessionIds.has(sessionId)) return;
    await this.request("session.attach", {
      sessionId,
      clientId: this.#clientId,
    });
    this.#attachedSessionIds.add(sessionId);
  }
}

export function createAgencClient(options: AgencClientOptions): AgencClient {
  return new AgencClient(options);
}

function numericIdFactory(): () => number {
  let nextId = 1;
  return () => {
    const id = nextId;
    nextId += 1;
    return id;
  };
}

function safeNotify(
  listener: (message: JsonObject) => void,
  message: JsonObject,
): void {
  try {
    listener(message);
  } catch {
    // Listener failures must not poison notification routing.
  }
}

function parseResponse<Method extends AgencDaemonMethod>(
  response: AgencDaemonResponse<Method>,
  method: Method,
  requestId: RequestId,
): AgencResultByMethod[Method] {
  if (!isJsonObject(response)) {
    throw new AgencMalformedResponseError(
      "AgenC daemon response must be an object",
      response,
    );
  }
  if (response.jsonrpc !== AGENC_SDK_JSON_RPC_VERSION) {
    throw new AgencMalformedResponseError(
      "AgenC daemon response used an unsupported JSON-RPC version",
      response,
    );
  }
  if ("error" in response && isJsonObject(response.error)) {
    throw new AgencRpcError(
      response.error as AgencDaemonErrorObject,
      method,
      (response as { id: RequestId | null }).id,
    );
  }
  if (response.id !== requestId) {
    throw new AgencMalformedResponseError(
      "AgenC daemon response id mismatch",
      response,
    );
  }
  if (!("result" in response)) {
    throw new AgencMalformedResponseError(
      "AgenC daemon response must include result or error",
      response,
    );
  }
  return (response as AgencDaemonResponse<Method> & { result: AgencResultByMethod[Method] })
    .result;
}

/** Absolute workspace path for daemon create RPCs (DAE-02 client boundary). */
function resolveClientCwd(cwd: string | undefined): string {
  const base = process.cwd();
  if (typeof cwd === "string" && cwd.trim().length > 0) {
    const trimmed = cwd.trim();
    return isAbsolute(trimmed) ? resolve(trimmed) : resolve(base, trimmed);
  }
  return resolve(base);
}
