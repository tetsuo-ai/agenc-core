import type { StdoutMessage } from "../entrypoints/sdk/controlTypes.js";

// Retained openclaude session-ingress transport seam.
// Codex app-server JSON-RPC ownership lives elsewhere.
export type TransportMessage = StdoutMessage;
export type HeaderMap = Record<string, string>;
export type RefreshHeaders = () => HeaderMap;

const TRANSPORT_AUTH_HEADER_NAMES = [
  "Authorization",
  "Cookie",
  "X-Organization-Uuid",
] as const;

export interface Transport {
  connect(): Promise<void>;
  write(message: TransportMessage): Promise<void>;
  close(): void;
  setOnData(callback: (data: string) => void): void;
  setOnClose(callback: (closeCode?: number) => void): void;
  setOnConnect?(callback: () => void): void;
  isConnectedStatus(): boolean;
  isClosedStatus(): boolean;
  getStateLabel(): string;
}

export interface TransportTimers {
  setTimeout: typeof globalThis.setTimeout;
  clearTimeout: typeof globalThis.clearTimeout;
  setInterval: typeof globalThis.setInterval;
  clearInterval: typeof globalThis.clearInterval;
}

export function defaultTransportTimers(): TransportTimers {
  return {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
  };
}

export function withResolvedHeaders(
  baseHeaders: HeaderMap,
  refreshHeaders?: RefreshHeaders,
): HeaderMap {
  if (!refreshHeaders) {
    return { ...baseHeaders };
  }
  return {
    ...baseHeaders,
    ...refreshHeaders(),
  };
}

export function authHeadersOnly(headers: HeaderMap): HeaderMap {
  const authHeaders: HeaderMap = {};
  for (const headerName of TRANSPORT_AUTH_HEADER_NAMES) {
    const value = headers[headerName];
    if (typeof value === "string" && value.length > 0) {
      authHeaders[headerName] = value;
    }
  }
  if (authHeaders.Cookie) {
    delete authHeaders.Authorization;
  }
  return authHeaders;
}

export function messageUuid(message: TransportMessage): string | undefined {
  if (
    typeof message === "object" &&
    message !== null &&
    "uuid" in message &&
    typeof message.uuid === "string"
  ) {
    return message.uuid;
  }
  return undefined;
}

export function asNdjson(message: TransportMessage): string {
  return `${JSON.stringify(message)}\n`;
}
