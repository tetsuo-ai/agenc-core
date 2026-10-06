import { EventEmitter, once } from "node:events";
import { createConnection } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { runAgenCDaemonCli, resolveAgenCDaemonSocketPath, resolveAgenCDaemonCookiePath, type AgenCDaemonCliHost } from "../../src/app-server/daemon-cli.js";
import { AGENC_DAEMON_PROTOCOL_VERSION } from "../../src/app-server/protocol/index.js";
const fixture = vi.hoisted(() => ({ home: "", workspace: "", errors: [] as string[], responses: [] as any[], replies: [] as string[], updates: [] as any[], token: "123:isolated_fake_token_123456789" }));
// Never consult the owner's native credentials or contact Telegram.
vi.mock("../../src/utils/secureStorage/native.js", async original => ({ ...await original<any>(), readNativeSecureStorage: () => ({}), readNativeSecureStorageAsync: async () => ({}), readNativeSecureStorageFresh: () => ({}) }));
vi.mock("../../src/gateway/owner-telegram-storage.js", async original => ({ ...await original<any>(), createOwnerTelegramStorage: () => {
  let record = { agentId: "fixture", name: "Fixture", instructions: "", workspacePath: fixture.workspace, ownerUserId: "456", ownerUsername: null, telegramIdentityId: "123", username: "fixture_bot", lastUpdateId: -1, tokenFingerprint: createHash("sha256").update(fixture.token).digest("hex") };
  return { load: () => null, agents: { load: () => [record], save: (next: any) => { record = next; }, token: () => fixture.token } };
} }));
vi.mock("../../src/gateway/owner-telegram.js", async original => {
  const actual = await original<any>();
  return { ...actual, OwnerTelegramService: class extends actual.OwnerTelegramService {
    constructor(options: any) { super({ ...options,
      createSession: async (...args: any[]) => { try { return await options.createSession(...args); } catch (error) { fixture.errors.push((error as Error).message); throw error; } },
      transport: () => ({ getMe: async () => ({ id: 123, username: "fixture_bot" }), getUpdates: async () => fixture.updates.splice(0), sendMessage: async (_chat: string, text: string) => { fixture.replies.push(text); return { message_id: 1 }; } }),
      createConnection: (access: any) => { const connection = options.createConnection(access); return { close: () => connection.close(), dispatch: async (message: any) => { const response = await connection.dispatch(message); if (message.method === "session.create") fixture.responses.push(response); return response; } }; },
    }); }
  } };
});
it("reproduces Telegram session creation through an isolated real daemon and fake transport", async () => {
  const root = realpathSync(mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "tg-repro-")));
  fixture.home = join(root, "home"); fixture.workspace = join(root, "workspace");
  mkdirSync(fixture.home); mkdirSync(fixture.workspace);
  writeFileSync(join(fixture.home, "config.toml"), 'config_version = 2\nmodel_provider = "deepseek"\nmodel = "deepseek-flash"\n');
  const env = { HOME: root, PWD: fixture.workspace, AGENC_HOME: fixture.home, AGENC_DAEMON_WEBSOCKET_PORT: "0" };
  const host: AgenCDaemonCliHost = { env, userHome: root, pid: 4101, entrypointPath: "/fixture/agenc.js", execPath: process.execPath,
    readCurrentRuntimeBuild: () => ({ runtimeVersion: "test", commit: "test", buildTime: "test" }), readProcessIdentity: pid => `fixture:${pid}`, isPidRunning: () => false,
    spawnDetachedDaemon: () => { throw Error("No spawn"); }, terminatePid: () => {}, sleep: async () => {} };
  let logs = "";
  const sink = { write: (chunk: any) => { logs += String(chunk); writeFileSync(join(root, "daemon.log"), logs); return true; } };
  const signal = new EventEmitter(); let ready = false;
  const running = runAgenCDaemonCli({ kind: "command", action: "run" }, { host, io: { stdout: sink, stderr: sink } as any, signalProcess: signal as any, beforeDaemonReady: async () => { ready = true; } });
  let socket: ReturnType<typeof createConnection> | undefined;
  try {
    await expect.poll(() => ready, { timeout: 20000 }).toBe(true);
    socket = createConnection(resolveAgenCDaemonSocketPath(env, root)); await once(socket, "connect");
    const responses: any[] = []; let buffer = ""; let id = 0;
    socket.on("data", data => { buffer += data; let end; while ((end = buffer.indexOf("\n")) >= 0) { responses.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); } });
    const rpc = async (method: string, params: any = {}) => { const requestId = ++id; socket!.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n"); await expect.poll(() => responses.find(r => r.id === requestId), { timeout: 20000 }).toBeDefined(); return responses.find(r => r.id === requestId); };
    expect((await rpc("initialize", { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, authCookie: readFileSync(resolveAgenCDaemonCookiePath(env, root), "utf8").trim() })).error).toBeUndefined();
    expect((await rpc("telegram.agents.start", { agentId: "fixture" })).error).toBeUndefined();
    fixture.updates.push({ update_id: 1, message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 456, type: "private" }, from: { id: 456 }, text: "hi" } });
    await expect.poll(() => fixture.responses.length, { timeout: 30000 }).toBe(1);
    console.log("EXACT TELEGRAM SESSION RESPONSE", JSON.stringify(fixture.responses[0]));
    console.log("EXACT FACTORY ERROR", JSON.stringify(fixture.errors));
    expect(fixture.responses[0].error.message).toBe("REMOTE_REQUEST_FAILED");
    expect(fixture.errors[0]).toContain("deepseek provider requires credentials. Set DEEPSEEK_API_KEY.");
    await expect.poll(() => fixture.replies.length).toBe(1);
    expect(fixture.replies[0]).toContain("No credential for deepseek");
    expect(logs).toContain(fixture.errors[0]);
    // Change the daemon default to a different uncredentialed provider. The
    // explicit Telegram choice must still bootstrap DeepSeek successfully.
    writeFileSync(join(fixture.home, "config.toml"), 'config_version = 2\nmodel_provider = "openai"\nmodel = "gpt-5.4"\n');
    expect((await rpc("daemon.reload")).error).toBeUndefined();
    expect((await rpc("telegram.agents.update", { agentId: "fixture", provider: "deepseek", model: "deepseek-flash" })).error).toBeUndefined();
    const secret = "isolated-provider-sentinel-no-network";
    expect((await rpc("telegram.agents.start", { agentId: "fixture", provider: "deepseek", envOverrides: { DEEPSEEK_API_KEY: secret } })).error).toBeUndefined();
    fixture.updates.push({ update_id: 2, message: { message_id: 2, date: Math.floor(Date.now() / 1000), chat: { id: 456, type: "private" }, from: { id: 456 }, text: "/new" } });
    await expect.poll(() => fixture.responses.length, { timeout: 20000 }).toBe(2);
    console.log("CREDENTIALED SESSION RESPONSE", JSON.stringify(fixture.responses[1]));
    expect(fixture.responses[1].error).toBeUndefined();
    expect(fixture.responses[1].result.sessionId).toEqual(expect.any(String));
    await expect.poll(() => fixture.replies.length).toBe(2);
    expect(fixture.replies[1]).toContain("New workspace session ready");
    // No provider inference request is made: /new only bootstraps a session.
    const scan = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) scan(path);
        else if (entry.isFile()) expect(readFileSync(path).includes(Buffer.from(secret)), path).toBe(false);
      }
    };
    scan(root);
    expect(logs).not.toContain(secret);
    // A missing workspace is a separate, actionable failure.
    renameSync(fixture.workspace, fixture.workspace + "-moved");
    fixture.updates.push({ update_id: 3, message: { message_id: 3, date: Math.floor(Date.now() / 1000), chat: { id: 456, type: "private" }, from: { id: 456 }, text: "/new" } });
    await expect.poll(() => fixture.replies.length).toBe(3);
    expect(fixture.replies[2]).toContain("workspace folder is unavailable");
  } catch (error) { console.log("DAEMON LOG", logs); throw error; } finally { socket?.destroy(); signal.emit("SIGTERM"); await running; rmSync(root, { recursive: true, force: true }); }
}, 60000);
