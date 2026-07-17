import net from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createAllowlistProxy,
  isIpLiteral,
  parseSni,
} from "../../scripts/eval-allowlist-proxy.mjs";

// Tier-1 security core tests for the phase-2b egress proxy. Pure loopback, no
// docker, no network. Prove the deny-by-default allowlist blocks github and
// everything except the exact allowed host:port, and that the deny happens
// before any DNS resolution.

const ALLOW_HOST = "api.provider.test";
const ALLOW_PORT = "443";

interface Upstream {
  readonly port: number;
  readonly received: Buffer[];
  close(): Promise<void>;
}

/** A loopback stand-in for the pinned provider IP: echoes what it receives. */
function startUpstream(): Promise<Upstream> {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk) => {
      received.push(chunk);
      socket.write(Buffer.concat([Buffer.from("ECHO:"), chunk]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        received,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Craft a minimal but well-formed TLS ClientHello carrying the given SNI. */
function buildClientHello(sni: string): Buffer {
  const nameBuf = Buffer.from(sni, "ascii");
  const serverNameList = Buffer.concat([
    Buffer.from([0x00]), // host_name
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(nameBuf.length); return b; })(),
    nameBuf,
  ]);
  const sniExtData = Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(serverNameList.length); return b; })(),
    serverNameList,
  ]);
  const sniExt = Buffer.concat([
    Buffer.from([0x00, 0x00]), // extension type: server_name
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(sniExtData.length); return b; })(),
    sniExtData,
  ]);
  const extensions = Buffer.concat([
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(sniExt.length); return b; })(),
    sniExt,
  ]);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]), // client_version TLS1.2
    Buffer.alloc(32), // random
    Buffer.from([0x00]), // session_id length 0
    Buffer.from([0x00, 0x02, 0x13, 0x01]), // cipher_suites: len 2 + one suite
    Buffer.from([0x01, 0x00]), // compression_methods: len 1 + null
    extensions,
  ]);
  const handshake = Buffer.concat([
    Buffer.from([0x01]), // ClientHello
    (() => { const b = Buffer.alloc(3); b.writeUIntBE(body.length, 0, 3); return b; })(),
    body,
  ]);
  return Buffer.concat([
    Buffer.from([0x16, 0x03, 0x01]), // handshake record, TLS1.0 record version
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(handshake.length); return b; })(),
    handshake,
  ]);
}

interface ProxyHandle {
  readonly port: number;
  close(): Promise<void>;
}

async function startProxy(
  overrides: Partial<Parameters<typeof createAllowlistProxy>[0]>,
): Promise<ProxyHandle> {
  // The proxy dials pinIps[0]:allowPort; tests point both at the loopback
  // echo upstream, so no real :443 is needed.
  const server = createAllowlistProxy({
    allowHost: ALLOW_HOST,
    allowPort: ALLOW_PORT,
    pinIps: ["127.0.0.1"],
    sniTimeoutMs: 2_000,
    ...overrides,
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address ? address.port : 0,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** Send a raw CONNECT and return the status line + whether the tunnel opened. */
function sendConnect(
  proxyPort: number,
  authority: string,
  afterEstablished?: Buffer,
): Promise<{ status: string; tunneledEcho: string | null }> {
  return new Promise((resolve) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nhost: ${authority}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    let status = "";
    let established = false;
    let echo: string | null = null;
    const timer = setTimeout(() => finish(), 1_500);
    const finish = () => {
      clearTimeout(timer);
      socket.destroy();
      resolve({ status, tunneledEcho: echo });
    };
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!established && buf.includes(Buffer.from("\r\n\r\n"))) {
        established = true;
        status = buf.toString("latin1").split("\r\n")[0] ?? "";
        if (status.includes("200") && afterEstablished) {
          buf = Buffer.alloc(0); // tunnel bytes follow the status header
          socket.write(afterEstablished);
        } else {
          finish();
        }
      } else if (established) {
        const text = buf.toString("latin1");
        if (text.startsWith("ECHO:")) { echo = text; finish(); }
      }
    });
    socket.on("error", () => finish());
  });
}

describe("eval allowlist proxy (tier 1 security core)", () => {
  let upstream: Upstream;
  let proxy: ProxyHandle;

  beforeEach(async () => {
    upstream = await startUpstream();
    // Pin the proxy's upstream to the loopback echo server's port so the
    // "connect to pinned IP only" path is exercised without real 443.
    proxy = await startProxy({ allowPort: String(upstream.port) });
  });

  afterEach(async () => {
    await proxy.close();
    await upstream.close();
  });

  test("unit: SNI parser and IP-literal detector", () => {
    expect(parseSni(buildClientHello(ALLOW_HOST))).toBe(ALLOW_HOST);
    expect(parseSni(Buffer.from("not a tls record"))).toBeNull();
    expect(isIpLiteral("140.82.112.3")).toBe(true);
    expect(isIpLiteral("::1")).toBe(true);
    expect(isIpLiteral("api.provider.test")).toBe(false);
  });

  test("allowed host:port with matching SNI tunnels to the pinned upstream", async () => {
    const hello = buildClientHello(ALLOW_HOST);
    const result = await sendConnect(proxy.port, `${ALLOW_HOST}:${upstream.port}`, hello);
    expect(result.status).toContain("200");
    expect(result.tunneledEcho).toContain("ECHO:");
    expect(upstream.received.length).toBeGreaterThan(0);
  });

  test("github is denied 403 (default-deny, not a blocklist)", async () => {
    const result = await sendConnect(proxy.port, `github.com:${upstream.port}`);
    expect(result.status).toContain("403");
    expect(result.tunneledEcho).toBeNull();
    expect(upstream.received.length).toBe(0);
  });

  test("IP-literal authority is denied", async () => {
    const result = await sendConnect(proxy.port, `140.82.112.3:${upstream.port}`);
    expect(result.status).toContain("403");
  });

  test("wrong port on the allowed host is denied", async () => {
    const result = await sendConnect(proxy.port, `${ALLOW_HOST}:80`);
    expect(result.status).toContain("403");
  });

  test("a mismatched SNI on the allowed authority drops the tunnel", async () => {
    const hello = buildClientHello("api.github.com");
    const result = await sendConnect(proxy.port, `${ALLOW_HOST}:${upstream.port}`, hello);
    // CONNECT is accepted (200) but the SNI mismatch drops before upstream.
    expect(result.tunneledEcho).toBeNull();
    expect(upstream.received.length).toBe(0);
  });

  test("plain-HTTP absolute-form requests are forbidden", async () => {
    const status = await new Promise<string>((resolve) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        socket.write(`GET http://github.com/ HTTP/1.1\r\nhost: github.com\r\n\r\n`);
      });
      let buf = "";
      socket.on("data", (c) => { buf += c.toString("latin1"); if (buf.includes("\r\n")) { socket.destroy(); resolve(buf.split("\r\n")[0] ?? ""); } });
      socket.on("error", () => resolve(""));
    });
    expect(status).toContain("403");
  });

  test("a split ClientHello with a mismatched SNI is dropped (no single-segment bypass)", async () => {
    // Send a github-SNI ClientHello fragmented across writes. The proxy must
    // buffer the whole record and fail closed, not allow on the partial first
    // segment.
    const hello = buildClientHello("api.github.com");
    const received = await new Promise<number>((resolve) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        socket.write(`CONNECT ${ALLOW_HOST}:${upstream.port} HTTP/1.1\r\n\r\n`);
      });
      let established = false;
      const timer = setTimeout(() => { socket.destroy(); resolve(upstream.received.length); }, 1_200);
      socket.on("data", (chunk) => {
        if (!established && chunk.toString("latin1").includes("200")) {
          established = true;
          socket.write(hello.subarray(0, 1)); // one byte first
          setTimeout(() => socket.write(hello.subarray(1)), 60);
        }
      });
      socket.on("error", () => { clearTimeout(timer); resolve(upstream.received.length); });
    });
    expect(received).toBe(0);
  });

  test("a split ClientHello with the ALLOWED SNI still tunnels (buffering is correct)", async () => {
    const hello = buildClientHello(ALLOW_HOST);
    const echo = await new Promise<string | null>((resolve) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        socket.write(`CONNECT ${ALLOW_HOST}:${upstream.port} HTTP/1.1\r\n\r\n`);
      });
      let established = false;
      const timer = setTimeout(() => { socket.destroy(); resolve(null); }, 1_500);
      socket.on("data", (chunk) => {
        const text = chunk.toString("latin1");
        if (!established && text.includes("200")) {
          established = true;
          socket.write(hello.subarray(0, 5));
          setTimeout(() => socket.write(hello.subarray(5)), 50);
        } else if (established && text.startsWith("ECHO:")) {
          clearTimeout(timer); socket.destroy(); resolve(text);
        }
      });
      socket.on("error", () => { clearTimeout(timer); resolve(null); });
    });
    expect(echo).toContain("ECHO:");
  });

  test("a client RST after 200 does not crash the proxy (concurrent egress stays up)", async () => {
    await new Promise<void>((resolve) => {
      const socket = net.connect(proxy.port, "127.0.0.1", () => {
        socket.write(`CONNECT ${ALLOW_HOST}:${upstream.port} HTTP/1.1\r\n\r\n`);
      });
      socket.on("data", (chunk) => {
        if (chunk.toString("latin1").includes("200")) {
          socket.resetAndDestroy(); // RST instead of a ClientHello
          setTimeout(resolve, 100);
        }
      });
      socket.on("error", () => setTimeout(resolve, 100));
    });
    // The proxy must still be alive and enforcing: a fresh github probe → 403.
    const result = await sendConnect(proxy.port, `github.com:${upstream.port}`);
    expect(result.status).toContain("403");
  });

  test("REVERT-SENSITIVE: widening the allowlist to github makes it reachable", async () => {
    // If the deny is what blocks github, adding github to the allowlist must
    // flip the github probe from 403 to a tunnel. This fails if the block were
    // some artifact rather than the allowlist check.
    const widened = await startProxy(
      { allowHost: "github.com", allowPort: String(upstream.port) },
    );
    try {
      const hello = buildClientHello("github.com");
      const result = await sendConnect(widened.port, `github.com:${upstream.port}`, hello);
      expect(result.status).toContain("200");
      expect(result.tunneledEcho).toContain("ECHO:");
    } finally {
      await widened.close();
    }
  });
});
