import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createConnectedAgenCJsonLineDaemonTuiClient,
  createAgenCJsonLineDaemonClient,
  defaultEnsureDaemonReady,
  formatAgenCAgentAttachResult,
  formatAgenCAgentList,
  formatAgenCAgentCliHelpText,
  formatAgenCAgentLogsResult,
  formatAgenCAgentStopResult,
  parseAgenCAgentCliArgs,
  resolveAgenCAgentAttachCwd,
  runAgenCAgentCli,
  type AgenCAgentCliIo,
} from "./agent-cli.js";
import { AgenCDaemonAgentManager } from "./agent-lifecycle.js";
import { AgenCDaemonClientMultiplexer } from "./client-multiplexer.js";
import { AgenCDaemonJsonRpcDispatcher } from "./daemon-dispatcher.js";
import { AgenCDaemonSessionManager } from "./session-lifecycle.js";
import { AgenCUnixSocketServer } from "./transport/unix-socket.js";
import type {
  AgentCreateParams,
  AgentLogsParams,
  AgentStopParams,
} from "./protocol/index.js";
import type {
  AgenCBackgroundAgentMessageParams,
  AgenCBackgroundAgentRunner,
  AgenCBackgroundAgentSessionEventBinding,
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
    expect(parseAgenCAgentCliArgs(["agent", "list"])).toEqual({
      kind: "list",
    });
    expect(parseAgenCAgentCliArgs(["agent", "list", "--help"])).toEqual({
      kind: "help",
      text: formatAgenCAgentCliHelpText(),
    });
    expect(parseAgenCAgentCliArgs(["agent", "start", "--help"])).toEqual({
      kind: "help",
      text: formatAgenCAgentCliHelpText(),
    });
    expect(parseAgenCAgentCliArgs(["agent", "list", "extra"])).toEqual({
      kind: "error",
      message: "agent list does not accept arguments",
    });
    expect(parseAgenCAgentCliArgs(["agent", "attach", "agent_1"])).toEqual({
      kind: "attach",
      agentId: "agent_1",
    });
    expect(parseAgenCAgentCliArgs(["agent", "attach"])).toEqual({
      kind: "error",
      message: "agent attach requires an agent id",
    });
    expect(
      parseAgenCAgentCliArgs(["agent", "attach", "agent_1", "extra"]),
    ).toEqual({
      kind: "error",
      message: "agent attach accepts exactly one agent id",
    });
    expect(parseAgenCAgentCliArgs(["agent", "stop", "agent_1"])).toEqual({
      kind: "stop",
      agentId: "agent_1",
    });
    expect(parseAgenCAgentCliArgs(["agent", "stop"])).toEqual({
      kind: "error",
      message: "agent stop requires an agent id",
    });
    expect(
      parseAgenCAgentCliArgs(["agent", "stop", "agent_1", "extra"]),
    ).toEqual({
      kind: "error",
      message: "agent stop accepts exactly one agent id",
    });
    expect(parseAgenCAgentCliArgs(["agent", "logs", "agent_1"])).toEqual({
      kind: "logs",
      agentId: "agent_1",
    });
    expect(parseAgenCAgentCliArgs(["agent", "logs"])).toEqual({
      kind: "error",
      message: "agent logs requires an agent id",
    });
    expect(
      parseAgenCAgentCliArgs(["agent", "logs", "agent_1", "extra"]),
    ).toEqual({
      kind: "error",
      message: "agent logs accepts exactly one agent id",
    });
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
      parseAgenCAgentCliArgs(["agent", "start", "fix", "--help", "handling"]),
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
    expect(formatAgenCAgentCliHelpText()).toContain("list");
    expect(formatAgenCAgentCliHelpText()).toContain("attach <id>");
    expect(formatAgenCAgentCliHelpText()).toContain("stop <id>");
    expect(formatAgenCAgentCliHelpText()).toContain("logs <id>");
    expect(formatAgenCAgentCliHelpText()).toContain("Examples:");
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
            listAgents: async () => ({ agents: [] }),
            attachAgent: async () => {
              throw new Error("attachAgent should not be called");
            },
            stopAgent: async () => {
              throw new Error("stopAgent should not be called");
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

  it("prints active agent list rows with the required columns", async () => {
    const io = createIo();

    await expect(
      runAgenCAgentCli(
        { kind: "list" },
        {
          ensureDaemonReady: async () => {},
          io,
          client: {
            createAgent: async () => {
              throw new Error("createAgent should not be called");
            },
            listAgents: async () => ({
              agents: [
                {
                  agentId: "agent_1",
                  objective: "audit the repo",
                  status: "running",
                  createdAt: "2026-05-01T12:00:00.000Z",
                  startedAt: "2026-05-01T12:00:01.000Z",
                  lastActiveAt: "2026-05-01T12:00:02.000Z",
                },
              ],
            }),
            attachAgent: async () => {
              throw new Error("attachAgent should not be called");
            },
            stopAgent: async () => {
              throw new Error("stopAgent should not be called");
            },
          },
        },
      ),
    ).resolves.toBe(0);

    expect(io.stdoutText()).toBe(
      [
        "id\tobjective\tstatus\tstarted_at\tlast_active_at",
        "agent_1\taudit the repo\trunning\t2026-05-01T12:00:01.000Z\t2026-05-01T12:00:02.000Z",
        "",
      ].join("\n"),
    );
    expect(io.stderrText()).toBe("");
    expect(formatAgenCAgentList({ agents: [] })).toBe("No active agents");
  });

  it("keeps control characters out of tabular agent list cells", () => {
    expect(
      formatAgenCAgentList({
        agents: [
          {
            agentId: "agent_1",
            objective: "audit\tthe\nrepo\rnow",
            status: "running",
            createdAt: "2026-05-01T12:00:00.000Z",
            startedAt: "2026-05-01T12:00:01.000Z",
            lastActiveAt: "2026-05-01T12:00:02.000Z",
          },
        ],
      }),
    ).toBe(
      [
        "id\tobjective\tstatus\tstarted_at\tlast_active_at",
        "agent_1\taudit the repo now\trunning\t2026-05-01T12:00:01.000Z\t2026-05-01T12:00:02.000Z",
      ].join("\n"),
    );
  });

  it("prints agents from every daemon list page", async () => {
    const io = createIo();
    const requests: unknown[] = [];

    await expect(
      runAgenCAgentCli(
        { kind: "list" },
        {
          ensureDaemonReady: async () => {},
          io,
          client: {
            createAgent: async () => {
              throw new Error("createAgent should not be called");
            },
            listAgents: async (params = {}) => {
              requests.push(params);
              if (params.cursor === undefined) {
                return {
                  agents: [
                    {
                      agentId: "agent_1",
                      objective: "audit the repo",
                      status: "running",
                      createdAt: "2026-05-01T12:00:00.000Z",
                      startedAt: "2026-05-01T12:00:01.000Z",
                      lastActiveAt: "2026-05-01T12:00:02.000Z",
                    },
                  ],
                  nextCursor: "1",
                };
              }
              if (params.cursor === "1") {
                return {
                  agents: [
                    {
                      agentId: "agent_2",
                      objective: "check release notes",
                      status: "running",
                      createdAt: "2026-05-01T12:01:00.000Z",
                      startedAt: "2026-05-01T12:01:01.000Z",
                      lastActiveAt: "2026-05-01T12:01:02.000Z",
                    },
                  ],
                };
              }
              throw new Error(`unexpected cursor ${params.cursor}`);
            },
            attachAgent: async () => {
              throw new Error("attachAgent should not be called");
            },
            stopAgent: async () => {
              throw new Error("stopAgent should not be called");
            },
          },
        },
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([{}, { cursor: "1" }]);
    expect(io.stdoutText()).toBe(
      [
        "id\tobjective\tstatus\tstarted_at\tlast_active_at",
        "agent_1\taudit the repo\trunning\t2026-05-01T12:00:01.000Z\t2026-05-01T12:00:02.000Z",
        "agent_2\tcheck release notes\trunning\t2026-05-01T12:01:01.000Z\t2026-05-01T12:01:02.000Z",
        "",
      ].join("\n"),
    );
    expect(io.stderrText()).toBe("");
  });

  it("prints the daemon-returned agent attachment target", async () => {
    const io = createIo();
    const requests: unknown[] = [];

    await expect(
      runAgenCAgentCli(
        { kind: "attach", agentId: "agent_1" },
        {
          clientId: "tui_test",
          ensureDaemonReady: async () => {},
          io,
          client: {
            createAgent: async () => {
              throw new Error("createAgent should not be called");
            },
            listAgents: async () => {
              throw new Error("listAgents should not be called");
            },
            attachAgent: async (params) => {
              requests.push(params);
              return {
                agentId: params.agentId,
                attachmentId: "attachment_1",
                sessionIds: ["session_1"],
              };
            },
            stopAgent: async () => {
              throw new Error("stopAgent should not be called");
            },
          },
        },
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([{ agentId: "agent_1", clientId: "tui_test" }]);
    expect(io.stdoutText()).toBe(
      [
        "agent_id\tsession_id\tattachment_id",
        "agent_1\tsession_1\tattachment_1",
        "",
      ].join("\n"),
    );
    expect(
      formatAgenCAgentAttachResult({
        agentId: "agent_2",
        attachmentId: "attachment_2",
        sessionIds: [],
      }),
    ).toBe(
      ["agent_id\tsession_id\tattachment_id", "agent_2\t-\tattachment_2"].join(
        "\n",
      ),
    );
    expect(
      resolveAgenCAgentAttachCwd(
        {
          agentId: "agent_3",
          attachmentId: "attachment_3",
          sessionIds: ["session_remote"],
          sessions: [
            {
              sessionId: "session_remote",
              agentId: "agent_3",
              status: "idle",
              createdAt: "2026-05-01T12:00:00.000Z",
              cwd: "/daemon/workspace",
            },
          ],
        },
        "/local/workspace",
      ),
    ).toBe("/daemon/workspace");
    expect(io.stderrText()).toBe("");
  });

  it("sends agent.stop and prints the stop outcome", async () => {
    const io = createIo();
    const requests: AgentStopParams[] = [];

    await expect(
      runAgenCAgentCli(
        { kind: "stop", agentId: "agent_1" },
        {
          ensureDaemonReady: async () => {},
          io,
          client: {
            createAgent: async () => {
              throw new Error("createAgent should not be called");
            },
            listAgents: async () => {
              throw new Error("listAgents should not be called");
            },
            attachAgent: async () => {
              throw new Error("attachAgent should not be called");
            },
            stopAgent: async (params) => {
              requests.push(params);
              return { agentId: params.agentId, stopped: true };
            },
          },
        },
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([
      { agentId: "agent_1", reason: "agenc agent stop" },
    ]);
    expect(io.stdoutText()).toBe("agent_1\tstopped\n");
    expect(io.stderrText()).toBe("");
    expect(
      formatAgenCAgentStopResult({
        agentId: "agent_2",
        stopped: false,
      }),
    ).toBe("agent_2\talready_stopped");
  });

  it("sends agent.logs and prints the returned transcript", async () => {
    const io = createIo();
    const requests: AgentLogsParams[] = [];

    await expect(
      runAgenCAgentCli(
        { kind: "logs", agentId: "agent_1" },
        {
          ensureDaemonReady: async () => {},
          io,
          client: {
            createAgent: async () => {
              throw new Error("createAgent should not be called");
            },
            listAgents: async () => {
              throw new Error("listAgents should not be called");
            },
            attachAgent: async () => {
              throw new Error("attachAgent should not be called");
            },
            stopAgent: async () => {
              throw new Error("stopAgent should not be called");
            },
            getAgentLogs: async (params) => {
              requests.push(params);
              return {
                agentId: params.agentId,
                sessions: [],
                transcript: "agent_id\tagent_1\nassistant:\ndone",
              };
            },
          },
        },
      ),
    ).resolves.toBe(0);

    expect(requests).toEqual([{ agentId: "agent_1" }]);
    expect(io.stdoutText()).toBe("agent_id\tagent_1\nassistant:\ndone\n");
    expect(io.stderrText()).toBe("");
    expect(
      formatAgenCAgentLogsResult({
        agentId: "agent_2",
        sessions: [],
        transcript: "agent_id\tagent_2",
      }),
    ).toBe("agent_id\tagent_2");
  });

  it("hands agent attach to the TUI launcher when provided", async () => {
    const io = createIo();
    const launches: unknown[] = [];

    await expect(
      runAgenCAgentCli(
        { kind: "attach", agentId: "agent_1" },
        {
          clientId: "tui_test",
          env: { AGENC_HOME: "/tmp/agenc-home" },
          ensureDaemonReady: async () => {},
          io,
          client: {
            createAgent: async () => {
              throw new Error("createAgent should not be called");
            },
            listAgents: async () => {
              throw new Error("listAgents should not be called");
            },
            attachAgent: async () => {
              throw new Error("attachAgent should not be called");
            },
            stopAgent: async () => {
              throw new Error("stopAgent should not be called");
            },
          },
          attachTui: async (context) => {
            launches.push(context);
            return 0;
          },
        },
      ),
    ).resolves.toBe(0);

    expect(launches).toEqual([
      {
        agentId: "agent_1",
        clientId: "tui_test",
        env: { AGENC_HOME: "/tmp/agenc-home" },
      },
    ]);
    expect(io.stdoutText()).toBe("");
    expect(io.stderrText()).toBe("");
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

  it("skips daemon autostart when config disables it", async () => {
    const agencHome = await mkdtemp(join(tmpdir(), "agenc-agent-config-"));
    const env = {
      AGENC_HOME: agencHome,
    };
    const calls: unknown[] = [];
    await writeFile(
      join(agencHome, "config.toml"),
      `
[daemon]
autostart = false
      `,
    );

    await expect(
      defaultEnsureDaemonReady(env, async (options) => {
        calls.push(options);
        return {
          pid: 1234,
          pidPath: join(agencHome, "daemon.pid"),
          status: "already-running",
          ready: true,
          connected: false,
        };
      })(),
    ).resolves.toBeUndefined();

    expect(calls).toEqual([]);
    await rm(agencHome, { recursive: true, force: true });
  });

  it("sends agent.create over the daemon JSON-line socket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-agent-start-"));
    const socketPath = join(dir, "daemon.sock");
    const io = createIo();
    const sessionManager = new AgenCDaemonSessionManager({
      createSessionId: sequence(["session_1"]),
      createAttachmentId: sequence(["attachment_socket", "attachment_live"]),
      now: sequence([
        "2026-05-01T12:00:01.000Z",
        "2026-05-01T12:00:02.000Z",
        "2026-05-01T12:00:03.000Z",
        "2026-05-01T12:00:04.000Z",
      ]),
    });
    const clientMultiplexer = new AgenCDaemonClientMultiplexer({
      sessionManager,
    });
    const starts: AgenCBackgroundAgentStartParams[] = [];
    const submitted: AgenCBackgroundAgentMessageParams[] = [];
    const stops: unknown[] = [];
    let sessionBinding: AgenCBackgroundAgentSessionEventBinding | undefined;
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
      attachAgentSessionEvents: async (_agentId, binding) => {
        sessionBinding = binding;
      },
      submitAgentMessage: async (_agentId, params) => {
        submitted.push(params);
        await sessionBinding?.emit({
          type: "daemon.event",
          sessionId: params.sessionId,
          messageId: params.messageId,
          streamId: params.streamId,
          acceptedAt: params.acceptedAt,
          msg: {
            id: params.messageId,
            type: "user_message",
            payload: {
              message: params.originalContent,
              displayText: params.content,
            },
          },
        });
        await sessionBinding?.emit({
          type: "daemon.event",
          sessionId: params.sessionId,
          msg: {
            id: "runtime_echo",
            type: "agent_message_delta",
            payload: { delta: `accepted ${params.content}` },
          },
        });
        await sessionBinding?.emit({
          type: "daemon.event",
          sessionId: params.sessionId,
          msg: {
            id: "runtime_complete",
            type: "turn_complete",
            payload: { lastAgentMessage: `accepted ${params.content}` },
          },
        });
      },
      stopAgent: async (agentId, reason) => {
        stops.push({ agentId, reason });
      },
    };
    const dispatcher = new AgenCDaemonJsonRpcDispatcher({
      agentManager: new AgenCDaemonAgentManager({
        defaultCwd: () => "/daemon",
        now: sequence(["2026-05-01T12:00:00.000Z", "2026-05-01T12:00:04.500Z"]),
        runner,
        sessionManager,
        broadcastSessionEvent: async (sessionId, event) => {
          await clientMultiplexer.broadcastSessionEvent(sessionId, event);
        },
      }),
      clientMultiplexer,
      createMessageId: sequence(["message_socket"]),
      now: sequence(["2026-05-01T12:00:03.500Z"]),
      initializeAuthenticator: (params) =>
        params.authCookie === "socket-cookie",
    });
    const connections = new Map<
      number,
      ReturnType<typeof dispatcher.createConnection>
    >();
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        let connection = connections.get(context.connectionId);
        if (connection === undefined) {
          connection = dispatcher.createConnection({
            sendNotification: (notification) => context.send(notification),
          });
          connections.set(context.connectionId, connection);
        }
        await context.send(await connection.dispatch(message));
      },
      onConnectionClosed: (connectionId) => {
        const connection = connections.get(connectionId);
        for (const clientId of connection?.trackedClientIds ?? []) {
          void clientMultiplexer.removeClient(clientId).catch(() => {});
        }
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

      const listIo = createIo();
      await expect(
        runAgenCAgentCli(
          { kind: "list" },
          {
            client: createAgenCJsonLineDaemonClient({
              socketPath,
              authCookie: "socket-cookie",
            }),
            ensureDaemonReady: async () => {},
            io: listIo,
          },
        ),
      ).resolves.toBe(0);
      expect(listIo.stdoutText()).toBe(
        [
          "id\tobjective\tstatus\tstarted_at\tlast_active_at",
          "agent_socket\tbackground compile\trunning\t2026-05-01T12:00:00.500Z\t2026-05-01T12:00:00.500Z",
          "",
        ].join("\n"),
      );

      const attachIo = createIo();
      await expect(
        runAgenCAgentCli(
          { kind: "attach", agentId: "agent_socket" },
          {
            client: createAgenCJsonLineDaemonClient({
              socketPath,
              authCookie: "socket-cookie",
            }),
            clientId: "tui_socket",
            ensureDaemonReady: async () => {},
            io: attachIo,
          },
        ),
      ).resolves.toBe(0);
      expect(attachIo.stdoutText()).toBe(
        [
          "agent_id\tsession_id\tattachment_id",
          "agent_socket\tsession_1\tattachment_socket",
          "",
        ].join("\n"),
      );

      const tuiClient = await createConnectedAgenCJsonLineDaemonTuiClient({
        socketPath,
        authCookie: "socket-cookie",
      });
      const liveEvents: unknown[] = [];
      try {
        await tuiClient.request("agent.attach", {
          agentId: "agent_socket",
          clientId: "tui_live",
        });
        const unsubscribe = tuiClient.subscribeToSessionEvents(
          "session_1",
          (event) => liveEvents.push(event),
        );
        await expect(
          tuiClient.request("message.stream", {
            sessionId: "session_1",
            content: "continue",
            streamId: "stream_socket",
          }),
        ).resolves.toEqual({
          messageId: "message_socket",
          streamId: "stream_socket",
          acceptedAt: "2026-05-01T12:00:03.500Z",
        });
        unsubscribe();
      } finally {
        await tuiClient.close();
      }
      expect(liveEvents).toEqual([
        {
          type: "daemon.event",
          sessionId: "session_1",
          messageId: "message_socket",
          streamId: "stream_socket",
          acceptedAt: "2026-05-01T12:00:03.500Z",
          msg: {
            type: "user_message",
            id: "message_socket",
            payload: {
              message: "continue",
              displayText: "continue",
            },
          },
        },
        {
          type: "daemon.event",
          sessionId: "session_1",
          msg: {
            id: "runtime_echo",
            type: "agent_message_delta",
            payload: { delta: "accepted continue" },
          },
        },
        {
          type: "daemon.event",
          sessionId: "session_1",
          msg: {
            id: "runtime_complete",
            type: "turn_complete",
            payload: { lastAgentMessage: "accepted continue" },
          },
        },
      ]);

      const stopIo = createIo();
      await expect(
        runAgenCAgentCli(
          { kind: "stop", agentId: "agent_socket" },
          {
            client: createAgenCJsonLineDaemonClient({
              socketPath,
              authCookie: "socket-cookie",
            }),
            ensureDaemonReady: async () => {},
            io: stopIo,
          },
        ),
      ).resolves.toBe(0);
      expect(stopIo.stdoutText()).toBe("agent_socket\tstopped\n");

      const stoppedListIo = createIo();
      await expect(
        runAgenCAgentCli(
          { kind: "list" },
          {
            client: createAgenCJsonLineDaemonClient({
              socketPath,
              authCookie: "socket-cookie",
            }),
            ensureDaemonReady: async () => {},
            io: stoppedListIo,
          },
        ),
      ).resolves.toBe(0);
      expect(stoppedListIo.stdoutText()).toBe("No active agents\n");
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }

    expect(io.stdoutText()).toBe("agent_socket\n");
    expect(starts).toMatchObject([
      {
        objective: "background compile",
        cwd: "/workspace",
        unattendedAllow: [],
        unattendedDeny: [],
      },
    ]);
    expect(stops).toEqual([
      { agentId: "agent_socket", reason: "agenc agent stop" },
    ]);
    expect(submitted).toEqual([
      {
        sessionId: "session_1",
        content: "continue",
        originalContent: "continue",
        messageId: "message_socket",
        streamId: "stream_socket",
        acceptedAt: "2026-05-01T12:00:03.500Z",
      },
    ]);
    await expect(sessionManager.getSession("session_1")).resolves.toMatchObject(
      {
        agentId: "agent_socket",
        status: "closed",
        closedAt: "2026-05-01T12:00:04.000Z",
        metadata: {
          objective: "background compile",
          source: "agent.start",
        },
      },
    );
  });

  it("buffers attach replay notifications until the TUI subscribes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-agent-attach-replay-"));
    const socketPath = join(dir, "daemon.sock");
    const replayEvent = {
      type: "daemon.event",
      sessionId: "session_replay",
      msg: {
        id: "event_before_subscribe",
        type: "agent_message_delta",
        payload: { delta: "already running" },
      },
    };
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        if (message.method === "initialize") {
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              type: "initialized",
              protocolVersion: "1.0.0",
              capabilities: {},
            },
          });
          return;
        }
        if (message.method === "agent.attach") {
          await context.send(replayEvent);
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              agentId: "agent_replay",
              attachmentId: "attachment_replay",
              sessionIds: ["session_replay"],
              sessions: [
                {
                  sessionId: "session_replay",
                  agentId: "agent_replay",
                  status: "idle",
                  createdAt: "2026-05-01T12:00:00.000Z",
                  cwd: "/daemon/workspace",
                },
              ],
            },
          });
        }
      },
    });

    await server.listen();
    const client = await createConnectedAgenCJsonLineDaemonTuiClient({
      socketPath,
      authCookie: "replay-cookie",
    });
    try {
      await expect(
        client.request("agent.attach", {
          agentId: "agent_replay",
          clientId: "tui_replay",
        }),
      ).resolves.toMatchObject({
        agentId: "agent_replay",
        sessionIds: ["session_replay"],
      });
      const received: unknown[] = [];
      const unsubscribe = client.subscribeToSessionEvents(
        "session_replay",
        (event) => received.push(event),
      );
      unsubscribe();

      expect(received).toEqual([replayEvent]);
    } finally {
      await client.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("exposes connection-level notifications to persistent TUI clients", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-agent-realtime-events-"));
    const socketPath = join(dir, "daemon.sock");
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        if (message.method === "initialize") {
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              type: "initialized",
              protocolVersion: "1.0.0",
              capabilities: {},
            },
          });
          return;
        }
        if (message.method === "thread/realtime/start") {
          await context.send({
            jsonrpc: "2.0",
            method: "thread/realtime/started",
            params: {
              threadId: "agent_realtime",
              realtimeSessionId: "rt_1",
              version: "v2",
            },
          });
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {},
          });
        }
      },
    });

    await server.listen();
    const client = await createConnectedAgenCJsonLineDaemonTuiClient({
      socketPath,
      authCookie: "realtime-cookie",
    });
    const notifications: unknown[] = [];
    const unsubscribe = client.subscribeToNotifications((event) => {
      notifications.push(event);
    });
    try {
      await expect(
        client.request("thread/realtime/start", {
          threadId: "agent_realtime",
          transport: { type: "websocket" },
          outputModality: "audio",
        }),
      ).resolves.toEqual({});
      expect(notifications).toEqual([
        {
          jsonrpc: "2.0",
          method: "thread/realtime/started",
          params: {
            threadId: "agent_realtime",
            realtimeSessionId: "rt_1",
            version: "v2",
          },
        },
      ]);
    } finally {
      unsubscribe();
      await client.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("disconnects persistent TUI clients on malformed daemon JSON lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-agent-bad-json-"));
    const socketPath = join(dir, "daemon.sock");
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        const message = JSON.parse(line) as { readonly id: number };
        socket.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              type: "initialized",
              protocolVersion: "1.0.0",
              capabilities: {},
            },
          })}\n`,
        );
        socket.write("{bad-json\n");
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(socketPath, resolve);
    });
    const client = await createConnectedAgenCJsonLineDaemonTuiClient({
      socketPath,
      authCookie: "bad-json-cookie",
      timeoutMs: 200,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(client.getConnectionState()).toMatchObject({
        status: "disconnected",
      });
      expect(client.getConnectionState().message).toContain("JSON");
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("times out persistent daemon requests that never receive responses", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-agent-request-timeout-"));
    const socketPath = join(dir, "daemon.sock");
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        if (message.method === "initialize") {
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              type: "initialized",
              protocolVersion: "1.0.0",
              capabilities: {},
            },
          });
        }
      },
    });

    await server.listen();
    const client = await createConnectedAgenCJsonLineDaemonTuiClient({
      socketPath,
      authCookie: "timeout-cookie",
      timeoutMs: 50,
    });
    try {
      await expect(
        client.request("thread/realtime/start", {
          threadId: "agent_timeout",
          transport: { type: "websocket" },
          outputModality: "audio",
        }),
      ).rejects.toThrow(
        "Timed out waiting for daemon response to thread/realtime/start",
      );
    } finally {
      await client.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("notifies persistent TUI clients when the daemon socket drops", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agenc-agent-connection-state-"));
    const socketPath = join(dir, "daemon.sock");
    const server = new AgenCUnixSocketServer({
      socketPath,
      onMessage: async (message, context) => {
        if (message.method === "initialize") {
          await context.send({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              type: "initialized",
              protocolVersion: "1.0.0",
              capabilities: {},
            },
          });
        }
      },
    });

    await server.listen();
    const client = await createConnectedAgenCJsonLineDaemonTuiClient({
      socketPath,
      authCookie: "state-cookie",
    });
    const states: unknown[] = [];
    const unsubscribe = client.subscribeToConnectionState((state) => {
      states.push(state);
    });
    try {
      await server.close();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      unsubscribe();
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }

    expect(states).toContainEqual({
      status: "disconnected",
      message: "Daemon connection closed",
    });
    expect(client.getConnectionState()).toEqual({
      status: "disconnected",
      message: "Daemon connection closed",
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
    const connections = new Map<
      number,
      ReturnType<typeof dispatcher.createConnection>
    >();
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
    expect(io.stderrText()).toContain(
      "Daemon connection closed before response",
    );
  });
});
