/**
 * BrowserProxy — the browser tool's SSRF enforcement point.
 *
 * These tests drive the real proxy with a real loopback fixture and an
 * injected resolver, so they prove the block at the socket layer without a
 * browser. Revert-sensitivity: if the address classification is loosened (e.g.
 * loopback stops being blocked by default, or the "any disallowed address"
 * strictness is dropped), the block assertions here go red.
 */

import { afterEach, describe, expect, test } from "vitest";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { createServer as createTcpServer, connect as tcpConnect } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import type { Server as HttpServer } from "node:http";
import type { Server as TcpServer } from "node:net";
import { BrowserProxy } from "../../src/browser/proxy.js";
import type { HostLookup } from "../../src/browser/ssrf.js";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function startHttpFixture(body: string): Promise<{ port: number }> {
  const server: HttpServer = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(body);
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", resolve),
  );
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return { port: (server.address() as AddressInfo).port };
}

async function startProxy(
  allowPrivateNetwork: boolean,
  lookup: HostLookup,
  connectTimeoutMs?: number,
): Promise<BrowserProxy> {
  const proxy = new BrowserProxy({
    policy: { allowPrivateNetwork },
    lookup,
    ...(connectTimeoutMs !== undefined ? { connectTimeoutMs } : {}),
  });
  await proxy.start();
  cleanups.push(() => proxy.stop());
  return proxy;
}

/** GET an absolute-form URL through the proxy; resolve with {status, body}. */
function getThroughProxy(
  proxyPort: number,
  absoluteUrl: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const host = new URL(absoluteUrl).host;
    const req = httpRequest(
      { host: "127.0.0.1", port: proxyPort, path: absoluteUrl, headers: { host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Send a CONNECT to the proxy; resolve with the raw status line. */
function connectThroughProxy(
  proxyPort: number,
  hostPort: string,
): Promise<{ statusLine: string; socket: Socket }> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\n\r\n`);
    });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buf += chunk;
      const idx = buf.indexOf("\r\n");
      if (idx >= 0) {
        resolve({ statusLine: buf.slice(0, idx), socket });
      }
    });
    socket.on("error", reject);
  });
}

describe("BrowserProxy SSRF enforcement (HTTP)", () => {
  test("blocks a host that resolves to loopback by default", async () => {
    const proxy = await startProxy(false, async () => ["127.0.0.1"]);
    const res = await getThroughProxy(proxy.port, "http://evil.test:80/");
    expect(res.status).toBe(403);
    expect(res.body).toContain("blocked");
  });

  test("blocks a host that resolves to a private address by default", async () => {
    const proxy = await startProxy(false, async () => ["10.0.0.5"]);
    const res = await getThroughProxy(proxy.port, "http://intranet.test:80/");
    expect(res.status).toBe(403);
  });

  test("blocks cloud metadata even when private network is allowed", async () => {
    const proxy = await startProxy(true, async () => ["169.254.169.254"]);
    const res = await getThroughProxy(proxy.port, "http://metadata.test:80/");
    expect(res.status).toBe(403);
  });

  test("blocks when ANY resolved address is disallowed (mixed answer)", async () => {
    const proxy = await startProxy(false, async () => ["8.8.8.8", "10.0.0.1"]);
    const res = await getThroughProxy(proxy.port, "http://mixed.test:80/");
    expect(res.status).toBe(403);
  });

  test("allows loopback only when private network is explicitly allowed", async () => {
    const fixture = await startHttpFixture("LOCALOK");
    const proxy = await startProxy(true, async () => ["127.0.0.1"]);
    const res = await getThroughProxy(
      proxy.port,
      `http://local.test:${fixture.port}/`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe("LOCALOK");
  });

  test("times out a stalled origin instead of leaking the socket", async () => {
    // An origin that accepts the TCP connection but never sends response
    // headers. Without an upstream timeout the proxy would hang forever.
    const stallSockets: Socket[] = [];
    const stall: TcpServer = createTcpServer((sock) => {
      sock.on("error", () => {});
      stallSockets.push(sock); // never responds
    });
    await new Promise<void>((r) => stall.listen(0, "127.0.0.1", r));
    cleanups.push(() => {
      for (const s of stallSockets) s.destroy();
      return new Promise<void>((r) => stall.close(() => r()));
    });
    const stallPort = (stall.address() as AddressInfo).port;

    const proxy = await startProxy(true, async () => ["127.0.0.1"], 200);
    const res = await getThroughProxy(
      proxy.port,
      `http://stall.test:${stallPort}/`,
    );
    expect(res.status).toBe(504);
  });
});

describe("BrowserProxy SSRF enforcement (CONNECT tunnel)", () => {
  test("refuses CONNECT to a blocked host with 403", async () => {
    const proxy = await startProxy(false, async () => ["169.254.169.254"]);
    const { statusLine, socket } = await connectThroughProxy(
      proxy.port,
      "metadata.test:443",
    );
    cleanups.push(() => socket.destroy());
    expect(statusLine).toContain("403");
  });

  test("establishes a CONNECT tunnel to an allowed host", async () => {
    // A TCP echo fixture stands in for an origin server.
    const echo: TcpServer = createTcpServer((sock) => sock.pipe(sock));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => echo.close(() => r())));
    const echoPort = (echo.address() as AddressInfo).port;

    const proxy = await startProxy(true, async () => ["127.0.0.1"]);
    const { statusLine, socket } = await connectThroughProxy(
      proxy.port,
      `origin.test:${echoPort}`,
    );
    cleanups.push(() => socket.destroy());
    expect(statusLine).toContain("200");

    // The tunnel is now raw bytes to the echo server.
    const echoed = await new Promise<string>((resolve) => {
      socket.removeAllListeners("data");
      socket.on("data", (c: string) => resolve(c.toString()));
      socket.write("ping");
    });
    expect(echoed).toBe("ping");
  });
});

describe("BrowserProxy takeBlockReason", () => {
  test("records and consumes a block reason for the host", async () => {
    const proxy = await startProxy(false, async () => ["10.0.0.9"]);
    await getThroughProxy(proxy.port, "http://blocked.test:80/");
    const reason = proxy.takeBlockReason("blocked.test");
    expect(reason).toBeDefined();
    expect(reason).toContain("10.0.0.9");
    // Consumed — a second read is empty.
    expect(proxy.takeBlockReason("blocked.test")).toBeUndefined();
  });

  test("matches an IPv6-literal block record despite bracket forms", async () => {
    // A blocked plain-HTTP IPv6 target is recorded under the bracketed host
    // "[::1]"; navigate() consults it with the same bracketed hostname. Record
    // and consume must normalize identically or navigate() fails open.
    const proxy = await startProxy(false, async () => ["::1"]);
    const res = await getThroughProxy(proxy.port, "http://[::1]:80/");
    expect(res.status).toBe(403);
    expect(proxy.takeBlockReason("[::1]")).toBeDefined();
  });
});
