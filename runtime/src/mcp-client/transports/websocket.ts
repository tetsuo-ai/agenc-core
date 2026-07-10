/**
 * Ports the MCP JSON-RPC WebSocket transport shape used by the donor CX
 * `rmcp-client/tests/streamable_http_test_support.rs` remote harness onto
 * AgenC's MCP client connection boundary.
 *
 * Why this lives here:
 *   - WebSocket is a first-class MCP transport choice for remote servers, but
 *     AgenC keeps SDK and socket details behind transport factories.
 *
 * Cross-cuts deliberately NOT carried:
 *   - Remote executor-server process management. This module only owns MCP
 *     JSON-RPC over a caller-provided WebSocket endpoint.
 */

import { VERSION } from "../../version.js";
import WebSocket, { type RawData } from "ws";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type JSONRPCMessage,
  JSONRPCMessageSchema,
} from "@modelcontextprotocol/sdk/types.js";

import type { Logger } from "../_deps/logger.js";
import { silentLogger } from "../_deps/logger.js";
import type { MCPElicitationHandlers } from "../types.js";
import { configureMcpElicitationClient } from "../../elicitation/mcp.js";
import {
  buildMcpHostClientCapabilities,
  configureMcpHostRequestHandlers,
  type McpSamplingHandlers,
} from "../../services/mcp/hostCapabilities.js";

const MCP_WEBSOCKET_SUBPROTOCOL = "mcp";
export const WEBSOCKET_CLOSE_WAIT_MS = 1_000;

export interface MCPServerWebSocketConfig {
  readonly name: string;
  readonly endpoint: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeout?: number;
}

export class MCPWebSocketClientTransport implements Transport {
  private socket: WebSocket | undefined;
  private closedNotified = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(
    readonly url: URL,
    readonly headers?: Readonly<Record<string, string>>,
  ) {}

  async start(): Promise<void> {
    if (this.socket !== undefined) {
      throw new Error("MCPWebSocketClientTransport already started");
    }

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, MCP_WEBSOCKET_SUBPROTOCOL, {
        ...(this.headers !== undefined ? { headers: { ...this.headers } } : {}),
      });
      this.socket = socket;
      this.closedNotified = false;

      const onOpen = () => {
        socket.off("error", onStartError);
        resolve();
      };
      const onStartError = (error: Error) => {
        socket.off("open", onOpen);
        reject(error);
        this.onerror?.(error);
      };

      socket.once("open", onOpen);
      socket.once("error", onStartError);
      socket.on("message", this.onMessage);
      socket.on("error", this.onSocketError);
      socket.on("close", this.onSocketClose);
    });
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) {
      this.notifyClosed();
      return;
    }

    this.socket = undefined;

    if (socket.readyState !== WebSocket.CLOSED) {
      if (socket.readyState !== WebSocket.CLOSING) {
        try {
          socket.close();
        } catch {
          socket.terminate();
        }
      }
      if (!(await waitForSocketClose(socket, WEBSOCKET_CLOSE_WAIT_MS))) {
        socket.terminate();
        await waitForSocketClose(socket, WEBSOCKET_CLOSE_WAIT_MS);
      }
    }

    this.detachSocket(socket);
    this.notifyClosed();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }

    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
          this.onerror?.(error);
          return;
        }
        resolve();
      });
    });
  }

  private readonly onMessage = (data: RawData): void => {
    try {
      const message = JSONRPCMessageSchema.parse(JSON.parse(rawDataToString(data)));
      this.onmessage?.(message);
    } catch (error) {
      this.onerror?.(toError(error));
    }
  };

  private readonly onSocketError = (error: Error): void => {
    this.onerror?.(error);
  };

  private readonly onSocketClose = (): void => {
    const socket = this.socket;
    if (socket !== undefined) {
      this.socket = undefined;
      this.detachSocket(socket);
    }
    this.notifyClosed();
  };

  private detachSocket(socket: WebSocket): void {
    socket.off("message", this.onMessage);
    socket.off("error", this.onSocketError);
    socket.off("close", this.onSocketClose);
  }

  private notifyClosed(): void {
    if (this.closedNotified) return;
    this.closedNotified = true;
    this.onclose?.();
  }
}

function createWebSocketMCPTransport(
  config: MCPServerWebSocketConfig,
): MCPWebSocketClientTransport {
  return new MCPWebSocketClientTransport(
    new URL(config.endpoint),
    config.headers,
  );
}

export async function createWebSocketMCPConnection(
  config: MCPServerWebSocketConfig,
  logger: Logger = silentLogger,
  elicitationHandlers?: MCPElicitationHandlers,
  samplingHandlers?: McpSamplingHandlers,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const timeout = config.timeout ?? 30_000;
  const transport = createWebSocketMCPTransport(config);
  const client = new Client(
    { name: "agenc-runtime", version: VERSION },
    {
      capabilities: buildMcpHostClientCapabilities(
        elicitationHandlers === undefined ? "none" : "form-url",
      ),
    },
  );
  configureMcpHostRequestHandlers(
    client,
    config.name,
    samplingHandlers === undefined ? undefined : { samplingHandlers },
  );
  await configureMcpElicitationClient(client, config.name, elicitationHandlers);

  logger.info(`Connecting to MCP WebSocket server "${config.name}"...`, {
    endpoint: config.endpoint,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const connectPromise = client.connect(transport);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        client.close();
      } catch {
        // best-effort
      }
      reject(
        new Error(
          `MCP WebSocket connect to "${config.name}" timed out after ${timeout}ms`,
        ),
      );
    }, timeout);
  });

  try {
    await Promise.race([connectPromise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }

  logger.info(`Connected to MCP WebSocket server "${config.name}"`);
  return client;
}

function rawDataToString(data: RawData): string {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function waitForSocketClose(
  socket: WebSocket,
  timeoutMs: number,
): Promise<boolean> {
  if (socket.readyState === WebSocket.CLOSED) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off("close", onClose);
      resolve(false);
    }, timeoutMs);
    timer.unref?.();

    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    socket.once("close", onClose);
  });
}
