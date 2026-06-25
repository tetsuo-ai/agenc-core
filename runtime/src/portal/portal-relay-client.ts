// The portal's RELAY transport (P2a). Instead of listening locally, the portal dials OUT to a
// Cloudflare Durable-Object relay room and serves app connections multiplexed by connection id
// (cid). Each cid gets its own PortalConnection (adapter + loopback daemon socket). This is the
// in-core replacement for connector/connector-real.mjs, letting a physical phone reach a local
// daemon through the relay. Auth to the relay is the host ticket (P2a: a `dev:<account>:host:...`
// shared-secret ticket; P2b swaps in per-device id.agenc.ag tokens via resolveTicket()).

import WebSocket from "ws";
import { createPortalConnection, type PortalConnection } from "./portal-connection.js";
import { PORTAL_DEFAULT_DAEMON_URL } from "./portal-protocol.js";

export interface PortalRelayClientOptions {
  relayUrl: string; // must be wss:// (ws:// only allowed to loopback)
  /** Host ticket presented to the relay. P2a: `dev:<account>:host:<machine>`. */
  ticket: string;
  daemonUrl?: string;
  logger?: (msg: string) => void;
  reconnectDelayMs?: number;
  keepaliveMs?: number;
  /** Cap on concurrent remote connections (one daemon socket each) to bound resource use (M5). */
  maxPeers?: number;
}

export interface PortalRelayHandle {
  close: () => void;
}

interface RelayFrame {
  t?: string;
  cid?: string;
  event?: string;
  payload?: string;
}

/** Require TLS to the relay; allow cleartext only to loopback for local dev (M6). */
function isSecureRelayUrl(url: string): boolean {
  if (url.startsWith("wss://")) return true;
  return /^ws:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(url);
}

export function startPortalRelayClient(
  options: PortalRelayClientOptions,
): PortalRelayHandle {
  if (!isSecureRelayUrl(options.relayUrl)) {
    throw new Error(
      `portal relay requires a wss:// URL (got "${options.relayUrl}"); ws:// is only allowed to loopback`,
    );
  }
  const daemonUrl = options.daemonUrl ?? PORTAL_DEFAULT_DAEMON_URL;
  const log = options.logger ?? ((): void => {});
  const reconnectDelayMs = options.reconnectDelayMs ?? 2000;
  const keepaliveMs = options.keepaliveMs ?? 25000;
  const maxPeers = options.maxPeers ?? 32;
  const hostUrl = `${options.relayUrl}/v1/host?ticket=${encodeURIComponent(options.ticket)}`;

  const peers = new Map<string, PortalConnection>();
  let relay: WebSocket | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  function sendToRelay(cid: string, msg: unknown): void {
    try {
      relay?.send(JSON.stringify({ t: "data", cid, payload: JSON.stringify(msg) }));
    } catch {
      /* relay closing */
    }
  }

  function openPeer(cid: string): PortalConnection {
    const existing = peers.get(cid);
    if (existing) return existing;
    const conn = createPortalConnection({
      daemonUrl,
      isRemote: true, // activates the adapter's remote scope gate (M1/M2/M3)
      logger: log,
      sendToApp: (msg) => sendToRelay(cid, msg),
      onGatewayClose: () => {
        peers.delete(cid);
        try {
          relay?.send(JSON.stringify({ t: "peer", cid, event: "close" }));
        } catch {
          /* relay closing */
        }
      },
    });
    peers.set(cid, conn);
    return conn;
  }

  function closePeer(cid: string): void {
    const conn = peers.get(cid);
    if (conn) {
      conn.close();
      peers.delete(cid);
    }
  }

  function teardownAllPeers(): void {
    for (const conn of peers.values()) conn.close();
    peers.clear();
  }

  function connect(): void {
    if (closed) return;
    relay = new WebSocket(hostUrl);

    relay.on("open", () => {
      log(`[portal-relay] host channel open -> ${options.relayUrl} -> daemon ${daemonUrl}`);
      if (keepalive) clearInterval(keepalive);
      // Keep the host channel warm so the Cloudflare DO doesn't idle-close it.
      keepalive = setInterval(() => {
        try {
          relay?.send(JSON.stringify({ t: "ping" }));
        } catch {
          /* a dropped send surfaces via the close handler */
        }
      }, keepaliveMs);
    });

    relay.on("message", (data: WebSocket.RawData) => {
      let frame: RelayFrame;
      try {
        frame = JSON.parse(data.toString()) as RelayFrame;
      } catch {
        return;
      }
      if (frame.t === "peer" && typeof frame.cid === "string") {
        if (frame.event === "open") {
          if (peers.size >= maxPeers) {
            // Bound resource use: each peer opens a daemon socket (M5). Reject overflow.
            log(`[portal-relay] peer cap ${maxPeers} reached — rejecting ${frame.cid}`);
            try {
              relay?.send(JSON.stringify({ t: "peer", cid: frame.cid, event: "close" }));
            } catch {
              /* relay closing */
            }
          } else {
            openPeer(frame.cid);
            log(`[portal-relay] phone ${frame.cid} connected (${peers.size} active)`);
          }
        } else if (frame.event === "close") {
          closePeer(frame.cid);
        }
      } else if (
        frame.t === "data" &&
        typeof frame.cid === "string" &&
        typeof frame.payload === "string"
      ) {
        // Only serve cids that completed a peer-open handshake — never lazily spawn a daemon socket
        // from a data frame for an unknown cid (M5).
        peers.get(frame.cid)?.handleAppMessage(frame.payload);
      }
      // {t:"welcome"}, {t:"pong"}, and anything else are ignored.
    });

    relay.on("close", () => {
      if (keepalive) {
        clearInterval(keepalive);
        keepalive = null;
      }
      // The relay closes all clients when the host drops, so reset every peer and re-dial.
      teardownAllPeers();
      if (!closed) {
        log(`[portal-relay] relay closed — reconnecting in ${reconnectDelayMs}ms`);
        setTimeout(connect, reconnectDelayMs);
      }
    });

    relay.on("error", (err: Error) => log(`[portal-relay] relay error: ${err.message}`));
  }

  connect();

  return {
    close: () => {
      closed = true;
      if (keepalive) clearInterval(keepalive);
      teardownAllPeers();
      try {
        relay?.close();
      } catch {
        /* already closing */
      }
    },
  };
}
