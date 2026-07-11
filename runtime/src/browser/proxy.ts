/**
 * In-process loopback egress proxy — the browser tool's single SSRF
 * enforcement point.
 *
 * Chromium is launched pointing every connection at this proxy and is denied
 * its own DNS/egress (`--proxy-server` + `--host-resolver-rules` +
 * `--proxy-bypass-list=<-loopback>`). For each request the proxy resolves the
 * host EXACTLY ONCE via {@link resolveAllowedAddress} and dials that resolved
 * IP directly, so the address the policy approved is the address the socket
 * connects to — closing the DNS-rebinding TOCTOU that a pre-resolve-then-trust
 * design leaves open. HTTPS uses CONNECT tunneling (TLS stays end-to-end to the
 * origin); plain HTTP is forwarded to the pinned IP with the original Host
 * header. Every failure path denies (fail closed).
 *
 * @module
 */

import { createServer, request as httpRequest, type Server } from "node:http";
import { connect as netConnect } from "node:net";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  resolveAllowedAddress,
  BrowserSsrfError,
  type BrowserSsrfPolicy,
  type HostLookup,
} from "./ssrf.js";

const CONNECT_TIMEOUT_MS = 30_000;
const MAX_BLOCK_RECORDS = 64;

export interface BrowserProxyOptions {
  readonly policy: BrowserSsrfPolicy;
  /** Test seam: overrides DNS resolution. */
  readonly lookup?: HostLookup;
  /** Idle/stall timeout for upstream connections (ms). Test seam. */
  readonly connectTimeoutMs?: number;
}

/** Strip a single pair of surrounding brackets from an IPv6 host literal. */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Split a `host:port` / `[ipv6]:port` authority, returning the default port
 * when none is present. IPv6 literals keep their brackets (the resolver strips
 * them); a bare-colon split would corrupt them.
 */
function splitHostPort(
  authority: string,
  defaultPort: number,
): { host: string; port: number } {
  if (authority.startsWith("[")) {
    const end = authority.indexOf("]");
    if (end > 0) {
      const host = authority.slice(0, end + 1);
      const rest = authority.slice(end + 1);
      const port = rest.startsWith(":") ? Number(rest.slice(1)) : defaultPort;
      return { host, port: Number.isFinite(port) ? port : defaultPort };
    }
  }
  const idx = authority.lastIndexOf(":");
  if (idx === -1) return { host: authority, port: defaultPort };
  const port = Number(authority.slice(idx + 1));
  return {
    host: authority.slice(0, idx),
    port: Number.isFinite(port) ? port : defaultPort,
  };
}

interface BlockRecord {
  readonly host: string;
  readonly reason: string;
  readonly at: number;
}

/** Loopback HTTP/HTTPS forward proxy with per-connection SSRF enforcement. */
export class BrowserProxy {
  readonly #policy: BrowserSsrfPolicy;
  readonly #lookup: HostLookup | undefined;
  readonly #connectTimeoutMs: number;
  #server: Server | undefined;
  #port = 0;
  readonly #sockets = new Set<Duplex>();
  readonly #blocks: BlockRecord[] = [];

  constructor(options: BrowserProxyOptions) {
    this.#policy = options.policy;
    this.#lookup = options.lookup;
    this.#connectTimeoutMs = options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
  }

  get port(): number {
    return this.#port;
  }

  async start(): Promise<number> {
    const server = createServer();
    server.on("request", (req, res) => {
      // Absolute-form request URL (proxy mode): http://host:port/path
      let target: URL;
      try {
        target = new URL(req.url ?? "");
      } catch {
        res.writeHead(400).end("bad request");
        return;
      }
      const host = target.hostname;
      const port = target.port !== "" ? Number(target.port) : 80;
      void this.#resolve(host)
        .then((ip) => {
          const upstream = httpRequest(
            {
              host: ip,
              port,
              method: req.method ?? "GET",
              path: `${target.pathname}${target.search}`,
              headers: { ...req.headers, host: target.host },
            },
            (upstreamRes) => {
              res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
              upstreamRes.pipe(res);
            },
          );
          // Track the upstream socket so stop() can tear it down, and bound a
          // slow/hostile origin that accepts the TCP connection but never
          // responds (which would otherwise leak the socket until the OS TCP
          // timeout and hang stop()). The global agent keep-alives sockets, so
          // the same socket is handed to many requests — attach the close
          // listener only once per socket, or listeners accumulate on reuse.
          upstream.on("socket", (socket) => {
            if (this.#sockets.has(socket)) return;
            this.#sockets.add(socket);
            socket.on("close", () => this.#sockets.delete(socket));
          });
          upstream.setTimeout(this.#connectTimeoutMs, () => {
            if (!res.headersSent) res.writeHead(504);
            res.end();
            upstream.destroy();
          });
          upstream.on("error", () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
          });
          // Tear down the upstream only if the client aborted mid-response;
          // on normal completion leave the socket for keep-alive reuse.
          res.on("close", () => {
            if (!res.writableFinished) upstream.destroy();
          });
          req.pipe(upstream);
        })
        .catch((err: unknown) => {
          this.#recordBlock(host, err);
          if (!res.headersSent) {
            res.writeHead(403, { "content-type": "text/plain" });
          }
          res.end("blocked by AgenC browser SSRF policy");
        });
    });

    server.on("connect", (req, clientSocket, head) => {
      this.#sockets.add(clientSocket);
      clientSocket.on("close", () => this.#sockets.delete(clientSocket));
      const { host, port } = splitHostPort(req.url ?? "", 443);
      void this.#resolve(host)
        .then((ip) => {
          const upstream = netConnect({ host: ip, port }, () => {
            clientSocket.write(
              "HTTP/1.1 200 Connection Established\r\n\r\n",
            );
            if (head.length > 0) upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
          });
          this.#sockets.add(upstream);
          upstream.setTimeout(this.#connectTimeoutMs, () => upstream.destroy());
          upstream.on("close", () => this.#sockets.delete(upstream));
          upstream.on("error", () => clientSocket.destroy());
          clientSocket.on("error", () => upstream.destroy());
        })
        .catch((err: unknown) => {
          this.#recordBlock(host, err);
          clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
          clientSocket.destroy();
        });
    });

    // Do not leak connection errors as process crashes.
    server.on("clientError", (_err, socket) => {
      if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.#server = server;
    this.#port = (server.address() as AddressInfo).port;
    return this.#port;
  }

  async #resolve(host: string): Promise<string> {
    return resolveAllowedAddress(host, this.#policy, this.#lookup);
  }

  #recordBlock(host: string, err: unknown): void {
    const reason =
      err instanceof BrowserSsrfError
        ? err.message
        : err instanceof Error
          ? err.message
          : "blocked";
    // Store under the bracket-stripped host so takeBlockReason (which also
    // strips) matches IPv6 literals recorded as "[::1]" against a "[::1]" query.
    this.#blocks.push({ host: stripBrackets(host), reason, at: Date.now() });
    if (this.#blocks.length > MAX_BLOCK_RECORDS) this.#blocks.shift();
  }

  /**
   * Return (and clear) the most recent block reason for `host`, if the proxy
   * refused a connection to it. Lets `navigate()` surface a precise SSRF error
   * instead of a generic load failure. The proxy — not this lookup — is the
   * enforcement boundary; this is only for messaging.
   */
  takeBlockReason(host: string): string | undefined {
    const bare = stripBrackets(host);
    for (let i = this.#blocks.length - 1; i >= 0; i--) {
      if (this.#blocks[i]!.host === bare) {
        const reason = this.#blocks[i]!.reason;
        this.#blocks.splice(i, 1);
        return reason;
      }
    }
    return undefined;
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    const server = this.#server;
    this.#server = undefined;
    if (server === undefined) return;
    // Force-close idle keep-alive inbound connections too, so stop() cannot
    // hang waiting on a client the proxy no longer serves.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
