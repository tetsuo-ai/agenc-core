import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { McpHttpSseServerTransport } from "src/mcp-server/http-sse";
import { McpServerFramework } from "src/mcp-server/framework";

/**
 * gaphunt3 #22 regression: streamable-http sessions are created on an
 * `initialize` POST and were only ever removed by the OPTIONAL HTTP DELETE or
 * an `initialize` rollback. A client that POSTs and then disconnects (crash,
 * network drop, or a client that never opens a GET stream) leaked the
 * `McpHttpSseSession` — with its full McpServerFramework — into `#sessions`
 * forever. The fix arms an idle reaper for stream-less streamable-http sessions
 * so disconnects without a DELETE are bounded by an idle window rather than
 * relying on the optional DELETE.
 *
 * These tests use a real loopback HTTP server (the only way to drive the
 * private session lifecycle) but with a tiny `streamableIdleMs` so eviction is
 * observed without a real long sleep. `snapshots()` is the public window into
 * `#sessions`.
 */

function initializeBody(id = 1): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "initialize" });
}

function streamablePostHeaders(): Record<string, string> {
  return {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  ms = 1000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(message);
}

interface RunningServer {
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}

async function startServer(
  transport: McpHttpSseServerTransport,
): Promise<RunningServer> {
  const server = transport.createNodeServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

describe("gaphunt3 #22 — streamable-http session eviction on disconnect", () => {
  let transport: McpHttpSseServerTransport;
  let server: RunningServer;

  afterEach(async () => {
    await server.close();
  });

  it("evicts a streamable-http session whose client disconnects without a DELETE", async () => {
    transport = new McpHttpSseServerTransport({
      serverFactory: () =>
        new McpServerFramework({ serverInfo: { version: "1.0.0" } }),
      streamableIdleMs: 40,
    });
    server = await startServer(transport);

    // Client POSTs a valid `initialize` and gets a session id. This is a
    // non-SSE POST: no GET stream is ever opened.
    const initialize = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: streamablePostHeaders(),
      body: initializeBody(),
    });
    const sessionId = initialize.headers.get("mcp-session-id");
    expect(sessionId).toEqual(expect.any(String));
    expect(transport.snapshots()).toHaveLength(1);

    // Client disconnects without sending the optional HTTP DELETE — simulated
    // here by simply not issuing it. The idle reaper armed by the POST must
    // evict the now-idle, stream-less session.
    await waitFor(
      () => transport.snapshots().length === 0,
      "idle streamable-http session to be evicted after disconnect (no DELETE)",
    );
    expect(transport.snapshots()).toHaveLength(0);

    // A follow-up request for the evicted session id is rejected (session gone).
    const afterEviction = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: { ...streamablePostHeaders(), "mcp-session-id": sessionId! },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
    });
    expect(afterEviction.status).toBe(404);
  });

  it("does not evict within the idle grace window (protects clients between POSTs)", async () => {
    transport = new McpHttpSseServerTransport({
      serverFactory: () =>
        new McpServerFramework({ serverInfo: { version: "1.0.0" } }),
      // Large window so the session must survive the immediate post-POST tick.
      streamableIdleMs: 60_000,
    });
    server = await startServer(transport);

    const initialize = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: streamablePostHeaders(),
      body: initializeBody(),
    });
    expect(initialize.headers.get("mcp-session-id")).toEqual(expect.any(String));
    expect(transport.snapshots()).toHaveLength(1);

    // Give the event loop several turns; with a 60s grace window the session
    // must still be present (the reaper must NOT drop a client that is merely
    // idle between POSTs).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(transport.snapshots()).toHaveLength(1);
  });

  it("keeps an explicit DELETE working and cancels the pending idle reaper", async () => {
    transport = new McpHttpSseServerTransport({
      serverFactory: () =>
        new McpServerFramework({ serverInfo: { version: "1.0.0" } }),
      streamableIdleMs: 40,
    });
    server = await startServer(transport);

    const initialize = await fetch(`${server.baseUrl}/mcp`, {
      method: "POST",
      headers: streamablePostHeaders(),
      body: initializeBody(),
    });
    const sessionId = initialize.headers.get("mcp-session-id")!;
    expect(transport.snapshots()).toHaveLength(1);

    const deleted = await fetch(`${server.baseUrl}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sessionId },
    });
    expect(deleted.status).toBe(204);
    expect(transport.snapshots()).toHaveLength(0);

    // The reaper armed by the POST must have been cancelled by closeSession;
    // letting the idle window elapse must not throw or re-evict a missing
    // session (no late timer firing on a deleted entry).
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(transport.snapshots()).toHaveLength(0);
  });
});
