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

    it("keeps bounded long-running RPCs alive while control RPCs retain their timeout", async () => {
      // Darwin caps AF_UNIX paths at 104 bytes; the hermetic test HOME can be
      // much longer than that before this test's own suffix is appended.
      const socketTempRoot = process.platform === "darwin" ? "/tmp" : tmpdir();
      root = await mkdtemp(join(socketTempRoot, "agenc-sdk-socket-"));
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
      let transcriptionSettled = false;
      const transcription = transport.request({
        jsonrpc: "2.0",
        id: "long-transcription",
        method: "audio.transcribe",
        params: {
          preferredProvider: "local",
          audio: {
            data: "AAAA",
            mimeType: "audio/webm",
            fileName: "voice.webm",
          },
        },
      });
      void transcription.finally(() => {
        transcriptionSettled = true;
      });

      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(settled).toBe(false);
      expect(transcriptionSettled).toBe(false);

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
      serverSocket!.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "long-transcription",
          result: {
            text: "spoken words",
            model: "ggml-small.bin",
            provider: "local",
          },
        })}\n`,
      );
      await expect(transcription).resolves.toMatchObject({
        result: { text: "spoken words", provider: "local" },
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
