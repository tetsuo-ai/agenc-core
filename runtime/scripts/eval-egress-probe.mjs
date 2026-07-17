// Containment deny-probe for the eval executor's real-model lane. Runs INSIDE
// the agent task container, executed by the overlay's pinned node so it is
// tool-independent. It positively confirms each containment property and
// prints one JSON line (AGENC_EGRESS_PROBE:<json>). FAIL CLOSED: a probe
// reports `true` only when it has confirmed the safe outcome; any error,
// timeout, or unexpected success reports `false`, which leaves the run
// oracle_containment_unverified so the agent is never started.
//
// Env: AGENC_PROBE_PROXY=host:port  AGENC_PROBE_ALLOW_HOST  AGENC_PROBE_ALLOW_PORT
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import http from "node:http";
import { readFileSync } from "node:fs";

const PROXY = process.env.AGENC_PROBE_PROXY ?? "";
const ALLOW_HOST = process.env.AGENC_PROBE_ALLOW_HOST ?? "";
const ALLOW_PORT = Number(process.env.AGENC_PROBE_ALLOW_PORT ?? "443");
const GATEWAY = process.env.AGENC_PROBE_GATEWAY ?? "";
const [PROXY_HOST, PROXY_PORT] = PROXY.split(":");
const PROBE_TIMEOUT_MS = 8_000;
// Common host-service ports a bridge gateway might expose to the agent.
const GATEWAY_PROBE_PORTS = [22, 80, 443, 2375, 2376, 5000, 8080];

/**
 * True iff the container has NO IPv4 default route. `--internal` gives no
 * default route; a default route means egress off the /29 is possible.
 * Unknown (unreadable) => assume a route exists => NOT contained.
 */
function noDefaultRoute4() {
  try {
    const lines = readFileSync("/proc/net/route", "utf8").split("\n").slice(1);
    return !lines.some((line) => {
      const cols = line.trim().split(/\s+/u);
      return cols.length > 1 && cols[1] === "00000000";
    });
  } catch {
    return false;
  }
}


function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
  ]);
}

/** true iff a raw TCP connect to a public address FAILS (no route off net). */
function rawConnectFails(host, port, family) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, family });
    let settled = false;
    const done = (failed) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(failed);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(false)); // connected => route exists => NOT contained
    socket.once("timeout", () => done(true));
    socket.once("error", () => done(true));
  });
}

/** CONNECT to host:port through the proxy; resolves the HTTP status number. */
function proxyConnectStatus(host, port) {
  return new Promise((resolve) => {
    const req = http.request({
      host: PROXY_HOST,
      port: Number(PROXY_PORT),
      method: "CONNECT",
      path: `${host}:${port}`,
      timeout: PROBE_TIMEOUT_MS,
    });
    let settled = false;
    const done = (status) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      resolve(status);
    };
    req.once("connect", (res, socket) => { socket.destroy(); done(res.statusCode ?? 0); });
    req.once("response", (res) => done(res.statusCode ?? 0)); // 403 arrives as a response
    req.once("timeout", () => done(-1));
    req.once("error", () => done(-1));
    req.end();
  });
}

/** true iff DNS resolution of a public name FAILS (resolver blackholed). */
function dnsFails(name) {
  return new Promise((resolve) => {
    dns.lookup(name, (error) => resolve(Boolean(error)));
  });
}

/**
 * true iff a mismatched-SNI TLS handshake over an allowed-host tunnel FAILS
 * (the proxy pins SNI to the allow host). Opens a real CONNECT tunnel to the
 * allow host, then attempts TLS with a bogus servername.
 */
function sniMismatchDropped() {
  return new Promise((resolve) => {
    const req = http.request({
      host: PROXY_HOST,
      port: Number(PROXY_PORT),
      method: "CONNECT",
      path: `${ALLOW_HOST}:${ALLOW_PORT}`,
      timeout: PROBE_TIMEOUT_MS,
    });
    let settled = false;
    const done = (dropped) => {
      if (settled) return;
      settled = true;
      try { req.destroy(); } catch { /* ignore */ }
      resolve(dropped);
    };
    req.once("connect", (_res, socket) => {
      const tlsSocket = tls.connect(
        { socket, servername: "sni-mismatch.invalid", rejectUnauthorized: false },
        () => { tlsSocket.destroy(); done(false); }, // handshake succeeded => NOT pinned
      );
      tlsSocket.setTimeout(PROBE_TIMEOUT_MS);
      tlsSocket.once("error", () => done(true)); // dropped => pinned
      tlsSocket.once("timeout", () => done(true));
      tlsSocket.once("close", () => done(true));
    });
    req.once("response", () => done(true)); // proxy refused the tunnel outright
    req.once("timeout", () => done(false));
    req.once("error", () => done(false));
    req.end();
  });
}

async function bool(promise) {
  const r = await withTimeout(promise, PROBE_TIMEOUT_MS + 2_000);
  return r === true;
}

/** True iff the bridge gateway is unreachable on every common host-service port. */
async function gatewayUnreachable() {
  if (!GATEWAY) return false; // no gateway to verify => cannot confirm => fail closed
  const results = await Promise.all(
    GATEWAY_PROBE_PORTS.map((port) => rawConnectFails(GATEWAY, port, 4)),
  );
  return results.every(Boolean);
}

const [
  publicV4Fails, githubStatus, dnsBlackholed, publicV6Fails, ipLiteralStatus, sniPinned, gatewayOk,
] = await Promise.all([
  bool(rawConnectFails("1.1.1.1", 443, 4)),
  withTimeout(proxyConnectStatus("github.com", 443), PROBE_TIMEOUT_MS + 2_000),
  bool(dnsFails("github.com")),
  bool(rawConnectFails("2606:4700:4700::1111", 443, 6)),
  withTimeout(proxyConnectStatus("140.82.112.3", 443), PROBE_TIMEOUT_MS + 2_000),
  bool(sniMismatchDropped()),
  bool(gatewayUnreachable()),
]);

const probes = {
  // Topological: no public route, no v4 default route, and the bridge gateway
  // (a host interface) is unreachable — closing the host-service path.
  noRouteOffNet: publicV4Fails && noDefaultRoute4() && gatewayOk,
  githubBlocked: githubStatus === 403,
  dnsBlackholed,
  // No reachable public IPv6 == no v6 egress. (A /proc route-table parse is
  // fragile across kernels; the reachability test is the sound signal.)
  ipv6Absent: publicV6Fails,
  ipLiteralRejected: ipLiteralStatus === 403,
  sniPinned,
};
process.stdout.write(`AGENC_EGRESS_PROBE:${JSON.stringify(probes)}\n`);
