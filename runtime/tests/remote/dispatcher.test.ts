import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AGENC_DAEMON_PROTOCOL_VERSION, type JsonObject } from "../../src/app-server/protocol/index.js";
import { RemoteAccessBoundary } from "../../src/remote/access.js";
import { RemoteApprovalProjection } from "../../src/remote/approvals.js";
import type { RemoteService } from "../../src/remote/service.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const request = (method: string, params: JsonObject = {}): JsonObject => ({ jsonrpc: "2.0", id: method, method, params });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "remote-dispatch-"))); const workspace = join(root, "workspace"); const home = join(root, "private"); mkdirSync(workspace); mkdirSync(home);
  const authenticate = vi.fn((params: JsonObject) => params.authCookie === "fixture-cookie");
  const manage = vi.fn(async () => ({ enabled: false }));
  const agents = new AgenCDaemonAgentManager({ agencHome: home });
  const transcript = vi.spyOn(agents, "getSessionTranscriptV2").mockImplementation(async (params) => ({ schemaVersion: 2, sessionId: params.sessionId, runId: "run", historyEpoch: "epoch", asOfSequence: 0, messages: [] }));
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: agents, initializeAuthenticator: authenticate, remote: { handle: manage } as unknown as RemoteService });
  const connection = dispatcher.createConnection();
  const grant = { workspacePath: workspace, workspaceId: "opaque-id", sessionIds: ["allowed"], role: "control" as const, allowFiles: false, allowApprovals: true };
  let active = true;
  const projection = new RemoteApprovalProjection();
  const createSession = vi.fn(async () => ({ sessionId: "new-session", agentId: "new-agent" }));
  const boundary = new RemoteAccessBoundary(grant, () => active, async (sessionId) => ({ sessionId, cwd: workspace, title: "Title", apiKey: "private-key" }), home, { approvals: projection, createSession });
  const browser = dispatcher.createConnection({ remoteAccess: boundary, remoteCid: "peer" });
  cleanups.push(async () => { active = false; await browser.close(); await connection.close(); await dispatcher.close(); rmSync(root, { recursive: true, force: true }); });
  const initialize = { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, capabilities: { "portal.mobile.status.push.v1": true, "routine.updated.v1": true }, authCookie: "fixture-cookie" };
  return { browser, connection, initialize, authenticate, manage, transcript, boundary, projection, createSession, grant };
}

describe("Core browser dispatcher authority", () => {
  it("measures legacy transcript replies after remote envelope escaping", async () => {
    const f = fixture();
    await f.browser.dispatch(request("initialize", { protocol: { version: "1.17.0" } }));
    const message = { messageId: "answer", commitEventId: "answer", role: "assistant" as const, text: "A".repeat(800_000), committedSequence: 1 };
    f.transcript.mockResolvedValue({ schemaVersion: 2, sessionId: "allowed", runId: "run", historyEpoch: "epoch", asOfSequence: 1, messages: [message] });
    const fitting = await f.browser.dispatch(request("session.transcript.v2", { sessionId: "allowed" }));
    expect((fitting.result as { messages: typeof message[] }).messages[0]?.text).toBe(message.text);
    expect(Buffer.byteLength(JSON.stringify({ t: "data", cid: "peer", payload: JSON.stringify(fitting) }))).toBeLessThanOrEqual(1024 * 1024);
    f.transcript.mockResolvedValue({ schemaVersion: 2, sessionId: "allowed", runId: "run", historyEpoch: "epoch", asOfSequence: 1, messages: [{ ...message, text: "\n".repeat(400_000) }] });
    const tooLarge = await f.browser.dispatch(request("session.transcript.v2", { sessionId: "allowed" }));
    expect(tooLarge).toHaveProperty("error");
    expect(tooLarge).not.toHaveProperty("result");
  });
  it("requires authenticated initialization for local remote management", async () => {
    const f = fixture();
    await expect(f.connection.dispatch(request("remote.start"))).resolves.toMatchObject({ error: { data: { code: "CONNECTION_NOT_INITIALIZED" } } });
    await expect(f.connection.dispatch(request("initialize", { protocol: { version: AGENC_DAEMON_PROTOCOL_VERSION }, remoteAccess: { role: "control" } }))).resolves.toMatchObject({ error: { data: { code: "INVALID_ARGUMENT" } } });
    expect(f.manage).not.toHaveBeenCalled();
    await f.connection.dispatch(request("initialize", f.initialize));
    await expect(f.connection.dispatch(request("remote.start"))).resolves.toMatchObject({ result: { enabled: false } });
    expect(f.manage).toHaveBeenCalledWith("remote.start", {});
  });
  it("never authenticates browser cookies or registers broad client capabilities", async () => {
    const f = fixture(); const result = await f.browser.dispatch(request("initialize", f.initialize));
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(result).toMatchObject({ result: { capabilities: { "daemon.methods": { "remote.start": false, "auth.whoami": false, "session.applyConfig": false, "session.transcript.v2": true } } } });
    expect(f.browser.trackedClientIds).toEqual([]); expect(JSON.stringify(result)).not.toContain("fixture-cookie");
    for (const method of ["remote.start", "remote.approve", "telegram.configure", "telegram.start", "telegram.agents.list", "telegram.agents.create", "telegram.agents.pair.confirm", "telegram.agents.start", "auth.whoami", "session.applyConfig", "agent.attach"]) await expect(f.browser.dispatch(request(method))).resolves.toMatchObject({ error: { data: { code: "REMOTE_METHOD_DENIED" } } });
    expect(f.manage).not.toHaveBeenCalled();
  });
  it("filters history at Core, even if the browser knows another valid session ID", async () => {
    const f = fixture(); await f.browser.dispatch(request("initialize", f.initialize));
    await expect(f.browser.dispatch(request("session.transcript.v2", { sessionId: "other" }))).resolves.toMatchObject({ error: { data: { code: "REMOTE_SESSION_DENIED" } } });
    expect(f.transcript).not.toHaveBeenCalled();
    await expect(f.browser.dispatch(request("session.transcript.v2", { sessionId: "allowed" }))).resolves.toMatchObject({ result: { sessionId: "allowed" } });
    const result = await f.browser.dispatch(request("session.list")); expect(JSON.stringify(result)).not.toMatch(/private-key|apiKey|cwd/);
  });
  it("creates only through the trusted factory and adds that one session to the grant", async () => {
    const f = fixture(); await f.browser.dispatch(request("initialize", f.initialize));
    await expect(f.browser.dispatch(request("session.create", { title: "Work", provider: "malicious", cwd: "/elsewhere" }))).resolves.toMatchObject({ error: { data: { code: "REMOTE_SESSION_CREATE_INVALID" } } });
    expect(f.createSession).not.toHaveBeenCalled();
    await expect(f.browser.dispatch(request("session.create", { title: "Work" }))).resolves.toMatchObject({ result: { sessionId: "new-session", workspaceId: "opaque-id" } });
    expect(f.createSession).toHaveBeenCalledWith("Work"); expect(f.grant.sessionIds).toEqual(["allowed", "new-session"]);
  });
  it("shows scoped pending requests and removes canonical resolved decisions", async () => {
    const f = fixture(); await f.browser.dispatch(request("initialize", f.initialize));
    f.projection.observe("allowed", { method: "event.permission_request", params: { requestId: "request", toolName: "Read", input: { path: "src/file.ts", apiKey: "secret" }, permissions: [] } });
    f.projection.observe("other", { method: "event.permission_request", params: { requestId: "private-request", toolName: "Private", input: {}, permissions: [] } });
    const pending = await f.browser.dispatch(request("remote.pendingApprovals", { sessionId: "allowed" }));
    expect(JSON.stringify(pending)).not.toMatch(/secret|private-request/); expect(JSON.stringify(pending)).toContain("[redacted]");
    f.projection.observe("allowed", { method: "event.session_event", params: { event: { type: "permission_decision", payload: { callId: "request" } } } });
    await expect(f.browser.dispatch(request("remote.pendingApprovals", { sessionId: "allowed" }))).resolves.toMatchObject({ result: { approvals: [] } });
    await expect(f.browser.dispatch(request("tool.approve", { sessionId: "allowed", requestId: "request", scope: "once" }))).resolves.toMatchObject({ error: { data: { code: "REMOTE_APPROVAL_NOT_PENDING" } } });
  });
});
