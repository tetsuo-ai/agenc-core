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

function codeMode<T>(result: { readonly codeModeResult?: unknown }): T {
  expect(result.codeModeResult).toBeDefined();
  return result.codeModeResult as T;
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
        "close_agent",
        "followup_task",
        "send_message",
        "list_agents",
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
        "TaskOutput",
        "TaskStop",
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
    expect(allNames).not.toContain("Agent");
    expect(allNames).not.toContain("SendMessage");
    expect(allNames).not.toContain("send_input");
    expect(allNames).not.toContain("resume_agent");
    expect(allNames).not.toContain("TeamCreate");
    expect(allNames).not.toContain("TeamDelete");

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
    expect(visibleNames).not.toContain("NotebookEdit");
    expect(visibleNames).not.toContain("TaskCreate");
    const waitAgentTool = registry.tools.find(
      (tool) => tool.name === "wait_agent",
    );
    expect(waitAgentTool?.timeoutBehavior).toBe("tool");
    expect(waitAgentTool?.timeoutMs).toBeUndefined();
    expect(waitAgentTool?.inputSchema).toMatchObject({
      properties: {
        timeout_ms: {
          description: expect.stringContaining(
            "Defaults to 30000, min 10000, max 3600000",
          ),
        },
      },
    });
    expect(
      registry.tools.find((tool) => tool.name === "spawn_agent")?.inputSchema,
    ).toMatchObject({
      required: ["message", "task_name"],
      additionalProperties: false,
    });
    expect(
      (
        registry.tools.find((tool) => tool.name === "spawn_agent")
          ?.inputSchema as { properties?: Record<string, unknown> } | undefined
      )?.properties,
    ).not.toHaveProperty("fork_context");
    expect(
      registry.tools.find((tool) => tool.name === "TaskCreate")?.inputSchema,
    ).toMatchObject({
      required: ["subject", "description"],
      additionalProperties: false,
    });
    expect(
      registry.tools.find((tool) => tool.name === "TaskCreate")?.inputSchema,
    ).not.toMatchObject({
      properties: { owner: expect.anything() },
    });
    expect(
      registry.tools.find((tool) => tool.name === "TaskGet")?.inputSchema,
    ).toMatchObject({
      required: ["taskId"],
      additionalProperties: false,
    });
    expect(
      registry.tools.find((tool) => tool.name === "TaskUpdate")?.inputSchema,
    ).toMatchObject({
      required: ["taskId"],
      additionalProperties: false,
      properties: {
        status: {
          enum: ["pending", "in_progress", "completed", "deleted"],
        },
        owner: { type: ["string", "null"] },
      },
    });
    expect(
      registry.tools.find((tool) => tool.name === "TaskList")?.inputSchema,
    ).toMatchObject({
      properties: {},
      additionalProperties: false,
    });
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
      });
      expect(created.content).toBe("Task #1 created successfully: Wire tools");
      const task = codeMode<{
        task: {
          id: string;
          owner?: string;
          status: string;
        };
      }>(created).task;
      expect(task.id).toMatch(/^\d+$/);
      expect(task.owner).toBeUndefined();
      expect(task.status).toBe("pending");

      const assigned = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        owner: "/root/task_3",
      });
      expect(assigned.content).toBe(`Updated task #${task.id} owner`);
      const assignedTask = codeMode<{
        task: {
          owner?: string;
        };
      }>(assigned).task;
      expect(assignedTask.owner).toBe("/root/task_3");

      const blocker = await byName.get("TaskCreate")!.execute({
        subject: "B",
        description: "Block Wire tools",
      });
      const blockerTask = codeMode<{
        task: { id: string };
      }>(blocker).task;

      const linked = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        addBlockedBy: [blockerTask.id, blockerTask.id],
      });
      const linkedTask = codeMode<{
        task: {
          blockedBy: readonly string[];
        };
      }>(linked).task;
      expect(linkedTask.blockedBy).toEqual([blockerTask.id]);

      // Auto-mirror under the list lock: blocker.blocks should now
      // contain task.id with no separate update call.
      const blockerAfter = await byName.get("TaskGet")!.execute({
        taskId: blockerTask.id,
      });
      expect(blockerAfter.content).toContain(`Task #${blockerTask.id}: B`);
      expect(
        codeMode<{ task: { blocks: readonly string[] } }>(blockerAfter).task
          .blocks,
      ).toEqual([task.id]);

      const listed = codeMode<{
        tasks: readonly {
          id: string;
          unresolvedBlockers: readonly string[];
        }[];
      }>(await byName.get("TaskList")!.execute({})).tasks;
      const tEntry = listed.find((t) => t.id === task.id);
      expect(tEntry?.unresolvedBlockers).toEqual([blockerTask.id]);

      const completed = await byName.get("TaskUpdate")!.execute({
        taskId: blockerTask.id,
        status: "completed",
      });
      expect(completed.content).toBe(`Updated task #${blockerTask.id} status`);
      expect(
        codeMode<{
          task: { status: string };
          statusChange: { from: string; to: string };
        }>(completed).task.status,
      ).toBe("completed");

      const refreshed = codeMode<{
        tasks: readonly {
          id: string;
          unresolvedBlockers: readonly string[];
        }[];
      }>(await byName.get("TaskList")!.execute({})).tasks;
      expect(
        refreshed.find((t) => t.id === task.id)?.unresolvedBlockers,
      ).toEqual([]);

      const metadataUpdated = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        metadata: { kept: 1, removeMe: "x" },
      });
      expect(
        codeMode<{ task: { metadata?: Record<string, unknown> } }>(
          metadataUpdated,
        ).task.metadata,
      ).toEqual({ kept: 1, removeMe: "x" });
      const metadataDeleted = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        metadata: { removeMe: null },
      });
      expect(
        codeMode<{ task: { metadata?: Record<string, unknown> } }>(
          metadataDeleted,
        ).task.metadata,
      ).toEqual({ kept: 1 });

      const deleted = await byName.get("TaskUpdate")!.execute({
        taskId: task.id,
        status: "deleted",
      });
      expect(deleted.content).toBe(`Deleted task #${task.id}`);
      expect(
        codeMode<{
          updatedFields: readonly string[];
          statusChange: { from: string; to: string };
        }>(deleted).updatedFields,
      ).toEqual(["deleted"]);

      const visibleAfterDelete = codeMode<{
        tasks: readonly { id: string }[];
      }>(await byName.get("TaskList")!.execute({})).tasks;
      expect(visibleAfterDelete.map((t) => t.id)).not.toContain(task.id);

      const got = await byName.get("TaskGet")!.execute({ taskId: task.id });
      expect(got.isError).toBe(true);
      expect(got.content).toBe("Task not found");

      const missing = await byName.get("TaskGet")!.execute({ taskId: "9999" });
      expect(missing.isError).toBe(true);
      expect(missing.content).toBe("Task not found");
      expect(codeMode<{ error: string }>(missing).error).toBe("Task not found");

      const badRef = await byName.get("TaskUpdate")!.execute({
        taskId: blockerTask.id,
        addBlocks: ["9999"],
      });
      expect(badRef.isError).toBe(true);
      expect(badRef.content).toBe("Unknown task reference");
      expect(codeMode<{ missing: readonly string[] }>(badRef).missing).toEqual([
        "9999",
      ]);
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

      await byName.get("TaskCreate")!.execute({
        subject: "auto-expand",
        description: "Check panel expansion",
      });
      expect(expansions).toEqual(["tasks"]);

      // TaskUpdate must NOT auto-expand (only create does).
      const task = codeMode<{ task: { id: string } }>(
        await byName.get("TaskCreate")!.execute({
          subject: "second",
          description: "Second task",
        }),
      ).task;
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
        .execute({ subject: "no-tui", description: "No TUI mounted" });
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

  it("rejects removed compatibility fields on strict agent tools", async () => {
    const tools = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: fakeSession,
    });
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const spawn = await byName.get("spawn_agent")!.execute({
      message: "inspect",
      task_name: "task_1",
      items: [{ text: "removed compatibility field" }],
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

    const wait = tools.find((tool) => tool.name === "wait_agent")!;
    const zeroTimeout = await wait.execute({ timeout_ms: 0 });
    expect(zeroTimeout.isError).toBe(true);
    expect(JSON.parse(zeroTimeout.content).error).toBe(
      "timeout_ms must be greater than zero",
    );

    const invalidRole = await spawnAgent.execute({
      message: "inspect",
      task_name: "task_1",
      agent_type: "missing-role",
      fork_turns: "none",
    });
    expect(invalidRole.isError).toBe(true);
    expect(JSON.parse(invalidRole.content).error).toBe(
      "unknown agent_type 'missing-role'",
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

  it("rejects over-depth spawn_agent before emitting lifecycle events", async () => {
    const session = fakeSession();
    (session.config as { agent_max_depth?: number }).agent_max_depth = 1;
    const emit = vi.fn();
    (session as unknown as { emit: typeof emit }).emit = emit;
    const control = {
      getLive: vi.fn((threadId: string) =>
        threadId === "child-1"
          ? {
              agentId: "child-1",
              agentPath: "/root/child_1",
              depth: 1,
              nickname: "Deckard",
              role: { name: "worker" },
              status: { value: { status: "running", turnId: "t", startedAtMs: 1 } },
            }
          : undefined,
      ),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const spawn = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "spawn_agent")!;

      const result = await spawn.execute({
        __agencSessionId: "child-1",
        message: "inspect",
        task_name: "grandchild",
        fork_turns: "none",
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toBe(
        "Agent depth limit reached. Solve the task yourself.",
      );
      expect(delegateMock).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
  });

  it("launches strict spawn_agent through the delegate runner and stores a joinable thread", async () => {
    const session = fakeSession();
    const counter = vi.fn();
    (session.services as unknown as { sessionTelemetry: unknown }).sessionTelemetry = {
      counter,
    };
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
      nickname: "Snowcrash",
      role: { name: "worker" },
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
      agent_type: "runner",
      fork_turns: "none",
    });

    expect(spawned.isError).not.toBe(true);
    expect(JSON.parse(spawned.content)).toEqual({
      task_name: "/root/task_1",
      nickname: "Snowcrash",
    });
    expect(delegateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        parent: session,
        parentPath: "/root",
        taskPrompt: "inspect",
        agentName: "task_1",
        role: "worker",
        runInBackground: true,
      }),
    );
    expect(counter).toHaveBeenCalledWith("agenc.multi_agent.spawn", 1, [
      ["role", "worker"],
    ]);

    expect(byName.has("TaskOutput")).toBe(true);
    expect(join).toHaveBeenCalledTimes(1);
  });

  it("hides spawn_agent nickname metadata when configured", async () => {
    const session = fakeSession();
    (session.config as unknown as { multiAgentV2: unknown }).multiAgentV2 = {
      hideSpawnAgentMetadata: true,
    };
    delegateMock.mockResolvedValue({
      kind: "async_launched",
      thread: {
        live: {
          agentId: "550e8400-e29b-41d4-a716-446655440000",
          agentPath: "/root/task_1",
          nickname: "Snowcrash",
          role: { name: "default" },
          status: {
            value: {
              status: "running",
              turnId: "turn-1",
              startedAtMs: 1,
            },
          },
        },
        join: vi.fn(),
      },
    });

    const spawn = createModelFacingTools({
      workspaceRoot: process.cwd(),
      getSession: () => session,
    }).find((tool) => tool.name === "spawn_agent")!;

    const result = await spawn.execute({
      message: "inspect",
      task_name: "task_1",
      fork_turns: "none",
    });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content)).toEqual({ task_name: "/root/task_1" });
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

  it("send_message emits the interaction end event after delivery failure", async () => {
    const session = fakeSession();
    const emitted: unknown[] = [];
    (session as unknown as { emit: typeof session.emit }).emit = (event) => {
      emitted.push(event);
    };
    const control = {
      getLive: vi.fn((threadId: string) =>
        threadId === "agent-1"
          ? {
              agentId: "agent-1",
              agentPath: "/root/task_1",
              nickname: "TaskOne",
              role: { name: "worker" },
              metadata: {
                agentId: "agent-1",
                agentPath: "/root/task_1",
                agentNickname: "TaskOne",
                agentRole: "worker",
              },
            }
          : undefined,
      ),
      getAgentMetadata: vi.fn(() => ({
        agentId: "agent-1",
        agentPath: "/root/task_1",
        agentNickname: "TaskOne",
        agentRole: "worker",
      })),
      resolveAgentReference: vi.fn(() => "agent-1"),
      sendInterAgentCommunication: vi.fn(async () => {
        throw new Error("agent with id agent-1 is closed");
      }),
      getStatus: vi.fn(async () => ({ status: "shutdown" as const })),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const tools = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      });
      const result = await tools.find((tool) => tool.name === "send_message")!.execute({
        target: "/root/task_1",
        message: "hello",
      });

      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content).error).toBe(
        "agent with id agent-1 is closed",
      );
      expect(
        emitted.map((event) => (event as { msg: { type: string } }).msg.type),
      ).toEqual([
        "collab_agent_interaction_begin",
        "collab_agent_interaction_end",
      ]);
      expect(
        (emitted[1] as { msg: { payload: { status: unknown } } }).msg.payload.status,
      ).toEqual({ status: "shutdown" });
    } finally {
      _clearAgentControlCacheForTesting();
    }
  });

  it("list_agents returns AgenC V2 snake_case entries only", async () => {
    const session = fakeSession();
    const control = {
      listAgents: vi.fn(() => [
        {
          agentName: "/root",
          agentStatus: { status: "pending_init" },
          lastTaskMessage: "Main thread",
        },
        {
          agentName: "/root/worker",
          agentStatus: {
            status: "completed",
            turnId: "t",
            endedAtMs: 1,
            lastMessage: "done",
          },
          lastTaskMessage: "inspect",
        },
      ]),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const byName = new Map(
        createModelFacingTools({
          workspaceRoot: process.cwd(),
          getSession: () => session,
        }).map((tool) => [tool.name, tool]),
      );

      const roleFiltered = await byName.get("list_agents")!.execute({
        role: "worker",
      });
      expect(roleFiltered.isError).toBe(true);
      expect(JSON.parse(roleFiltered.content).error).toBe("unknown field `role`");

      const result = await byName.get("list_agents")!.execute({});
      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual({
        agents: [
          {
            agent_name: "/root",
            agent_status: "pending_init",
            last_task_message: "Main thread",
          },
          {
            agent_name: "/root/worker",
            agent_status: { completed: "done" },
            last_task_message: "inspect",
          },
        ],
      });
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
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

  it("close_agent emits receiver nickname and role metadata", async () => {
    const session = fakeSession();
    const emit = vi.fn();
    (session as unknown as { emit: typeof emit }).emit = emit;
    const status = {
      status: "running" as const,
      turnId: "turn-1",
      startedAtMs: 1,
    };
    const control = {
      resolveAgentReference: vi.fn(() => "550e8400-e29b-41d4-a716-446655440003"),
      getLive: vi.fn(() => ({
        agentId: "550e8400-e29b-41d4-a716-446655440003",
        agentPath: "/root/live",
        nickname: "Neuromancer",
        role: { name: "worker" },
        status: { value: status },
      })),
      getAgentMetadata: vi.fn(() => ({
        agentId: "550e8400-e29b-41d4-a716-446655440003",
        agentPath: "/root/live",
        agentNickname: "Neuromancer",
        agentRole: "worker",
        depth: 1,
      })),
      shutdown: vi.fn(),
    };
    _setAgentControlForTesting(session, {
      control: control as never,
      registry: {} as never,
    });
    try {
      const close = createModelFacingTools({
        workspaceRoot: process.cwd(),
        getSession: () => session,
      }).find((tool) => tool.name === "close_agent")!;

      const result = await close.execute({ target: "/root/live" });

      expect(result.isError).toBeUndefined();
      expect(JSON.parse(result.content)).toEqual({ previous_status: "running" });
      expect(emit.mock.calls.map((call) => call[0].msg.payload)).toEqual([
        expect.objectContaining({
          receiverAgentNickname: "Neuromancer",
          receiverAgentRole: "worker",
        }),
        expect.objectContaining({
          receiverAgentNickname: "Neuromancer",
          receiverAgentRole: "worker",
          status,
        }),
      ]);
    } finally {
      _clearAgentControlCacheForTesting(session);
    }
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
