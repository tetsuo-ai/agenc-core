import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import {
  AgenCInProcessDaemonTransport as PublicAgenCInProcessDaemonTransport,
  AgenCDaemonJsonRpcDispatcher as PublicAgenCDaemonJsonRpcDispatcher,
  startAgenCInProcessDaemonTransport as publicStartAgenCInProcessDaemonTransport,
} from "../index.js";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import type { AgenCCommandExec } from "./command-exec.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import {
  JSON_RPC_VERSION,
  type AgenCDaemonRequest,
  type JsonObject,
} from "./protocol/index.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import {
  AgenCInProcessDaemonTransport,
  startAgenCInProcessDaemonTransport,
} from "./transport/in-process.js";
import {
  createAgenCDaemonClient as createSdkDaemonClient,
  type AgenCDaemonTransport as SdkAgenCDaemonTransport,
} from "../../../../agenc-sdk/src/daemon";

const workspaces = createTempWorkspaceFixture(
  "agenc-in-process-transport-workspace-",
);

afterEach(async () => {
  await workspaces.cleanup();
});

function sequence(values: readonly string[]): () => string {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) {
      throw new Error("test sequence exhausted");
    }
    index += 1;
    return value;
  };
}

describe("AgenC in-process app-server transport", () => {
  it("uses one initialized dispatcher connection for SDK-style requests and notifications", async () => {
    const notifications: JsonObject[] = [];
    let observedConnectionId = "";
    const commandExec: AgenCCommandExec = {
      start: vi.fn(async (_params, context) => {
        observedConnectionId = context.connectionId;
        await context.sendNotification?.({
          jsonrpc: JSON_RPC_VERSION,
          method: "commandExec.outputDelta",
          params: {
            processId: "proc-1",
            stream: "stdout",
            deltaBase64: "b2s=",
            capReached: false,
          },
        });
        return { exitCode: 0, stdout: "ok", stderr: "" };
      }),
      write: vi.fn(async () => ({})),
      resize: vi.fn(async () => ({})),
      terminate: vi.fn(async () => ({})),
      closeConnection: vi.fn(async () => {}),
    };
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      commandExec,
    });
    const transport = new AgenCInProcessDaemonTransport({
      dispatcher,
      sendNotification: (notification) => notifications.push(notification),
    });

    await expect(
      transport.request({
        jsonrpc: JSON_RPC_VERSION,
        id: "before-init",
        method: "commandExec.start",
        params: {
          command: [process.execPath, "-e", "process.stdout.write('ok')"],
          processId: "proc-1",
          streamStdoutStderr: true,
        },
      }),
    ).resolves.toMatchObject({
      error: { data: { code: "CONNECTION_NOT_INITIALIZED" } },
    });

    await expect(transport.initialize()).resolves.toMatchObject({
      result: {
        type: "initialized",
        protocolVersion: "1.0.0",
        protocol: { version: "1.0.0" },
      },
    });
    expect(transport.initialized).toBe(true);

    await expect(
      transport.request({
        jsonrpc: JSON_RPC_VERSION,
        id: "start",
        method: "commandExec.start",
        params: {
          command: [process.execPath, "-e", "process.stdout.write('ok')"],
          processId: "proc-1",
          streamStdoutStderr: true,
        },
      }),
    ).resolves.toEqual({
      jsonrpc: JSON_RPC_VERSION,
      id: "start",
      result: { exitCode: 0, stdout: "ok", stderr: "" },
    });
    expect(observedConnectionId).toBe(transport.connectionId);
    expect(notifications).toEqual([
      {
        jsonrpc: JSON_RPC_VERSION,
        method: "commandExec.outputDelta",
        params: {
          processId: "proc-1",
          stream: "stdout",
          deltaBase64: "b2s=",
          capReached: false,
        },
      },
    ]);

    await transport.close();
    await transport.close();
    expect(commandExec.closeConnection).toHaveBeenCalledTimes(1);
    expect(commandExec.closeConnection).toHaveBeenCalledWith(
      observedConnectionId,
    );
    await expect(
      transport.request({
        jsonrpc: JSON_RPC_VERSION,
        id: "after-close",
        method: "agent.list",
        params: {},
      }),
    ).rejects.toThrow("AgenC in-process daemon transport is closed");
  });

  it("start helper returns an initialized transport and closes on initialize failure", async () => {
    const accepted = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      initializeAuthenticator: (params) => params.authCookie === "expected",
    });
    const transport = await startAgenCInProcessDaemonTransport({
      dispatcher: accepted,
      initialize: {
        protocolVersion: "1.0.0",
        protocol: { version: "1.0.0" },
        clientName: "embedded-test",
        authCookie: "expected",
      },
    });
    expect(transport.initialized).toBe(true);
    await transport.close();

    const closedConnectionIds: string[] = [];
    const rejected = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
      commandExec: {
        start: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
        write: vi.fn(async () => ({})),
        resize: vi.fn(async () => ({})),
        terminate: vi.fn(async () => ({})),
        closeConnection: vi.fn(async (connectionId) => {
          closedConnectionIds.push(connectionId);
        }),
      },
      initializeAuthenticator: () => false,
    });

    await expect(
      startAgenCInProcessDaemonTransport({
        dispatcher: rejected,
        initialize: {
          protocolVersion: "1.0.0",
          protocol: { version: "1.0.0" },
          clientName: "embedded-test",
          authCookie: "wrong",
        },
      }),
    ).rejects.toThrow("AgenC in-process daemon initialize failed");
    expect(closedConnectionIds).toHaveLength(1);
  });

  it("close releases clients registered by agent.attach", async () => {
    const sessions = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_1"]),
      now: sequence(["2026-05-01T12:00:00.000Z", "2026-05-01T12:00:01.000Z"]),
    });
    await sessions.createSession({
      agentId: "agent_1",
      cwd: await workspaces.create(),
    });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager: sessions,
    });
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: {
        createAgent: async () => {
          throw new Error("createAgent should not be called");
        },
        listAgents: async () => ({ agents: [] }),
        attachAgent: async () => ({
          agentId: "agent_1",
          attachmentId: "attachment_1",
          sessionIds: ["session_1"],
        }),
        streamAgentMessage: async () => {},
        approveTool: async () => ({
          requestId: "unused",
          decision: "approved",
        }),
        denyTool: async () => ({ requestId: "unused", decision: "denied" }),
        cancelTool: async () => ({
          requestId: "unused",
          decision: "cancelled",
        }),
        stopAgent: async () => ({ agentId: "agent_1", stopped: true }),
        getAgentLogs: async () => ({
          agentId: "agent_1",
          sessions: [],
          transcript: "agent_id\tagent_1\nNo transcript entries",
        }),
      },
      clientMultiplexer,
    });
    const transport = await startAgenCInProcessDaemonTransport({
      dispatcher,
      sendNotification: () => {},
    });

    await expect(
      transport.request({
        jsonrpc: JSON_RPC_VERSION,
        id: "attach",
        method: "agent.attach",
        params: { agentId: "agent_1", clientId: "embedded-client" },
      }),
    ).resolves.toMatchObject({
      result: { agentId: "agent_1", sessionIds: ["session_1"] },
    });
    await expect(
      clientMultiplexer.attachedClientIds("session_1"),
    ).resolves.toEqual(["embedded-client"]);
    await expect(sessions.getSession("session_1")).resolves.toMatchObject({
      activeAttachmentIds: ["attachment_1"],
    });

    await transport.close();

    await expect(
      clientMultiplexer.attachedClientIds("session_1"),
    ).resolves.toEqual([]);
    await expect(sessions.getSession("session_1")).resolves.not.toHaveProperty(
      "activeAttachmentIds",
    );
  });

  it("matches the SDK transport request shape", async () => {
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const transport = new AgenCInProcessDaemonTransport({ dispatcher });
    const request = {
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "1.0.0",
        clientName: "sdk-shape-test",
      },
    } satisfies AgenCDaemonRequest;

    await expect(transport.request(request)).resolves.toMatchObject({
      jsonrpc: JSON_RPC_VERSION,
      id: 1,
      result: {
        type: "initialized",
        protocol: { version: "1.0.0" },
      },
    });
    await transport.close();
  });

  it("is reachable through the public runtime barrel and usable by the SDK client", async () => {
    expect(PublicAgenCInProcessDaemonTransport).toBe(
      AgenCInProcessDaemonTransport,
    );
    expect(publicStartAgenCInProcessDaemonTransport).toBe(
      startAgenCInProcessDaemonTransport,
    );

    const dispatcher = new PublicAgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager(),
    });
    const transport = new PublicAgenCInProcessDaemonTransport({ dispatcher });
    const sdkTransport: SdkAgenCDaemonTransport = transport;
    const sdkClient = createSdkDaemonClient({ transport: sdkTransport });

    await expect(
      sdkClient.initialize({
        protocolVersion: "1.0.0",
        protocol: { version: "1.0.0" },
        clientName: "sdk-public-import-test",
      }),
    ).resolves.toMatchObject({
      type: "initialized",
      protocolVersion: "1.0.0",
      protocol: { version: "1.0.0" },
    });
    await transport.close();
  });
});
