/**
 * OpenAI Responses API over one WebSocket per provider session (opt-in).
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
}

export interface ResponsesWebSocketStats {
  connects: number;
  connectFailures: number;
  turns: number;
  incrementalTurns: number;
  fallbacks: number;
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
  return calls.size === 0 && replayText.trim() === text.trim();
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
}

export interface ResponsesWebSocketSessionOptions {
  readonly providerName: string;
  readonly connectTimeoutMs?: number;
  readonly maxConnectionAgeMs?: number;
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
    connects: 0, connectFailures: 0, turns: 0, incrementalTurns: 0, fallbacks: 0,
  };

  private readonly options: ResponsesWebSocketSessionOptions;
  private connection: Connection | undefined;
  private chain: ResponsesWebSocketChain | undefined;
  private busy = false;
  private consecutiveFailures = 0;
  private httpOnly = false;
  private incrementalRefused = false;
  private disposed = false;

  constructor(options: ResponsesWebSocketSessionOptions) {
    this.options = options;
  }

  /** Whether a request can start on the socket now. */
  get available(): boolean {
    return !this.disposed && !this.httpOnly && !this.busy;
  }

  dispose(): void {
    this.disposed = true;
    this.drop();
  }

  /**
   * Send `body` and wait for the first frame of its response.
   *
   * @throws ResponsesWebSocketFallback when the request must go over HTTP.
   * @throws the abort reason, or an idle error, as the HTTP path does.
   */
  async begin(options: ResponsesWebSocketBeginOptions): Promise<ResponsesWebSocketTurn> {
    if (!this.available) throw this.fallback("socket not available");
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
        try {
          await new Promise<void>((resolve, reject) => {
            connection.socket.send(JSON.stringify(frame), (error) => error ? reject(error) : resolve());
          });
        } catch {
          this.failed();
          throw this.fallback("send failed", { afterSend: true });
        }
        const first = await this.next(connection, options);
        if (first.kind === "aborted") {
          this.drop();
          throw abortError(options.signal!);
        }
        if (first.kind === "idle") {
          this.drop();
          throw new Error(`${this.options.providerName} stream idle for ${options.idleTimeoutMs}ms`);
        }
        if (first.kind !== "frame") {
          this.failed();
          throw this.fallback(
            first.kind === "closed" ? "socket closed before the first event" : "invalid frame",
            { afterSend: true },
          );
        }
        if (first.data.type === "error") {
          const error = isItem(first.data.error) ? first.data.error : {};
          if (error.code === CONNECTION_LIMIT_CODE && round === 0) {
            this.drop();
            continue;
          }
          if (incremental) this.incrementalRefused = true;
          throw this.fallback("error frame before the first event", {
            afterSend: true, refused: true, errorFrame: first.data,
          });
        }
        this.consecutiveFailures = 0;
        this.stats.turns += 1;
        if (incremental) this.stats.incrementalTurns += 1;
        return {
          incremental,
          events: () => this.events(connection, options, first.data),
        };
      }
    } catch (error) {
      this.release();
      throw error;
    }
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
    if (this.consecutiveFailures >= FAILURES_BEFORE_HTTP_ONLY) this.httpOnly = true;
  }

  private drop(): void {
    const connection = this.connection;
    this.connection = undefined;
    this.chain = undefined;
    if (connection === undefined) return;
    connection.closed = true;
    try {
      connection.socket.terminate();
    } catch {
      // Already gone.
    }
  }

  private async connect(options: ResponsesWebSocketBeginOptions): Promise<Connection> {
    const now = this.options.now ?? Date.now;
    const current = this.connection;
    if (current !== undefined) {
      const maxAge = this.options.maxConnectionAgeMs ?? DEFAULT_MAX_CONNECTION_AGE_MS;
      if (!current.closed && current.socket.readyState === WebSocket.OPEN &&
        now() - current.openedAt < maxAge) {
        return current;
      }
      this.drop();
    }
    if (options.signal?.aborted) throw abortError(options.signal);
    let socket: WebSocket | undefined;
    try {
      const target = await options.target();
      socket = new WebSocket(target.url, {
        headers: { ...target.headers },
        handshakeTimeout: this.options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
        perMessageDeflate: false,
        followRedirects: false,
      });
      // A socket given up during the handshake still reports its error.
      socket.on("error", () => undefined);
      await this.opened(socket, options.signal);
    } catch (error) {
      try {
        socket?.terminate();
      } catch {
        // Never opened.
      }
      if (options.signal?.aborted) throw abortError(options.signal);
      this.stats.connectFailures += 1;
      this.failed();
      throw this.fallback(`connect failed: ${error instanceof Error ? error.message : String(error)}`);
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
    };
    socket.on("close", closed);
    socket.on("error", closed);
    this.connection = connection;
    this.stats.connects += 1;
    return connection;
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

  private next(connection: Connection, options: ResponsesWebSocketBeginOptions): Promise<Waited> {
    const queued = connection.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (connection.closed) return Promise.resolve({ kind: "closed" });
    const signal = options.signal;
    if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
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
      if (options.idleTimeoutMs !== undefined && options.idleTimeoutMs > 0) {
        timer = setTimeout(() => settle({ kind: "idle" }), options.idleTimeoutMs);
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
          yield { data };
          return;
        }
        yield { data };
        const arrival = await this.next(connection, options);
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
