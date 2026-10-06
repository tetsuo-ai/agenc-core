import { afterEach, describe, expect, it } from "vitest";
import { AgenCDaemonAgentManager } from "../../src/app-server/agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import {
  AGENC_CROSS_PROVIDER_CONSENT_CAPABILITY,
  type JsonObject,
} from "../../src/app-server/protocol/index.js";

// A client advertises capabilities in initialize and then attaches to a
// session under the id it chose (the SDK's own client id). Core must count
// that attached connection as able to answer cross-provider consent.

const dispatchers: AgenCDaemonJsonRpcDispatcher[] = [];
afterEach(async () => {
  await Promise.all(dispatchers.splice(0).map((dispatcher) => dispatcher.close()));
});

function request(id: string, method: string, params: JsonObject = {}): JsonObject {
  return { jsonrpc: "2.0", id, method, params: method === "initialize" ? { protocol: { version: "1.9.0" }, ...params } : params };
}

function harness() {
  const sessions = new AgenCDaemonSessionManager();
  const multiplexer = new AgenCDaemonClientMultiplexer({ sessionManager: sessions });
  const agentManager = new AgenCDaemonAgentManager({ sessionManager: sessions });
  const dispatcher = new AgenCDaemonJsonRpcDispatcher({
    agentManager,
    sessionManager: sessions,
    clientMultiplexer: multiplexer,
  });
  dispatchers.push(dispatcher);
  const connect = () => dispatcher.createConnection({ sendNotification: () => {} });
  const canAnswer = (sessionId: string) =>
    multiplexer.hasAttachedClientWithCapability(sessionId, AGENC_CROSS_PROVIDER_CONSENT_CAPABILITY);
  return { sessions, connect, canAnswer };
}

describe("cross-provider consent through a real initialize and attach", () => {
  it("counts a connection that advertised consent and attached under its own client id", async () => {
    const h = harness();
    const session = await h.sessions.createSession({ cwd: process.cwd() });
    const desktop = h.connect();
    await expect(desktop.dispatch(request("init", "initialize", {
      capabilities: { [AGENC_CROSS_PROVIDER_CONSENT_CAPABILITY]: true },
    }))).resolves.toHaveProperty("result");
    expect(await h.canAnswer(session.sessionId)).toBe(false);
    await expect(desktop.dispatch(request("attach", "session.attach", {
      sessionId: session.sessionId, clientId: "agenc-sdk-4242-desktop-turn",
    }))).resolves.toHaveProperty("result");
    expect(await h.canAnswer(session.sessionId)).toBe(true);
    await desktop.close();
    expect(await h.canAnswer(session.sessionId)).toBe(false);
  });

  it("does not borrow the capability from a different, unattached connection", async () => {
    const h = harness();
    const session = await h.sessions.createSession({ cwd: process.cwd() });
    const capable = h.connect();
    await capable.dispatch(request("init", "initialize", {
      capabilities: { [AGENC_CROSS_PROVIDER_CONSENT_CAPABILITY]: true },
    }));
    const legacy = h.connect();
    await legacy.dispatch(request("init", "initialize"));
    await expect(legacy.dispatch(request("attach", "session.attach", {
      sessionId: session.sessionId, clientId: "legacy-client",
    }))).resolves.toHaveProperty("result");
    expect(await h.canAnswer(session.sessionId)).toBe(false);
    await capable.close();
    await legacy.close();
  });
});
