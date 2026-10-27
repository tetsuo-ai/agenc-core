/**
 * agent.create `toolPolicy` validation at the wire, and the attached-client
 * binding of tool.approve / elicitation.respond for sessions that have one.
 */
import { describe, expect, it, vi } from "vitest";
import { AgenCDaemonClientMultiplexer } from "../../src/app-server/client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "../../src/app-server/daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "../../src/app-server/session-lifecycle.js";
import { JSON_RPC_VERSION } from "../../src/app-server/protocol/index.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import {
  normalizeSessionToolPolicy,
  type SessionToolPolicy,
} from "../../src/permissions/session-tool-policy.js";

type Connection = ReturnType<AgenCDaemonJsonRpcDispatcher["createConnection"]>;

async function initialize(connection: Connection): Promise<void> {
  await connection.dispatch({
    jsonrpc: JSON_RPC_VERSION,
    id: "init",
    method: "initialize",
    params: { protocol: { version: "1.0.0" } },
  });
}

function call(connection: Connection, method: string, params: Record<string, unknown>, id = method) {
  return connection.dispatch({ jsonrpc: JSON_RPC_VERSION, id, method, params });
}

describe("agent.create toolPolicy validation", () => {
  const base = {
    cwd: process.cwd(),
    objective: "marketplace task",
    runtimeOptions: resolveAgentRuntimeOptions({}),
  };

  async function connected() {
    const createAgent = vi.fn(async () => ({ agentId: "agent_1", sessionId: "session_1" }));
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({ agentManager: { createAgent } as never });
    const connection = dispatcher.createConnection();
    await initialize(connection);
    return { connection, createAgent };
  }

  it("passes a well-formed policy to the lifecycle, normalized and frozen", async () => {
    const { connection, createAgent } = await connected();
    const toolPolicy = {
      enabledTools: ["FileRead", "mcp.desktop.read_file"],
      frozenPermissionMode: true,
      deferMcpTools: false,
      noFsWriteTools: ["mcp.desktop.read_file"],
    };
    const response = await call(connection, "agent.create", { ...base, toolPolicy });
    expect(response).toMatchObject({ result: { agentId: "agent_1" } });
    const received = (createAgent.mock.calls[0] as unknown as [{ toolPolicy: SessionToolPolicy }])[0].toolPolicy;
    expect(received).toEqual(toolPolicy);
    expect(Object.isFrozen(received)).toBe(true);
    expect(Object.isFrozen(received.enabledTools)).toBe(true);
  });

  it("accepts a request without a policy and passes none", async () => {
    const { connection, createAgent } = await connected();
    await call(connection, "agent.create", base);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent.mock.calls[0]![0]).not.toHaveProperty("toolPolicy");
  });

  it.each([
    ["not an object", "FileRead", "'toolPolicy' must be an object"],
    ["an empty allowlist", { enabledTools: [] }, "enabledTools must not be empty"],
    ["a missing allowlist", { frozenPermissionMode: true }, "enabledTools must be an array of strings"],
    ["a non-string entry", { enabledTools: ["FileRead", 7] }, "enabledTools must be an array of strings"],
    ["a duplicate", { enabledTools: ["FileRead", "FileRead"] }, 'lists "FileRead" more than once'],
    ["a malformed name", { enabledTools: ["File Read"] }, "not a well-formed tool name"],
    ["an empty name", { enabledTools: [""] }, "not a well-formed tool name"],
    ["an unknown key", { enabledTools: ["FileRead"], allowAll: true }, "does not accept 'allowAll'"],
    ["a non-boolean freeze", { enabledTools: ["FileRead"], frozenPermissionMode: "true" }, "frozenPermissionMode must be a boolean"],
    ["a non-boolean defer", { enabledTools: ["FileRead"], deferMcpTools: 1 }, "deferMcpTools must be a boolean"],
    ["a no-write grant for a tool that is not enabled", { enabledTools: ["FileRead"], noFsWriteTools: ["mcp.desktop.read_file"] }, "not in enabledTools"],
    ["a no-write grant for a built-in", { enabledTools: ["FileRead"], noFsWriteTools: ["FileRead"] }, "not an MCP tool name"],
  ])("rejects %s", async (_label, toolPolicy, fragment) => {
    const { connection, createAgent } = await connected();
    const response = (await call(connection, "agent.create", { ...base, toolPolicy })) as {
      error?: { code: number; message: string };
    };
    expect(response.error?.code).toBe(-32602);
    expect(response.error?.message).toContain(fragment);
    expect(createAgent).not.toHaveBeenCalled();
  });

  it("reserves the metadata keys the daemon persists the policy under", async () => {
    const { connection, createAgent } = await connected();
    for (const key of ["toolPolicy", "toolPolicyModeCeiling"]) {
      const response = (await call(connection, "agent.create", {
        ...base,
        metadata: { [key]: { enabledTools: ["system.bash"] } },
      })) as { error?: { code: number; message: string } };
      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain(`'metadata.${key}' is reserved`);
    }
    expect(createAgent).not.toHaveBeenCalled();
  });
});

describe("tool.approve and elicitation.respond are bound to an attached connection", () => {
  const POLICY = normalizeSessionToolPolicy({ enabledTools: ["FileRead"] });
  const approve = { sessionId: "session_1", requestId: "req_1", scope: "once" };
  const elicit = {
    sessionId: "session_1",
    requestId: "req_2",
    kind: "request_user_input",
    response: { answers: {} },
  };

  async function fixture(policy: SessionToolPolicy | undefined) {
    const approveTool = vi.fn(async () => ({ requestId: "req_1", decision: "approved" }));
    const respondToElicitation = vi.fn(async () => ({ requestId: "req_2", accepted: true }));
    const getSessionToolPolicy = vi.fn((id: string) =>
      id === "session_1" || id === "agent_1" ? policy : undefined,
    );
    const peekRoutineSessionId = vi.fn((id: string) => (id === "agent_1" ? "session_1" : id));
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({ sessionId: "session_1", agentId: "agent_1", cwd: process.cwd() });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      sessionManager: sessions,
      clientMultiplexer: new AgenCDaemonClientMultiplexer({ sessionManager: sessions }),
      agentManager: { approveTool, respondToElicitation, getSessionToolPolicy, peekRoutineSessionId } as never,
    });
    const owner = dispatcher.createConnection({ sendNotification: () => {} });
    await initialize(owner);
    await call(owner, "session.attach", { sessionId: "session_1", clientId: "owner-client" }, "attach");
    const stranger = dispatcher.createConnection({ sendNotification: () => {} });
    await initialize(stranger);
    return { dispatcher, owner, stranger, approveTool, respondToElicitation };
  }

  it("lets the attached connection answer and refuses another one", async () => {
    const { owner, stranger, approveTool, respondToElicitation } = await fixture(POLICY);

    expect(await call(stranger, "tool.approve", approve)).toMatchObject({
      error: { code: -32000, data: { code: "SESSION_NOT_ATTACHED" } },
    });
    expect(await call(stranger, "elicitation.respond", elicit)).toMatchObject({
      error: { code: -32000, data: { code: "SESSION_NOT_ATTACHED" } },
    });
    expect(approveTool).not.toHaveBeenCalled();
    expect(respondToElicitation).not.toHaveBeenCalled();

    expect(await call(owner, "tool.approve", approve)).toMatchObject({ result: { decision: "approved" } });
    expect(await call(owner, "elicitation.respond", elicit)).toMatchObject({ result: { accepted: true } });
    expect(approveTool).toHaveBeenCalledTimes(1);
    expect(respondToElicitation).toHaveBeenCalledTimes(1);
  });

  it("lets only the attached connection add, replace or toggle a session MCP server", async () => {
    const addMcpServerToSession = vi.fn(async () => ({ success: true, sessionId: "session_1", serverName: "task", toolCount: 1 }));
    const reconnectMcpServerOnSession = vi.fn(async () => ({ success: true }));
    const enableMcpServerOnSession = vi.fn(async () => ({ success: true }));
    const disableMcpServerOnSession = vi.fn(async () => ({ success: true }));
    const sessions = new AgenCDaemonSessionManager();
    await sessions.restoreSession({ sessionId: "session_1", agentId: "agent_1", cwd: process.cwd() });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      sessionManager: sessions,
      clientMultiplexer: new AgenCDaemonClientMultiplexer({ sessionManager: sessions }),
      agentManager: {
        addMcpServerToSession, reconnectMcpServerOnSession, enableMcpServerOnSession, disableMcpServerOnSession,
        getSessionToolPolicy: (id: string) => (id === "session_1" || id === "session_live" ? POLICY : undefined),
        peekRoutineSessionId: (id: string) => id,
        // One agent, two session ids: the one the client attached under and the live one.
        peekOwnerSessionIds: (id: string) => (id === "session_1" || id === "session_live" ? ["session_1", "session_live"] : []),
      } as never,
    });
    const owner = dispatcher.createConnection({ sendNotification: () => {} });
    await initialize(owner);
    await call(owner, "session.attach", { sessionId: "session_1", clientId: "owner-client" }, "attach");
    const stranger = dispatcher.createConnection({ sendNotification: () => {} });
    await initialize(stranger);
    const add = { sessionId: "session_1", config: { name: "task", transport: "http", endpoint: "http://127.0.0.1:43120/mcp" }, replace: true };
    const byName = { sessionId: "session_1", serverName: "task" };
    for (const [method, params] of [
      ["session.mcp.addServer", add],
      ["session.mcp.reconnectServer", byName],
      ["session.mcp.enableServer", byName],
      ["session.mcp.disableServer", byName],
      ["session.mcp.removeServer", byName],
    ] as const) {
      expect(await call(stranger, method, params), method).toMatchObject({ error: { code: -32000, data: { code: "SESSION_NOT_ATTACHED" } } });
    }
    expect(addMcpServerToSession).not.toHaveBeenCalled();
    expect(disableMcpServerOnSession).not.toHaveBeenCalled();
    expect(await call(owner, "session.mcp.addServer", add)).toMatchObject({ result: { success: true } });
    expect(addMcpServerToSession).toHaveBeenCalledTimes(1);
    // The owner may name the agent's live session id; a stranger still may not.
    const live = { ...add, sessionId: "session_live" };
    expect(await call(owner, "session.mcp.addServer", live)).toMatchObject({ result: { success: true } });
    expect(await call(stranger, "session.mcp.addServer", live)).toMatchObject({ error: { data: { code: "SESSION_NOT_ATTACHED" } } });
    expect(addMcpServerToSession).toHaveBeenCalledTimes(2);
  });

  it("lets the connection that created the policy session set up its servers before any client attaches", async () => {
    const addMcpServerToSession = vi.fn(async () => ({ success: true, sessionId: "session_live", serverName: "task", toolCount: 1 }));
    const createAgent = vi.fn(async () => ({ agentId: "agent_9" }));
    const sessions = new AgenCDaemonSessionManager();
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      sessionManager: sessions,
      clientMultiplexer: new AgenCDaemonClientMultiplexer({ sessionManager: sessions }),
      agentManager: {
        createAgent, addMcpServerToSession,
        getSessionToolPolicy: (id: string) => (id === "session_live" || id === "agent_9" ? POLICY : undefined),
        peekRoutineSessionId: (id: string) => id,
        peekOwnerSessionIds: () => [],
        peekOwnerAgentId: (id: string) => (id === "session_live" || id === "agent_9" ? "agent_9" : undefined),
      } as never,
    });
    const creator = dispatcher.createConnection({ sendNotification: () => {} });
    await initialize(creator);
    const other = dispatcher.createConnection({ sendNotification: () => {} });
    await initialize(other);
    const create = { cwd: process.cwd(), objective: "marketplace task", runtimeOptions: resolveAgentRuntimeOptions({}), toolPolicy: { enabledTools: ["FileRead"] } };
    expect(await call(creator, "agent.create", create)).toMatchObject({ result: { agentId: "agent_9" } });
    const add = { sessionId: "session_live", config: { name: "task", transport: "http", endpoint: "http://127.0.0.1:43120/mcp" }, replace: true };
    expect(await call(other, "session.mcp.addServer", add)).toMatchObject({ error: { data: { code: "SESSION_NOT_ATTACHED" } } });
    expect(await call(creator, "session.mcp.addServer", add)).toMatchObject({ result: { success: true } });
    expect(addMcpServerToSession).toHaveBeenCalledTimes(1);
  });

  it("names the session in the error and does not echo the request", async () => {
    const { stranger } = await fixture(POLICY);
    const response = (await call(stranger, "tool.approve", approve)) as { error: { message: string } };
    expect(response.error.message).toBe(
      "tool.approve requires a client attached to session session_1 on this connection",
    );
  });

  it("resolves an agent id to its session before checking the attachment", async () => {
    const { owner, stranger, approveTool } = await fixture(POLICY);
    expect(await call(stranger, "tool.approve", { ...approve, sessionId: "agent_1" })).toMatchObject({
      error: { data: { code: "SESSION_NOT_ATTACHED" } },
    });
    expect(await call(owner, "tool.approve", { ...approve, sessionId: "agent_1" })).toMatchObject({
      result: { decision: "approved" },
    });
    expect(approveTool).toHaveBeenCalledTimes(1);
  });

  it("refuses everyone when no multiplexer can prove an attachment", async () => {
    const approveTool = vi.fn(async () => ({}));
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: { approveTool, getSessionToolPolicy: () => POLICY } as never,
    });
    const connection = dispatcher.createConnection();
    await initialize(connection);
    expect(await call(connection, "tool.approve", approve)).toMatchObject({
      error: { data: { code: "SESSION_NOT_ATTACHED" } },
    });
    expect(approveTool).not.toHaveBeenCalled();
  });

  it("leaves a session without a policy open to any connection, as before", async () => {
    const { stranger, approveTool, respondToElicitation } = await fixture(undefined);
    expect(await call(stranger, "tool.approve", approve)).toMatchObject({ result: { decision: "approved" } });
    expect(await call(stranger, "elicitation.respond", elicit)).toMatchObject({ result: { accepted: true } });
    expect(approveTool).toHaveBeenCalledTimes(1);
    expect(respondToElicitation).toHaveBeenCalledTimes(1);
  });

  it("does not apply to remote connections, which carry their own grant", async () => {
    const { dispatcher, approveTool } = await fixture(POLICY);
    const remote = dispatcher.createConnection({
      remoteAccess: {
        authorize: async () => {},
        allowsMethod: () => true,
        projection: () => ({}),
        resolveApproval: () => {},
      } as never,
    });
    await initialize(remote);
    expect(await call(remote, "tool.approve", approve)).toMatchObject({ result: { decision: "approved" } });
    expect(approveTool).toHaveBeenCalledTimes(1);
  });
});
