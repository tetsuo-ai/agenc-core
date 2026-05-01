import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAgenCJsonLineDaemonClient,
  defaultEnsureDaemonReady,
  formatAgenCAgentCliHelpText,
  parseAgenCAgentCliArgs,
  runAgenCAgentCli,
  type AgenCAgentCliIo,
} from "./agent-cli.js";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import { AgenCUnixSocketServer } from "./transport/unix-socket.js";
import type { AgentCreateParams } from "./protocol/index.js";
import type {
  AgenCBackgroundAgentRunner,
  AgenCBackgroundAgentStartParams,
} from "./background-agent-runner.js";

function createIo(): AgenCAgentCliIo & {
  readonly stdoutText: () => string;
  readonly stderrText: () => string;
} {
  let stdout = "";
  let stderr = "";
  return {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += String(chunk);
        return true;
      },
    } as Pick<NodeJS.WriteStream, "write">,
    stdoutText: () => stdout,
    stderrText: () => stderr,
  };
}

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

describe("agenc agent start CLI", () => {
  it("parses the background-agent start command without claiming prompts", () => {
    expect(parseAgenCAgentCliArgs(["hello"])).toBeNull();
    expect(parseAgenCAgentCliArgs(["agent", "start", "build", "it"])).toEqual({
      kind: "start",
      objective: "build it",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    expect(
      parseAgenCAgentCliArgs([
        "agent",
        "start",
        "--unattended-allow",
        "FileRead,system.grep",
        "--unattended-deny=exec_command",
        "build",
        "it",
      ]),
    ).toEqual({
      kind: "start",
      objective: "build it",
      unattendedAllow: ["FileRead", "system.grep"],
      unattendedDeny: ["exec_command"],
    });
    expect(
      parseAgenCAgentCliArgs([
        "agent",
        "start",
        "fix",
        "--help",
        "handling",
      ]),
    ).toEqual({
      kind: "start",
      objective: "fix --help handling",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    expect(
      parseAgenCAgentCliArgs([
        "agent",
        "start",
        "--",
        "--unattended-allow",
        "literal",
      ]),
    ).toEqual({
      kind: "start",
      objective: "--unattended-allow literal",
      unattendedAllow: [],
      unattendedDeny: [],
    });
    expect(parseAgenCAgentCliArgs(["agent", "start"])).toEqual({
      kind: "error",
      message: "agent start requires an objective",
    });
    expect(formatAgenCAgentCliHelpText()).toContain(
      "start [--unattended-allow <tools>]",
    );
  });

  it("prints only the daemon-returned agent ID", async () => {
    const io = createIo();
    const requests: AgentCreateParams[] = [];

    await expect(
      runAgenCAgentCli(
        {
          kind: "start",
          objective: "audit the repo",
          unattendedAllow: ["FileRead"],
          unattendedDeny: ["exec_command"],
        },
        {
          cwd: "/workspace",
          ensureDaemonReady: async () => {},
          io,
          client: {
            createAgent: async (params) => {
              requests.push(params);
              return {
                agentId: "agent_1",
                objective: params.objective,
                status: "running",
                createdAt: "2026-05-01T12:00:00.000Z",
              };
            },
          },
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdoutText()).toBe("agent_1\n");
    expect(io.stderrText()).toBe("");
    expect(requests).toEqual([
      {
        objective: "audit the repo",
        instructions: "audit the repo",
        cwd: "/workspace",
        metadata: { source: "agenc agent start" },
        unattendedAllow: ["FileRead"],
        unattendedDeny: ["exec_command"],
      },
    ]);
  });

  it("threads the supplied environment into daemon autostart", async () => {
    const env = {
      AGENC_HOME: "/tmp/custom-agenc-home",
      AGENC_DAEMON_AUTOSTART: "1",
    };
    const calls: unknown[] = [];

    await expect(
      defaultEnsureDaemonReady(env, async (options) => {
        calls.push(options);
        return {
          pid: 1234,
          pidPath: "/tmp/custom-agenc-home/daemon.pid",
          status: "already-running",
          ready: true,
          connected: false,
        };
      })(),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      host: {
        env,
      },
    });
  });

  it("sends agent.create over the daemon JSON-line socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-agent-start-"));
    const socketPath = join(dir, "daemon.sock");
    const io = createIo();
    const sessionManager = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      now: sequence(["2026-05-01T12:00:01.000Z"]),
    });
    const starts: AgenCBackgroundAgentStartParams[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async (params) => {
        starts.push(params);
        return {
          agentId: "agent_socket",
          agentPath: "/root/agent_socket",
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        };
      },
    };
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager({
        defaultCwd: () => "/daemon",
        now: sequence(["2026-05-01T12:00:00.000Z"]),
        runner,
        sessionManager,
      }),
      initializeAuthenticator: (params) => params.authCookie === "socket-cookie",
    });
    const connections = new Map<number, ReturnType<typeof dispatcher.createConnection>>();
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        let connection = connections.get(context.connectionId);
        if (connection === undefined) {
          connection = dispatcher.createConnection();
          connections.set(context.connectionId, connection);
        }
        await context.send(await connection.dispatch(message));
      },
      onConnectionClosed: (connectionId) => {
        connections.delete(connectionId);
      },
    });

    await server.listen();
    try {
      await expect(
        createAgenCJsonLineDaemonClient({
          socketPath,
          authCookie: "wrong-cookie",
        }).createAgent({
          objective: "should not launch",
          cwd: "/workspace",
        }),
      ).rejects.toThrow("daemon connection authentication failed");
      expect(starts).toEqual([]);

      await expect(
        runAgenCAgentCli(
          {
            kind: "start",
            objective: "background compile",
            unattendedAllow: [],
            unattendedDeny: [],
          },
          {
            client: createAgenCJsonLineDaemonClient({
              socketPath,
              authCookie: "socket-cookie",
            }),
            cwd: "/workspace",
            ensureDaemonReady: async () => {},
            io,
          },
        ),
      ).resolves.toBe(0);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }

    expect(io.stdoutText()).toBe("agent_socket\n");
    expect(starts).toMatchObject([
      {
        objective: "background compile",
        cwd: "/workspace",
        unattendedAllow: [
          "FileRead",
          "system.grep",
          "system.glob",
          "system.listDir",
          "system.stat",
        ],
        unattendedDeny: [],
      },
    ]);
    await expect(sessionManager.getSession("session_1")).resolves.toMatchObject({
      agentId: "agent_socket",
      metadata: {
        objective: "background compile",
        source: "agent.start",
      },
    });
  });

  it("does not retry agent.create after the side-effecting request is sent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-agent-start-reset-"));
    const socketPath = join(dir, "daemon.sock");
    const io = createIo();
    const starts: AgenCBackgroundAgentStartParams[] = [];
    const runner: AgenCBackgroundAgentRunner = {
      startAgent: async (params) => {
        starts.push(params);
        return {
          agentId: `agent_reset_${starts.length}`,
          startedAt: "2026-05-01T12:00:00.500Z",
          status: "running",
        };
      },
    };
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager({
        now: sequence(["2026-05-01T12:00:00.000Z"]),
        runner,
      }),
      initializeAuthenticator: (params) => params.authCookie === "reset-cookie",
    });
    const connections = new Map<number, ReturnType<typeof dispatcher.createConnection>>();
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        let connection = connections.get(context.connectionId);
        if (connection === undefined) {
          connection = dispatcher.createConnection();
          connections.set(context.connectionId, connection);
        }
        const response = await connection.dispatch(message);
        if (message.method === "agent.create") {
          context.close();
          return;
        }
        await context.send(response);
      },
      onConnectionClosed: (connectionId) => {
        connections.delete(connectionId);
      },
    });

    await server.listen();
    try {
      await expect(
        runAgenCAgentCli(
          {
            kind: "start",
            objective: "background compile",
            unattendedAllow: [],
            unattendedDeny: [],
          },
          {
            client: createAgenCJsonLineDaemonClient({
              socketPath,
              authCookie: "reset-cookie",
              timeoutMs: 200,
            }),
            cwd: "/workspace",
            ensureDaemonReady: async () => {},
            io,
          },
        ),
      ).resolves.toBe(1);
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }

    expect(starts).toHaveLength(1);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toContain("Daemon connection closed before response");
  });
});
