// One loopback WebSocket client to the daemon gateway per app connection. The gateway routes
// server-initiated pushes (chat.stream, approval.request, owner pushes) through a connection-bound
// sink, so the portal must hold a real per-connection socket — it cannot consume the handler
// in-process. Loopback connections auto-authenticate (gateway.ts), so no auth frame is needed here;
// the remote/relay leg (P2) presents a token instead.

import WebSocket from "ws";
import type { GatewayEnvelope } from "./portal-protocol.js";

export interface PortalGatewayClientOptions {
  daemonUrl: string;
  onMessage: (msg: GatewayEnvelope) => void;
  onClose: () => void;
  onOpen?: () => void;
  onError?: (err: Error) => void;
}

export class PortalGatewayClient {
  private readonly ws: WebSocket;
  private readonly queue: string[] = [];
  private open = false;
  private closed = false;

  constructor(private readonly opts: PortalGatewayClientOptions) {
    this.ws = new WebSocket(opts.daemonUrl);
    this.ws.on("open", () => {
      this.open = true;
      for (const m of this.queue) this.ws.send(m);
      this.queue.length = 0;
      this.opts.onOpen?.();
    });
    this.ws.on("message", (data: WebSocket.RawData) => {
      let parsed: GatewayEnvelope;
      try {
        parsed = JSON.parse(data.toString()) as GatewayEnvelope;
      } catch {
        return;
      }
      this.opts.onMessage(parsed);
    });
    this.ws.on("close", () => {
      this.closed = true;
      this.open = false;
      this.opts.onClose();
    });
    this.ws.on("error", (err: Error) => {
      this.opts.onError?.(err);
    });
  }

  /** Send a `{type,...}` envelope to the gateway; queues until the socket opens. */
  send(envelope: Record<string, unknown>): void {
    if (this.closed) return;
    const s = JSON.stringify(envelope);
    if (this.open && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(s);
    } else {
      this.queue.push(s);
    }
  }

  close(): void {
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }
}
