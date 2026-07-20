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
  type RunReplayEvent,
  type RunReplayGap,
  type RunReplayParams,
  type RunReplayResult,
  type RunResultResult,
  type RunStartParams,
  type RunStartResult,
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

/** A durable replay cursor cannot be advanced without acknowledging a gap. */
export class AgencRunReplayGapError extends Error {
  readonly runId: string;
  readonly cursor: AgencRunReplayCursor;
  readonly gap: RunReplayGap;

  constructor(cursor: AgencRunReplayCursor, gap: RunReplayGap) {
    const firstAvailable =
      "firstAvailableSequence" in gap
        ? `; first available sequence is ${String(gap.firstAvailableSequence)}`
        : "lastAvailableSequence" in gap
          ? `; last available sequence is ${String(gap.lastAvailableSequence)}`
          : "";
    super(
      `AgenC run replay for ${cursor.runId} has an explicit ${gap.reason} gap after sequence ${String(cursor.afterSequence)}${firstAvailable}`,
    );
    this.name = "AgencRunReplayGapError";
    this.runId = cursor.runId;
    this.cursor = cursor;
    this.gap = gap;
  }
}

/** The daemon returned a replay page that could hide loss or corruption. */
export class AgencRunReplayProtocolError extends Error {
  readonly runId: string;
  readonly cursor: AgencRunReplayCursor;
  readonly response?: unknown;

  constructor(
    message: string,
    cursor: AgencRunReplayCursor,
    response?: unknown,
  ) {
    super(message);
    this.name = "AgencRunReplayProtocolError";
    this.runId = cursor.runId;
    this.cursor = cursor;
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

/** Serializable exclusive cursor for reconnecting to one durable run. */
export interface AgencRunReplayCursor {
  readonly runId: string;
  readonly afterSequence: number;
}

export type AgencRunReplayDuplicateReason =
  | "same_identity"
  | "at_or_before_cursor";

export interface AgencRunReplayDuplicate {
  readonly event: RunReplayEvent;
  readonly reason: AgencRunReplayDuplicateReason;
  /** Present when the same event was already observed by this attachment. */
  readonly original?: RunReplayEvent;
}

export interface AgencRunReattachOptions extends AgencRunReplayCursor {
  /** Page size sent to run.replay. Defaults to 100; valid range is 1..200. */
  readonly limit?: number;
  /**
   * Most recently delivered identities retained with their complete
   * fingerprints for exact duplicate diagnostics. Defaults to 1,024; valid
   * range is 1..100,000. Older identities remain in a fixed-size fail-closed
   * membership filter, so reuse is rejected rather than silently accepted.
   */
  readonly identityWindow?: number;
  readonly signal?: AbortSignal;
  /** Called for harmless duplicate delivery; callback failures are ignored. */
  readonly onDuplicate?: (duplicate: AgencRunReplayDuplicate) => void;
}

export interface AgencRunReplayDiagnostics {
  readonly duplicatesDropped: number;
  /** Exact identities currently retained; never exceeds identityWindow. */
  readonly trackedIdentities: number;
  readonly identityWindow: number;
}

/**
 * Cursor-safe attachment to a durable run.
 *
 * Iteration catches up to the journal head and then ends. Persist `cursor()`
 * and pass it to a new client's `reattachRun` after reconnecting. An explicit
 * replay gap throws {@link AgencRunReplayGapError} without advancing it.
 */
export interface AgencRunAttachment extends AsyncIterable<RunReplayEvent> {
  readonly runId: string;
  cursor(): AgencRunReplayCursor;
  replay(): AsyncGenerator<RunReplayEvent, void>;
  /** Durable terminal-result read; independent of the original connection. */
  result(): Promise<RunResultResult>;
  diagnostics(): AgencRunReplayDiagnostics;
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

interface SeenReplayEvent {
  readonly event: RunReplayEvent;
  readonly fingerprint: string;
}

const DEFAULT_REPLAY_IDENTITY_WINDOW = 1_024;
const MAX_REPLAY_IDENTITY_WINDOW = 100_000;
const REPLAY_IDENTITY_FILTER_BYTES = 64 * 1_024;

/**
 * Fixed-memory membership filter for identities that age out of the exact
 * fingerprint window. It has no false negatives because bits are never
 * cleared. A hash collision can only reject a new identity (fail closed);
 * it can never let an old identity be reused as new.
 */
class SeenReplayIdentityFilter {
  readonly #bits = new Uint8Array(REPLAY_IDENTITY_FILTER_BYTES);

  add(value: string): void {
    for (const bit of replayIdentityHashBits(value)) {
      this.#bits[bit >>> 3] |= 1 << (bit & 7);
    }
  }

  has(value: string): boolean {
    for (const bit of replayIdentityHashBits(value)) {
      if ((this.#bits[bit >>> 3]! & (1 << (bit & 7))) === 0) return false;
    }
    return true;
  }
}

interface ValidatedReplayPage {
  readonly events: readonly SeenReplayEvent[];
  readonly hasMore: boolean;
  readonly gap: RunReplayGap | null;
}

class ClientRunAttachment implements AgencRunAttachment {
  readonly runId: string;
  readonly #client: AgencClient;
  readonly #limit: number;
  readonly #identityWindow: number;
  readonly #signal: AbortSignal | undefined;
  readonly #onDuplicate:
    | ((duplicate: AgencRunReplayDuplicate) => void)
    | undefined;
  readonly #seenBySequence = new Map<number, SeenReplayEvent>();
  readonly #seenByEventId = new Map<string, SeenReplayEvent>();
  readonly #seenOrder = new Set<SeenReplayEvent>();
  readonly #seenEventIds = new SeenReplayIdentityFilter();
  #afterSequence: number;
  #duplicatesDropped = 0;
  #replaying = false;

  constructor(client: AgencClient, options: AgencRunReattachOptions) {
    this.#client = client;
    this.runId = normalizeReplayRunId(options.runId);
    this.#afterSequence = normalizeReplayAfterSequence(options.afterSequence);
    this.#limit = normalizeReplayLimit(options.limit);
    this.#identityWindow = normalizeReplayIdentityWindow(
      options.identityWindow,
    );
    this.#signal = options.signal;
    this.#onDuplicate = options.onDuplicate;
  }

  cursor(): AgencRunReplayCursor {
    return { runId: this.runId, afterSequence: this.#afterSequence };
  }

  diagnostics(): AgencRunReplayDiagnostics {
    return {
      duplicatesDropped: this.#duplicatesDropped,
      trackedIdentities: this.#seenOrder.size,
      identityWindow: this.#identityWindow,
    };
  }

  async #fetchPage(): Promise<ValidatedReplayPage> {
    const requestedAfterSequence = this.#afterSequence;
    const requestedCursor = this.cursor();
    this.#signal?.throwIfAborted();
    const response = await this.#client.replayRun({
      runId: this.runId,
      afterSequence: requestedAfterSequence,
      limit: this.#limit,
    });
    this.#signal?.throwIfAborted();
    validateReplayPageEnvelope(response, requestedCursor, this.#limit);

    if (
      response.gap === null &&
      response.source.sequenceScope === "run" &&
      response.firstAvailableSequence !== undefined &&
      response.firstAvailableSequence > requestedAfterSequence + 1
    ) {
      throw new AgencRunReplayProtocolError(
        `AgenC run replay exposed first available sequence ${String(response.firstAvailableSequence)} without an explicit gap`,
        requestedCursor,
        response,
      );
    }

    const uniqueEvents: SeenReplayEvent[] = [];
    const pageBySequence = new Map<number, SeenReplayEvent>();
    const pageByEventId = new Map<string, SeenReplayEvent>();
    let previousNewSequence = requestedAfterSequence;
    for (const event of response.events) {
      validateReplayEvent(event, requestedCursor, response);
      const fingerprint = canonicalJson(event);
      const bySequence =
        pageBySequence.get(event.sequence) ??
        this.#seenBySequence.get(event.sequence);
      const byEventId =
        pageByEventId.get(event.eventId) ??
        this.#seenByEventId.get(event.eventId);

      if (bySequence !== undefined || byEventId !== undefined) {
        const original = bySequence ?? byEventId!;
        if (
          original.event.sequence !== event.sequence ||
          original.event.eventId !== event.eventId ||
          original.fingerprint !== fingerprint
        ) {
          throw new AgencRunReplayProtocolError(
            `AgenC run replay reused event identity ${event.eventId}/${String(event.sequence)} with conflicting data`,
            requestedCursor,
            response,
          );
        }
        this.#reportDuplicate({
          event,
          reason: "same_identity",
          original: original.event,
        });
        continue;
      }

      if (event.sequence <= requestedAfterSequence) {
        throw new AgencRunReplayProtocolError(
          "AgenC run replay cannot verify event " +
            event.eventId +
            "/" +
            String(event.sequence) +
            " at or before exclusive cursor " +
            String(requestedAfterSequence),
          requestedCursor,
          response,
        );
      }
      if (this.#seenEventIds.has(event.eventId)) {
        throw new AgencRunReplayProtocolError(
          "AgenC run replay reused event identity " +
            event.eventId +
            " outside the exact verification window",
          requestedCursor,
          response,
        );
      }
      if (event.sequence <= previousNewSequence) {
        throw new AgencRunReplayProtocolError(
          `AgenC run replay events are not strictly sequence ordered after ${String(previousNewSequence)}`,
          requestedCursor,
          response,
        );
      }
      if (
        response.source.sequenceScope === "run" &&
        event.sequence !== previousNewSequence + 1
      ) {
        throw new AgencRunReplayProtocolError(
          `AgenC run replay skipped sequence ${String(previousNewSequence + 1)} without an explicit gap`,
          requestedCursor,
          response,
        );
      }

      const seen = { event, fingerprint };
      pageBySequence.set(event.sequence, seen);
      pageByEventId.set(event.eventId, seen);
      uniqueEvents.push(seen);
      previousNewSequence = event.sequence;
    }

    const expectedNextAfterSequence =
      uniqueEvents.at(-1)?.event.sequence ?? requestedAfterSequence;
    if (response.nextAfterSequence !== expectedNextAfterSequence) {
      throw new AgencRunReplayProtocolError(
        `AgenC run replay attempted to advance from ${String(requestedAfterSequence)} to ${String(response.nextAfterSequence)} without a matching final event`,
        requestedCursor,
        response,
      );
    }
    if (
      response.gap === null &&
      response.hasMore &&
      expectedNextAfterSequence === requestedAfterSequence
    ) {
      throw new AgencRunReplayProtocolError(
        "AgenC run replay reported more events without advancing its cursor",
        requestedCursor,
        response,
      );
    }
    if (
      response.gap === null &&
      response.lastAvailableSequence !== undefined &&
      ((response.hasMore &&
        expectedNextAfterSequence >= response.lastAvailableSequence) ||
        (!response.hasMore &&
          expectedNextAfterSequence !== response.lastAvailableSequence))
    ) {
      throw new AgencRunReplayProtocolError(
        response.hasMore
          ? "AgenC run replay reported more events at or beyond its advertised journal tail"
          : `AgenC run replay ended at sequence ${String(expectedNextAfterSequence)} before its advertised journal tail ${String(response.lastAvailableSequence)}`,
        requestedCursor,
        response,
      );
    }

    if (response.gap !== null) {
      validateReplayGap(
        response.gap,
        { runId: this.runId, afterSequence: expectedNextAfterSequence },
        response,
      );
    }

    return {
      events: uniqueEvents,
      hasMore: response.hasMore,
      gap: response.gap,
    };
  }

  async *replay(): AsyncGenerator<RunReplayEvent, void> {
    if (this.#replaying) {
      throw new AgencRunReplayProtocolError(
        "AgenC run replay does not allow concurrent cursor advancement",
        this.cursor(),
      );
    }
    this.#replaying = true;
    try {
      for (;;) {
        const page = await this.#fetchPage();
        for (const seen of page.events) {
          this.#signal?.throwIfAborted();
          this.#remember(seen);
          this.#afterSequence = seen.event.sequence;
          yield seen.event;
        }
        if (page.gap !== null) {
          throw new AgencRunReplayGapError(this.cursor(), page.gap);
        }
        if (!page.hasMore) return;
      }
    } finally {
      this.#replaying = false;
    }
  }

  [Symbol.asyncIterator](): AsyncGenerator<RunReplayEvent, void> {
    return this.replay();
  }

  result(): Promise<RunResultResult> {
    return this.#client.runResult(this.runId);
  }

  #reportDuplicate(duplicate: AgencRunReplayDuplicate): void {
    this.#duplicatesDropped += 1;
    try {
      this.#onDuplicate?.(duplicate);
    } catch {
      // Observability callbacks cannot make safe duplicate suppression fail.
    }
  }

  #remember(seen: SeenReplayEvent): void {
    this.#seenBySequence.set(seen.event.sequence, seen);
    this.#seenByEventId.set(seen.event.eventId, seen);
    this.#seenEventIds.add(seen.event.eventId);
    this.#seenOrder.add(seen);
    while (this.#seenOrder.size > this.#identityWindow) {
      const retired = this.#seenOrder.values().next().value;
      if (retired === undefined) break;
      this.#seenOrder.delete(retired);
      if (this.#seenBySequence.get(retired.event.sequence) === retired) {
        this.#seenBySequence.delete(retired.event.sequence);
      }
      if (this.#seenByEventId.get(retired.event.eventId) === retired) {
        this.#seenByEventId.delete(retired.event.eventId);
      }
    }
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

  /** Replay a bounded page of the canonical run journal. */
  replayRun(params: RunReplayParams): Promise<RunReplayResult> {
    return this.request("run.replay", params);
  }

  /**
   * Reattach to a durable run from an exclusive cursor.
   *
   * The returned attachment preserves event identity, suppresses harmless
   * duplicate delivery, refuses silent cursor jumps, and exposes a durable
   * `run.result` read that does not depend on the original connection.
   */
  reattachRun(options: AgencRunReattachOptions): AgencRunAttachment {
    return new ClientRunAttachment(this, options);
  }

  /** Export a bounded, hashed canonical run-journal evidence page. */
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
   * Start the M5 verified-change workflow as a durable daemon run. Resolves
   * after the intake commit; follow the pipeline with the existing
   * status/replay/result/evidence cursor contract on the returned run id.
   */
  startRun(params: RunStartParams): Promise<RunStartResult> {
    return this.request("run.start", params);
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

function normalizeReplayRunId(runId: string): string {
  const normalized = runId.trim();
  if (normalized.length === 0) {
    throw new TypeError("AgenC run replay requires a non-empty runId");
  }
  return normalized;
}

function normalizeReplayAfterSequence(afterSequence: number): number {
  if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
    throw new TypeError(
      "AgenC run replay afterSequence must be a non-negative safe integer",
    );
  }
  return afterSequence;
}

function normalizeReplayLimit(limit: number | undefined): number {
  const normalized = limit ?? 100;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > 200
  ) {
    throw new TypeError("AgenC run replay limit must be an integer from 1 to 200");
  }
  return normalized;
}

function normalizeReplayIdentityWindow(window: number | undefined): number {
  const normalized = window ?? DEFAULT_REPLAY_IDENTITY_WINDOW;
  if (
    !Number.isSafeInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_REPLAY_IDENTITY_WINDOW
  ) {
    throw new TypeError(
      "AgenC run replay identityWindow must be an integer from 1 to " +
        String(MAX_REPLAY_IDENTITY_WINDOW),
    );
  }
  return normalized;
}

function validateReplayPageEnvelope(
  response: RunReplayResult,
  cursor: AgencRunReplayCursor,
  requestedLimit: number,
): void {
  if (!isJsonObject(response)) {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay response must be an object",
      cursor,
      response,
    );
  }
  if (response.runId !== cursor.runId) {
    throw new AgencRunReplayProtocolError(
      `AgenC run replay returned run ${response.runId} for ${cursor.runId}`,
      cursor,
      response,
    );
  }
  if (response.afterSequence !== cursor.afterSequence) {
    throw new AgencRunReplayProtocolError(
      `AgenC run replay returned cursor ${String(response.afterSequence)} for requested cursor ${String(cursor.afterSequence)}`,
      cursor,
      response,
    );
  }
  if (response.limit !== requestedLimit) {
    throw new AgencRunReplayProtocolError(
      `AgenC run replay returned limit ${String(response.limit)} for requested limit ${String(requestedLimit)}`,
      cursor,
      response,
    );
  }
  if (!Array.isArray(response.events)) {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay response events must be an array",
      cursor,
      response,
    );
  }
  if (response.events.length > requestedLimit) {
    throw new AgencRunReplayProtocolError(
      `AgenC run replay returned ${String(response.events.length)} events for limit ${String(requestedLimit)}`,
      cursor,
      response,
    );
  }
  const firstAvailableSequence = response.firstAvailableSequence;
  const lastAvailableSequence = response.lastAvailableSequence;
  if (
    firstAvailableSequence !== undefined &&
    (!Number.isSafeInteger(firstAvailableSequence) ||
      firstAvailableSequence < 1)
  ) {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay returned an invalid firstAvailableSequence",
      cursor,
      response,
    );
  }
  if (
    lastAvailableSequence !== undefined &&
    (!Number.isSafeInteger(lastAvailableSequence) || lastAvailableSequence < 0)
  ) {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay returned an invalid lastAvailableSequence",
      cursor,
      response,
    );
  }
  if (
    firstAvailableSequence !== undefined &&
    lastAvailableSequence !== undefined &&
    firstAvailableSequence > lastAvailableSequence &&
    (response.events.length > 0 ||
      firstAvailableSequence - lastAvailableSequence !== 1)
  ) {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay returned inconsistent available-sequence bounds",
      cursor,
      response,
    );
  }
  if (
    !Number.isSafeInteger(response.nextAfterSequence) ||
    response.nextAfterSequence < cursor.afterSequence
  ) {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay returned an invalid nextAfterSequence",
      cursor,
      response,
    );
  }
  if (typeof response.hasMore !== "boolean") {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay response hasMore must be boolean",
      cursor,
      response,
    );
  }
  if (!isJsonObject(response.source)) {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay response source must be an object",
      cursor,
      response,
    );
  }
  validateReplaySource(response, cursor);
  if (
    response.source.kind === "run_journal" &&
    response.source.available &&
    (response.events.length > 0 || cursor.afterSequence > 0) &&
    response.lastAvailableSequence === undefined
  ) {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay omitted the canonical journal tail",
      cursor,
      response,
    );
  }
  if (response.gap !== null && !isJsonObject(response.gap)) {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay response gap must be null or an object",
      cursor,
      response,
    );
  }
}

function validateReplaySource(
  response: RunReplayResult,
  cursor: AgencRunReplayCursor,
): void {
  const source = response.source;
  const invalid = (message: string): never => {
    throw new AgencRunReplayProtocolError(message, cursor, response);
  };
  if (
    typeof source.available !== "boolean" ||
    typeof source.projectDir !== "string" ||
    source.projectDir.length === 0
  ) {
    invalid("AgenC run replay returned malformed source metadata");
  }
  if (source.kind === "run_journal") {
    if (
      source.sequenceScope !== "run" ||
      source.canonical !== "rollout_jsonl" ||
      source.projection !== "thread_rollout_items"
    ) {
      invalid("AgenC run replay returned malformed run-journal source metadata");
    }
  } else if (source.kind === "execution_admission_journal") {
    if (
      source.sequenceScope !== "project_state_database" ||
      source.canonical !== undefined ||
      source.projection !== undefined
    ) {
      invalid("AgenC run replay returned malformed admission-journal source metadata");
    }
  } else {
    invalid("AgenC run replay returned an unknown source kind");
  }

  const sourceUnavailable = response.gap?.kind === "source_unavailable";
  if (
    source.available === sourceUnavailable ||
    (!source.available && (response.events.length > 0 || response.hasMore))
  ) {
    invalid("AgenC run replay source availability conflicts with its page");
  }
  if (
    sourceUnavailable &&
    ((source.kind === "run_journal" &&
      response.gap?.reason !== "run_journal_not_present") ||
      (source.kind === "execution_admission_journal" &&
        response.gap?.reason !== "execution_admission_journal_not_present"))
  ) {
    invalid("AgenC run replay source kind conflicts with its unavailable reason");
  }
}

function validateReplayEvent(
  event: RunReplayEvent,
  cursor: AgencRunReplayCursor,
  response: RunReplayResult,
): void {
  const invalid = (message: string): never => {
    throw new AgencRunReplayProtocolError(message, cursor, response);
  };
  const isNonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  if (!isJsonObject(event)) {
    invalid("AgenC run replay event must be an object");
  }
  if (
    !Number.isSafeInteger(event.sequence) ||
    event.sequence < 1 ||
    !isNonEmptyString(event.eventId)
  ) {
    invalid(
      "AgenC run replay event requires a positive sequence and non-empty eventId",
    );
  }

  if (response.source.kind === "run_journal") {
    const canonicalCategories = new Set([
      "run",
      "step",
      "admission",
      "budget",
      "permission",
      "approval",
      "effect",
      "model",
      "artifact",
      "cancellation",
      "recovery",
      "terminal",
      "session",
    ]);
    if (
      !isNonEmptyString(event.runId) ||
      !isNonEmptyString(event.kind) ||
      !isNonEmptyString(event.event) ||
      !isNonEmptyString(event.category) ||
      !canonicalCategories.has(event.category) ||
      (event.timestamp !== undefined && !isNonEmptyString(event.timestamp)) ||
      (event.stepId !== undefined && !isNonEmptyString(event.stepId))
    ) {
      invalid("AgenC run replay returned a malformed canonical event envelope");
    }
    if (event.runId !== cursor.runId) {
      invalid(
        `AgenC run replay event ${event.eventId} belongs to unexpected run ${event.runId}`,
      );
    }
    return;
  }

  if (
    !isNonEmptyString(event.timestamp) ||
    !isNonEmptyString(event.runId) ||
    !isNonEmptyString(event.stepId) ||
    !isNonEmptyString(event.kind) ||
    !isNonEmptyString(event.event) ||
    (event.category !== undefined && event.category !== "admission")
  ) {
    invalid("AgenC run replay returned a malformed admission event envelope");
  }
}

function validateReplayGap(
  gap: RunReplayGap,
  cursor: AgencRunReplayCursor,
  response: RunReplayResult,
): void {
  if (gap.kind === "source_unavailable") {
    if (
      gap.reason !== "execution_admission_journal_not_present" &&
      gap.reason !== "run_journal_not_present"
    ) {
      throw new AgencRunReplayProtocolError(
        "AgenC run replay returned an unknown source-unavailable reason",
        cursor,
        response,
      );
    }
    return;
  }
  if (gap.kind === "cursor_ahead") {
    if (
      gap.runId !== cursor.runId ||
      gap.afterSequence !== cursor.afterSequence ||
      gap.reason !== "cursor_ahead" ||
      !Number.isSafeInteger(gap.lastAvailableSequence) ||
      gap.lastAvailableSequence < 0 ||
      gap.lastAvailableSequence >= gap.afterSequence ||
      response.lastAvailableSequence !== gap.lastAvailableSequence
    ) {
      throw new AgencRunReplayProtocolError(
        "AgenC run replay returned a malformed or mismatched cursor-ahead gap",
        cursor,
        response,
      );
    }
    return;
  }
  if (
    gap.kind !== "event_gap" ||
    gap.runId !== cursor.runId ||
    gap.afterSequence !== cursor.afterSequence ||
    !Number.isSafeInteger(gap.firstAvailableSequence) ||
    gap.firstAvailableSequence <= gap.afterSequence ||
    (response.firstAvailableSequence !== undefined &&
      response.firstAvailableSequence !== gap.firstAvailableSequence) ||
    (gap.reason !== "retention" &&
      gap.reason !== "corruption_truncated" &&
      gap.reason !== "compaction")
  ) {
    throw new AgencRunReplayProtocolError(
      "AgenC run replay returned a malformed or mismatched event gap",
      cursor,
      response,
    );
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (isJsonObject(value)) {
    const fields = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function replayIdentityHashBits(value: string): readonly number[] {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second =
      Math.imul(second ^ (code + index), 0x85ebca6b) + 0xc2b2ae35;
    second >>>= 0;
  }
  const bitCount = REPLAY_IDENTITY_FILTER_BYTES * 8;
  return [
    first % bitCount,
    second % bitCount,
    (first + second) % bitCount,
    ((first + Math.imul(second, 3)) >>> 0) % bitCount,
  ];
}
