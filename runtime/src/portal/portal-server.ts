// The portal's inbound transport (P1: loopback). A WebSocket server the AgenC iOS app connects to;
// each app connection gets its own PortalAdapter + one loopback PortalGatewayClient to the daemon.
// This is the in-core replacement for connector/local-translator.mjs. The relay/remote transport
// (P2) reuses the adapter behind an outbound relay-client dialer instead of this listener.

import WebSocket, { WebSocketServer } from "ws";
import { PortalAdapter } from "./portal-adapter.js";
import { PortalGatewayClient } from "./portal-gateway-client.js";
import {
  PORTAL_DEFAULT_DAEMON_URL,
  PORTAL_DEFAULT_HOST,
  PORTAL_DEFAULT_PORT,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "./portal-protocol.js";

export interface PortalServerOptions {
  host?: string;
  port?: number;
  daemonUrl?: string;
  logger?: (msg: string) => void;
}

export interface PortalServerHandle {
  host: string;
  port: number;
  close: () => Promise<void>;
}

export function startPortalServer(
  options: PortalServerOptions = {},
): Promise<PortalServerHandle> {
  const host = options.host ?? PORTAL_DEFAULT_HOST;
  const port = options.port ?? PORTAL_DEFAULT_PORT;
  const daemonUrl = options.daemonUrl ?? PORTAL_DEFAULT_DAEMON_URL;
  const log = options.logger ?? ((): void => {});

  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({ host, port });

    wss.on("listening", () => {
      log(`[portal] listening ws://${host}:${port} -> daemon ${daemonUrl}`);
      resolve({
        host,
        port,
        close: () => new Promise<void>((res) => wss.close(() => res())),
      });
    });

    wss.on("error", (err: Error) => reject(err));

    wss.on("connection", (app: WebSocket, req) => {
      // Origin allowlist: a native app sends no Origin header; reject any browser Origin so a
      // malicious page can't reach the loopback bridge.
      const origin = req.headers.origin;
      if (typeof origin === "string" && origin.length > 0) {
        log(`[portal] rejecting connection with Origin: ${origin}`);
        app.close(1008, "origin not allowed");
        return;
      }

      const sendToApp = (msg: JsonRpcResponse | JsonRpcNotification): void => {
        try {
          if (app.readyState === WebSocket.OPEN) app.send(JSON.stringify(msg));
        } catch {
          /* socket closing */
        }
      };

      let adapter: PortalAdapter;
      const gateway = new PortalGatewayClient({
        daemonUrl,
        onMessage: (m) => adapter.handleGatewayMessage(m),
        onClose: () => {
          adapter.handleGatewayClose();
          try {
            app.close();
          } catch {
            /* already closed */
          }
        },
        onError: (e) => log(`[portal] gateway error: ${e.message}`),
      });
      adapter = new PortalAdapter({
        sendToApp,
        sendToGateway: (env) => gateway.send(env),
        logger: log,
      });

      app.on("message", (data: WebSocket.RawData) => adapter.handleAppMessage(data.toString()));
      app.on("close", () => gateway.close());
      app.on("error", () => {
        /* ignore; close handler cleans up */
      });
      log("[portal] app connected");
    });
  });
}
