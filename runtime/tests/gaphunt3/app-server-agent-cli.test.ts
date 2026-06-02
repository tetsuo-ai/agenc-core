import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createConnectedAgenCJsonLineDaemonTuiClient } from "src/app-server/agent-cli";
import { AgenCUnixSocketServer } from "src/app-server/transport/unix-socket";
import type { JsonObject, JsonValue } from "src/app-server/protocol/index";

// gaphunt3 #2: a daemon-backed TUI uses a stable clientId and transparently
// reconnects on a socket drop. The daemon multiplexer detaches every session
// route when the old socket closes, so the reconnect MUST re-issue
// `session.attach` on the new socket — otherwise the daemon has no route for
// the reconnected client and live session events are silently dropped even
// though the connection-state chip flips back to "connected".
//
// These tests model the real daemon's route-gating: a connection only receives
// broadcast session events after it has issued `session.attach`/`agent.attach`
// for that session. Before the fix the reconnected socket never re-attaches, so
// (1) the new connection receives no `session.attach`, and (2) the post-
// reconnect broadcast never reaches the TUI listener.

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

const SESSION_ID = "session_reattach";
const AGENT_ID = "agent_reattach";
const CLIENT_ID = "tui_reattach";

describe("gaphunt3 #2 reconnectable daemon TUI client re-attaches sessions", () => {
  it("re-issues session.attach with the stable clientId after a socket reconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-gaphunt3-reattach-"));
    const socketPath = join(dir, "daemon.sock");

    // Methods received by the *second* (post-reconnect) daemon connection.
    const secondConnectionMethods: string[] = [];
    // session.attach params seen by the second daemon connection.
    const secondConnectionAttachParams: JsonObject[] = [];

    const respondInitialize = async (
      message: JsonObject,
      context: { send(message: JsonValue): Promise<void> },
    ): Promise<void> => {
      await context.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          type: "initialized",
          protocolVersion: "1.0.0",
          capabilities: {},
        },
      });
    };

    // First daemon instance: handles the initial agent.attach.
    const firstServer = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        if (message.method === "initialize") {
          await respondInitialize(message, context);
          return;
        }
        if (message.method === "agent.attach") {
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              agentId: AGENT_ID,
              attachmentId: "attachment_1",
              sessionIds: [SESSION_ID],
            },
          });
        }
      },
    });

    await firstServer.listen();
    const client = await createConnectedAgenCJsonLineDaemonTuiClient({
      socketPath,
      authCookie: "reattach-cookie",
      timeoutMs: 200,
    });

    const received: JsonObject[] = [];
    const unsubscribe = client.subscribeToSessionEvents(SESSION_ID, (event) => {
      received.push(event);
    });

    try {
      // Establish the initial daemon-side attachment.
      await expect(
        client.request("agent.attach", {
          agentId: AGENT_ID,
          clientId: CLIENT_ID,
        }),
      ).resolves.toMatchObject({ sessionIds: [SESSION_ID] });

      // Drop the daemon socket and wait for the client to notice.
      await firstServer.close();
      await waitFor(
        () => client.getConnectionState().status === "disconnected",
        "client disconnect after first daemon close",
      );

      // Second daemon instance: it ONLY broadcasts session events to a
      // connection that has re-attached (mirrors client-multiplexer routing).
      let reattachedSend: ((event: JsonValue) => Promise<void>) | null = null;
      const secondServer = new AgenCUnixSocketServer({
        socketPath,
        onMessage: async (message, context) => {
          secondConnectionMethods.push(String(message.method));
          if (message.method === "initialize") {
            await respondInitialize(message, context);
            return;
          }
          if (message.method === "session.attach") {
            const params = (message.params ?? {}) as JsonObject;
            secondConnectionAttachParams.push(params);
            reattachedSend = (event) => context.send(event);
            await context.send({
              jsonrpc: "2.0",
              id: message.id,
              result: {
                sessionId: SESSION_ID,
                attachmentId: "attachment_2",
                attachedAt: "2026-05-01T12:00:01.000Z",
                clientId: CLIENT_ID,
                activeAttachmentIds: ["attachment_2"],
              },
            });
            return;
          }
          // A benign request used purely to drive the reconnect; its response
          // is unimportant to the assertions.
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: { agents: [] },
          });
        },
      });
      await secondServer.listen();

      try {
        // Any request forces ensureConnected() to reconnect + re-initialize.
        // The fix re-issues session.attach during that reconnect.
        await client.request("agent.list", {});

        await waitFor(
          () => secondConnectionAttachParams.length > 0,
          "session.attach replayed on the reconnected daemon connection",
        );

        // Revert assertion #1: the reconnected connection re-attached the
        // session with the stable clientId. Reverting the fix removes the
        // session.attach entirely.
        expect(secondConnectionMethods).toContain("session.attach");
        expect(secondConnectionAttachParams[0]).toEqual({
          sessionId: SESSION_ID,
          clientId: CLIENT_ID,
        });

        // Revert assertion #2: a post-reconnect broadcast actually reaches the
        // TUI listener, because the daemon now has a route for this client.
        const event: JsonObject = {
          jsonrpc: "2.0",
          method: "event.session_event",
          sessionId: SESSION_ID,
          params: { delta: "after-reconnect" },
        };
        expect(reattachedSend).not.toBeNull();
        await reattachedSend!(event);

        await waitFor(
          () =>
            received.some(
              (e) =>
                isJsonObject(e.params) &&
                e.params.delta === "after-reconnect",
            ),
          "post-reconnect session event delivered to the TUI listener",
        );
        expect(
          received.filter(
            (e) =>
              isJsonObject(e.params) && e.params.delta === "after-reconnect",
          ),
        ).toHaveLength(1);
      } finally {
        await secondServer.close();
      }
    } finally {
      unsubscribe();
      await client.close();
      await firstServer.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not replay session.attach for a session the client detached before reconnect", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-gaphunt3-detach-"));
    const socketPath = join(dir, "daemon.sock");
    const secondConnectionMethods: string[] = [];

    const respondInitialize = async (
      message: JsonObject,
      context: { send(message: JsonValue): Promise<void> },
    ): Promise<void> => {
      await context.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          type: "initialized",
          protocolVersion: "1.0.0",
          capabilities: {},
        },
      });
    };

    const firstServer = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        if (message.method === "initialize") {
          await respondInitialize(message, context);
          return;
        }
        if (message.method === "agent.attach") {
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              agentId: AGENT_ID,
              attachmentId: "attachment_1",
              sessionIds: [SESSION_ID],
            },
          });
          return;
        }
        if (message.method === "session.detach") {
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              sessionId: SESSION_ID,
              detached: true,
            },
          });
        }
      },
    });

    await firstServer.listen();
    const client = await createConnectedAgenCJsonLineDaemonTuiClient({
      socketPath,
      authCookie: "detach-cookie",
      timeoutMs: 200,
    });

    try {
      await client.request("agent.attach", {
        agentId: AGENT_ID,
        clientId: CLIENT_ID,
      });
      // The client intentionally leaves the session; reconnect must not
      // silently re-attach it.
      await client.request("session.detach", {
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
      });

      await firstServer.close();
      await waitFor(
        () => client.getConnectionState().status === "disconnected",
        "client disconnect after first daemon close",
      );

      const secondServer = new AgenCUnixSocketServer({
        socketPath,
        onMessage: async (message, context) => {
          secondConnectionMethods.push(String(message.method));
          if (message.method === "initialize") {
            await respondInitialize(message, context);
            return;
          }
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: { agents: [] },
          });
        },
      });
      await secondServer.listen();

      try {
        await client.request("agent.list", {});
        await waitFor(
          () => secondConnectionMethods.includes("agent.list"),
          "reconnected request reached the second daemon",
        );
        expect(secondConnectionMethods).not.toContain("session.attach");
      } finally {
        await secondServer.close();
      }
    } finally {
      await client.close();
      await firstServer.close().catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  });
});

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
