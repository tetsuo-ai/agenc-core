import { Duplex, PassThrough } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { bridgeDaemonProxy, daemonProxyEnvironment, decodeDaemonProxyHome, parseAgenCDaemonProxyCliArgs } from "../../src/bin/daemon-proxy-cli.js";
import { validateDisplayBlock } from "../../src/mcp-client/display-attachments.js";
import { daemonEventFromUnboundSessionEvent, notificationFromDaemonEvent } from "../../src/app-server/background-agent-runner/daemon-events.js";
import { mkSession } from "../fixtures.js";

function fixture() {
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  const forwarded: Record<string, unknown>[] = [];
  const socket = new Duplex({ read() {}, write(chunk: Buffer, _encoding, callback) {
    forwarded.push(JSON.parse(chunk.toString())); callback();
  } });
  let stdout = "", stderr = "";
  output.on("data", (chunk) => { stdout += String(chunk); });
  error.on("data", (chunk) => { stderr += String(chunk); });
  const send = (value: unknown) => input.write(JSON.stringify(value) + "\n");
  const respond = (value: unknown) => socket.push(JSON.stringify(value) + "\n");
  return { input, output, error, socket, forwarded, send, respond, stdout: () => stdout, stderr: () => stderr };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const cookie = "a".repeat(64);

describe("daemon SSH proxy", () => {
  it("matches only the explicit daemon proxy command", () => {
    expect(parseAgenCDaemonProxyCliArgs(["daemon", "status"])).toBeNull();
    expect(parseAgenCDaemonProxyCliArgs(["daemon", "proxy", "--stdio"])).toEqual({ mode: "stdio" });
    expect(parseAgenCDaemonProxyCliArgs(["daemon", "proxy", "--stdio", "--unsafe"])).toBe("help");
  });
  it("decodes canonical shell-safe absolute homes for each remote platform", () => {
    const encode = (value: string) => Buffer.from(value).toString("base64url");
    for (const [platform, path] of [["darwin", "/Users/test/Core home"], ["linux", "/home/test/core"], ["win32", "C:\\Users\\test\\Core home"], ["win32", "\\\\server\\share\\core"]] as const) {
      expect(decodeDaemonProxyHome(encode(path), platform)).toBe(path);
      expect(parseAgenCDaemonProxyCliArgs(["daemon", "proxy", "--stdio", "--home-b64", encode(path)], platform)).toEqual({ mode: "stdio", coreHome: path });
    }
    for (const path of ["relative", "C:relative", "\\root-relative", "\\\\?\\C:\\core", "\\\\.\\pipe\\daemon", "//?/C:/core", "//./pipe/daemon", "\\/?\\C:\\core", "/\\.\\pipe\\daemon"]) expect(decodeDaemonProxyHome(encode(path), "win32")).toBeNull();
    for (const path of ["relative", "~/core", "/core\u0000", "/core\nother", "/" + "x".repeat(4097)]) expect(decodeDaemonProxyHome(encode(path), "linux")).toBeNull();
    for (const encoded of ["", "L2E=", "L2F", "L2E;echo", Buffer.from([0x2f, 0xff]).toString("base64url")]) expect(decodeDaemonProxyHome(encoded, "linux")).toBeNull();
    expect(parseAgenCDaemonProxyCliArgs(["daemon", "proxy", "--stdio", "--home-b64", "invalid"], "linux")).toBe("help");
  });
  it("scopes the saved home to a fresh environment without mutating process state", () => {
    const original = { AGENC_HOME: "/original", PATH: "/bin" };
    expect(daemonProxyEnvironment(original, { mode: "stdio", coreHome: "/selected" })).toEqual({ AGENC_HOME: "/selected", PATH: "/bin" });
    expect(original.AGENC_HOME).toBe("/original");
    expect(daemonProxyEnvironment(original, { mode: "stdio" })).toEqual(original);
    expect(daemonProxyEnvironment(original, { mode: "stdio" })).not.toBe(original);
  });
  it("injects the remote local cookie without returning it and preserves responses/notifications", async () => {
    const f = fixture();
    const result = bridgeDaemonProxy(f.socket, cookie, f);
    f.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { authCookie: "client-forgery", clientName: "Desktop" } });
    expect(f.forwarded[0]).toMatchObject({ params: { authCookie: cookie } });
    f.respond({ jsonrpc: "2.0", id: 1, result: { protocol: { version: "1.2" } } });
    await flush();
    f.send({ jsonrpc: "2.0", id: 2, method: "session.list", params: {} });
    expect(f.forwarded[1]).toMatchObject({ method: "session.list" });
    f.respond({ jsonrpc: "2.0", id: 2, result: { sessions: [] } });
    f.respond({ jsonrpc: "2.0", method: "event.permission_request", params: { sessionId: "task-1", requestId: "request-1" } });
    await flush();
    f.input.end(); expect(await result).toBe(0);
    expect(f.stdout()).toContain("event.permission_request");
    expect(f.stdout()).not.toContain(cookie);
    expect(f.stderr()).toBe("");
  });
  it("forwards every chunk of a session artifact within the SSH frame limit", async () => {
    const f = fixture();
    const result = bridgeDaemonProxy(f.socket, cookie, f);
    f.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocol: { version: "1.18.0" } } });
    f.respond({ jsonrpc: "2.0", id: 1, result: { protocol: { version: "1.18.0" } } });
    await flush();
    const bytes = Buffer.alloc(700_000, 0x61);
    const id = "b".repeat(64);
    const received: Buffer[] = [];
    for (let offset = 0, requestId = 2; offset < bytes.length; requestId++) {
      f.send({ jsonrpc: "2.0", id: requestId, method: "session.artifact.read", params: { sessionId: "session-1", id, offset, length: 512 * 1024 } });
      expect(f.forwarded.at(-1)).toMatchObject({ method: "session.artifact.read", params: { sessionId: "session-1", id, offset } });
      const end = Math.min(offset + 512 * 1024, bytes.length);
      const frame = { jsonrpc: "2.0", id: requestId, result: { sessionId: "session-1", id, encoding: "base64", data: bytes.subarray(offset, end).toString("base64"), size: bytes.length, offset, nextOffset: end < bytes.length ? end : null } };
      expect(Buffer.byteLength(JSON.stringify(frame) + "\n")).toBeLessThanOrEqual(1024 * 1024);
      f.respond(frame);
      await flush();
      const response = JSON.parse(f.stdout().trim().split("\n").at(-1)!) as typeof frame;
      received.push(Buffer.from(response.result.data, "base64"));
      offset = response.result.nextOffset ?? bytes.length;
    }
    expect(Buffer.concat(received)).toEqual(bytes);
    f.input.end();
    expect(await result).toBe(0);
    expect(f.stderr()).toBe("");
  });
  it("publishes three 450,000-byte tables live through the SSH bridge", async () => {
    const directory = mkdtempSync(join(tmpdir(), "display-live-ssh-"));
    try {
      const pending = await Promise.all([0, 1, 2].map(async (index) => {
        const table = { version: 1, title: `Table ${index}`, columns: [{ key: "value", label: "Value" }], rows: [{ value: "x".repeat(449_950) }] };
        const display = await validateDisplayBlock({ type: "resource", resource: { uri: `agenc:table-${index}`, mimeType: "application/vnd.agenc.table+json", text: JSON.stringify(table) } }, []);
        expect(display.attachment.size).toBeGreaterThanOrEqual(450_000);
        return display.attachment;
      }));
      const { session } = mkSession();
      session.rolloutStore = { store: { sessionDir: directory }, append: vi.fn(() => true) } as unknown as typeof session.rolloutStore;
      const completed = session.emit({ id: "complete", msg: { type: "tool_call_completed", payload: {
        callId: "call-1", result: "shown", isError: false, metadata: { displayAttachments: pending },
      } } });
      const projected = daemonEventFromUnboundSessionEvent(completed);
      expect(projected).not.toBeNull();
      const notification = notificationFromDaemonEvent("session-1", "agent-1", projected!);
      const f = fixture();
      const result = bridgeDaemonProxy(f.socket, cookie, f);
      f.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocol: { version: "1.18.0" } } });
      f.respond({ jsonrpc: "2.0", id: 1, result: { protocol: { version: "1.18.0" } } });
      await flush();
      f.respond(notification);
      await flush();
      f.input.end();
      expect(await result).toBe(0);
      expect(f.stderr()).toBe("");
      const received = JSON.parse(f.stdout().trim().split("\n").at(-1)!) as typeof notification;
      expect(received.params.event.payload.displayAttachments).toHaveLength(3);
      expect(received.params.event.payload.displayAttachments.every((item: { data?: unknown }) => item.data === undefined)).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(notification) + "\n")).toBeLessThanOrEqual(1024 * 1024);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("requires initialization, rejects credential/settings methods, and bounds unterminated input", async () => {
    const before = fixture(); const beforeResult = bridgeDaemonProxy(before.socket, cookie, before);
    before.send({ jsonrpc: "2.0", id: 1, method: "session.list" });
    expect(before.forwarded).toHaveLength(0); expect(before.stdout()).toContain("Initialize");
    before.send({ jsonrpc: "2.0", id: 2, method: "auth.status" });
    expect(await beforeResult).toBe(1); expect(before.stderr()).toContain("REQUEST_DENIED");
    const large = fixture(); const largeResult = bridgeDaemonProxy(large.socket, cookie, large);
    large.input.write("x".repeat(1024 * 1024 + 1));
    expect(await largeResult).toBe(1); expect(large.stderr()).toContain("FRAME_LIMIT");
  });
  it("fails closed if the daemon echoes the cookie", async () => {
    const f = fixture(); const result = bridgeDaemonProxy(f.socket, cookie, f);
    f.respond({ jsonrpc: "2.0", id: 1, error: { message: cookie } });
    expect(await result).toBe(1); expect(f.stdout()).not.toContain(cookie); expect(f.stderr()).not.toContain(cookie);
  });
});
