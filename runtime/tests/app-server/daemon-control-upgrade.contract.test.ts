import { createServer, type Socket } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgenCJsonLineDaemonRequestClient } from "../../src/app-server/agent-cli.js";
import {
  requestAgenCDaemonInstanceIdentity,
  requestAgenCDaemonShutdown,
  type AgenCDaemonCliHost,
} from "../../src/app-server/daemon-cli.js";
import { AGENC_DAEMON_PROTOCOL_VERSION, type JsonObject } from "../../src/app-server/protocol/index.js";

const identity = {
  pid: 4242, instanceId: "old-daemon-instance", processStart: "linux:boot:4242",
  runtimeVersion: "0.1.0", commit: "old-build", buildTime: "2026-09-11T00:00:00.000Z",
};

async function oldDaemon(options: { readonly mismatch?: boolean; readonly omitIdentity?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "agenc-control-upgrade-"));
  const cookie = "isolated-control-cookie";
  await writeFile(join(root, "daemon.cookie"), cookie, { mode: 0o600 });
  const requests: JsonObject[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "", authenticated = false;
    socket.setEncoding("utf8");
    socket.on("data", (data) => {
      buffer += data;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const request = JSON.parse(buffer.slice(0, end)) as JsonObject;
        buffer = buffer.slice(end + 1);
        requests.push(request);
        const params = request.params as JsonObject;
        let result: JsonObject | undefined;
        let error: JsonObject | undefined;
        if (request.method === "initialize") {
          const version = String(params.protocolVersion);
          // The real 1.12 daemon accepts older same-major protocol clients.
          const [major, minor] = version.split(".").map(Number);
          if (major !== 1 || minor! > 12) error = { code: -32000, message: "Unsupported protocol version" };
          else if (params.authCookie !== cookie) error = { code: -32000, message: "authentication failed" };
          else {
            authenticated = true;
            result = options.omitIdentity ? {} : { daemonIdentity: options.mismatch ? { ...identity, processStart: "another-generation" } : identity };
          }
        } else if (!authenticated) error = { code: -32000, message: "not initialized" };
        else if (request.method === "daemon.shutdown") result = { shuttingDown: true, instanceId: identity.instanceId };
        else error = { code: -32601, message: "unexpected control method" };
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(error ? { error } : { result }) }) + "\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(join(root, "daemon.sock"), resolve));
  const host: AgenCDaemonCliHost = {
    env: { AGENC_HOME: root }, userHome: root, entrypointPath: "/opt/agenc/bin/agenc.js", execPath: process.execPath,
    pid: process.pid, spawnDetachedDaemon: () => 0, isPidRunning: () => true, terminatePid: () => {}, sleep: async () => {},
  };
  return {
    root, host, requests,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("authenticated control across daemon protocol upgrades", () => {
  it("proves and stops a 1.12 daemon while normal session clients retain the new protocol", async () => {
    const old = await oldDaemon();
    try {
      expect(await requestAgenCDaemonInstanceIdentity(old.host)).toEqual(identity);
      await requestAgenCDaemonShutdown(old.host, identity);
      expect(old.requests.map((request) => request.method)).toEqual(["initialize", "initialize", "daemon.shutdown"]);
      expect(old.requests.filter((request) => request.method === "initialize").every((request) =>
        (request.params as JsonObject).protocolVersion === "1.0.0")).toBe(true);
      const client = createAgenCJsonLineDaemonRequestClient({ env: old.host.env, timeoutMs: 1_000 });
      await expect(client.request("agent.list", {})).rejects.toThrow("Unsupported protocol version");
      expect((old.requests.at(-1)?.params as JsonObject).protocolVersion).toBe(AGENC_DAEMON_PROTOCOL_VERSION);
    } finally { await old.close(); }
  });

  it("refuses shutdown before sending it when the authenticated process generation differs", async () => {
    const old = await oldDaemon({ mismatch: true });
    try {
      await expect(requestAgenCDaemonShutdown(old.host, identity)).rejects.toThrow("instance changed before shutdown");
      expect(old.requests.map((request) => request.method)).toEqual(["initialize"]);
    } finally { await old.close(); }
  });

  it.each(["wrong cookie", "missing identity"])("does not lower identity requirements for an old peer: %s", async (failure) => {
    const old = await oldDaemon({ omitIdentity: failure === "missing identity" });
    try {
      if (failure === "wrong cookie") await writeFile(join(old.root, "daemon.cookie"), "wrong-cookie");
      await expect(requestAgenCDaemonInstanceIdentity(old.host)).rejects.toThrow(failure === "wrong cookie" ? "authentication failed" : "valid instance identity");
      expect(old.requests.map((request) => request.method)).toEqual(["initialize"]);
    } finally { await old.close(); }
  });
});
