/**
 * Protocol 1.35 adds a skill's settings (`skillInvocation`) to
 * `message.stream`. Both directions with AgenC Core 0.19.25 (protocol 1.34)
 * keep working:
 *
 * - this TUI and a 0.19.25 daemon: the TUI negotiates down to 1.34, sends the
 *   skill turn as 0.19.25 did (the old daemon refuses the whole request when
 *   the field is present) and tells the user the skill's settings need a
 *   daemon restart;
 * - a 0.19.25 TUI and this daemon: it negotiates 1.34 and its requests are
 *   accepted as before.
 *
 * The 0.19.25 side is the frozen copy in helpers/daemon-protocol-0.19.25.ts.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createConnectedAgenCJsonLineDaemonTuiClient } from "../../src/app-server/agent-cli.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  AGENC_MESSAGE_STREAM_SKILL_INVOCATION_CAPABILITY,
  JSON_RPC_VERSION,
} from "../../src/app-server/protocol/index.js";
import { AgenCUnixSocketServer } from "../../src/app-server/transport/unix-socket.js";
import {
  Daemon01925ParamsError,
  messageStreamFrom01925Tui,
  negotiate01925,
  PROTOCOL_0_19_25,
  validateMessageStream01925,
} from "../helpers/daemon-protocol-0.19.25.js";
import { createDaemonTuiSessionFixture } from "../helpers/daemon-tui-session.js";

const DEEP_REVIEW = {
  name: "deep-review",
  model: "deepseek-v4-pro",
  effort: "low",
  allowedTools: ["Write"],
} as const;

describe("skill invocations across the 0.19.25 protocol boundary", () => {
  it("this TUI drives a 0.19.25 daemon: protocol 1.34, the 0.19.25 request and a restart notice", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-skill-compat-"));
    const socketPath = join(dir, "daemon.sock");
    const initializeVersions: string[] = [];
    const streamed: Record<string, unknown>[] = [];
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        const params = (message.params ?? {}) as Record<string, unknown>;
        if (message.method === "initialize") {
          const version = String(
            (params.protocol as { version?: string } | undefined)?.version ??
              params.protocolVersion,
          );
          initializeVersions.push(version);
          const negotiated = negotiate01925(version);
          await context.send(negotiated.supported
            ? { jsonrpc: "2.0", id: message.id, result: {
                type: "initialized",
                protocolVersion: PROTOCOL_0_19_25,
                protocol: { version: PROTOCOL_0_19_25 },
                capabilities: { "daemon.methods": { "message.stream": true } },
              } }
            : { jsonrpc: "2.0", id: message.id, error: negotiated.error });
          return;
        }
        if (message.method === "message.stream") {
          try {
            validateMessageStream01925(params);
          } catch (error) {
            if (!(error instanceof Daemon01925ParamsError)) throw error;
            await context.send({ jsonrpc: "2.0", id: message.id,
              error: { code: -32602, message: error.message } });
            return;
          }
          streamed.push(params);
          await context.send({ jsonrpc: "2.0", id: message.id, result: {} });
          return;
        }
        await context.send({ jsonrpc: "2.0", id: message.id, result: {} });
      },
    });
    await server.listen();
    const client = await createConnectedAgenCJsonLineDaemonTuiClient({ socketPath, authCookie: "test-cookie" });
    const session = createDaemonTuiSessionFixture({
      baseSession: { conversationId: "session", services: {} }, sessionId: "session", clientId: "tui",
      client: {
        request: client.request,
        supportsMethod: client.supportsMethod,
        supportsCapability: client.supportsCapability,
        subscribeToSessionEvents: client.subscribeToSessionEvents,
      },
    });
    const events: unknown[] = [];
    const unsubscribe = session.subscribeToEvents((event) => events.push(event));
    try {
      expect(initializeVersions).toEqual([AGENC_DAEMON_PROTOCOL_VERSION, PROTOCOL_0_19_25]);
      expect(client.supportsCapability?.(AGENC_MESSAGE_STREAM_SKILL_INVOCATION_CAPABILITY)).toBe(false);

      await session.submit("review the diff", {
        displayUserMessage: "$deep-review",
        skillInvocation: DEEP_REVIEW,
      });

      expect(streamed).toHaveLength(1);
      expect(streamed[0]).not.toHaveProperty("skillInvocation");
      expect(streamed[0]).toMatchObject({ sessionId: "session", content: "review the diff" });
      expect(events.filter((event) =>
        (event as { payload?: { cause?: string } }).payload?.cause === "skill_settings_need_daemon_restart",
      )).toEqual([expect.objectContaining({
        type: "warning",
        payload: expect.objectContaining({
          message: expect.stringContaining("deep-review runs without its model, effort and allowed-tools"),
        }),
      })]);
    } finally {
      unsubscribe();
      await client.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("the 0.19.25 daemon refuses the field, which is why the TUI gates it", () => {
    expect(() => validateMessageStream01925({
      ...messageStreamFrom01925Tui("session"),
      skillInvocation: DEEP_REVIEW,
    })).toThrow("message.stream does not accept param 'skillInvocation'");
    expect(negotiate01925(AGENC_DAEMON_PROTOCOL_VERSION).supported).toBe(false);
  });

  it("a 0.19.25 TUI drives this daemon: protocol 1.34 and its message.stream are accepted", async () => {
    const streamAgentMessage = vi.fn(async () => ({
      disposition: "started",
      acceptedAt: "2026-10-31T00:00:00.000Z",
    }));
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { streamAgentMessage } as never,
    });
    const connection = dispatcher.createConnection();
    const initialized = await connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_0_19_25,
        protocol: { version: PROTOCOL_0_19_25 },
        clientName: "agenc-agent-tui",
        capabilities: {},
      },
    });
    expect(initialized).toMatchObject({
      result: {
        protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
        capabilities: { [AGENC_MESSAGE_STREAM_SKILL_INVOCATION_CAPABILITY]: true },
      },
    });

    const params = messageStreamFrom01925Tui("session");
    expect(() => validateMessageStream01925(params)).not.toThrow();
    await expect(connection.dispatch({
      jsonrpc: JSON_RPC_VERSION,
      id: "stream",
      method: "message.stream",
      params,
    })).resolves.toMatchObject({ result: { acceptedAt: "2026-10-31T00:00:00.000Z" } });
    expect(streamAgentMessage).toHaveBeenCalledOnce();
    expect(streamAgentMessage).toHaveBeenCalledWith(expect.not.objectContaining({
      skillInvocation: expect.anything(),
    }));
  });
});
