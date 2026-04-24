import { describe, expect, test } from "vitest";
import { buildToolRegistry } from "./tool-registry.js";
import { PermissionModeRegistry } from "./permissions/mode.js";
import { createEmptyToolPermissionContext } from "./permissions/types.js";
import type { Tool } from "./tools/types.js";

describe("T7 tool-registry ConcurrencyClass tagging", () => {
  test("read-only fs tools get SharedRead + isReadOnly=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const readFile = registry.tools.find((t) => t.name === "system.readFile");
    expect(readFile?.concurrencyClass?.kind).toBe("shared_read");
    expect(readFile?.isReadOnly).toBe(true);
    expect(readFile?.supportsParallelToolCalls).toBe(true);
  });

  test("write fs tools get Exclusive + requiresApproval=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const writeFile = registry.tools.find((t) => t.name === "system.writeFile");
    expect(writeFile?.concurrencyClass?.kind).toBe("exclusive");
    expect(writeFile?.requiresApproval).toBe(true);
    expect(writeFile?.supportsParallelToolCalls).toBe(false);
  });

  test("apply_patch gets Exclusive + requiresApproval=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const applyPatch = registry.tools.find((t) => t.name === "apply_patch");
    expect(applyPatch?.concurrencyClass?.kind).toBe("exclusive");
    expect(applyPatch?.requiresApproval).toBe(true);
    expect(applyPatch?.supportsParallelToolCalls).toBe(false);
  });

  test("bash tool gets BackgroundTerminal + requiresApproval=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const bash = registry.tools.find((t) => t.name === "system.bash");
    expect(bash?.concurrencyClass?.kind).toBe("background_terminal");
    expect(bash?.requiresApproval).toBe(true);
  });
});

describe("tool-registry dynamic and deferred catalog", () => {
  test("coding and planning tools are visible while heavy catalog entries stay deferred", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const registeredNames = registry.tools.map((tool) => tool.name);
    expect(registeredNames).toContain("system.gitStatus");
    expect(registeredNames).toContain("system.symbolSearch");
    expect(registeredNames).toContain("system.repoInventory");
    expect(registeredNames).toContain("TodoWrite");
    expect(registeredNames).toContain("EnterPlanMode");
    expect(registeredNames).toContain("ExitPlanMode");
    expect(registeredNames).toContain("workflow.enterPlan");
    expect(registeredNames).toContain("workflow.exitPlan");

    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);
    expect(visibleNames).toContain("update_plan");
    expect(visibleNames).toContain("apply_patch");
    expect(visibleNames).toContain("TodoWrite");
    expect(visibleNames).toContain("EnterPlanMode");
    expect(visibleNames).toContain("ExitPlanMode");
    expect(visibleNames).toContain("system.searchTools");
    expect(visibleNames).not.toContain("system.gitStatus");
    expect(visibleNames).not.toContain("system.symbolSearch");
    expect(visibleNames).not.toContain("system.repoInventory");
    expect(visibleNames).not.toContain("workflow.enterPlan");
  });

  test("searchTools supports OpenClaude-style select:<tool> loading", async () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });

    const result = await registry.dispatch({
      id: "search-select-1",
      name: "system.searchTools",
      arguments: JSON.stringify({ query: "select:system.gitStatus" }),
    });

    const body = JSON.parse(result.content) as {
      loaded: string[];
      results: Array<{ name: string; selected: boolean }>;
    };
    expect(body.loaded).toContain("system.gitStatus");
    expect(body.results).toContainEqual(
      expect.objectContaining({ name: "system.gitStatus", selected: true }),
    );
    expect(registry.getDiscoveredToolNames?.().has("system.gitStatus")).toBe(true);
    expect(registry.toLLMTools().map((tool) => tool.function.name)).toContain(
      "system.gitStatus",
    );
  });

  test("update_plan is the primary plan tool and TodoWrite is a visible compatibility alias", async () => {
    const emittedPlans: unknown[] = [];
    const writtenPlans: string[] = [];
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        writePlan: async (content) => {
          writtenPlans.push(content);
        },
        emitPlanUpdated: (state) => {
          emittedPlans.push(state);
        },
      },
    });

    const update = await registry.dispatch({
      id: "plan-1",
      name: "update_plan",
      arguments: JSON.stringify({
        explanation: "wire tools",
        plan: [
          { step: "Inspect registry", status: "completed" },
          { step: "Add compatibility alias", status: "in_progress" },
        ],
      }),
    });
    expect(update.isError).toBeUndefined();
    expect(writtenPlans[0]).toContain("# AgenC Plan");
    expect(writtenPlans[0]).toContain("- [x] Inspect registry");
    expect(writtenPlans[0]).toContain("- [-] Add compatibility alias");
    expect(JSON.parse(update.content)).toMatchObject({
      message: "Plan updated.",
      explanation: "wire tools",
      plan: [
        { step: "Inspect registry", status: "completed" },
        { step: "Add compatibility alias", status: "in_progress" },
      ],
    });
    expect(emittedPlans).toHaveLength(1);

    const todo = await registry.dispatch({
      id: "todo-1",
      name: "TodoWrite",
      arguments: JSON.stringify({
        todos: [
          { content: "Ship alias", status: "completed" },
          { content: "Run tests", status: "pending" },
        ],
      }),
    });
    expect(todo.isError).toBeUndefined();
    expect(writtenPlans[1]).toContain("- [x] Ship alias");
    expect(writtenPlans[1]).toContain("- [ ] Run tests");
    expect(JSON.parse(todo.content)).toMatchObject({
      message: "Todo list updated through update_plan compatibility state.",
      plan: [
        { step: "Ship alias", status: "completed" },
        { step: "Run tests", status: "pending" },
      ],
    });
    expect(emittedPlans).toHaveLength(2);
  });

  test("OpenClaude-style EnterPlanMode/ExitPlanMode drive the live permission-mode registry", async () => {
    const permissionRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "acceptEdits" }),
    );
    const warnings: string[] = [];
    let syncCount = 0;
    let exited = false;
    let plan = "# Plan\n\nDo it.";
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        getPermissionModeRegistry: () => permissionRegistry,
        syncPermissionContext: async () => {
          syncCount += 1;
        },
        emitWarning: (cause) => {
          warnings.push(cause);
        },
        emitPlanExited: () => {
          exited = true;
        },
        getPlanFilePath: () => "/tmp/agenc/plans/plan.md",
        readPlan: () => plan,
        writePlan: async (content) => {
          plan = content;
        },
      },
    });

    const entered = await registry.dispatch({
      id: "enter-plan",
      name: "EnterPlanMode",
      arguments: "{}",
    });
    expect(entered.isError).toBeUndefined();
    expect(entered.content).toContain("Entered plan mode");
    expect(permissionRegistry.current().mode).toBe("plan");
    expect(permissionRegistry.current().prePlanMode).toBe("acceptEdits");

    const exitedResult = await registry.dispatch({
      id: "exit-plan",
      name: "ExitPlanMode",
      arguments: JSON.stringify({ plan: "# Edited Plan\n\nDo it better." }),
    });
    expect(exitedResult.isError).toBeUndefined();
    expect(exitedResult.content).toContain("Approved Plan");
    expect(exitedResult.content).toContain("# Edited Plan");
    expect(permissionRegistry.current().mode).toBe("acceptEdits");
    expect(syncCount).toBe(2);
    expect(warnings).toEqual(["mode_changed_to_plan", "mode_exited_plan"]);
    expect(exited).toBe(true);
  });

  test("searchTools suggests deferred tools but only explicit selection loads schema", async () => {
    const deferredTool: Tool = {
      name: "dynamic.report",
      description: "Generate a deferred dynamic report.",
      inputSchema: {
        type: "object",
        properties: { topic: { type: "string" } },
        required: ["topic"],
      },
      metadata: {
        family: "dynamic",
        source: "plugin",
        keywords: ["report", "deferred"],
        deferred: true,
      },
      execute: async () => ({ content: "reported" }),
    };
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      dynamicTools: [deferredTool],
    });

    expect(registry.tools.map((tool) => tool.name)).toContain("dynamic.report");
    expect(registry.toLLMTools().map((tool) => tool.function.name)).not.toContain(
      "dynamic.report",
    );

    const result = await registry.dispatch({
      id: "search-1",
      name: "system.searchTools",
      arguments: JSON.stringify({ query: "report" }),
    });
    const body = JSON.parse(result.content) as {
      loaded: string[];
      results: Array<{ name: string; loadHint?: string }>;
    };
    expect(body.results.map((entry) => entry.name)).toContain("dynamic.report");
    expect(body.loaded).not.toContain("dynamic.report");
    expect(
      body.results.find((entry) => entry.name === "dynamic.report")?.loadHint,
    ).toContain("select:dynamic.report");
    expect(registry.getDiscoveredToolNames?.().has("dynamic.report")).toBe(false);
    expect(registry.toLLMTools().map((tool) => tool.function.name)).not.toContain(
      "dynamic.report",
    );

    await registry.dispatch({
      id: "search-1b",
      name: "system.searchTools",
      arguments: JSON.stringify({ select: "dynamic.report" }),
    });

    expect(registry.getDiscoveredToolNames?.().has("dynamic.report")).toBe(true);
    expect(registry.toLLMTools().map((tool) => tool.function.name)).toContain(
      "dynamic.report",
    );
  });

  test("live MCP tools are cataloged as deferred shared-server tools", async () => {
    const mcpTool: Tool = {
      name: "mcp.demo.lookup",
      description: "Look up demo data.",
      inputSchema: {
        type: "object",
        properties: { key: { type: "string" } },
      },
      execute: async () => ({ content: "lookup-result" }),
    };
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      mcpToolsProvider: { getTools: () => [mcpTool] },
    });

    const registered = registry.tools.find((tool) => tool.name === mcpTool.name);
    expect(registered?.metadata?.source).toBe("mcp");
    expect(registered?.metadata?.deferred).toBe(true);
    expect(registered?.serverId).toBe("demo");
    expect(registered?.concurrencyClass).toEqual({
      kind: "shared_server",
      serverId: "demo",
    });
    expect(registry.toLLMTools().map((tool) => tool.function.name)).not.toContain(
      mcpTool.name,
    );

    await registry.dispatch({
      id: "search-2",
      name: "system.searchTools",
      arguments: JSON.stringify({ query: "lookup" }),
    });

    expect(registry.toLLMTools().map((tool) => tool.function.name)).not.toContain(
      mcpTool.name,
    );

    await registry.dispatch({
      id: "search-2b",
      name: "system.searchTools",
      arguments: JSON.stringify({ select: mcpTool.name }),
    });

    expect(registry.toLLMTools().map((tool) => tool.function.name)).toContain(
      mcpTool.name,
    );
    await expect(
      registry.dispatch({
        id: "mcp-1",
        name: mcpTool.name,
        arguments: "{}",
      }),
    ).resolves.toEqual({ content: "lookup-result", isError: undefined });
  });
});
