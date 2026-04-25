import { describe, expect, test } from "vitest";
import { buildToolRegistry } from "./tool-registry.js";
import { PermissionModeRegistry } from "./permissions/mode.js";
import { createEmptyToolPermissionContext } from "./permissions/types.js";
import type { Tool } from "./tools/types.js";
import { QuickJsCodeModeService } from "./tools/code-mode/service.js";

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

  test("exec_command gets BackgroundTerminal + requiresApproval=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const execCommand = registry.tools.find((t) => t.name === "exec_command");
    expect(execCommand?.concurrencyClass?.kind).toBe("background_terminal");
    expect(execCommand?.requiresApproval).toBe(true);
  });

  test("write_stdin gets BackgroundTerminal without a second approval prompt", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const writeStdin = registry.tools.find((t) => t.name === "write_stdin");
    expect(writeStdin?.concurrencyClass?.kind).toBe("background_terminal");
    expect(writeStdin?.requiresApproval).toBe(false);
  });
});

describe("tool-registry dynamic and deferred catalog", () => {
  test("Codex-primary tools are visible while compatibility entries stay deferred", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const registeredNames = registry.tools.map((tool) => tool.name);
    expect(registeredNames).toContain("exec_command");
    expect(registeredNames).toContain("write_stdin");
    expect(registeredNames).toContain("system.bash");
    expect(registeredNames).toContain("system.readFile");
    expect(registeredNames).toContain("system.writeFile");
    expect(registeredNames).toContain("system.editFile");
    expect(registeredNames).toContain("system.grep");
    expect(registeredNames).toContain("system.glob");
    expect(registeredNames).toContain("system.gitStatus");
    expect(registeredNames).toContain("system.symbolSearch");
    expect(registeredNames).toContain("system.repoInventory");
    expect(registeredNames).toContain("TodoWrite");
    expect(registeredNames).toContain("EnterPlanMode");
    expect(registeredNames).toContain("ExitPlanMode");
    // The legacy `workflow.enterPlan` / `workflow.exitPlan` aliases were
    // dropped — the canonical OpenClaude-parity names are the only entries.
    expect(registeredNames).not.toContain("workflow.enterPlan");
    expect(registeredNames).not.toContain("workflow.exitPlan");

    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);
    expect(visibleNames).toContain("exec_command");
    expect(visibleNames).toContain("write_stdin");
    expect(visibleNames).toContain("update_plan");
    expect(visibleNames).toContain("apply_patch");
    expect(visibleNames).toContain("TodoWrite");
    expect(visibleNames).toContain("EnterPlanMode");
    expect(visibleNames).toContain("ExitPlanMode");
    expect(visibleNames).toContain("system.searchTools");
    expect(visibleNames).not.toContain("system.bash");
    expect(visibleNames).not.toContain("system.readFile");
    expect(visibleNames).not.toContain("system.writeFile");
    expect(visibleNames).not.toContain("system.editFile");
    expect(visibleNames).not.toContain("system.grep");
    expect(visibleNames).not.toContain("system.glob");
    expect(visibleNames).not.toContain("system.gitStatus");
    expect(visibleNames).not.toContain("system.symbolSearch");
    expect(visibleNames).not.toContain("system.repoInventory");
  });

  test("exec_command dispatch accepts Codex-style cmd/workdir arguments", async () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });

    const result = await registry.dispatch({
      id: "exec-1",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "printf agenc-codex", workdir: "/tmp" }),
    });

    expect(result.isError).toBeUndefined();
    // After the openclaude tool_result shape port, `content` is plain
    // text (the model-facing surface) — same shape as openclaude's
    // BashTool tool_result. Structured fields (exitCode, stdout,
    // stderr) live on `metadata`, which the registry deliberately
    // does NOT propagate to the LLM-facing dispatch result (metadata
    // is in-process-only; `ToolResult.metadata` is documented as
    // "not sent to LLMs"). Tests that need to assert the structured
    // fields call `tool.execute()` directly.
    expect(result.content).toBe("agenc-codex");
  });

  test("code mode adds visible exec/wait tools when enabled", () => {
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      codeModeService: new QuickJsCodeModeService({ enabled: true }),
    });

    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);
    expect(visibleNames).toContain("exec");
    expect(visibleNames).toContain("wait");
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

  test("searchTools selection loads deferred AgenC compatibility file tools", async () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });

    expect(registry.toLLMTools().map((tool) => tool.function.name)).not.toContain(
      "system.readFile",
    );

    const result = await registry.dispatch({
      id: "search-select-read",
      name: "system.searchTools",
      arguments: JSON.stringify({ query: "select:system.readFile" }),
    });

    const body = JSON.parse(result.content) as {
      loaded: string[];
      results: Array<{ name: string; selected: boolean }>;
    };
    expect(body.loaded).toContain("system.readFile");
    expect(body.results).toContainEqual(
      expect.objectContaining({ name: "system.readFile", selected: true }),
    );
    expect(registry.getDiscoveredToolNames?.().has("system.readFile")).toBe(true);
    expect(registry.toLLMTools().map((tool) => tool.function.name)).toContain(
      "system.readFile",
    );
  });

  test("update_plan and TodoWrite mutate in-memory state and emit events but never overwrite the plan file", async () => {
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
    expect(JSON.parse(todo.content)).toMatchObject({
      message: "Todo list updated through update_plan compatibility state.",
      plan: [
        { step: "Ship alias", status: "completed" },
        { step: "Run tests", status: "pending" },
      ],
    });
    expect(emittedPlans).toHaveLength(2);

    // Bug A regression: neither tool may persist to the plan file.
    // Codex's update_plan is in-memory only (broadcast as PlanUpdate
    // events); openclaude's TodoWrite is in-memory only. We were the
    // only one persisting and that overwrote the user's authored plan.
    expect(writtenPlans).toHaveLength(0);
  });

  test("update_plan is rejected in plan mode (matches codex contract)", async () => {
    const permissionRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan" }),
    );
    const writtenPlans: string[] = [];
    const emittedPlans: unknown[] = [];
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        getPermissionModeRegistry: () => permissionRegistry,
        writePlan: async (content) => {
          writtenPlans.push(content);
        },
        emitPlanUpdated: (state) => {
          emittedPlans.push(state);
        },
      },
    });

    const result = await registry.dispatch({
      id: "plan-rejected",
      name: "update_plan",
      arguments: JSON.stringify({
        plan: [{ step: "Should not run", status: "pending" }],
      }),
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "update_plan is a TODO/checklist tool and is not allowed in Plan mode",
    );
    expect(writtenPlans).toHaveLength(0);
    expect(emittedPlans).toHaveLength(0);
  });

  test("TodoWrite is rejected in plan mode", async () => {
    const permissionRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan" }),
    );
    const writtenPlans: string[] = [];
    const emittedPlans: unknown[] = [];
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        getPermissionModeRegistry: () => permissionRegistry,
        writePlan: async (content) => {
          writtenPlans.push(content);
        },
        emitPlanUpdated: (state) => {
          emittedPlans.push(state);
        },
      },
    });

    const result = await registry.dispatch({
      id: "todo-rejected",
      name: "TodoWrite",
      arguments: JSON.stringify({
        todos: [
          { content: "Should not run", status: "pending", activeForm: "Running" },
        ],
      }),
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain(
      "TodoWrite is a TODO/checklist tool and is not allowed in Plan mode",
    );
    expect(writtenPlans).toHaveLength(0);
    expect(emittedPlans).toHaveLength(0);
  });

  test("TodoWrite round-trips activeForm in returned state", async () => {
    const emittedPlans: unknown[] = [];
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        emitPlanUpdated: (state) => {
          emittedPlans.push(state);
        },
      },
    });

    const result = await registry.dispatch({
      id: "todo-active-form",
      name: "TodoWrite",
      arguments: JSON.stringify({
        todos: [
          { content: "Run tests", status: "in_progress", activeForm: "Running tests" },
          { content: "Build", status: "pending" },
        ],
      }),
    });
    expect(result.isError).toBeUndefined();
    const body = JSON.parse(result.content) as {
      plan: Array<{ step: string; status: string; activeForm?: string }>;
    };
    expect(body.plan).toEqual([
      { step: "Run tests", status: "in_progress", activeForm: "Running tests" },
      { step: "Build", status: "pending" },
    ]);
    // Empty/missing activeForm must not be coerced to "" — must be omitted.
    expect("activeForm" in body.plan[1]!).toBe(false);
    expect(emittedPlans).toHaveLength(1);
  });

  test("update_plan schema does not accept activeForm (codex parity)", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const updatePlan = registry.tools.find((t) => t.name === "update_plan");
    expect(updatePlan).toBeDefined();
    const items = (updatePlan!.inputSchema as {
      properties: {
        plan: {
          items: {
            properties: Record<string, unknown>;
            additionalProperties: boolean;
          };
        };
      };
    }).properties.plan.items;
    expect(items.additionalProperties).toBe(false);
    expect(Object.keys(items.properties)).toEqual(["step", "status"]);
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
