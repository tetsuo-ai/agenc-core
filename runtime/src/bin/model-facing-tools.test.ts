import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../session/session.js";
import { createModelFacingTools } from "./model-facing-tools.js";
import { buildBootstrapToolRegistry } from "./bootstrap-tool-registry.js";
import { _clearAgentControlCacheForTesting, _setAgentControlForTesting } from "./delegate-tool.js";

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
        resolveSkill: async (name: string) =>
          name === "demo-skill"
            ? {
                name: "demo-skill",
                description: "Demo skill",
                path: join(tmpdir(), "demo-skill", "SKILL.md"),
                root: join(tmpdir(), "demo-skill"),
                scope: "user",
                allowedTools: [],
              }
            : null,
        renderSkill: async ({ name, args }: { name: string; args?: string }) =>
          name === "demo-skill"
            ? {
                skill: {
                  name: "demo-skill",
                  description: "Demo skill",
                  path: join(tmpdir(), "demo-skill", "SKILL.md"),
                  root: join(tmpdir(), "demo-skill"),
                  scope: "user",
                  allowedTools: [],
                },
                content: `Demo content${args ? ` ${args}` : ""}`,
              }
            : null,
        recordInvokedSkill: () => {},
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
        "StructuredOutput",
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

  it("persists TaskCreate/TaskGet/TaskUpdate/TaskList against the per-project task board", async () => {
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
        owner: "/root/task_3",
      });
      const task = JSON.parse(created.content).task as {
        id: string;
        owner?: string;
        status: string;
      };
      expect(task.id).toMatch(/^\d+$/);
      expect(task.owner).toBe("/root/task_3");
      expect(task.status).toBe("pending");

      const blocker = await byName.get("TaskCreate")!.execute({ subject: "B" });
      const blockerTask = JSON.parse(blocker.content).task as { id: string };

      const linked = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        addBlockedBy: [blockerTask.id, blockerTask.id],
      });
      const linkedTask = JSON.parse(linked.content).task as {
        blockedBy: readonly string[];
      };
      expect(linkedTask.blockedBy).toEqual([blockerTask.id]);

      // Auto-mirror under the list lock: blocker.blocks should now
      // contain task.id with no separate update call.
      const blockerAfter = await byName.get("TaskGet")!.execute({
        taskId: blockerTask.id,
      });
      expect(JSON.parse(blockerAfter.content).task.blocks).toEqual([task.id]);

      const listed = JSON.parse(
        (await byName.get("TaskList")!.execute({})).content,
      ).tasks as readonly {
        id: string;
        unresolvedBlockers: readonly string[];
      }[];
      const tEntry = listed.find((t) => t.id === task.id);
      expect(tEntry?.unresolvedBlockers).toEqual([blockerTask.id]);

      const completed = await byName.get("TaskUpdate")!.execute({
        taskId: blockerTask.id,
        status: "completed",
      });
      expect(JSON.parse(completed.content).task.status).toBe("completed");

      const refreshed = JSON.parse(
        (await byName.get("TaskList")!.execute({})).content,
      ).tasks as readonly {
        id: string;
        unresolvedBlockers: readonly string[];
      }[];
      expect(
        refreshed.find((t) => t.id === task.id)?.unresolvedBlockers,
      ).toEqual([]);

      const tombstoned = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        status: "deleted",
      });
      expect(JSON.parse(tombstoned.content).task.status).toBe("deleted");

      const visibleAfterDelete = JSON.parse(
        (await byName.get("TaskList")!.execute({})).content,
      ).tasks as readonly { id: string }[];
      expect(visibleAfterDelete.map((t) => t.id)).not.toContain(task.id);

      const got = await byName.get("TaskGet")!.execute({ taskId: task.id });
      expect(got.isError).toBeUndefined();
      expect(JSON.parse(got.content).task.subject).toBe("Wire tools");

      const missing = await byName.get("TaskGet")!.execute({ taskId: "9999" });
      expect(missing.isError).toBe(true);
      expect(JSON.parse(missing.content).error).toBe("Task not found");

      const badRef = await byName.get("TaskUpdate")!.execute({
        taskId: blockerTask.id,
        addBlocks: ["9999"],
      });
      expect(badRef.isError).toBe(true);
      expect(JSON.parse(badRef.content).missing).toEqual(["9999"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("TaskCreate auto-expands the tasks panel via the appStateBridge", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-tool-home-"));
    try {
      const expansions: Array<"none" | "tasks"> = [];
      const session = {
        appStateBridge: {
          setExpandedView: (next: "none" | "tasks") => expansions.push(next),
        },
      } as unknown as Session;
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        agencHome: home,
        getSession: () => session,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));

      await byName.get("TaskCreate")!.execute({ subject: "auto-expand" });
      expect(expansions).toEqual(["tasks"]);

      // TaskUpdate must NOT auto-expand (only create does).
      const task = JSON.parse(
        (
          await byName.get("TaskCreate")!.execute({ subject: "second" })
        ).content,
      ).task as { id: string };
      expansions.length = 0;
      await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        status: "in_progress",
      });
      expect(expansions).toEqual([]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("TaskCreate is a no-op for the bridge when the TUI is not mounted", async () => {
    const home = await mkdtemp(join(tmpdir(), "agenc-tool-home-"));
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        agencHome: home,
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const result = await byName
        .get("TaskCreate")!
        .execute({ subject: "no-tui" });
      expect(result.isError).toBeUndefined();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("WebFetch renders HTML through Turndown and reports preapproved hosts", async () => {
    const html =
      "<!doctype html><html><head><title>x</title><style>body{}</style></head><body>" +
      "<h1>Hello</h1>" +
      "<p>This is a <strong>test</strong> with a <a href=\"https://example.com\">link</a>.</p>" +
      "<ul><li>one</li><li>two</li></ul>" +
      "<script>alert('x')</script>" +
      "</body></html>";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://docs.python.org/3/library/asyncio.html",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "text/html; charset=utf-8" : null,
      },
      text: async () => html,
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const result = await byName.get("WebFetch")!.execute({
        url: "https://docs.python.org/3/library/asyncio.html",
      });
      expect(result.isError).toBeUndefined();
      const parsed = JSON.parse(result.content);
      expect(parsed.preapproved).toBe(true);
      expect(parsed.rendered_as).toBe("markdown");
      expect(parsed.content).toContain("# Hello");
      expect(parsed.content).toContain("**test**");
      expect(parsed.content).toContain("[link](https://example.com)");
      // List bullet rendered with the configured "-" marker.
      expect(parsed.content).toMatch(/-\s+one/);
      // Scripts and styles must not leak into the markdown.
      expect(parsed.content).not.toContain("alert");
      expect(parsed.content).not.toContain("<style>");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("WebFetch flags non-preapproved hosts as preapproved=false", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      url: "https://random.example.com/page",
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "text/plain" : null,
      },
      text: async () => "plain body",
    });
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => null,
      });
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const result = await byName.get("WebFetch")!.execute({
        url: "https://random.example.com/page",
      });
      const parsed = JSON.parse(result.content);
      expect(parsed.preapproved).toBe(false);
      expect(parsed.rendered_as).toBe("passthrough");
      expect(parsed.content).toBe("plain body");
    } finally {
      globalThis.fetch = previousFetch;
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

  it("loads skills through the Skill tool and records invocations", async () => {
    const recordInvokedSkill = vi.fn();
    const session = fakeSession();
    (session.services.skillsManager as {
      recordInvokedSkill?: typeof recordInvokedSkill;
    }).recordInvokedSkill = recordInvokedSkill;
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    });
    const skill = tools.find((tool) => tool.name === "Skill")!;

    const result = await skill.execute({
      skill: "demo-skill",
      args: "focus",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("<command-name>demo-skill</command-name>");
    expect(result.content).toContain("Demo content focus");
    expect(recordInvokedSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        skillName: "demo-skill",
      }),
    );
  });

  it("rejects model-disabled skills", async () => {
    const session = fakeSession();
    (session.services.skillsManager as {
      renderSkill?: (opts: { name: string }) => Promise<unknown>;
    }).renderSkill = async () => ({
      skill: {
        name: "debug",
        path: "/skills/debug/SKILL.md",
        root: "/skills/debug",
        scope: "bundled",
        disableModelInvocation: true,
      },
      content: "debug",
    });
    const skill = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    }).find((tool) => tool.name === "Skill")!;

    const result = await skill.execute({ skill: "debug" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toContain("not model-invocable");
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

  it("resume_agent returns live status using the Codex id shape", async () => {
    const session = fakeSession();
    const emit = vi.fn();
    (session as unknown as { emit: typeof emit }).emit = emit;
    const status = {
      status: "running" as const,
      turnId: "turn-1",
      startedAtMs: 1,
    };
    const control = {
      getLive: vi.fn(() => ({
        agentId: "thread-live",
        agentPath: "/root/live",
        nickname: "Euclid",
        role: { name: "default" },
        status: { value: status },
        metadata: {
          agentId: "thread-live",
          agentPath: "/root/live",
          agentNickname: "Euclid",
          agentRole: "default",
          depth: 1,
        },
      })),
      getAgentMetadata: vi.fn(() => ({
        agentId: "thread-live",
        agentPath: "/root/live",
        agentNickname: "Euclid",
        agentRole: "default",
        depth: 1,
      })),
      getStatus: vi.fn(async () => status),
      resumeAgentFromRollout: vi.fn(),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const resume = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "resume_agent")!;

      const result = await resume.execute({ id: "thread-live" });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual({ status });
      expect(control.resumeAgentFromRollout).not.toHaveBeenCalled();
      expect(emit.mock.calls.map((call) => call[0].msg.type)).toEqual([
        "collab_resume_begin",
        "collab_resume_end",
      ]);
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("resume_agent reopens a closed rollout-backed agent", async () => {
    const session = fakeSession();
    const statuses = [
      { status: "not_found" as const },
      { status: "pending_init" as const },
    ];
    const rootLive = {
      agentId: "thread-closed",
      agentPath: "/root/closed",
      nickname: "Noether",
      role: { name: "worker" },
      status: { value: statuses[1] },
      metadata: {
        agentId: "thread-closed",
        agentPath: "/root/closed",
        agentNickname: "Noether",
        agentRole: "worker",
        depth: 1,
      },
    };
    const control = {
      getLive: vi.fn(() => undefined),
      getAgentMetadata: vi.fn(() => undefined),
      getStatus: vi
        .fn()
        .mockResolvedValueOnce(statuses[0])
        .mockResolvedValue(statuses[1]),
      resumeAgentFromRollout: vi.fn(async () => ({
        resumedCount: 1,
        rootLive,
      })),
    };
    (session as unknown as { rolloutStore: unknown }).rolloutStore = {
      getThreadSpawnEdge: () => ({
        childThreadId: "thread-closed",
        parentPath: "/root",
        metadata: rootLive.metadata,
      }),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const resume = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "resume_agent")!;

      const result = await resume.execute({ id: "thread-closed" });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual({ status: statuses[1] });
      expect(control.resumeAgentFromRollout).toHaveBeenCalledWith({
        rootThreadId: "thread-closed",
        parentPath: "/root",
        metadata: rootLive.metadata,
      });
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
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
