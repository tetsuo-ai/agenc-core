import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createConnectedAgenCJsonLineDaemonTuiClient } from "../../src/app-server/agent-cli.js";
import { AgenCUnixSocketServer } from "../../src/app-server/transport/unix-socket.js";

vi.mock("../../src/app-server/startup-restore-progress.js", async original => {
  const actual = await original<typeof import("../../src/app-server/startup-restore-progress.js")>();
  return { ...actual, createStartupRestoreWait: (options: Parameters<typeof actual.createStartupRestoreWait>[0]) =>
    actual.createStartupRestoreWait({ ...options, timeoutMs: 60 }) };
});

it("cancels only the timed-out restore request and keeps the connection usable", async () => {
  const home = await mkdtemp(join(tmpdir(), "agenc-restore-client-"));
  const socketPath = join(home, "daemon.sock");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const cancellations: unknown[] = [];
  const server = new AgenCUnixSocketServer({ socketPath, onMessage: async (message, context) => {
    if (message.method === "initialize") {
      await context.send({ jsonrpc: "2.0", id: message.id, result: { type: "initialized", protocolVersion: "1.1.0", capabilities: {} } });
    } else if (message.method === "agent.create") {
      await context.send({ jsonrpc: "2.0", method: "event.startup_restore", params: { requestId: message.id, remaining: 193 } });
    } else {
      if (message.method === "request.cancel") cancellations.push(message.params);
      await context.send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
    }
  } });
  await server.listen();
  const client = await createConnectedAgenCJsonLineDaemonTuiClient({ socketPath, authCookie: "test", timeoutMs: 500 });
  try {
    await expect(client.request("agent.create", { resumeSessionId: "old" })).rejects.toThrow("Timed out reopening the session");
    await vi.waitFor(() => expect(cancellations).toEqual([{ requestId: 2, reason: "startup session restore timeout" }]));
    expect(stderr).toHaveBeenCalledWith("Reopening 193 sessions...\n");
    await expect(client.request("health.ping")).resolves.toEqual({ ok: true });
  } finally {
    stderr.mockRestore();
    await client.close();
    await server.close();
    await rm(home, { recursive: true, force: true });
  }
});
