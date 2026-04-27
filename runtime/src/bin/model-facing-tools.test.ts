import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session } from "../session/session.js";
import { createModelFacingTools } from "./model-facing-tools.js";
import { buildBootstrapToolRegistry } from "./bootstrap-tool-registry.js";

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
  } as unknown as Session;
}

describe("model-facing tools", () => {
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
      expect.arrayContaining(["WebFetch", "WebSearch", "Skill", "spawn_agent"]),
    );
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
