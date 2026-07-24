import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgencSocketTransport } from "../../../packages/agenc-sdk/src/socket";

describe.skipIf(process.platform === "win32")(
  "SDK socket transport request deadlines",
  () => {
    let transport: AgencSocketTransport | null = null;
    let server: Server | null = null;
    let serverSocket: Socket | null = null;
    let root: string | null = null;

    afterEach(async () => {
      vi.useRealTimers();
      await transport?.close();
      transport = null;
      serverSocket?.destroy();
      serverSocket = null;
      if (server !== null) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
      if (root !== null) {
        await rm(root, { recursive: true, force: true });
        root = null;
      }
    });

    it("keeps full-turn message RPCs alive for hours while control RPCs retain their timeout", async () => {
      root = await mkdtemp(join(tmpdir(), "agenc-sdk-socket-"));
      const socketPath = join(root, "daemon.sock");
      server = createServer((socket) => {
        serverSocket = socket;
        socket.on("error", () => {});
      });
      server.listen(socketPath);
      await once(server, "listening");

      transport = await AgencSocketTransport.connect({
        socketPath,
        requestTimeoutMs: 25,
      });
      expect(serverSocket).not.toBeNull();

      vi.useFakeTimers();
      let settled = false;
      const fullTurn = transport.request({
        jsonrpc: "2.0",
        id: "long-turn",
        method: "message.send",
        params: {
          sessionId: "session_1",
          content: "work for hours",
        },
      });
      void fullTurn.finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(settled).toBe(false);

      vi.useRealTimers();
      serverSocket!.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "long-turn",
          result: {
            messageId: "message_1",
            acceptedAt: "2026-07-24T00:00:00.000Z",
          },
        })}\n`,
      );
      await expect(fullTurn).resolves.toMatchObject({
        result: { messageId: "message_1" },
      });

      vi.useFakeTimers();
      const control = transport.request({
        jsonrpc: "2.0",
        id: "control",
        method: "health.ping",
        params: {},
      });
      const rejection = expect(control).rejects.toThrow(
        "Timed out waiting for daemon response to health.ping",
      );
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    });
  },
);
