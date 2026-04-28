import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../session/session.js";
import { createModelFacingTools } from "./model-facing-tools.js";
import { buildBootstrapToolRegistry } from "./bootstrap-tool-registry.js";

const { delegateMock } = vi.hoisted(() => ({
  delegateMock: vi.fn(),
}));

vi.mock("../agents/delegate.js", () => ({
  delegate: delegateMock,
}));

function fakeMcpManager() {
  return {
    getTools: () => [],
    effectiveServers: async () => new Map(),
    toolPluginProvenance: async () => null,
    getResources: async () => [
      {
        serverName: "demo",
        uri: "resource://one",
        namespacedName: "mcp.demo.resource://one",
      },
    ],
    getResourcesByServer: async (server: string) => [
      {
        serverName: server,
        uri: "resource://one",
        namespacedName: `mcp.${server}.resource://one`,
      },
    ],
    readResource: async (name: string) => ({
      uri: name,
      text: "resource body",
      truncated: false,
      bytesReturned: 13,
    }),
  };
}

function fakeSession(): Session {
  return {
    conversationId: "session-test",
    config: {
      cwd: process.cwd(),
    },
    sessionConfiguration: {
      cwd: process.cwd(),
      collaborationMode: {
        model: "test-model",
        reasoningEffort: "medium",
      },
    },
    childInboxes: new Map(),
    mailbox: {
      hasPending: () => false,
      send: () => 1,
    },
    services: {
      mcpManager: fakeMcpManager(),
      skillsManager: {
        skillsForConfig: async () => ({
          invokedSkills: ["demo-skill"],
          availableSkills: [
            {
              name: "demo-skill",
              description: "Demo skill",
              path: join(tmpdir(), "missing-skill.md"),
              root: tmpdir(),
              scope: "user",
            },
          ],
        }),
      },
    },
    emit: () => {},
    nextInternalSubId: () => "event-1",
    eventLog: { emit: (event: unknown) => event },
  } as unknown as Session;
}

describe("model-facing tools", () => {
  beforeEach(() => {
    delegateMock.mockReset();
  });

  it("registers the requested product tools and omits raw system HTTP tools", () => {
    const registry = buildBootstrapToolRegistry({
      workspaceRoot: process.cwd(),
      agencHome: join(tmpdir(), "agenc-tools-test"),
      mcpManager: fakeMcpManager() as never,
      getSession: () => null,
      emitWarning: () => {},
    });

    const allNames = registry.tools.map((tool) => tool.name);
    expect(allNames).toEqual(
      expect.arrayContaining([
        "WebFetch",
        "WebSearch",
        "spawn_agent",
        "wait_agent",
        "resume_agent",
        "close_agent",
        "followup_task",
        "send_input",
        "send_message",
        "list_agents",
        "Agent",
        "TaskOutput",
        "TaskStop",
        "SendMessage",
        "Skill",
        "ListMcpResourcesTool",
        "ReadMcpResourceTool",
        "ListMcpResources",
        "ReadMcpResource",
        "NotebookEdit",
        "LSP",
        "TaskCreate",
        "TaskGet",
        "TaskUpdate",
        "TaskList",
        "CronCreate",
        "CronDelete",
        "CronList",
        "WorkflowTool",
        "Brief",
        "SendUserMessage",
        "VerifyPlanExecution",
      ]),
    );
    expect(allNames.some((name) => name.startsWith("system.http"))).toBe(false);

    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);
    expect(visibleNames).toEqual(
      expect.arrayContaining([
        "WebFetch",
        "WebSearch",
        "Skill",
        "spawn_agent",
        "followup_task",
        "send_message",
        "wait_agent",
        "close_agent",
        "list_agents",
      ]),
    );
    expect(allNames).not.toContain("system.agent.delegate");
    expect(visibleNames).not.toContain("system.agent.delegate");
    expect(visibleNames).not.toContain("resume_agent");
    expect(visibleNames).not.toContain("send_input");
    expect(visibleNames).not.toContain("NotebookEdit");
    expect(visibleNames).not.toContain("TaskCreate");
  });

  it("persists TaskCreate/TaskGet/TaskUpdate/TaskList in the AgenC state dir", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-tool-home-"));
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        agencHome: home,
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      const created = await byName.get("TaskCreate")!.execute({
        subject: "Wire tools",
        description: "Add missing model-facing tools",
      });
      const task = JSON.parse(created.content).task as { id: string };

      const updated = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        status: "completed",
      });
      expect(JSON.parse(updated.content).task.status).toBe("completed");

      const got = await byName.get("TaskGet")!.execute({ taskId: task.id });
      expect(JSON.parse(got.content).task.subject).toBe("Wire tools");

      const listed = await byName.get("TaskList")!.execute({
        status: "completed",
      });
      expect(JSON.parse(listed.content).tasks).toHaveLength(1);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("lists and reads MCP resources through the live session manager", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const listed = await byName.get("ListMcpResourcesTool")!.execute({});
    expect(JSON.parse(listed.content).resources[0].serverName).toBe("demo");

    const read = await byName.get("ReadMcpResourceTool")!.execute({
      server: "demo",
      uri: "resource://one",
    });
    expect(JSON.parse(read.content).resource.text).toBe("resource body");
  });

  it("rejects legacy fields on strict Codex v2 agent tools", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const spawn = await byName.get("spawn_agent")!.execute({
      message: "inspect",
      task_name: "task_1",
      items: [{ text: "legacy" }],
    });
    expect(spawn.isError).toBe(true);
    expect(JSON.parse(spawn.content).error).toContain("unknown field `items`");

    const send = await byName.get("send_message")!.execute({
      target: "/root/task_1",
      message: "hello",
      interrupt: true,
    });
    expect(send.isError).toBe(true);
    expect(JSON.parse(send.content).error).toContain("unknown field `interrupt`");

    const followup = await byName.get("followup_task")!.execute({
      target: "/root/task_1",
      message: "hello",
      items: [],
    });
    expect(followup.isError).toBe(true);
    expect(JSON.parse(followup.content).error).toContain("unknown field `items`");
  });

  it("rejects invalid strict spawn_agent arguments before delegation", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const spawnAgent = tools.find((tool) => tool.name === "spawn_agent")!;

    const missingTaskName = await spawnAgent.execute({ message: "inspect" });
    expect(missingTaskName.isError).toBe(true);
    expect(JSON.parse(missingTaskName.content).error).toBe("task_name is required");

    const forkContext = await spawnAgent.execute({
      message: "inspect",
      task_name: "task_1",
      fork_context: true,
    });
    expect(forkContext.isError).toBe(true);
    expect(JSON.parse(forkContext.content).error).toContain(
      "fork_context is not supported",
    );

    const forkTurns = await spawnAgent.execute({
      message: "inspect",
      task_name: "task_1",
      fork_turns: "0",
    });
    expect(forkTurns.isError).toBe(true);
    expect(JSON.parse(forkTurns.content).error).toBe(
      "fork_turns must be `none`, `all`, or a positive integer string",
    );
  });

  it("launches strict spawn_agent through the delegate runner and stores a joinable thread", async () => {
    const session = fakeSession();
    let status:
      | {
          status: "running";
          turnId: string;
          startedAtMs: number;
        }
      | {
          status: "completed";
          turnId: string;
          endedAtMs: number;
          lastMessage: string;
        } = {
      status: "running" as const,
      turnId: "turn-1",
      startedAtMs: 1,
    };
    const join = vi.fn(async () => ({
      threadId: "thread-1",
      durationMs: 7,
      outcome: "completed",
      finalMessage: "done",
    }));
    const live = {
      agentId: "thread-1",
      agentPath: "/root/task_1",
      nickname: "Euclid",
      role: { name: "default" },
      status: {
        get value() {
          return status;
        },
      },
    };
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live,
        join,
      },
    });

    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const spawned = await byName.get("spawn_agent")!.execute({
      message: "inspect",
      task_name: "task_1",
      fork_turns: "none",
    });

    expect(spawned.isError).not.toBe(true);
    expect(JSON.parse(spawned.content)).toEqual({
      task_name: "/root/task_1",
      nickname: "Euclid",
    });
    expect(delegateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: session,
        parentPath: "/root",
        taskPrompt: "inspect",
        agentName: "task_1",
        forkMode: { kind: "new" },
        runInBackground: true,
      }),
    );

    status = {
      status: "completed" as const,
      turnId: "turn-1",
      endedAtMs: 2,
      lastMessage: "done",
    };
    const output = await byName.get("TaskOutput")!.execute({
      target: "thread-1",
      timeout_ms: 0,
    });
    expect(join).toHaveBeenCalledOnce();
    expect(JSON.parse(output.content).status["thread-1:result"]).toMatchObject({
      outcome: "completed",
      finalMessage: "done",
    });
  });

  it("rejects empty v2 agent messages before dispatch", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const result = await byName.get("send_message")!.execute({
      target: "/root/task_1",
      message: "   ",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toBe(
      "Empty message can't be sent to an agent",
    );
  });

  it("does not fall back to raw unresolved agent targets", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const result = await byName.get("send_message")!.execute({
      target: "missing_child",
      message: "hello",
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain(
      "agent reference cannot be resolved",
    );
  });

  it("rejects closing the root agent", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const close = tools.find((tool) => tool.name === "close_agent")!;

    const result = await close.execute({ target: "/root" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toBe("root is not a spawned agent");
  });

  it("edits notebook cells structurally", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "agenc-notebook-ws-"));
    try {
      const notebookPath = join(workspace, "demo.ipynb");
      await writeFile(
        notebookPath,
        JSON.stringify({
          cells: [
            {
              cell_type: "code",
              id: "cell-a",
              metadata: {},
              source: "print('old')\n",
              execution_count: null,
              outputs: [],
            },
          ],
          metadata: {},
          nbformat: 4,
          nbformat_minor: 5,
        }),
        "utf8",
      );

      const tool = createModelFacingTools({
        workspaceRoot: workspace,
        getSession: () => null,
      }).find((candidate) => candidate.name === "NotebookEdit")!;

      const result = await tool.execute({
        notebook_path: notebookPath,
        cell_id: "cell-a",
        new_source: "print('new')",
      });

      expect(result.isError).toBeUndefined();
      const updated = JSON.parse(await readFile(notebookPath, "utf8"));
      expect(updated.cells[0].source).toBe("print('new')\n");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
