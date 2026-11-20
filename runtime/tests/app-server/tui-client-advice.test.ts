/**
 * The TUI runs /compact and /clear, so it is the one daemon client that
 * declares it in `initialize`: a turn it prompts may name them. Every other
 * client is told the same thing in plain words (session/turn-advice.ts).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createAgenCJsonLineDaemonClient,
  createConnectedAgenCJsonLineDaemonTuiClient,
} from "../../src/app-server/agent-cli.js";
import {
  AGENC_DAEMON_PROTOCOL_VERSION,
  AGENC_SLASH_COMMAND_ADVICE_CAPABILITY,
} from "../../src/app-server/protocol/index.js";
import { AgenCUnixSocketServer } from "../../src/app-server/transport/unix-socket.js";

describe("the TUI's daemon connection", () => {
  it("declares that it runs slash commands; Core's one-shot requests do not", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-tui-advice-"));
    const socketPath = join(dir, "daemon.sock");
    const initializations: Record<string, unknown>[] = [];
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        if (message.method === "initialize") {
          initializations.push((message.params ?? {}) as Record<string, unknown>);
          await context.send({ jsonrpc: "2.0", id: message.id, result: {
            type: "initialized",
            protocolVersion: AGENC_DAEMON_PROTOCOL_VERSION,
            protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION },
            capabilities: { "daemon.methods": { "agent.list": true } },
          } });
          return;
        }
        await context.send({ jsonrpc: "2.0", id: message.id, result: {} });
      },
    });
    await server.listen();
    const client = await createConnectedAgenCJsonLineDaemonTuiClient({ socketPath, authCookie: "test-cookie" });
    try {
      await createAgenCJsonLineDaemonClient({ socketPath, authCookie: "test-cookie" }).listAgents();
      expect(initializations.map((params) => [params.clientName, params.capabilities])).toEqual([
        ["agenc-agent-tui", { [AGENC_SLASH_COMMAND_ADVICE_CAPABILITY]: true }],
        ["agenc-agent-cli", {}],
      ]);
    } finally {
      await client.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
