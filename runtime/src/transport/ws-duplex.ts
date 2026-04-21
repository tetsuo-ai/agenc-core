import type { StdoutMessage } from "../entrypoints/sdk/controlTypes.js";
import { CircularBuffer } from "../utils/CircularBuffer.js";
import { isEnvTruthy } from "../utils/envUtils.js";
import {
  registerSessionActivityCallback,
  unregisterSessionActivityCallback,
} from "../utils/sessionActivity.js";
import {
  asNdjson,
  defaultTransportTimers,
  messageUuid,
  type HeaderMap,
  type RefreshHeaders,
  type Transport,
  type TransportTimers,
} from "./index.js";
import { applyRefreshedHeaders, refreshAuthHeaders } from "./refresh-headers.js";

// Retained openclaude websocket session-ingress contract.
const KEEP_ALIVE_FRAME = '{"type":"keep_alive"}\n';

export const DEFAULT_MAX_BUFFER_SIZE = 1000;
export const DEFAULT_BASE_RECONNECT_DELAY_MS = 1_000;
export const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
export const DEFAULT_RECONNECT_GIVE_UP_MS = 600_000;
export const DEFAULT_PING_INTERVAL_MS = 10_000;
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 300_000;
export const DEFAULT_SLEEP_DETECTION_THRESHOLD_MS =
  DEFAULT_MAX_RECONNECT_DELAY_MS * 2;

const PERMANENT_CLOSE_CODES = new Set([1002, 4001, 4003]);

type WebSocketTransportState =
  | "idle"
  | "connected"
  | "reconnecting"
  | "closing"
  | "closed";

type WebSocketEventMap = {
  open: [];
  message: [string | Buffer];
  error: [unknown];
  close: [number?, Buffer?];
  pong: [];
};

type UpgradeHeaderBag = {
  headers?: Record<string, string | string[] | undefined>;
};

export interface WebSocketClientLike {
  send(data: string): void;
  close(code?: number): void;
  ping?(): void;
  upgradeHeaders?: HeaderMap;
  upgradeReq?: UpgradeHeaderBag;
  response?: UpgradeHeaderBag;
  on<K extends keyof WebSocketEventMap>(
    event: K,
    handler: (...args: WebSocketEventMap[K]) => void,
  ): void;
  off?<K extends keyof WebSocketEventMap>(
    event: K,
    handler: (...args: WebSocketEventMap[K]) => void,
  ): void;
}

export type WebSocketFactory = (args: {
  readonly url: string;
  readonly headers: HeaderMap;
}) => Promise<WebSocketClientLike> | WebSocketClientLike;

export interface WebSocketTransportOptions {
  readonly autoReconnect?: boolean;
  readonly maxBufferSize?: number;
  readonly createSocket?: WebSocketFactory;
  readonly timers?: Partial<TransportTimers>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly baseReconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly reconnectGiveUpMs?: number;
  readonly pingIntervalMs?: number;
  readonly keepAliveIntervalMs?: number;
  readonly sleepDetectionThresholdMs?: number;
}

function mergeTimers(timers?: Partial<TransportTimers>): TransportTimers {
  return { ...defaultTransportTimers(), ...timers };
}

async function defaultWebSocketFactory(args: {
  readonly url: string;
  readonly headers: HeaderMap;
}): Promise<WebSocketClientLike> {
  const { default: WS } = await import("ws");
  return new WS(args.url, { headers: args.headers }) as unknown as WebSocketClientLike;
}

export class WebSocketTransport implements Transport {
  private socket: WebSocketClientLike | null = null;
  protected readonly url: URL;
  protected state: WebSocketTransportState = "idle";
  protected onData?: (data: string) => void;
  private onCloseCallback?: (closeCode?: number) => void;
  private onConnectCallback?: () => void;
  private headers: HeaderMap;
  private readonly autoReconnect: boolean;
  private readonly createSocket: WebSocketFactory;
  private readonly timers: TransportTimers;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly baseReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly reconnectGiveUpMs: number;
  private readonly pingIntervalMs: number;
  private readonly keepAliveIntervalMs: number;
  private readonly sleepDetectionThresholdMs: number;
  private readonly refreshHeaders?: RefreshHeaders;
  private reconnectAttempts = 0;
  private reconnectStartedAt: number | null = null;
  private lastReconnectAttemptAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;
  private lastPingTickAt: number | null = null;
  private keepAliveInterval: ReturnType<typeof setInterval> | null = null;
  private lastSentId: string | null = null;
  private readonly messageBuffer: CircularBuffer<StdoutMessage>;

  private readonly handleOpen = () => {
    const acknowledgedId = readAcknowledgedMessageId(this.socket);
    this.reconnectAttempts = 0;
    this.reconnectStartedAt = null;
    this.lastReconnectAttemptAt = null;
    this.state = "connected";
    this.onConnectCallback?.();
    this.startPingInterval();
    this.startKeepaliveInterval();
    registerSessionActivityCallback(() => {
      void this.write({ type: "keep_alive" } as StdoutMessage);
    });
    this.replayBufferedMessages(acknowledgedId ?? "");
  };

  private readonly handleMessage = (data: string | Buffer) => {
    const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
    this.onData?.(text);
  };

  private readonly handlePong = () => {
    this.pongReceived = true;
  };

  private readonly handleClose = (closeCode?: number) => {
    this.handleConnectionError(closeCode);
  };

  private readonly handleError = () => {
    // `ws` follows `error` with `close`; defer state changes to close.
  };

  constructor(
    url: URL,
    headers: HeaderMap = {},
    _sessionId?: string,
    refreshHeaders?: RefreshHeaders,
    options: WebSocketTransportOptions = {},
  ) {
    this.url = url;
    this.headers = { ...headers };
    this.refreshHeaders = refreshHeaders;
    this.autoReconnect = options.autoReconnect ?? true;
    this.createSocket = options.createSocket ?? defaultWebSocketFactory;
    this.timers = mergeTimers(options.timers);
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.baseReconnectDelayMs =
      options.baseReconnectDelayMs ?? DEFAULT_BASE_RECONNECT_DELAY_MS;
    this.maxReconnectDelayMs =
      options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    this.reconnectGiveUpMs =
      options.reconnectGiveUpMs ?? DEFAULT_RECONNECT_GIVE_UP_MS;
    this.pingIntervalMs = options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.keepAliveIntervalMs =
      options.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
    this.sleepDetectionThresholdMs =
      options.sleepDetectionThresholdMs ?? DEFAULT_SLEEP_DETECTION_THRESHOLD_MS;
    this.messageBuffer = new CircularBuffer(
      options.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE,
    );
  }

  async connect(): Promise<void> {
    if (this.state !== "idle" && this.state !== "reconnecting") {
      return;
    }
    this.state = "reconnecting";
    const socket = await this.createSocket({
      url: this.url.href,
      headers: this.buildConnectHeaders(),
    });
    this.socket = socket;
    socket.on("open", this.handleOpen);
    socket.on("message", this.handleMessage);
    socket.on("error", this.handleError);
    socket.on("close", this.handleClose);
    socket.on("pong", this.handlePong);
  }

  setOnData(callback: (data: string) => void): void {
    this.onData = callback;
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCallback = callback;
  }

  setOnConnect(callback: () => void): void {
    this.onConnectCallback = callback;
  }

  isConnectedStatus(): boolean {
    return this.state === "connected";
  }

  isClosedStatus(): boolean {
    return this.state === "closed";
  }

  getStateLabel(): string {
    return this.state;
  }

  async write(message: StdoutMessage): Promise<void> {
    this.trackBufferedMessage(message);

    if (this.state !== "connected") {
      return;
    }

    this.sendLine(asNdjson(message));
  }

  close(): void {
    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.state = "closing";
    this.disconnectSocket();
  }

  protected sendLine(line: string): boolean {
    if (!this.socket || this.state !== "connected") {
      return false;
    }
    try {
      this.socket.send(line);
      return true;
    } catch {
      this.handleConnectionError();
      return false;
    }
  }

  protected replayBufferedMessages(lastId = ""): void {
    for (const message of this.consumeReplayBufferedMessages(lastId)) {
      if (!this.sendLine(asNdjson(message))) {
        break;
      }
    }
  }

  private buildConnectHeaders(): HeaderMap {
    const headers = { ...this.headers };
    if (this.lastSentId) {
      headers["X-Last-Request-Id"] = this.lastSentId;
    }
    return headers;
  }

  protected trackBufferedMessage(message: StdoutMessage): void {
    const uuid = messageUuid(message);
    if (!uuid) {
      return;
    }
    this.lastSentId = uuid;
    this.messageBuffer.add(message);
  }

  protected consumeReplayBufferedMessages(lastId = ""): StdoutMessage[] {
    const messages = this.messageBuffer.toArray();
    if (messages.length === 0) {
      return [];
    }

    if (lastId.length === 0) {
      return messages;
    }

    const confirmedIndex = messages.findIndex(
      (message) => messageUuid(message) === lastId,
    );
    if (confirmedIndex < 0) {
      return messages;
    }

    const remaining = messages.slice(confirmedIndex + 1);
    this.messageBuffer.clear();
    this.messageBuffer.addAll(remaining);
    this.lastSentId = findLastBufferedUuid(remaining);
    return remaining;
  }

  protected refreshTransportHeaders(): HeaderMap {
    this.headers = applyRefreshedHeaders(this.headers, this.refreshHeaders);
    return { ...this.headers };
  }

  private startPingInterval(): void {
    this.stopPingInterval();
    this.pongReceived = true;
    this.lastPingTickAt = this.now();
    this.pingInterval = this.timers.setInterval(() => {
      if (this.state !== "connected" || !this.socket) {
        return;
      }
      const tickAt = this.now();
      const lastTickAt = this.lastPingTickAt ?? tickAt;
      this.lastPingTickAt = tickAt;
      if (tickAt - lastTickAt > this.sleepDetectionThresholdMs) {
        this.handleConnectionError();
        return;
      }
      if (!this.pongReceived) {
        this.handleConnectionError();
        return;
      }
      this.pongReceived = false;
      this.socket.ping?.();
    }, this.pingIntervalMs);
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      this.timers.clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private startKeepaliveInterval(): void {
    this.stopKeepaliveInterval();
    if (isEnvTruthy(process.env.CLAUDE_CODE_REMOTE)) {
      return;
    }
    this.keepAliveInterval = this.timers.setInterval(() => {
      if (this.state !== "connected") {
        return;
      }
      this.sendLine(KEEP_ALIVE_FRAME);
    }, this.keepAliveIntervalMs);
  }

  private stopKeepaliveInterval(): void {
    if (this.keepAliveInterval) {
      this.timers.clearInterval(this.keepAliveInterval);
      this.keepAliveInterval = null;
    }
  }

  private disconnectSocket(): void {
    this.stopPingInterval();
    this.stopKeepaliveInterval();
    unregisterSessionActivityCallback();

    const socket = this.socket;
    if (!socket) {
      return;
    }
    socket.off?.("open", this.handleOpen);
    socket.off?.("message", this.handleMessage);
    socket.off?.("error", this.handleError);
    socket.off?.("close", this.handleClose);
    socket.off?.("pong", this.handlePong);
    this.socket = null;
    socket.close();
  }

  private handleConnectionError(closeCode?: number): void {
    this.disconnectSocket();

    if (this.state === "closing" || this.state === "closed") {
      return;
    }

    let headersRefreshed = false;
    if (closeCode === 4003) {
      const refreshed = refreshAuthHeaders(this.headers, this.refreshHeaders);
      this.headers = refreshed.headers;
      headersRefreshed = refreshed.changed;
    }

    if (
      closeCode !== undefined &&
      PERMANENT_CLOSE_CODES.has(closeCode) &&
      !headersRefreshed
    ) {
      this.state = "closed";
      this.onCloseCallback?.(closeCode);
      return;
    }

    if (!this.autoReconnect) {
      this.state = "closed";
      this.onCloseCallback?.(closeCode);
      return;
    }

    const now = this.now();
    if (this.reconnectStartedAt === null) {
      this.reconnectStartedAt = now;
    }

    if (
      this.lastReconnectAttemptAt !== null &&
      now - this.lastReconnectAttemptAt > this.sleepDetectionThresholdMs
    ) {
      this.reconnectStartedAt = now;
      this.reconnectAttempts = 0;
    }
    this.lastReconnectAttemptAt = now;

    const elapsed = now - this.reconnectStartedAt;
    if (elapsed >= this.reconnectGiveUpMs) {
      this.state = "closed";
      this.onCloseCallback?.(closeCode);
      return;
    }

    if (!headersRefreshed && this.refreshHeaders) {
      this.headers = applyRefreshedHeaders(this.headers, this.refreshHeaders);
    }

    if (this.reconnectTimer) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.state = "reconnecting";
    this.reconnectAttempts += 1;
    const baseDelay = Math.min(
      this.baseReconnectDelayMs * 2 ** (this.reconnectAttempts - 1),
      this.maxReconnectDelayMs,
    );
    const jitter = baseDelay * 0.25 * (2 * this.random() - 1);
    const delay = Math.max(0, Math.round(baseDelay + jitter));
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }
}

function findLastBufferedUuid(messages: StdoutMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const uuid = messageUuid(messages[index]!);
    if (uuid) {
      return uuid;
    }
  }
  return null;
}

function readAcknowledgedMessageId(
  socket: WebSocketClientLike | null,
): string | undefined {
  if (!socket) {
    return undefined;
  }

  const sources: Array<Record<string, string | string[] | undefined> | undefined> = [
    socket.upgradeHeaders,
    socket.upgradeReq?.headers,
    socket.response?.headers,
  ];

  for (const headers of sources) {
    const rawValue =
      headers?.["x-last-request-id"] ?? headers?.["X-Last-Request-Id"];
    if (typeof rawValue === "string" && rawValue.length > 0) {
      return rawValue;
    }
    if (Array.isArray(rawValue)) {
      const [first] = rawValue;
      if (typeof first === "string" && first.length > 0) {
        return first;
      }
    }
  }

  return undefined;
}

export function convertWsUrlToPostUrl(wsUrl: URL): string {
  const protocol = wsUrl.protocol === "wss:" ? "https:" : "http:";
  let pathname = wsUrl.pathname;
  pathname = pathname.replace("/ws/", "/session/");
  if (!pathname.endsWith("/events")) {
    pathname = pathname.endsWith("/") ? `${pathname}events` : `${pathname}/events`;
  }
  return `${protocol}//${wsUrl.host}${pathname}${wsUrl.search}`;
}
