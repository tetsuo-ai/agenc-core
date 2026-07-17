// Deny-by-default HTTPS CONNECT proxy for the eval executor's real-model
// lane. It runs inside a sidecar container on an --internal docker network;
// the agent container's only reachable route off its network is this proxy.
// The proxy allows a CONNECT tunnel to EXACTLY ONE host:port, dialing only
// pre-resolved pinned IPs, and denies everything else BEFORE any DNS lookup.
// It is an opaque tunnel: TLS stays end-to-end between the agent and the real
// provider (the agent validates the provider cert), so the proxy never sees
// plaintext or the provider cert. See docs/design/eval-pilot-executor-phase2b-egress.md.
import net from "node:net";
import { createServer } from "node:http";

const CONNECT_SELF_PROBE_MARKER = "AGENC_PROXY_READY";

export function isIpLiteral(host) {
  // IPv4 dotted-quad or any colon (IPv6) — allowlist is hostname-only.
  if (host.includes(":")) return true;
  return /^[0-9]+(?:\.[0-9]+){3}$/u.test(host);
}

/**
 * Extract the SNI server_name from a TLS ClientHello record, or null if the
 * bytes are not a ClientHello or carry no SNI. The caller treats a null (or
 * any non-`allowHost`) result as a FAIL-CLOSED drop, so a parse quirk or a
 * missing SNI can never open an unverified tunnel.
 */
export function parseSni(buffer) {
  try {
    if (buffer.length < 43 || buffer[0] !== 0x16) return null; // not a handshake record
    if (buffer[5] !== 0x01) return null; // not ClientHello
    let p = 5 + 4; // skip record header (5) + handshake type/length (4)
    p += 2 + 32; // client_version + random
    const sessionIdLen = buffer[p];
    p += 1 + sessionIdLen;
    const cipherLen = buffer.readUInt16BE(p);
    p += 2 + cipherLen;
    const compLen = buffer[p];
    p += 1 + compLen;
    if (p + 2 > buffer.length) return null;
    const extTotal = buffer.readUInt16BE(p);
    p += 2;
    const extEnd = Math.min(p + extTotal, buffer.length);
    while (p + 4 <= extEnd) {
      const extType = buffer.readUInt16BE(p);
      const extLen = buffer.readUInt16BE(p + 2);
      const extStart = p + 4;
      if (extType === 0x0000) {
        // server_name extension: list length (2), name type (1), name len (2), name
        let q = extStart + 2;
        if (buffer[q] !== 0x00) return null; // only host_name(0)
        const nameLen = buffer.readUInt16BE(q + 1);
        q += 3;
        if (q + nameLen > buffer.length) return null;
        return buffer.toString("ascii", q, q + nameLen).toLowerCase();
      }
      p = extStart + extLen;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Buffer the complete first TLS record (the ClientHello) so SNI is checked on
 * the whole message, not a single TCP segment. Pauses the socket before
 * resolving so no bytes are lost between the read and the upstream pipe.
 * Returns null (→ fail-closed drop) on timeout, oversize, or a malformed
 * record header.
 */
function readClientHello(socket, { maxHelloBytes, timeoutMs }) {
  return new Promise((resolve) => {
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener("data", onData);
      socket.pause();
      resolve(value);
    };
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > maxHelloBytes) return done(null);
      if (buf.length >= 5) {
        const recordLength = buf.readUInt16BE(3);
        if (recordLength <= 0 || recordLength > maxHelloBytes) return done(null);
        if (buf.length >= 5 + recordLength) return done(buf);
      }
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    socket.on("data", onData);
  });
}

export function createAllowlistProxy(config) {
  const allowHost = String(config.allowHost).toLowerCase();
  const allowPort = String(config.allowPort);
  const pinIps = [...config.pinIps];
  const sniTimeoutMs = config.sniTimeoutMs ?? 10_000;
  // Bound the buffered ClientHello above the TLS record maximum (16 KiB).
  const maxHelloBytes = config.maxHelloBytes ?? 18_432;
  const maxConnections = config.maxConnections ?? 64;
  if (pinIps.length === 0) throw new Error("allowlist proxy requires at least one pinned IP");

  // Absolute-form / plain-HTTP requests are never the provider API path.
  const server = createServer((_req, res) => {
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("forbidden");
  });
  // Cap concurrent tunnels so a malicious agent cannot exhaust the sidecar.
  server.maxConnections = maxConnections;

  server.on("connect", (req, clientSocket) => {
    // Attach the error handler FIRST: a client RST at any point (including
    // while awaiting the ClientHello) must drop the socket, never crash the
    // egress proxy for concurrent runs.
    clientSocket.on("error", () => clientSocket.destroy());
    const authority = String(req.url ?? "");
    const lastColon = authority.lastIndexOf(":");
    const host = lastColon > 0 ? authority.slice(0, lastColon).toLowerCase() : authority.toLowerCase();
    const port = lastColon > 0 ? authority.slice(lastColon + 1) : "";

    // A trivial in-container readiness self-probe: the sidecar dials itself
    // with this exact authority and expects a 403, proving the deny path is
    // live before the agent is started.
    const denyAndClose = (reason) => {
      clientSocket.write(
        `HTTP/1.1 403 Forbidden\r\nx-agenc-proxy-deny: ${reason}\r\nconnection: close\r\n\r\n`,
      );
      clientSocket.destroy();
    };

    // Deny BEFORE any DNS resolution: the proxy must never look up a denied
    // host (that would itself be an exfil channel).
    if (isIpLiteral(host)) return denyAndClose("ip-literal");
    if (host !== allowHost) return denyAndClose("host");
    if (port !== allowPort) return denyAndClose("port");

    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // Buffer the whole ClientHello and pin its SNI to the allowed host —
    // FAIL CLOSED: drop unless the SNI is positively verified as allowHost.
    // Then replay the exact bytes upstream (opaque tunnel, no TLS
    // termination), dialing only a pre-resolved pinned IP.
    readClientHello(clientSocket, { maxHelloBytes, timeoutMs: sniTimeoutMs }).then((hello) => {
      if (!hello || parseSni(hello) !== allowHost) return clientSocket.destroy();
      const upstream = net.connect({ host: pinIps[0], port: Number(allowPort) }, () => {
        upstream.write(hello);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
      });
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    });
  });

  return server;
}

async function main() {
  const allowHost = process.env.AGENC_PROXY_ALLOW_HOST;
  const allowPort = process.env.AGENC_PROXY_ALLOW_PORT ?? "443";
  const pinIps = (process.env.AGENC_PROXY_PIN_IPS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const listenPort = Number(process.env.AGENC_PROXY_LISTEN_PORT ?? "8080");
  if (!allowHost || pinIps.length === 0) {
    process.stderr.write("AGENC_PROXY_ALLOW_HOST and AGENC_PROXY_PIN_IPS are required\n");
    process.exit(2);
  }
  const server = createAllowlistProxy({ allowHost, allowPort, pinIps });
  server.listen(listenPort, "0.0.0.0", () => {
    process.stdout.write(`${CONNECT_SELF_PROBE_MARKER} host=${allowHost} port=${allowPort}\n`);
  });
}

const invokedDirectly = process.argv[1] &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exit(1);
  });
}
