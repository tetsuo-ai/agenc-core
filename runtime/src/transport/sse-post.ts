import type { StdoutMessage } from "../entrypoints/sdk/controlTypes.js";
import { getSessionIngressAuthHeaders } from "../utils/sessionIngressAuth.js";
import {
  authHeadersOnly,
  defaultTransportTimers,
  type HeaderMap,
  type RefreshHeaders,
  type Transport,
  type TransportTimers,
} from "./index.js";
import { applyRefreshedHeaders } from "./refresh-headers.js";

// Retained openclaude CCR/session-ingress seam: SSE reads, POST writes.
export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;
export const RECONNECT_GIVE_UP_MS = 600_000;
export const LIVENESS_TIMEOUT_MS = 45_000;
export const POST_MAX_RETRIES = 10;
export const POST_BASE_DELAY_MS = 500;
export const POST_MAX_DELAY_MS = 8_000;
export const SLEEP_DETECTION_THRESHOLD_MS = RECONNECT_MAX_DELAY_MS * 2;

const PERMANENT_HTTP_CODES = new Set([401, 403, 404]);

type SSETransportState =
  | "idle"
  | "connected"
  | "reconnecting"
  | "closing"
  | "closed";

type SSEFrame = {
  event?: string;
  id?: string;
  data?: string;
};

export type StreamClientEvent = {
  event_id: string;
  sequence_num: number;
  event_type: string;
  source: string;
  payload: Record<string, unknown>;
  created_at: string;
};

export interface SSETransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timers?: Partial<TransportTimers>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly getAuthHeaders?: () => HeaderMap;
  readonly initialSequenceNum?: number;
  readonly sleepDetectionThresholdMs?: number;
}

function mergeTimers(timers?: Partial<TransportTimers>): TransportTimers {
  return { ...defaultTransportTimers(), ...timers };
}

export function parseSSEFrames(buffer: string): {
  readonly frames: SSEFrame[];
  readonly remaining: string;
} {
  const frames: SSEFrame[] = [];
  let position = 0;

  while (true) {
    const separator = findFrameSeparator(buffer, position);
    if (separator === -1) {
      return { frames, remaining: buffer.slice(position) };
    }
    const rawFrame = buffer.slice(position, separator).replace(/\r/g, "");
    position = separator + (buffer[separator] === "\r" ? 4 : 2);
    if (rawFrame.trim().length === 0) {
      continue;
    }

    const frame: SSEFrame = {};
    let isComment = false;
    for (const line of rawFrame.split("\n")) {
      if (line.startsWith(":")) {
        isComment = true;
        continue;
      }
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const field = line.slice(0, colon);
      const rawValue = line.slice(colon + 1);
      const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
      if (field === "event") frame.event = value;
      if (field === "id") frame.id = value;
      if (field === "data") {
        frame.data = frame.data ? `${frame.data}\n${value}` : value;
      }
    }

    if (frame.data !== undefined || isComment) {
      frames.push(frame);
    }
  }
}

export class SSETransport implements Transport {
  private readonly url: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timers: TransportTimers;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly getAuthHeaders: () => HeaderMap;
  private headers: HeaderMap;
  private readonly refreshHeaders?: RefreshHeaders;
  private state: SSETransportState = "idle";
  private onData?: (data: string) => void;
  private onCloseCallback?: (closeCode?: number) => void;
  private onEventCallback?: (event: StreamClientEvent) => void;
  private abortController: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private livenessTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnectStartedAt: number | null = null;
  private lastReconnectAttemptAt: number | null = null;
  private lastSequenceNum = 0;
  private readonly seenSequenceNums = new Set<number>();
  private readonly postUrl: string;
  private readonly sleepDetectionThresholdMs: number;

  constructor(
    url: URL,
    headers: HeaderMap = {},
    _sessionId?: string,
    refreshHeaders?: RefreshHeaders,
    options: SSETransportOptions = {},
  ) {
    this.url = url;
    this.headers = { ...headers };
    this.refreshHeaders = refreshHeaders;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timers = mergeTimers(options.timers);
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    this.getAuthHeaders = options.getAuthHeaders ?? getSessionIngressAuthHeaders;
    this.lastSequenceNum = options.initialSequenceNum ?? 0;
    this.postUrl = convertSSEUrlToPostUrl(url);
    this.sleepDetectionThresholdMs =
      options.sleepDetectionThresholdMs ?? SLEEP_DETECTION_THRESHOLD_MS;
  }

  async connect(): Promise<void> {
    if (this.state !== "idle" && this.state !== "reconnecting") {
      return;
    }
    this.state = "reconnecting";
    const connectUrl = new URL(this.url.href);
    if (this.lastSequenceNum > 0) {
      connectUrl.searchParams.set("from_sequence_num", String(this.lastSequenceNum));
    }

    this.abortController = new AbortController();
    const headers = this.buildReadHeaders();
    try {
      const response = await this.fetchImpl(connectUrl.href, {
        headers,
        signal: this.abortController.signal,
      });
      if (!response.ok) {
        if (PERMANENT_HTTP_CODES.has(response.status)) {
          this.state = "closed";
          this.onCloseCallback?.(response.status);
          return;
        }
        this.handleConnectionError();
        return;
      }
      if (!response.body) {
        this.handleConnectionError();
        return;
      }

      this.state = "connected";
      this.reconnectAttempts = 0;
      this.reconnectStartedAt = null;
      this.lastReconnectAttemptAt = null;
      this.resetLivenessTimer();
      await this.readStream(response.body);
    } catch {
      if (this.abortController?.signal.aborted) {
        return;
      }
      this.handleConnectionError();
    }
  }

  setOnData(callback: (data: string) => void): void {
    this.onData = callback;
  }

  setOnClose(callback: (closeCode?: number) => void): void {
    this.onCloseCallback = callback;
  }

  setOnEvent(callback: (event: StreamClientEvent) => void): void {
    this.onEventCallback = callback;
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

  getLastSequenceNum(): number {
    return this.lastSequenceNum;
  }

  async write(message: StdoutMessage): Promise<void> {
    for (let attempt = 1; attempt <= POST_MAX_RETRIES; attempt += 1) {
      const nextHeaders = this.buildWriteHeaders();
      if (Object.keys(nextHeaders).length === 0) {
        return;
      }
      try {
        const response = await this.fetchImpl(this.postUrl, {
          method: "POST",
          headers: nextHeaders,
          body: JSON.stringify(message),
        });
        if (response.status === 200 || response.status === 201) {
          return;
        }
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          return;
        }
      } catch {
        // handled by retry loop
      }

      if (attempt === POST_MAX_RETRIES) {
        return;
      }
      const delay = Math.min(
        POST_BASE_DELAY_MS * 2 ** (attempt - 1),
        POST_MAX_DELAY_MS,
      );
      await sleep(delay, this.timers);
    }
  }

  close(): void {
    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearLivenessTimer();
    this.state = "closing";
    this.abortController?.abort();
    this.abortController = null;
  }

  private buildReadHeaders(): HeaderMap {
    const refreshedHeaders = applyRefreshedHeaders(this.headers, this.refreshHeaders);
    const authHeaders = this.resolveAuthHeaders(refreshedHeaders);
    const headers: HeaderMap = {
      ...refreshedHeaders,
      ...authHeaders,
      Accept: "text/event-stream",
    };
    if (authHeaders.Cookie) {
      delete headers.Authorization;
    }
    if (this.lastSequenceNum > 0) {
      headers["Last-Event-ID"] = String(this.lastSequenceNum);
    }
    this.headers = { ...headers };
    return headers;
  }

  private async readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parsed = parseSSEFrames(buffer);
        buffer = parsed.remaining;
        for (const frame of parsed.frames) {
          this.resetLivenessTimer();
          let isDuplicate = false;
          if (frame.id) {
            const sequence = Number.parseInt(frame.id, 10);
            if (!Number.isNaN(sequence)) {
              isDuplicate = this.trackSequenceNumber(sequence);
            }
          }
          if (!isDuplicate && frame.event && frame.data) {
            this.handleFrame(frame.event, frame.data);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (this.state !== "closing" && this.state !== "closed") {
      this.handleConnectionError();
    }
  }

  private handleFrame(eventType: string, data: string): void {
    if (eventType !== "client_event") {
      return;
    }

    let parsed: StreamClientEvent;
    try {
      parsed = JSON.parse(data) as StreamClientEvent;
    } catch {
      return;
    }

    const payload = parsed.payload;
    if (payload && typeof payload === "object" && "type" in payload) {
      this.onData?.(`${JSON.stringify(payload)}\n`);
    }
    this.onEventCallback?.(parsed);
  }

  private resolveAuthHeaders(baseHeaders: HeaderMap): HeaderMap {
    const currentHeaders = authHeadersOnly(baseHeaders);
    if (Object.keys(currentHeaders).length > 0) {
      return currentHeaders;
    }
    return authHeadersOnly(this.getAuthHeaders());
  }

  private buildWriteHeaders(): HeaderMap {
    const refreshedHeaders = applyRefreshedHeaders(this.headers, this.refreshHeaders);
    this.headers = { ...refreshedHeaders };
    const authHeaders = this.resolveAuthHeaders(refreshedHeaders);
    if (Object.keys(authHeaders).length === 0) {
      return {};
    }
    const headers: HeaderMap = {
      ...authHeaders,
      "Content-Type": "application/json",
    };
    if (headers.Cookie) {
      delete headers.Authorization;
    }
    return headers;
  }

  private trackSequenceNumber(sequence: number): boolean {
    if (this.seenSequenceNums.has(sequence)) {
      return true;
    }
    this.seenSequenceNums.add(sequence);
    if (this.seenSequenceNums.size > 1000) {
      const threshold = this.lastSequenceNum - 200;
      for (const seen of this.seenSequenceNums) {
        if (seen < threshold) {
          this.seenSequenceNums.delete(seen);
        }
      }
    }
    if (sequence > this.lastSequenceNum) {
      this.lastSequenceNum = sequence;
    }
    return false;
  }

  private handleConnectionError(): void {
    this.clearLivenessTimer();
    if (this.state === "closing" || this.state === "closed") {
      return;
    }
    this.abortController?.abort();
    this.abortController = null;

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
    if (elapsed >= RECONNECT_GIVE_UP_MS) {
      this.state = "closed";
      this.onCloseCallback?.();
      return;
    }

    if (this.refreshHeaders) {
      this.headers = applyRefreshedHeaders(this.headers, this.refreshHeaders);
    }

    if (this.reconnectTimer !== null) {
      this.timers.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.state = "reconnecting";
    this.reconnectAttempts += 1;
    const baseDelay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (this.reconnectAttempts - 1),
      RECONNECT_MAX_DELAY_MS,
    );
    const delay = Math.max(
      0,
      Math.round(baseDelay + baseDelay * 0.25 * (2 * this.random() - 1)),
    );
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private resetLivenessTimer(): void {
    this.clearLivenessTimer();
    this.livenessTimer = this.timers.setTimeout(() => {
      this.livenessTimer = null;
      this.abortController?.abort();
      this.handleConnectionError();
    }, LIVENESS_TIMEOUT_MS);
  }

  private clearLivenessTimer(): void {
    if (this.livenessTimer !== null) {
      this.timers.clearTimeout(this.livenessTimer);
      this.livenessTimer = null;
    }
  }
}

function findFrameSeparator(buffer: string, start: number): number {
  const lf = buffer.indexOf("\n\n", start);
  const crlf = buffer.indexOf("\r\n\r\n", start);
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

export function convertSSEUrlToPostUrl(sseUrl: URL): string {
  const normalized = new URL(sseUrl.href);
  normalized.pathname = normalized.pathname.replace(/\/stream$/, "");
  normalized.search = "";
  return normalized.href;
}

async function sleep(ms: number, timers: TransportTimers): Promise<void> {
  await new Promise<void>((resolve) => {
    timers.setTimeout(resolve, ms);
  });
}
