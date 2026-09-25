import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTick } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgencSocketTransport } from "../../../packages/agenc-sdk/src/socket";

function startPendingRequests(transport: AgencSocketTransport) {
  const requests = [
    transport.request({
      jsonrpc: "2.0", id: "send", method: "message.send",
      params: { sessionId: "session", content: "test" },
    }),
    transport.request({
      jsonrpc: "2.0", id: "stream", method: "message.stream",
      params: { sessionId: "session", content: "test", streamId: "stream" },
    }),
    transport.request({ jsonrpc: "2.0", id: "control", method: "health.ping", params: {} }),
  ];
  const outcomes: Array<{ status: string; value: unknown }> = [];
  const settled = Promise.all(requests.map((request) => request.then(
    (value) => { outcomes.push({ status: "resolved", value }); },
    (error: unknown) => { outcomes.push({ status: "rejected", value: error }); },
  )));
  return { outcomes, settled };
}

describe("SDK socket protocol failures", () => {
  let transport: AgencSocketTransport;
  let server: Server;
  let peer: Socket;
  let root: string;
  let socketPath: string;
  let onClose: ReturnType<typeof vi.fn>;
  let onNotification: ReturnType<typeof vi.fn>;

  async function connect(requestTimeoutMs: number): Promise<void> {
    const accepted = once(server, "connection");
    transport = await AgencSocketTransport.connect({
      socketPath, requestTimeoutMs, onClose, onNotification,
    });
    [peer] = await accepted;
    peer.on("error", () => {});
    peer.resume();
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-sdk-protocol-"));
    socketPath = process.platform === "win32"
      ? `\\\\.\\pipe\\agenc-sdk-protocol-${randomUUID()}`
      : join(root, "daemon.sock");
    server = createServer();
    server.listen(socketPath);
    await once(server, "listening");
    onClose = vi.fn();
    onNotification = vi.fn();
    await connect(5000);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await transport?.close();
    peer?.destroy();
    if (server !== undefined) await new Promise<void>((resolve) => server.close(() => resolve()));
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  });

  it("reassembles a 13 MiB display artifact from bounded socket responses", async () => {
    const bytes = randomBytes(13 * 1024 * 1024);
    const digest = createHash("sha256").update(bytes).digest("hex");
    let input = "";
    peer.on("data", (chunk: Buffer) => {
      input += chunk.toString("utf8");
      for (;;) {
        const newline = input.indexOf("\n");
        if (newline < 0) break;
        const request = JSON.parse(input.slice(0, newline)) as { id: string; method: string; params: { offset: number } };
        input = input.slice(newline + 1);
        expect(request.method).toBe("session.artifact.read");
        const offset = request.params.offset;
        const end = Math.min(bytes.length, offset + 512 * 1024);
        const frame = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
          sessionId: "session", id: digest, encoding: "base64", data: bytes.subarray(offset, end).toString("base64"),
          size: bytes.length, offset, nextOffset: end < bytes.length ? end : null,
        } }) + "\n";
        expect(Buffer.byteLength(frame)).toBeLessThan(1024 * 1024);
        peer.write(frame);
      }
    });
    const chunks: Buffer[] = [];
    let offset = 0;
    for (let index = 0;; index += 1) {
      const response = await transport.request({ jsonrpc: "2.0", id: `chunk-${index}`, method: "session.artifact.read", params: { sessionId: "session", id: digest, offset } });
      const result = response.result as { data: string; nextOffset: number | null };
      chunks.push(Buffer.from(result.data, "base64"));
      if (result.nextOffset === null) break;
      offset = result.nextOffset;
    }
    expect(createHash("sha256").update(Buffer.concat(chunks)).digest("hex")).toBe(digest);
    expect(onClose).not.toHaveBeenCalled();
  }, 60_000);

  it.each([
    "{malformed",
    "null",
    "[]",
    "42",
    '"text"',
    "true",
    "{}",
    '{"jsonrpc":"2.0","id":"send"}',
    '{"jsonrpc":"2.0","id":"send","result":{},"error":{"code":-32000,"message":"bad"}}',
    '{"jsonrpc":"2.0","id":"send","error":"bad"}',
    '{"jsonrpc":"2.0","id":"send","error":{"code":"bad","message":"bad"}}',
    '{"jsonrpc":"2.0","id":"send","error":{"code":-32000}}',
    '{"jsonrpc":"2.0","id":null,"result":{}}',
    '{"jsonrpc":"2.0","id":true,"result":{}}',
    '{"jsonrpc":"2.0","method":123}',
    '{"jsonrpc":"2.0","method":"event.test","params":null}',
    '{"jsonrpc":"2.0","id":"send","method":"event.test","params":{}}',
    '{"jsonrpc":"1.0","id":"send","result":{}}',
  ])("rejects every pending request after the invalid complete frame %s", async (line) => {
    const pending = startPendingRequests(transport);
    peer.write(`${line}\n`);
    await vi.waitFor(() => expect(pending.outcomes).toHaveLength(3));
    await pending.settled;
    expect(pending.outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    const failure = pending.outcomes[0]?.value;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/daemon.*(?:malformed|invalid).*frame/i);
    expect(pending.outcomes.every((outcome) => outcome.value === failure)).toBe(true);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(failure);
    await vi.waitFor(() => expect(peer.destroyed).toBe(true));
    await expect(transport.request({ jsonrpc: "2.0", id: "later", method: "health.ping" }))
      .rejects.toThrow(/connection is closed/);
    await transport.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not dispatch trailing responses or notifications after a malformed frame", async () => {
    const pending = startPendingRequests(transport);
    peer.write('{invalid\n{"jsonrpc":"2.0","id":"send","result":{}}\n{"jsonrpc":"2.0","method":"event.test","params":{}}\n');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await pending.settled;
    expect(pending.outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(onNotification).not.toHaveBeenCalled();
  });

  it("does not copy sensitive frame contents into the protocol error", async () => {
    const pending = startPendingRequests(transport);
    peer.write('{"private":"sensitive-session-value",broken}\n');
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await pending.settled;
    const failure = pending.outcomes[0]?.value as Error;
    expect(failure.message).not.toContain("sensitive-session-value");
    expect(failure.cause).toBeUndefined();
  });

  it("rejects reentrant requests before invoking the close callback", async () => {
    const pending = startPendingRequests(transport);
    let reentrant: Promise<unknown> | undefined;
    onClose.mockImplementation(() => {
      reentrant = transport.request({ jsonrpc: "2.0", id: "reentrant", method: "message.send", params: { sessionId: "session", content: "test" } })
        .catch((error: unknown) => error);
    });
    peer.write("{invalid\n");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await pending.settled;
    expect(await reentrant).toEqual(expect.objectContaining({ message: "AgenC daemon connection is closed" }));
  });

  it("accepts fragmented UTF-8 responses and valid unknown notifications and IDs", async () => {
    const pending = startPendingRequests(transport);
    const notification = { jsonrpc: "2.0", method: "event.future", params: { text: "é🛰" } };
    peer.write(`${JSON.stringify(notification)}\n`);
    peer.write('{"jsonrpc":"2.0","id":"unknown","result":{}}\n');
    peer.write('{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"unmatched"}}\n');
    const frame = Buffer.from('{"jsonrpc":"2.0","id":"send","result":{"text":"é🛰"}}\n');
    const split = frame.indexOf(Buffer.from("🛰")) + 1;
    peer.write(frame.subarray(0, split));
    await nextTick();
    expect(pending.outcomes).toEqual([]);
    peer.write(frame.subarray(split));
    peer.write('{"jsonrpc":"2.0","id":"stream","result":{}}\n');
    peer.write('{"jsonrpc":"2.0","id":"control","error":{"code":-32000,"message":"expected"}}\n');
    await pending.settled;
    expect(pending.outcomes.every((outcome) => outcome.status === "resolved")).toBe(true);
    expect(pending.outcomes[0]?.value).toMatchObject({ result: { text: "é🛰" } });
    expect(onNotification).toHaveBeenCalledExactlyOnceWith(notification);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps incomplete frames pending until a newline completes them", async () => {
    const pending = startPendingRequests(transport);
    peer.write("{malformed");
    await nextTick();
    expect(pending.outcomes).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    peer.write("\n");
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    await pending.settled;
    expect(pending.outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
  });

  it("still rejects incomplete-buffer overflow and closes once", async () => {
    // 16 MiB has to cross a real socket before the overflow can be detected,
    // which can take seconds on a loaded machine. The requests must outlive
    // that wait, or their own timeout settles them first with another error.
    await transport.close();
    peer.destroy();
    onClose = vi.fn();
    onNotification = vi.fn();
    await connect(120_000);
    const overflowWait = { timeout: 60_000 } as const;
    const pending = startPendingRequests(transport);
    peer.write("x".repeat(16 * 1024 * 1024 + 1));
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1), overflowWait);
    await pending.settled;
    expect(pending.outcomes).toHaveLength(3);
    for (const outcome of pending.outcomes) {
      expect(outcome.status).toBe("rejected");
      expect((outcome.value as Error).message).toContain("exceeded 16777216 bytes");
    }
    await vi.waitFor(() => expect(peer.destroyed).toBe(true), overflowWait);
    await transport.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  }, 180_000);

  it("keeps deliberate local closure silent and settles pending work", async () => {
    const pending = startPendingRequests(transport);
    await transport.close();
    await pending.settled;
    await nextTick();
    expect(pending.outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("settles every request and notifies once when the peer closes", async () => {
    const pending = startPendingRequests(transport);
    peer.end();
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledExactlyOnceWith(null));
    await pending.settled;
    expect(pending.outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect((pending.outcomes[0]?.value as Error).message).toBe("AgenC daemon connection closed");
    await transport.close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("clears the pending control timer on protocol failure", async () => {
    vi.useFakeTimers();
    const closed = new Promise<void>((resolve) => { onClose.mockImplementation(resolve); });
    const pending = startPendingRequests(transport);
    expect(vi.getTimerCount()).toBe(1);
    peer.write("{invalid\n");
    await closed;
    await pending.settled;
    expect(vi.getTimerCount()).toBe(0);
    expect(pending.outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
  });

  it.each(["message.send", "message.stream"] as const)("keeps valid %s requests alive beyond the control timeout", async (method) => {
    vi.useFakeTimers();
    let settled = false;
    const result = transport.request({
      jsonrpc: "2.0", id: "long-turn", method,
      params: { sessionId: "session", content: "test", streamId: "stream" },
    });
    void result.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(settled).toBe(false);
    vi.useRealTimers();
    peer.write('{"jsonrpc":"2.0","id":"long-turn","result":{}}\n');
    await expect(result).resolves.toMatchObject({ id: "long-turn", result: {} });
    expect(onClose).not.toHaveBeenCalled();
  });
});
