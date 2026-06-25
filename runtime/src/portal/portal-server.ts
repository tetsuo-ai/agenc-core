// The portal's inbound LOOPBACK transport (P1). A WebSocket server the AgenC iOS app connects to
// directly; each app connection gets its own PortalConnection (adapter + daemon socket). This is
// the in-core replacement for connector/local-translator.mjs. The relay/remote transport (P2) lives
// in portal-relay-client.ts and reuses the same PortalConnection.

import WebSocket, { WebSocketServer } from "ws";
import { createPortalConnection } from "./portal-connection.js";
import {
  PORTAL_DEFAULT_DAEMON_URL,
  PORTAL_DEFAULT_HOST,
  PORTAL_DEFAULT_PORT,
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

      const conn = createPortalConnection({
        daemonUrl,
        logger: log,
        sendToApp: (msg) => {
          try {
            if (app.readyState === WebSocket.OPEN) app.send(JSON.stringify(msg));
          } catch {
            /* socket closing */
          }
        },
        onGatewayClose: () => {
          try {
            app.close();
          } catch {
            /* already closed */
          }
        },
      });

      app.on("message", (data: WebSocket.RawData) => conn.handleAppMessage(data.toString()));
      app.on("close", () => conn.close());
      app.on("error", () => {
        /* close handler cleans up */
      });
      log("[portal] app connected");
    });
  });
}
