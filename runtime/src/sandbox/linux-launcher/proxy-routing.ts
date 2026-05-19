import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { AGENC_PROXY_SOCKET_DIR_PREFIX } from "./config.js";

export interface ProxyRoute {
  readonly envKey: string;
  readonly host: string;
  readonly port: number;
}

export interface ProxyRoutePlan {
  readonly hasProxyConfig: boolean;
  readonly routes: readonly ProxyRoute[];
}

export interface PreparedProxyRouteSpec {
  readonly socketDir: string;
  readonly routes: readonly {
    readonly envKey: string;
    readonly udsPath: string;
  }[];
}

export interface PreparedProxyRoutes {
  readonly spec: PreparedProxyRouteSpec;
  readonly serializedSpec: string;
  readonly socketDir: string;
  cleanup(): void;
}

export interface ActivatedProxyRoutes {
  readonly env: NodeJS.ProcessEnv;
  cleanup(): void;
}

const PROXY_ENV_KEYS = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "YARN_HTTP_PROXY",
  "YARN_HTTPS_PROXY",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTP_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "BUNDLE_HTTP_PROXY",
  "BUNDLE_HTTPS_PROXY",
  "PIP_PROXY",
  "DOCKER_HTTP_PROXY",
  "DOCKER_HTTPS_PROXY",
]);

function isProxyEnvKey(key: string): boolean {
  return PROXY_ENV_KEYS.has(key.toUpperCase());
}

export function planProxyRoutes(env: NodeJS.ProcessEnv): ProxyRoutePlan {
  let hasProxyConfig = false;
  const routes: ProxyRoute[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!isProxyEnvKey(key)) continue;
    const trimmed = String(value ?? "").trim();
    if (trimmed.length === 0) continue;
    hasProxyConfig = true;
    const endpoint = parseLoopbackProxyEndpoint(trimmed);
    if (endpoint === null) continue;
    routes.push({ envKey: key, host: endpoint.host, port: endpoint.port });
  }
  return { hasProxyConfig, routes };
}

export function prepareHostProxyRouteSpec(
  env: NodeJS.ProcessEnv,
): PreparedProxyRouteSpec {
  const plan = planProxyRoutes(env);
  if (plan.routes.length === 0) {
    const detail = plan.hasProxyConfig
      ? "managed proxy mode requires parseable loopback proxy endpoints"
      : "managed proxy mode requires proxy environment variables";
    throw new Error(detail);
  }
  cleanupStaleProxySocketDirs();
  const socketDir = fs.mkdtempSync(path.join(os.tmpdir(), AGENC_PROXY_SOCKET_DIR_PREFIX));
  fs.chmodSync(socketDir, 0o700);
  const socketByEndpoint = new Map<string, string>();
  let nextSocketIndex = 0;
  return {
    socketDir,
    routes: plan.routes.map((route) => {
      const endpoint = endpointKey(route.host, route.port);
      let udsPath = socketByEndpoint.get(endpoint);
      if (udsPath === undefined) {
        udsPath = path.join(socketDir, `proxy-route-${nextSocketIndex}.sock`);
        nextSocketIndex += 1;
        socketByEndpoint.set(endpoint, udsPath);
      }
      return {
        envKey: route.envKey,
        udsPath,
      };
    }),
  };
}

export async function prepareHostProxyRoutes(
  env: NodeJS.ProcessEnv,
): Promise<PreparedProxyRoutes> {
  const spec = prepareHostProxyRouteSpec(env);
  const plan = planProxyRoutes(env);
  const servers: net.Server[] = [];
  const activeSockets = new Set<net.Socket>();
  const endpointBySocket = new Map<string, ProxyRoute>();
  spec.routes.forEach((route, index) => {
    const endpoint = plan.routes[index];
    if (endpoint !== undefined && !endpointBySocket.has(route.udsPath)) {
      endpointBySocket.set(route.udsPath, endpoint);
    }
  });
  try {
    await Promise.all([...endpointBySocket.entries()].map(async ([udsPath, endpoint]) => {
      const server = net.createServer((unixSocket) => {
        trackSocket(activeSockets, unixSocket);
        const tcp = trackSocket(
          activeSockets,
          net.connect({ host: endpoint.host, port: endpoint.port }),
        );
        void createProxyPair(tcp, unixSocket);
      });
      servers.push(server);
      await listen(server, udsPath);
    }));
  } catch (error) {
    closeServers(servers);
    destroySockets(activeSockets);
    fs.rmSync(spec.socketDir, { recursive: true, force: true });
    throw error;
  }
  return {
    spec,
    serializedSpec: JSON.stringify(spec),
    socketDir: spec.socketDir,
    cleanup() {
      closeServers(servers);
      destroySockets(activeSockets);
      fs.rmSync(spec.socketDir, { recursive: true, force: true });
    },
  };
}

export async function activateProxyRoutesInNetns(
  serializedSpec: string,
  env: NodeJS.ProcessEnv,
): Promise<ActivatedProxyRoutes> {
  const spec = parseProxyRouteSpec(serializedSpec);
  if (spec.routes.length === 0) {
    throw new Error("proxy routing spec contained no routes");
  }
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  const servers: net.Server[] = [];
  const activeSockets = new Set<net.Socket>();
  try {
    await Promise.all(spec.routes.map(async (route) => {
      const original = nextEnv[route.envKey];
      if (original === undefined) {
        throw new Error(`missing proxy env key ${route.envKey}`);
      }
      const server = net.createServer((tcpSocket) => {
        trackSocket(activeSockets, tcpSocket);
        const unixSocket = trackSocket(activeSockets, net.connect(route.udsPath));
        void createProxyPair(tcpSocket, unixSocket);
      });
      servers.push(server);
      await listen(server, "127.0.0.1", 0);
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        throw new Error(`failed to allocate proxy route port for ${route.envKey}`);
      }
      const rewritten = rewriteProxyEnvValue(original, address.port);
      if (rewritten === null) {
        throw new Error(`could not rewrite proxy URL for env key ${route.envKey}`);
      }
      nextEnv[route.envKey] = rewritten;
    }));
  } catch (error) {
    closeServers(servers);
    destroySockets(activeSockets);
    throw error;
  }
  return {
    env: nextEnv,
    cleanup() {
      closeServers(servers);
      destroySockets(activeSockets);
    },
  };
}

export function rewriteProxyEnvValue(
  proxyUrl: string,
  localPort: number,
): string | null {
  const candidate = proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  parsed.hostname = "127.0.0.1";
  parsed.port = String(localPort);
  const value = parsed.toString();
  const rewritten = proxyUrl.includes("://") ? value : value.replace(/^http:\/\//u, "");
  return proxyUrlHasNoPathQueryOrFragment(proxyUrl) && rewritten.endsWith("/")
    ? rewritten.slice(0, -1)
    : rewritten;
}

function parseLoopbackProxyEndpoint(
  proxyUrl: string,
): { readonly host: string; readonly port: number } | null {
  const candidate = proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  if (!isLoopbackHost(host)) return null;
  const port = parsed.port.length > 0
    ? Number.parseInt(parsed.port, 10)
    : defaultProxyPort(parsed.protocol);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

function defaultProxyPort(protocol: string): number {
  switch (protocol.replace(/:$/u, "")) {
    case "https":
      return 443;
    case "socks4":
    case "socks4a":
    case "socks5":
    case "socks5h":
      return 1080;
    default:
      return 80;
  }
}

function createProxyPair(
  tcp: net.Socket,
  unix: net.Socket,
): Promise<void> {
  const destroyBoth = () => {
    tcp.destroy();
    unix.destroy();
  };
  tcp.once("error", destroyBoth);
  unix.once("error", destroyBoth);
  tcp.pipe(unix);
  unix.pipe(tcp);
  return new Promise((resolve) => {
    let pending = 2;
    const done = () => {
      pending -= 1;
      if (pending === 0) resolve();
    };
    tcp.once("close", done);
    unix.once("close", done);
  });
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]";
}

function endpointKey(host: string, port: number): string {
  return `${host}:${port}`;
}

function proxyUrlHasNoPathQueryOrFragment(proxyUrl: string): boolean {
  const authority = proxyUrl.includes("://")
    ? proxyUrl.slice(proxyUrl.indexOf("://") + 3)
    : proxyUrl;
  return !/[/?#]/u.test(authority);
}

function pathWithin(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function cleanupStaleProxySocketDirs(now: number = Date.now()): void {
  const tmp = os.tmpdir();
  let entries: string[];
  try {
    entries = fs.readdirSync(tmp);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(AGENC_PROXY_SOCKET_DIR_PREFIX)) continue;
    const candidate = path.join(tmp, entry);
    try {
      const stat = fs.statSync(candidate);
      if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
        fs.rmSync(candidate, { recursive: true, force: true });
      }
    } catch {
      // Ignore stale cleanup races; new route creation remains fail-closed.
    }
  }
}

function parseProxyRouteSpec(serializedSpec: string): PreparedProxyRouteSpec {
  const parsed = JSON.parse(serializedSpec) as Partial<PreparedProxyRouteSpec>;
  const socketDir = String(parsed.socketDir ?? "");
  if (!path.isAbsolute(socketDir)) {
    throw new Error("proxy routing spec socketDir must be absolute");
  }
  if (!Array.isArray(parsed.routes)) {
    throw new Error("proxy routing spec is missing routes");
  }
  return {
    socketDir,
    routes: parsed.routes.map((route) => {
      const envKey = String(route.envKey);
      const udsPath = String(route.udsPath);
      if (!isProxyEnvKey(envKey)) {
        throw new Error(`proxy routing spec contains unsupported env key ${envKey}`);
      }
      if (!path.isAbsolute(udsPath) || !pathWithin(udsPath, socketDir)) {
        throw new Error("proxy routing spec route path must stay under socketDir");
      }
      return { envKey, udsPath };
    }),
  };
}

function listen(server: net.Server, pathOrHost: string, port?: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    if (port === undefined) {
      server.listen(pathOrHost, onListening);
    } else {
      server.listen(port, pathOrHost, onListening);
    }
  });
}

function closeServers(servers: readonly net.Server[]): void {
  for (const server of servers) {
    try {
      server.close();
    } catch {
      // Best effort; the process is exiting or the socket is already closed.
    }
  }
}

function trackSocket<T extends net.Socket>(
  activeSockets: Set<net.Socket>,
  socket: T,
): T {
  activeSockets.add(socket);
  socket.once("close", () => {
    activeSockets.delete(socket);
  });
  return socket;
}

function destroySockets(activeSockets: Set<net.Socket>): void {
  for (const socket of activeSockets) {
    socket.destroy();
  }
  activeSockets.clear();
}
