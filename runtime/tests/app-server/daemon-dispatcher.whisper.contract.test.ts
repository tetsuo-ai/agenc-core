import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { WhisperError, type WhisperService } from "../../src/audio/whisper.js";
import type { JsonObject } from "../../src/app-server/protocol/index.js";
import { BROWSER_METHODS } from "../../src/remote/access.js";
const status = { engine: "whisper.cpp" as const, optionsVersion: 1 as const, available: true, models: [{ id: "base" as const, installed: true, bytes: 147951465 }] };
function request(id: string, method: string, params: JsonObject = {}): JsonObject { return { jsonrpc: "2.0", id, method, params }; }
function fixture(whisper?: WhisperService) {
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: {} as never, ...(whisper ? { whisper } : {}) });
  return { dispatcher, connection: dispatcher.createConnection() };
}
function handlers(): WhisperService { return { status: vi.fn(async () => status), install: vi.fn(async () => status), transcribe: vi.fn(async () => ({ text: "hello", model: "base", provider: "local" })) }; }
async function initialize(connection: ReturnType<typeof fixture>["connection"]) { return connection.dispatch(request("init", "initialize", { protocol: { version: "1.10.0" } })); }
describe("local Whisper daemon RPC", () => {
  it("never adds audio to the browser remote grant surface", () => {
    for (const method of ["audio.whisper.status", "audio.whisper.install", "audio.whisper.transcribe"]) expect(BROWSER_METHODS).not.toContain(method);
  });
  it("denies every Whisper handler on a remote connection even if its boundary admits the method", async () => {
    const service = handlers(); const { dispatcher, connection: local } = fixture(service);
    const remote = dispatcher.createConnection({ remoteAccess: { authorize: async () => {}, allowsMethod: () => true, projection: () => ({}) } as never });
    try {
      await initialize(remote);
      for (const method of ["audio.whisper.status", "audio.whisper.install", "audio.whisper.transcribe"]) {
        expect(await remote.dispatch(request(method, method))).toHaveProperty("error");
      }
      expect(service.status).not.toHaveBeenCalled(); expect(service.install).not.toHaveBeenCalled(); expect(service.transcribe).not.toHaveBeenCalled();
    } finally { await remote.close(); await local.close(); await dispatcher.close(); }
  });
  it("does not let another local connection cancel an in-flight Whisper request", async () => {
    let observed: AbortSignal | undefined;
    const pending = vi.fn((_params: unknown, signal: AbortSignal) => { observed = signal; return new Promise<never>(() => {}); });
    const { dispatcher, connection } = fixture({ ...handlers(), install: pending });
    const other = dispatcher.createConnection();
    try {
      await initialize(connection); await initialize(other);
      const work = connection.dispatch(request("install", "audio.whisper.install", { model: "base" }));
      await vi.waitFor(() => expect(observed).toBeDefined());
      expect(await other.dispatch(request("cancel-other", "request.cancel", { requestId: "install" }))).toMatchObject({ result: { cancelled: false } });
      expect(observed?.aborted).toBe(false);
      await connection.dispatch(request("cancel-owner", "request.cancel", { requestId: "install" }));
      expect(await work).toMatchObject({ error: { data: { code: "REQUEST_CANCELLED" } } });
    } finally { await other.close(); await connection.close(); await dispatcher.close(); }
  });
  it("advertises only configured handlers and requires initialize", async () => {
    const enabled = fixture(handlers()); const disabled = fixture();
    try {
      expect(await enabled.connection.dispatch(request("early", "audio.whisper.status"))).toHaveProperty("error");
      expect(await initialize(enabled.connection)).toMatchObject({ result: { capabilities: { "daemon.methods": { "audio.whisper.status": true, "audio.whisper.install": true, "audio.whisper.transcribe": true } } } });
      expect(await initialize(disabled.connection)).toMatchObject({ result: { capabilities: { "daemon.methods": { "audio.whisper.status": false } } } });
      expect(await disabled.connection.dispatch(request("status", "audio.whisper.status"))).toMatchObject({ error: { code: -32601 } });
      expect(await enabled.connection.dispatch(request("status", "audio.whisper.status"))).toMatchObject({ result: status });
    } finally { await enabled.connection.close(); await enabled.dispatcher.close(); await disabled.connection.close(); await disabled.dispatcher.close(); }
  });
  it.each(["audio.whisper.install", "audio.whisper.transcribe"])("cancels %s through request.cancel and disconnect", async (method) => {
    let observed: AbortSignal | undefined;
    const pending = vi.fn((_params: unknown, signal: AbortSignal) => { observed = signal; return new Promise<never>(() => {}); });
    const service = handlers(); const { connection, dispatcher } = fixture({ ...service, install: pending, transcribe: pending });
    try {
      await initialize(connection);
      const response = connection.dispatch(request("work", method, { model: "base" }));
      await vi.waitFor(() => expect(observed).toBeDefined());
      expect(await connection.dispatch(request("cancel", "request.cancel", { requestId: "work" }))).toMatchObject({ result: { cancelled: true } });
      expect(observed?.aborted).toBe(true); expect(await response).toMatchObject({ error: { data: { code: "REQUEST_CANCELLED" } } });
      observed = undefined;
      const second = connection.dispatch(request("work2", method, { model: "base" }));
      await vi.waitFor(() => expect(observed).toBeDefined());
      await connection.close(); expect(observed?.aborted).toBe(true); expect(await second).toHaveProperty("error");
    } finally { await connection.close(); await dispatcher.close(); }
  });
  it("returns structured validation errors and preserves empty no-speech results", async () => {
    const service = handlers(); const { connection, dispatcher } = fixture({ ...service, install: async () => { throw new WhisperError("WHISPER_INVALID_ARGUMENT", "Choose Base or Small"); }, transcribe: async () => ({ text: "", model: "base", provider: "local" }) });
    try {
      await initialize(connection);
      expect(await connection.dispatch(request("invalid", "audio.whisper.install", { model: "bad" }))).toMatchObject({ error: { code: -32602, data: { code: "WHISPER_INVALID_ARGUMENT" } } });
      expect(await connection.dispatch(request("silent", "audio.whisper.transcribe"))).toMatchObject({ result: { text: "", provider: "local" } });
    } finally { await connection.close(); await dispatcher.close(); }
  });
  it("preserves bounded transcription options and the status version over RPC", async () => {
    const service = handlers(); const { connection, dispatcher } = fixture(service);
    const params = { model: "base", language: "fr", task: "translate", compute: "cpu", prompt: "AgenC", audio: { mimeType: "audio/wav", data: "fixture" } };
    try {
      await initialize(connection);
      expect(await connection.dispatch(request("status-options", "audio.whisper.status"))).toMatchObject({ result: { optionsVersion: 1 } });
      expect(await connection.dispatch(request("install-options", "audio.whisper.install", { model: "base" }))).toMatchObject({ result: { optionsVersion: 1 } });
      await connection.dispatch(request("transcribe-options", "audio.whisper.transcribe", params));
      expect(service.transcribe).toHaveBeenCalledWith(params, expect.any(AbortSignal));
    } finally { await connection.close(); await dispatcher.close(); }
  });
});
