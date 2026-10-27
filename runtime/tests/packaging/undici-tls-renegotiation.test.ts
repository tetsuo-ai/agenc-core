import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// GHSA-qrxm-fqhp-jwvm (CVE-2026-87018). A TLS 1.2 server could renegotiate
// with a CA-trusted certificate for another host. Node then fails the open
// socket with ERR_TLS_CERT_ALTNAME_INVALID, and undici before 8.12.2 asserted
// that code could never reach an established connection, so one hostile
// endpoint crashed the process. WebFetch, HTTP proxies, mTLS and the Qwen
// transport all dispatch through agents built by loadUndiciAgent().
const FIXED_UNDICI = [8, 12, 2] as const;

const runtimeRequire = createRequire(new URL("../../package.json", import.meta.url));
const dispatcherSource = new URL("../../src/llm/undici-dispatcher.ts", import.meta.url);

function isAtLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  for (const [index, floor] of minimum.entries()) {
    const part = parts[index] ?? 0;
    if (part !== floor) return part > floor;
  }
  return true;
}

describe("undici TLS renegotiation crash fix", () => {
  it("resolves undici 8.12.2 or later from the runtime package", () => {
    const { version } = runtimeRequire("undici/package.json") as { version: string };
    expect(isAtLeast(version, FIXED_UNDICI), `undici ${version} lacks the fix`).toBe(true);
  });

  it("rejects the request instead of crashing when an open connection fails its certificate check", () => {
    const code = `
      import { once } from 'node:events';
      import { createRequire } from 'node:module';
      import { connect, createServer } from 'node:net';
      globalThis.require = createRequire(${JSON.stringify(dispatcherSource.href)});
      const { loadUndiciAgent } = await import(${JSON.stringify(dispatcherSource.href)});
      setTimeout(() => { console.error('request never settled'); process.exit(2); }, 10_000).unref();
      let clientSocket;
      const serverSockets = new Set();
      const server = createServer(socket => {
        serverSockets.add(socket);
        socket.on('error', () => {});
        // The request arrived over an established connection. Fail that
        // socket with the error Node raises after a renegotiated certificate.
        socket.once('data', () => clientSocket.destroy(Object.assign(
          new Error("Hostname/IP does not match certificate's altnames"),
          { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
        )));
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address();
      const Agent = loadUndiciAgent();
      const agent = new Agent({
        connect(_options, callback) {
          const socket = connect(port, '127.0.0.1');
          const onError = error => callback(error, null);
          socket.once('error', onError);
          socket.once('connect', () => {
            socket.off('error', onError);
            clientSocket = socket;
            callback(null, socket);
          });
        },
      });
      try {
        await fetch('http://127.0.0.1:' + port + '/', { dispatcher: agent });
        console.log('unexpected response');
      } catch (error) {
        console.log('rejected ' + (error.cause?.code ?? error.code));
      }
      await agent.close();
      for (const socket of serverSockets) socket.destroy();
      server.close();
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("rejected ERR_TLS_CERT_ALTNAME_INVALID");
  });
});
