import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("ws", async () => (await import("./helpers/legacy-bridge.js")).fakeWsModule());
import { captureRemoteCliRuntimeContext, runRemoteSlash, startRemoteOn } from "../../src/bin/remote-cli.js";
import { fakeSockets, pairStartResponse } from "./helpers/legacy-bridge.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); fakeSockets.length = 0; vi.restoreAllMocks(); vi.useRealTimers(); });
async function fixture() {
  vi.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "legacy-stop-"));
  const context = captureRemoteCliRuntimeContext(Object.freeze({ AGENC_HOME: home, AGENC_REMOTE_AUTH_TOKEN: "fixture-token", AGENC_REMOTE_FULL_CONTROL: "1" }));
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async () => pairStartResponse());
  cleanups.push(async () => { await runRemoteSlash("off", context); rmSync(home, { recursive: true, force: true }); });
  await startRemoteOn(context);
  return { home, context, fetcher };
}
describe("legacy remote revocation", () => {
  it("checks the cross-process stop marker before forwarding the next frame", async () => {
    const f = await fixture(); const socket = fakeSockets[0]!; socket.readyState = 1; socket.emit("open");
    writeFileSync(join(f.home, "remote", "stopped"), "another-process-revoked", { mode: 0o600 });
    socket.emit("message", JSON.stringify({ t: "data", cid: "phone", payload: JSON.stringify({ jsonrpc: "2.0", id: "request", method: "initialize", params: {} }) }));
    expect(socket.readyState).toBe(3); expect(fakeSockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000); expect(fakeSockets).toHaveLength(1);
  });
  it("off invalidates a ticket refresh that resolves after the bridge closed", async () => {
    const f = await fixture(); let resolve!: (response: Response) => void;
    f.fetcher.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    fakeSockets[0]!.terminate();
    await runRemoteSlash("off", f.context);
    resolve(pairStartResponse()); await vi.advanceTimersByTimeAsync(10_000);
    expect(fakeSockets).toHaveLength(1);
  });
});
