/**
 * OpenAI Responses API over one WebSocket per provider session.
 *
 * The socket carries the same create body as `POST /responses`, as a
 * `response.create` frame, and answers with the same streaming events, one
 * JSON object per frame. A response that follows the previous one on the same
 * socket can name it in `previous_response_id` and send only the new input
 * items: the service keeps the latest response of a connection in memory,
 * also with `store: false`.
 * https://developers.openai.com/api/docs/guides/websocket-mode
 *
 * Everything here fails toward HTTP: a request this module cannot carry is
 * reported as a {@link ResponsesWebSocketFallback}, and the adapter sends the
 * unchanged full body over SSE.
 *
 * @module
 */

import { isDeepStrictEqual } from "node:util";
import WebSocket, { type RawData } from "ws";

/** The shape the adapter's SSE reader yields, so both transports share a loop. */
export interface ResponsesWebSocketEvent {
  readonly event?: string;
  readonly data: Record<string, unknown>;
}

export interface ResponsesWebSocketTarget {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface ResponsesWebSocketTurn {
  /** Whether the frame carried `previous_response_id` and only new input. */
  readonly incremental: boolean;
  events(): AsyncGenerator<ResponsesWebSocketEvent>;
  /** Give the response up without reading it: closes the socket and frees the session. */
  cancel(): void;
}

export interface ResponsesWebSocketStats {
  connects: number;
  connectFailures: number;
  turns: number;
  incrementalTurns: number;
  fallbacks: number;
  /** Sockets opened ahead of a request: at session start or after one was lost. */
  preconnects: number;
}

/**
 * The request did not start on the socket and the full body must go over
 * HTTP. `afterSend` tells a caller that allows a single wire attempt that the
 * frame may have reached the service; `refused` that the service answered it
 * with an error frame, so nothing was generated.
 */
export class ResponsesWebSocketFallback extends Error {
  readonly afterSend: boolean;
  readonly refused: boolean;
  readonly errorFrame?: Record<string, unknown>;

  constructor(
    reason: string,
    details: { afterSend?: boolean; refused?: boolean; errorFrame?: Record<string, unknown> } = {},
  ) {
    super(reason);
    this.name = "ResponsesWebSocketFallback";
    this.afterSend = details.afterSend === true;
    this.refused = details.refused === true;
    if (details.errorFrame !== undefined) this.errorFrame = details.errorFrame;
  }
}

type Item = Record<string, unknown>;

/** What the last completed response of the socket left to continue from. */
export interface ResponsesWebSocketChain {
  readonly responseId: string;
  /** The request without `input`, serialized. */
  readonly fixed: string;
  /** Each item of the full logical input, serialized. */
  readonly input: readonly string[];
  readonly output: readonly Item[];
}

const TERMINAL_EVENTS: ReadonlySet<string> = new Set([
  "response.completed",
  "response.incomplete",
  "response.failed",
]);
const CONNECTION_LIMIT_CODE = "websocket_connection_limit_reached";
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** The service closes a connection at 60 minutes; replace it before that. */
const DEFAULT_MAX_CONNECTION_AGE_MS = 55 * 60_000;
const FAILURES_BEFORE_HTTP_ONLY = 2;
/**
 * Sockets opened ahead of a request that may go unused in a row. A far end
 * that closes idle sockets would otherwise be reconnected to for as long as
 * the session sits idle.
 */
const MAX_UNUSED_CONNECTS = 2;
/**
 * How long a sent frame may stay unanswered. The first event of a response
 * arrives within a second; a socket that stays silent is half open (no ping
 * tells), and the stream idle timeout is off by default.
 */
const DEFAULT_FIRST_EVENT_TIMEOUT_MS = 30_000;
const DEFAULT_SEND_TIMEOUT_MS = 30_000;

function isItem(value: unknown): value is Item {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Every top-level field but the input (and the HTTP-only `stream`). */
export function responsesWebSocketFixedPart(body: Readonly<Record<string, unknown>>): string {
  const { input: _input, stream: _stream, ...fixed } = body;
  return JSON.stringify(fixed);
}

function outputText(item: Item): string | undefined {
  if (!Array.isArray(item.content)) return undefined;
  let text = "";
  for (const part of item.content) {
    if (!isItem(part) || part.type !== "output_text" || typeof part.text !== "string") {
      return undefined;
    }
    text += part.text;
  }
  return text;
}

function sameArguments(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left === right) return true;
  try {
    return isDeepStrictEqual(JSON.parse(left), JSON.parse(right));
  } catch {
    return false;
  }
}

function isReplayItem(item: unknown): item is Item {
  return isItem(item) && (item.type === "reasoning" || item.type === "function_call" ||
    (item.type === "message" && item.role === "assistant"));
}

/**
 * Whether `replay`, the items a full request carries for the previous
 * response, say what that response's `output` said: the same function calls,
 * the same assistant text and no reasoning item it did not issue. The service
 * continues from its own copy, so anything else would change the conversation.
 */
function replayMatchesOutput(replay: readonly Item[], output: readonly Item[]): boolean {
  const calls = new Map<string, Item>();
  const reasoningIds = new Set<string>();
  let text = "";
  for (const item of output) {
    if (item.type === "function_call") {
      if (typeof item.call_id !== "string" || item.call_id.length === 0 || calls.has(item.call_id)) {
        return false;
      }
      calls.set(item.call_id, item);
    } else if (item.type === "reasoning") {
      if (typeof item.id === "string") reasoningIds.add(item.id);
    } else if (item.type === "message" && (item.role === undefined || item.role === "assistant")) {
      const part = outputText(item);
      if (part === undefined) return false;
      text += part;
    } else {
      // Server tool calls and unknown items have no replay to compare with.
      return false;
    }
  }
  let replayText = "";
  for (const item of replay) {
    if (item.type === "function_call") {
      const issued = typeof item.call_id === "string" ? calls.get(item.call_id) : undefined;
      if (issued === undefined || issued.name !== item.name ||
        !sameArguments(issued.arguments, item.arguments)) {
        return false;
      }
      calls.delete(item.call_id as string);
    } else if (item.type === "reasoning") {
      if (typeof item.id !== "string" || !reasoningIds.has(item.id)) return false;
    } else {
      const part = outputText(item);
      if (part === undefined) return false;
      replayText += part;
    }
  }
  // Exactly: an edit that only changes whitespace is still an edit.
  return calls.size === 0 && replayText === text;
}

/**
 * The input a `response.create` frame can send on top of `chain`, or nothing
 * when the request is not a plain continuation of it: another model,
 * instructions, tools or sampling field, a rewritten history (compaction, an
 * edit, a changed leading item), a replay that differs from what the service
 * produced, or no new item.
 */
export function planResponsesWebSocketInput(
  chain: ResponsesWebSocketChain,
  body: Readonly<Record<string, unknown>>,
): unknown[] | undefined {
  const input = body.input;
  if (!Array.isArray(input) || input.length <= chain.input.length) return undefined;
  if (responsesWebSocketFixedPart(body) !== chain.fixed) return undefined;
  for (const [index, previous] of chain.input.entries()) {
    if (JSON.stringify(input[index]) !== previous) return undefined;
  }
  let next = chain.input.length;
  const replay: Item[] = [];
  while (next < input.length && isReplayItem(input[next])) {
    replay.push(input[next] as Item);
    next += 1;
  }
  if (next >= input.length || !replayMatchesOutput(replay, chain.output)) return undefined;
  return input.slice(next);
}

/** The frame for `body`; `incrementalInput` comes from the plan above. */
export function responsesWebSocketCreateFrame(
  body: Readonly<Record<string, unknown>>,
  chain?: ResponsesWebSocketChain,
  incrementalInput?: unknown[],
): Record<string, unknown> {
  // `stream` is implicit on a socket and must not be sent.
  const { stream: _stream, ...create } = body;
  return chain !== undefined && incrementalInput !== undefined
    ? { type: "response.create", ...create, input: incrementalInput, previous_response_id: chain.responseId }
    : { type: "response.create", ...create };
}

/** Hold the event loop open for a response in flight, and only then. */
function keepProcessAlive(socket: WebSocket, alive: boolean): void {
  const raw = (socket as unknown as { _socket?: { ref?: () => void; unref?: () => void } })._socket;
  if (alive) raw?.ref?.();
  else raw?.unref?.();
}

/**
 * Whether an error frame refuses the continuation itself (an unknown or
 * unsupported `previous_response_id`), as opposed to the request (a rate
 * limit, an overload), which says nothing about later continuations.
 */
function refusesContinuation(error: Item): boolean {
  return error.code === "previous_response_not_found" || error.param === "previous_response_id" ||
    (typeof error.message === "string" && error.message.includes("previous_response_id"));
}

/** A handshake nobody waits for must not keep the process alive. */
function unrefHandshake(socket: WebSocket): void {
  const request = (socket as unknown as {
    _req?: { socket?: { unref?: () => void }; once?: (event: "socket", listener: (raw: { unref?: () => void }) => void) => void };
  })._req;
  if (request?.socket !== undefined && request.socket !== null) request.socket.unref?.();
  else request?.once?.("socket", (raw) => raw.unref?.());
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Operation aborted", "AbortError");
}

type Arrival =
  | { readonly kind: "frame"; readonly data: Record<string, unknown> }
  | { readonly kind: "invalid" }
  | { readonly kind: "closed" };

type Waited =
  | Arrival
  | { readonly kind: "aborted" }
  | { readonly kind: "idle" };

interface Connection {
  readonly socket: WebSocket;
  readonly openedAt: number;
  readonly queue: Arrival[];
  wake?: () => void;
  closed: boolean;
  ageTimer?: ReturnType<typeof setTimeout>;
}

type TargetResolver = () => Promise<ResponsesWebSocketTarget>;

export interface ResponsesWebSocketSessionOptions {
  readonly providerName: string;
  readonly connectTimeoutMs?: number;
  readonly maxConnectionAgeMs?: number;
  readonly firstEventTimeoutMs?: number;
  /** How long writing a frame may take before the socket is given up (default 30 s). */
  readonly sendTimeoutMs?: number;
  /** Failed starts in a row that keep the session on HTTP (default 2). */
  readonly failuresBeforeHttpOnly?: number;
  readonly now?: () => number;
}

export interface ResponsesWebSocketBeginOptions {
  /** Resolved per connect, so a refreshed credential reaches a new socket. */
  readonly target: () => Promise<ResponsesWebSocketTarget>;
  /** The HTTP request body, complete. */
  readonly body: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
  readonly idleTimeoutMs?: number;
  /** `false` always sends the full input. */
  readonly incremental?: boolean;
}

/** One socket, one response at a time, and the chain to continue from. */
export class ResponsesWebSocketSession {
  readonly stats: ResponsesWebSocketStats = {
    connects: 0, connectFailures: 0, turns: 0, incrementalTurns: 0, fallbacks: 0, preconnects: 0,
  };

  private readonly options: ResponsesWebSocketSessionOptions;
  private connection: Connection | undefined;
  private chain: ResponsesWebSocketChain | undefined;
  private busy = false;
  private consecutiveFailures = 0;
  private httpOnly = false;
  private incrementalRefused = false;
  private disposed = false;
  /** The connect in flight, shared by a request that arrives meanwhile. Never rejects. */
  private opening: Promise<Connection | Error> | undefined;
  /** The socket of the connect in flight, to end it with the session. */
  private handshake: WebSocket | undefined;
  /** Where a socket opened ahead of a request connects; set by `preconnect`. */
  private ahead: TargetResolver | undefined;
  /** Sockets opened since the last response started. */
  private unusedConnects = 0;

  constructor(options: ResponsesWebSocketSessionOptions) {
    this.options = options;
  }

  /** Whether a request can start on the socket now. */
  get available(): boolean {
    return !this.disposed && !this.httpOnly && !this.busy;
  }

  /** Two failed starts in a row: the session stays on HTTP. */
  get httpOnlyForSession(): boolean {
    return this.httpOnly;
  }

  /** The service refused a continuation: every later frame carries the full input. */
  get fullInputOnly(): boolean {
    return this.incrementalRefused;
  }

  dispose(): void {
    this.disposed = true;
    this.drop();
    try {
      this.handshake?.terminate();
    } catch {
      // Not connected yet.
    }
  }

  /**
   * Open the socket ahead of the first request, so that request does not wait
   * for the connect, and keep doing so when a socket is lost later: closed by
   * the far end while idle, at its age limit, or with a response that was cut
   * or cancelled. `target` must be callable outside a request. A failure here
   * is not a failed start of a request (the credential may only need the
   * refresh a request triggers) and is not retried until a request asks.
   */
  async preconnect(target: TargetResolver): Promise<"open" | "failed" | "skipped"> {
    this.ahead = target;
    if (this.disposed || this.httpOnly) return "skipped";
    if (this.usable(this.connection)) return "open";
    if (this.busy && this.opening === undefined) return "skipped";
    if (!this.busy && this.connection !== undefined) this.drop();
    const opening = this.opening ?? this.openAhead();
    if (opening === undefined) return "skipped";
    return (await opening) instanceof Error ? "failed" : "open";
  }

  private usable(connection: Connection | undefined): connection is Connection {
    return connection !== undefined && !connection.closed &&
      connection.socket.readyState === WebSocket.OPEN &&
      (this.options.now ?? Date.now)() - connection.openedAt <
        (this.options.maxConnectionAgeMs ?? DEFAULT_MAX_CONNECTION_AGE_MS);
  }

  /** Replace a lost socket in the background when `preconnect` asked for that. */
  private openAhead(): Promise<Connection | Error> | undefined {
    if (this.ahead === undefined || this.disposed || this.httpOnly ||
      this.connection !== undefined || this.opening !== undefined ||
      this.unusedConnects >= MAX_UNUSED_CONNECTS) {
      return undefined;
    }
    this.stats.preconnects += 1;
    return this.open(this.ahead, false);
  }

  /**
   * Send `body` and wait for the first frame of its response.
   *
   * @throws ResponsesWebSocketFallback when the request must go over HTTP.
   * @throws the abort reason, as the HTTP path does.
   */
  async begin(options: ResponsesWebSocketBeginOptions): Promise<ResponsesWebSocketTurn> {
    if (!this.available) throw this.fallback("socket not available");
    if (options.signal?.aborted) throw abortError(options.signal);
    this.busy = true;
    try {
      // One more round only when the service ends a connection at its age limit.
      for (let round = 0; ; round += 1) {
        const connection = await this.connect(options);
        keepProcessAlive(connection.socket, true);
        const chain = this.chain;
        const incrementalInput = chain !== undefined && options.incremental !== false &&
          !this.incrementalRefused
          ? planResponsesWebSocketInput(chain, options.body)
          : undefined;
        const incremental = incrementalInput !== undefined;
        const frame = responsesWebSocketCreateFrame(options.body, chain, incrementalInput);
        // The service forgets a response that a failed continuation named.
        this.chain = undefined;
        // Anything that arrived after the previous response ended is not this one's.
        connection.queue.length = 0;
        // A peer that stops reading leaves the write pending: bound it, and let a cancel end it.
        const sent = await this.send(connection, JSON.stringify(frame), options.signal);
        if (sent === "aborted") {
          this.drop();
          void this.openAhead();
          throw abortError(options.signal!);
        }
        if (sent !== "sent") {
          this.failed();
          throw this.fallback(sent === "timeout" ? "send timed out" : "send failed", { afterSend: true });
        }
        const idle = options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0
          ? options.idleTimeoutMs
          : Number.POSITIVE_INFINITY;
        const first = await this.next(connection, options.signal,
          Math.min(idle, this.options.firstEventTimeoutMs ?? DEFAULT_FIRST_EVENT_TIMEOUT_MS));
        if (first.kind === "aborted") {
          this.drop();
          void this.openAhead();
          throw abortError(options.signal!);
        }
        if (first.kind !== "frame") {
          this.failed();
          throw this.fallback(
            first.kind === "closed" ? "socket closed before the first event"
              : first.kind === "idle" ? "no event after the frame was sent"
              : "invalid frame",
            { afterSend: true },
          );
        }
        if (first.data.type === "error") {
          const error = isItem(first.data.error) ? first.data.error : {};
          if (error.code === CONNECTION_LIMIT_CODE && round === 0) {
            this.drop();
            continue;
          }
          if (incremental && refusesContinuation(error)) this.incrementalRefused = true;
          throw this.fallback(`error frame before the first event (${String(error.code ?? "no code")})`, {
            afterSend: true, refused: true, errorFrame: first.data,
          });
        }
        this.consecutiveFailures = 0;
        this.unusedConnects = 0;
        this.stats.turns += 1;
        if (incremental) this.stats.incrementalTurns += 1;
        return {
          incremental,
          events: () => this.events(connection, options, first.data),
          cancel: () => {
            if (this.connection === connection) this.drop();
            else connection.socket.terminate();
            this.release();
            void this.openAhead();
          },
        };
      }
    } catch (error) {
      this.release();
      throw error;
    }
  }

  private send(
    connection: Connection,
    text: string,
    signal: AbortSignal | undefined,
  ): Promise<"sent" | "failed" | "timeout" | "aborted"> {
    return new Promise((resolve) => {
      const settle = (result: "sent" | "failed" | "timeout" | "aborted"): void => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => settle("aborted");
      const timer = setTimeout(() => settle("timeout"), this.options.sendTimeoutMs ?? DEFAULT_SEND_TIMEOUT_MS);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        connection.socket.send(text, (error) => settle(error ? "failed" : "sent"));
      } catch {
        settle("failed");
      }
    });
  }

  /**
   * The owner is done with the socket for now (its session ended, or another
   * provider took over): close an idle socket and stop opening one ahead. A
   * response in flight keeps its socket. Unlike `dispose`, a later request
   * may connect again.
   */
  standDown(): void {
    this.ahead = undefined;
    try {
      this.handshake?.terminate();
    } catch {
      // Not connected yet.
    }
    if (!this.busy) this.drop();
    else if (this.connection?.ageTimer !== undefined) clearTimeout(this.connection.ageTimer);
  }

  /** The lane is free; an idle socket must not keep the process alive. */
  private release(): void {
    this.busy = false;
    if (this.connection !== undefined) keepProcessAlive(this.connection.socket, false);
  }

  private fallback(
    reason: string,
    details?: ConstructorParameters<typeof ResponsesWebSocketFallback>[1],
  ): ResponsesWebSocketFallback {
    this.stats.fallbacks += 1;
    return new ResponsesWebSocketFallback(reason, details);
  }

  private failed(): void {
    this.drop();
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= (this.options.failuresBeforeHttpOnly ?? FAILURES_BEFORE_HTTP_ONLY)) {
      this.httpOnly = true;
    }
  }

  private drop(): void {
    const connection = this.connection;
    this.connection = undefined;
    this.chain = undefined;
    if (connection === undefined) return;
    connection.closed = true;
    if (connection.ageTimer !== undefined) clearTimeout(connection.ageTimer);
    // A reader still waiting on this connection must see it end.
    connection.queue.push({ kind: "closed" });
    connection.wake?.();
    try {
      connection.socket.terminate();
    } catch {
      // Already gone.
    }
  }

  private async connect(options: ResponsesWebSocketBeginOptions): Promise<Connection> {
    const current = this.connection;
    if (this.usable(current)) return current;
    if (current !== undefined) this.drop();
    const signal = options.signal;
    if (signal?.aborted) throw abortError(signal);
    // A connect already in flight (opened ahead of this request) is this request's connect.
    const opening = this.opening ?? this.open(options.target, true);
    // A socket opened ahead does not hold the process; a request waiting for it does.
    const hold = setInterval(() => undefined, 60_000);
    let onAbort: (() => void) | undefined;
    let result: Connection | Error | "aborted";
    try {
      result = await (signal === undefined ? opening : Promise.race([
        opening,
        new Promise<"aborted">((resolve) => {
          onAbort = () => resolve("aborted");
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]));
    } finally {
      clearInterval(hold);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
    if (result === "aborted" || signal?.aborted) {
      // The handshake goes on without the request (the next one finds the
      // socket open), but must not hold the process.
      if (this.handshake !== undefined) unrefHandshake(this.handshake);
      throw abortError(signal!);
    }
    if (result instanceof Error) {
      this.failed();
      throw this.fallback(`connect failed: ${result.message}`);
    }
    if (this.connection !== result || !this.usable(result)) {
      this.failed();
      throw this.fallback("connect failed: the socket closed right after the handshake");
    }
    return result;
  }

  /**
   * One handshake, the target included, within the connect timeout. Resolves
   * to the error instead of rejecting. Whether a failure is a failed start is
   * the waiting request's call.
   */
  private open(target: TargetResolver, forRequest: boolean): Promise<Connection | Error> {
    const now = this.options.now ?? Date.now;
    const attempt = async (): Promise<Connection | Error> => {
      let socket: WebSocket | undefined;
      const timeoutMs = this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const resolved = await Promise.race([
          target(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("the connection target did not resolve in time")), timeoutMs);
            if (!forRequest) timer.unref?.();
          }),
        ]);
        if (this.disposed) return new Error("session disposed");
        socket = new WebSocket(resolved.url, {
          headers: { ...resolved.headers },
          handshakeTimeout: timeoutMs,
          perMessageDeflate: false,
          followRedirects: false,
        });
        this.handshake = socket;
        // A socket given up during the handshake still reports its error.
        socket.on("error", () => undefined);
        if (!forRequest) unrefHandshake(socket);
        await this.opened(socket, undefined);
      } catch (error) {
        try {
          socket?.terminate();
        } catch {
          // Never opened.
        }
        if (this.disposed) return new Error("session disposed");
        this.stats.connectFailures += 1;
        this.drop();
        return error instanceof Error ? error : new Error(String(error));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (this.handshake === socket) this.handshake = undefined;
      }
      if (this.disposed) {
        socket.terminate();
        return new Error("session disposed");
      }
      const connection: Connection = { socket, openedAt: now(), queue: [], closed: false };
      const arrive = (arrival: Arrival): void => {
        connection.queue.push(arrival);
        connection.wake?.();
      };
      socket.on("message", (data: RawData, isBinary: boolean) => {
        if (isBinary) return arrive({ kind: "invalid" });
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return arrive({ kind: "invalid" });
        }
        arrive(isItem(parsed) && typeof parsed.type === "string"
          ? { kind: "frame", data: parsed }
          : { kind: "invalid" });
      });
      const closed = (): void => {
        if (connection.closed) return;
        connection.closed = true;
        arrive({ kind: "closed" });
        // Closed by the far end between responses: open the next one now, not on the next request.
        if (this.connection === connection && !this.busy) {
          this.drop();
          void this.openAhead();
        }
      };
      socket.on("close", closed);
      socket.on("error", closed);
      this.connection = connection;
      this.stats.connects += 1;
      this.unusedConnects += 1;
      keepProcessAlive(socket, false);
      // An idle socket at its age limit is replaced then, not on the next request.
      const maxAge = this.options.maxConnectionAgeMs ?? DEFAULT_MAX_CONNECTION_AGE_MS;
      if (this.ahead !== undefined && Number.isFinite(maxAge) && maxAge > 0) {
        connection.ageTimer = setTimeout(() => this.retire(connection), maxAge);
        connection.ageTimer.unref?.();
      }
      return connection;
    };
    const opening: Promise<Connection | Error> = attempt().finally(() => {
      if (this.opening === opening) this.opening = undefined;
    });
    this.opening = opening;
    return opening;
  }

  /** Replace an idle socket that reached its age limit; a busy one is replaced when its response ends. */
  private retire(connection: Connection): void {
    if (this.connection !== connection || this.busy) return;
    this.drop();
    void this.openAhead();
  }

  private opened(socket: WebSocket, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: unknown): void => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
        socket.off("unexpected-response", onRefused);
        signal?.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onOpen = (): void => settle();
      const onError = (error: Error): void => settle(error);
      const onClose = (): void => settle(new Error("closed during the handshake"));
      const onRefused = (_request: unknown, response: { statusCode?: number }): void =>
        settle(new Error(`upgrade refused with HTTP ${response.statusCode ?? "?"}`));
      const onAbort = (): void => settle(abortError(signal!));
      socket.on("open", onOpen);
      socket.on("error", onError);
      socket.on("close", onClose);
      socket.on("unexpected-response", onRefused);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private next(
    connection: Connection,
    signal: AbortSignal | undefined,
    timeoutMs: number | undefined,
  ): Promise<Waited> {
    if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
    const queued = connection.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (connection.closed) return Promise.resolve({ kind: "closed" });
    return new Promise<Waited>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settle = (result: Waited): void => {
        connection.wake = undefined;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(result);
      };
      const onAbort = (): void => settle({ kind: "aborted" });
      connection.wake = () => settle(connection.queue.shift() ?? { kind: "closed" });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs !== undefined && timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => settle({ kind: "idle" }), timeoutMs);
      }
    });
  }

  private async *events(
    connection: Connection,
    options: ResponsesWebSocketBeginOptions,
    first: Record<string, unknown>,
  ): AsyncGenerator<ResponsesWebSocketEvent> {
    const doneItems: Item[] = [];
    let finished = false;
    try {
      let data = first;
      for (;;) {
        const type = String(data.type);
        if (type === "response.output_item.done" && isItem(data.item)) doneItems.push(data.item);
        if (TERMINAL_EVENTS.has(type)) {
          // Settle before the yield: the consumer stops reading at this event.
          this.settle(connection, options.body, type, data, doneItems);
          finished = true;
          yield { data };
          return;
        }
        if (type === "error") {
          // An error frame ends the response without a terminal event.
          this.drop();
          finished = true;
          this.release();
          void this.openAhead();
          yield { data };
          return;
        }
        yield { data };
        const arrival = await this.next(connection, options.signal, options.idleTimeoutMs);
        if (arrival.kind === "aborted") throw abortError(options.signal!);
        if (arrival.kind === "idle") {
          throw new Error(`${this.options.providerName} stream idle for ${options.idleTimeoutMs}ms`);
        }
        // A cut socket ends the events like a cut SSE body ends its stream.
        if (arrival.kind !== "frame") return;
        data = arrival.data;
      }
    } finally {
      if (!finished) {
        // The response may still be running on this socket.
        if (this.connection === connection) this.drop();
        else connection.socket.terminate();
        this.release();
        void this.openAhead();
      }
    }
  }

  private settle(
    connection: Connection,
    body: Readonly<Record<string, unknown>>,
    type: string,
    data: Record<string, unknown>,
    doneItems: readonly Item[],
  ): void {
    this.release();
    if (this.connection !== connection) return;
    if (this.ahead !== undefined && !this.usable(connection)) {
      // Closed or at its age limit when the response ended: the next one starts on a new socket.
      this.drop();
      void this.openAhead();
      return;
    }
    const response = isItem(data.response) ? data.response : {};
    const terminalOutput = Array.isArray(response.output) ? response.output.filter(isItem) : [];
    this.chain = type === "response.completed" &&
      (response.status === undefined || response.status === "completed") &&
      typeof response.id === "string" && response.id.length > 0 && Array.isArray(body.input)
      ? {
        responseId: response.id,
        fixed: responsesWebSocketFixedPart(body),
        input: body.input.map((item) => JSON.stringify(item)),
        // The ChatGPT backend completes with an empty output.
        output: terminalOutput.length > 0 ? terminalOutput : [...doneItems],
      }
      : undefined;
  }
}
