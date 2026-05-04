import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildToolRegistry } from "./tool-registry.js";
import { PermissionModeRegistry } from "./permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "./permissions/types.js";
import {
  clearExitPlanModeApprovalsForTest,
  recordExitPlanModeApproval,
} from "./planning/exit-plan-approval.js";
import type { Tool } from "./tools/types.js";
import { QuickJsCodeModeService } from "./tools/code-mode/service.js";
import { createTaskTools } from "./tools/tasks/index.js";

afterEach(() => {
  clearExitPlanModeApprovalsForTest();
});

describe("T7 tool-registry ConcurrencyClass tagging", () => {
  test("read-only fs tools get SharedRead + isReadOnly=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const readFile = registry.tools.find((t) => t.name === "FileRead");
    expect(readFile?.concurrencyClass?.kind).toBe("shared_read");
    expect(readFile?.isReadOnly).toBe(true);
    expect(readFile?.recoveryCategory).toBe("idempotent");
    expect(readFile?.supportsParallelToolCalls).toBe(true);
  });

  test("write fs tools get Exclusive + requiresApproval=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const writeFile = registry.tools.find((t) => t.name === "Write");
    expect(writeFile?.concurrencyClass?.kind).toBe("exclusive");
    expect(writeFile?.requiresApproval).toBe(true);
    expect(writeFile?.recoveryCategory).toBe("side-effecting");
    expect(writeFile?.supportsParallelToolCalls).toBe(false);
  });

  test("bash tool gets BackgroundTerminal + requiresApproval=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const bash = registry.tools.find((t) => t.name === "system.bash");
    expect(bash?.concurrencyClass?.kind).toBe("background_terminal");
    expect(bash?.requiresApproval).toBe(true);
    expect(bash?.recoveryCategory).toBe("side-effecting");
  });

  test("exec_command gets BackgroundTerminal + requiresApproval=true", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const execCommand = registry.tools.find((t) => t.name === "exec_command");
    expect(execCommand?.concurrencyClass?.kind).toBe("background_terminal");
    expect(execCommand?.requiresApproval).toBe(true);
    expect(execCommand?.recoveryCategory).toBe("side-effecting");
  });

  test("write_stdin gets BackgroundTerminal without a second approval prompt", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const writeStdin = registry.tools.find((t) => t.name === "write_stdin");
    expect(writeStdin?.concurrencyClass?.kind).toBe("background_terminal");
    expect(writeStdin?.requiresApproval).toBe(false);
    expect(writeStdin?.recoveryCategory).toBe("side-effecting");
  });

  test("undeclared recovery categories default to side-effecting even for read-only tools", () => {
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      extraTools: [
        {
          name: "custom.readOnly",
          description: "Read-only custom tool without recovery declaration",
          metadata: { mutating: false },
          isReadOnly: true,
          inputSchema: { type: "object", properties: {} },
          execute: async () => ({ content: "ok" }),
        } satisfies Tool,
      ],
    });

    const custom = registry.tools.find((tool) => tool.name === "custom.readOnly");
    expect(custom?.isReadOnly).toBe(true);
    expect(custom?.recoveryCategory).toBe("side-effecting");
  });
});

describe("tool-registry dynamic and deferred catalog", () => {
  test("AgenC-primary tools are visible while compatibility entries stay deferred", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const registeredNames = registry.tools.map((tool) => tool.name);
    expect(registeredNames).toContain("exec_command");
    expect(registeredNames).toContain("write_stdin");
    expect(registeredNames).toContain("system.bash");
    expect(registeredNames).toContain("FileRead");
    expect(registeredNames).toContain("Write");
    expect(registeredNames).toContain("Edit");
    expect(registeredNames).toContain("MultiEdit");
    expect(registeredNames).toContain("Glob");
    expect(registeredNames).toContain("Grep");
    expect(registeredNames).toContain("apply_patch");
    expect(registeredNames).toContain("system.grep");
    expect(registeredNames).toContain("system.glob");
    expect(registeredNames).toContain("system.gitStatus");
    expect(registeredNames).toContain("system.symbolSearch");
    expect(registeredNames).toContain("system.repoInventory");
    expect(registeredNames).toContain("TodoWrite");
    expect(registeredNames).toContain("EnterPlanMode");
    expect(registeredNames).toContain("ExitPlanMode");
    expect(registeredNames).toContain("AskUserQuestion");
    // The legacy `workflow.enterPlan` / `workflow.exitPlan` aliases were
    // dropped — the canonical AgenC-compatible names are the only entries.
    expect(registeredNames).not.toContain("workflow.enterPlan");
    expect(registeredNames).not.toContain("workflow.exitPlan");
    // `update_plan` is the legacy runtime-only checklist name. AgenC's `/plan`
    // surface is AgenC-owned, so the only checklist tool we
    // ship is `TodoWrite`.
    expect(registeredNames).not.toContain("update_plan");

    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);
    expect(visibleNames).toContain("exec_command");
    expect(visibleNames).toContain("write_stdin");
    expect(visibleNames).toContain("TodoWrite");
    expect(visibleNames).toContain("EnterPlanMode");
    expect(visibleNames).toContain("ExitPlanMode");
    expect(visibleNames).toContain("AskUserQuestion");
    expect(visibleNames).not.toContain("update_plan");
    expect(visibleNames).toContain("system.searchTools");
    expect(visibleNames).not.toContain("system.bash");
    expect(visibleNames).toContain("FileRead");
    expect(visibleNames).toContain("Write");
    expect(visibleNames).toContain("Edit");
    expect(visibleNames).toContain("MultiEdit");
    expect(visibleNames).toContain("Glob");
    expect(visibleNames).toContain("Grep");
    expect(visibleNames).not.toContain("apply_patch");
    expect(visibleNames).not.toContain("system.grep");
    expect(visibleNames).not.toContain("system.glob");
    expect(visibleNames).not.toContain("system.gitStatus");
    expect(visibleNames).not.toContain("system.symbolSearch");
    expect(visibleNames).not.toContain("system.repoInventory");
  });

  test("AskUserQuestion is marked as an interactive planning tool", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const askUserQuestion = registry.tools.find(
      (tool) => tool.name === "AskUserQuestion",
    );

    expect(askUserQuestion).toBeDefined();
    expect(askUserQuestion?.requiresUserInteraction?.()).toBe(true);
    expect(askUserQuestion?.isReadOnly).toBe(true);
    expect(askUserQuestion?.recoveryCategory).toBe("interactive");
    expect(askUserQuestion?.supportsParallelToolCalls).toBe(false);
    expect(askUserQuestion?.metadata?.family).toBe("planning");
  });

  test("exec_command dispatch accepts AgenC-style cmd/workdir arguments", async () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });

    const result = await registry.dispatch({
      id: "exec-1",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "printf agenc-runtime", workdir: "/tmp" }),
    });

    expect(result.isError).toBeUndefined();
    // The model-facing content follows unified-exec output: status
    // headers plus the captured stdout/stderr.
    expect(result.content).toContain("Process exited with code 0");
    expect(result.content).toContain("Output:\nagenc-runtime");
  });

  test("dispatch wraps plain-string arguments using the consolidated registry surface", async () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });

    const result = await registry.dispatch({
      id: "exec-plain-string",
      name: "exec_command",
      arguments: "printf agenc-plain-string",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Process exited with code 0");
    expect(result.content).toContain("Output:\nagenc-plain-string");
  });

  test("model-facing Task tools keep string id dispatch in the registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-registry-task-tools-"));
    try {
      const registry = buildToolRegistry({
        workspaceRoot: root,
        modelFacingTools: createTaskTools({
          workspaceRoot: root,
          agencHome: root,
          getSession: () => null,
        }),
      });

      const registeredNames = registry.tools.map((tool) => tool.name);
      expect(registeredNames).toEqual(
        expect.arrayContaining([
          "TaskCreate",
          "TaskGet",
          "TaskList",
          "TaskOutput",
          "TaskStop",
        ]),
      );

      const created = await registry.dispatch({
        id: "task-create-1",
        name: "TaskCreate",
        arguments: JSON.stringify({
          subject: "Registry task",
          description: "Exercise TaskGet string wrapping",
        }),
      });
      expect(created.isError).toBeUndefined();

      const got = await registry.dispatch({
        id: "task-get-1",
        name: "TaskGet",
        arguments: JSON.stringify("1"),
      });

      expect(got.isError).toBeUndefined();
      expect(got.content).toContain("Task #1: Registry task");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("apply_patch is deferred but dispatch accepts raw patch strings", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenc-registry-apply-patch-"));
    const registry = buildToolRegistry({ workspaceRoot: root });
    const tool = registry.tools.find((candidate) => candidate.name === "apply_patch");

    expect(tool?.metadata?.deferred).toBe(true);
    expect(registry.toLLMTools().map((entry) => entry.function.name)).not.toContain(
      "apply_patch",
    );

    const result = await registry.dispatch({
      id: "patch-1",
      name: "apply_patch",
      arguments: `*** Begin Patch
*** Add File: patched.txt
+patched
*** End Patch`,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe(
      "Success. Updated the following files:\nA patched.txt\n",
    );
    await expect(readFile(join(root, "patched.txt"), "utf8")).resolves.toBe(
      "patched\n",
    );
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

  test("searchTools supports AgenC-style select:<tool> loading", async () => {
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

  test("first-class file tools are visible without searchTools discovery", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });

    expect(registry.toLLMTools().map((tool) => tool.function.name)).toContain(
      "FileRead",
    );
    expect(registry.getDiscoveredToolNames?.().has("FileRead")).toBe(false);
  });

  test("tools_config disables tools before catalog advertisement and dispatch", async () => {
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      toolsConfig: {
        exec_command: { enabled: false },
        Write: false,
      },
    });

    const registeredNames = registry.tools.map((tool) => tool.name);
    expect(registeredNames).not.toContain("exec_command");
    expect(registeredNames).not.toContain("Write");

    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);
    expect(visibleNames).not.toContain("exec_command");
    expect(visibleNames).not.toContain("Write");

    const result = await registry.dispatch({
      id: "disabled-exec",
      name: "exec_command",
      arguments: JSON.stringify({ cmd: "printf should-not-run" }),
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unknown tool: exec_command");
  });

  test("tools_config tags per-tool default permission mode on registered tools", () => {
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      toolsConfig: {
        Edit: {
          default_permission_mode: "never",
        },
      },
    });

    const edit = registry.tools.find((tool) => tool.name === "Edit");
    expect(edit?.defaultPermissionMode).toBe("never");
  });

  test("searchTools advertisedOnly is derived from the registry visible surface", async () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });

    const result = await registry.dispatch({
      id: "search-advertised",
      name: "system.searchTools",
      arguments: JSON.stringify({ advertisedOnly: true, maxResults: 200 }),
    });

    const body = JSON.parse(result.content) as {
      results: Array<{ name: string; advertised: boolean }>;
    };
    const resultNames = body.results.map((entry) => entry.name);
    expect(resultNames).toContain("exec_command");
    expect(resultNames).toContain("MultiEdit");
    expect(resultNames).toContain("Grep");
    expect(resultNames).not.toContain("system.grep");
    expect(body.results.every((entry) => entry.advertised)).toBe(true);
  });

  test("model-facing tools are registered through the registry-owned surface", async () => {
    const visibleProductTool: Tool = {
      name: "ProductVisible",
      description: "Visible product tool.",
      inputSchema: { type: "object" },
      metadata: {
        family: "product",
        source: "builtin",
        mutating: false,
          deferred: false,
        },
        recoveryCategory: "idempotent",
        execute: async () => ({ content: "visible" }),
      };
    const deferredProductTool: Tool = {
      name: "ProductDeferred",
      description: "Deferred product tool.",
      inputSchema: { type: "object" },
      metadata: {
        family: "product",
        source: "builtin",
        mutating: true,
          deferred: true,
        },
        recoveryCategory: "side-effecting",
        execute: async () => ({ content: "deferred" }),
      };
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      modelFacingTools: [visibleProductTool, deferredProductTool],
    });

    const visibleNames = registry.toLLMTools().map((tool) => tool.function.name);
    expect(visibleNames).toContain("ProductVisible");
    expect(visibleNames).not.toContain("ProductDeferred");
    expect(registry.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["ProductVisible", "ProductDeferred"]),
    );

    await registry.dispatch({
      id: "product-search",
      name: "system.searchTools",
      arguments: JSON.stringify({ select: "ProductDeferred" }),
    });

    expect(registry.toLLMTools().map((tool) => tool.function.name)).toContain(
      "ProductDeferred",
    );
  });

  test("builtin model-facing tools must explicitly declare recovery category", () => {
    const missingRecoveryCategory: Tool = {
      name: "ProductMissingRecovery",
      description: "Builtin product tool missing restart recovery policy.",
      inputSchema: { type: "object" },
      metadata: {
        family: "product",
        source: "builtin",
        mutating: false,
        deferred: false,
      },
      execute: async () => ({ content: "missing" }),
    };

    expect(() =>
      buildToolRegistry({
        workspaceRoot: "/tmp",
        modelFacingTools: [missingRecoveryCategory],
      }),
    ).toThrow(
      "builtin tool group model-facing missing recoveryCategory: ProductMissingRecovery",
    );
  });

  test("TodoWrite returns the verbatim AgenC tool_result sentence and emits a plan event without ever writing the plan file", async () => {
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

    const todo = await registry.dispatch({
      id: "todo-1",
      name: "TodoWrite",
      arguments: JSON.stringify({
        todos: [
          { content: "Ship parity", status: "in_progress", activeForm: "Shipping parity" },
          { content: "Run tests", status: "pending", activeForm: "Running tests" },
        ],
      }),
    });
    expect(todo.isError).toBeUndefined();
    // Preserve the canonical `TodoWrite` result sentence.
    expect(todo.content).toBe(
      "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress. Please proceed with the current tasks if applicable",
    );
    expect(emittedPlans).toHaveLength(1);
    expect(emittedPlans[0]).toMatchObject({
      todos: [
        { content: "Ship parity", status: "in_progress", activeForm: "Shipping parity" },
        { content: "Run tests", status: "pending", activeForm: "Running tests" },
      ],
      updatedAt: expect.any(String),
    });

    // AgenC's TodoWrite is in-memory only. Persisting to the plan
    // file would overwrite the user-authored plan.
    expect(writtenPlans).toHaveLength(0);
  });

  test("TodoWrite is permitted in plan mode (AgenC classifier classifies it as metadata-only)", async () => {
    const permissionRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan" }),
    );
    const emittedPlans: unknown[] = [];
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        getPermissionModeRegistry: () => permissionRegistry,
        emitPlanUpdated: (state) => {
          emittedPlans.push(state);
        },
      },
    });

    const result = await registry.dispatch({
      id: "todo-plan-mode",
      name: "TodoWrite",
      arguments: JSON.stringify({
        todos: [
          { content: "Plan task", status: "in_progress", activeForm: "Planning task" },
        ],
      }),
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Todos have been modified successfully");
    expect(emittedPlans).toHaveLength(1);
  });

  test("TodoWrite adds the verification-agent nudge when closing 3+ tasks without verification", async () => {
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
      id: "todo-verification-nudge",
      name: "TodoWrite",
      arguments: JSON.stringify({
        todos: [
          { content: "Implement feature", status: "completed", activeForm: "Implementing feature" },
          { content: "Update tests", status: "completed", activeForm: "Updating tests" },
          { content: "Run typecheck", status: "completed", activeForm: "Running typecheck" },
        ],
      }),
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain('spawn the sentinel agent (agent_type="sentinel")');
    expect(result.metadata).toMatchObject({ verificationNudgeNeeded: true });
    expect(emittedPlans).toHaveLength(1);
    expect(emittedPlans[0]).toMatchObject({
      todos: [],
      updatedAt: expect.any(String),
    });
  });

  test("TodoWrite schema requires content/status/activeForm and rejects extras (AgenC behavior)", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const todoWrite = registry.tools.find((t) => t.name === "TodoWrite");
    expect(todoWrite).toBeDefined();
    const items = (todoWrite!.inputSchema as {
      properties: {
        todos: {
          items: {
            properties: Record<string, unknown>;
            required: string[];
            additionalProperties: boolean;
          };
        };
      };
    }).properties.todos.items;
    expect(items.additionalProperties).toBe(false);
    expect(Object.keys(items.properties).sort()).toEqual([
      "activeForm",
      "content",
      "status",
    ]);
    expect(items.required.sort()).toEqual(["activeForm", "content", "status"]);
  });

  test("TodoWrite rejects todos missing activeForm", async () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    const result = await registry.dispatch({
      id: "todo-missing-active-form",
      name: "TodoWrite",
      arguments: JSON.stringify({
        todos: [{ content: "Run tests", status: "in_progress" }],
      }),
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("activeForm");
  });

  test("update_plan is no longer registered (runtime name dropped in favor of AgenC TodoWrite)", () => {
    const registry = buildToolRegistry({ workspaceRoot: "/tmp" });
    expect(registry.tools.find((t) => t.name === "update_plan")).toBeUndefined();
  });

  test("AgenC-style EnterPlanMode/ExitPlanMode drive the live permission-mode registry", async () => {
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
    expect(exitedResult.content).toContain("Approved Plan (edited by user)");
    expect(exitedResult.content).toContain("# Edited Plan");
    expect(permissionRegistry.current().mode).toBe("acceptEdits");
    expect(syncCount).toBe(2);
    expect(warnings).toEqual(["mode_changed_to_plan", "mode_exited_plan"]);
    expect(exited).toBe(true);
  });

  test("ExitPlanMode exposes AgenC-style approved-plan metadata", async () => {
    const permissionRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan" }),
    );
    let plan = "# Original Plan\n\nDo it.";
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        getPermissionModeRegistry: () => permissionRegistry,
        syncPermissionContext: async () => {},
        getPlanFilePath: () => "/tmp/agenc/plans/plan.md",
        readPlan: () => plan,
        writePlan: async (content) => {
          plan = content;
        },
      },
    });
    const exitPlanMode = registry.tools.find((tool) => tool.name === "ExitPlanMode");

    const result = await exitPlanMode?.execute({
      plan: "# Edited Plan\n\nDo it better.",
    });

    expect(result?.isError).toBeUndefined();
    expect(result?.content).toContain("Approved Plan (edited by user)");
    expect(result?.metadata).toMatchObject({
      plan: "# Edited Plan\n\nDo it better.",
      filePath: "/tmp/agenc/plans/plan.md",
      planFilePath: "/tmp/agenc/plans/plan.md",
      planWasEdited: true,
      isAgent: false,
    });
  });

  test("ExitPlanMode refuses to write a plan when no live permission registry exists", async () => {
    let writeCount = 0;
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        getPlanFilePath: () => "/tmp/agenc/plans/plan.md",
        readPlan: () => "# Existing Plan\n\nDo it.",
        writePlan: async () => {
          writeCount += 1;
        },
      },
    });

    const result = await registry.dispatch({
      id: "exit-no-registry",
      name: "ExitPlanMode",
      arguments: JSON.stringify({ plan: "# Edited Plan\n\nDo it better." }),
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("permission mode registry is not available");
    expect(writeCount).toBe(0);
  });

  test("ExitPlanMode consumes TUI plan approval decisions for requested prompts and target mode", async () => {
    const permissionRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan", prePlanMode: "default" }),
    );
    let plan = "# Original Plan\n\nDo it.";
    let exited = false;
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        getPermissionModeRegistry: () => permissionRegistry,
        syncPermissionContext: async () => {},
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
    recordExitPlanModeApproval("exit-approval", {
      action: "approve",
      plan: "# Approved Plan\n\nRun the checks.",
      mode: "acceptEdits",
      applyAllowedPrompts: true,
      allowedPrompts: [{ tool: "Bash", prompt: "npm test" }],
    });

    const result = await registry.dispatch({
      id: "exit-approval",
      name: "ExitPlanMode",
      arguments: "{}",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("# Approved Plan");
    expect(permissionRegistry.current().mode).toBe("acceptEdits");
    expect(permissionRegistry.current().alwaysAllowRules.session).toEqual([
      "Bash(npm test)",
    ]);
    expect(result.metadata).toMatchObject({
      planWasEdited: true,
      appliedPlanPermissionUpdates: 1,
      toMode: "acceptEdits",
    });
    expect(exited).toBe(true);
  });

  test("ExitPlanMode invokes the controller clear-context hook when requested by TUI approval", async () => {
    const permissionRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan", prePlanMode: "default" }),
    );
    let clearedPlan: string | null | undefined;
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        getPermissionModeRegistry: () => permissionRegistry,
        syncPermissionContext: async () => {},
        getPlanFilePath: () => "/tmp/agenc/plans/plan.md",
        readPlan: () => "# Plan\n\nClear context.",
        requestContextClearAfterPlanApproval: async (plan) => {
          clearedPlan = plan;
        },
      },
    });
    recordExitPlanModeApproval("exit-clear", {
      action: "approve",
      clearContext: true,
    });

    const result = await registry.dispatch({
      id: "exit-clear",
      name: "ExitPlanMode",
      arguments: "{}",
    });

    expect(result.isError).toBeUndefined();
    expect(clearedPlan).toBe("# Plan\n\nClear context.");
    expect(result.metadata).toMatchObject({ clearContextRequested: true });
  });

  test("ExitPlanMode keeps plan mode active when TUI asks for revision feedback", async () => {
    const permissionRegistry = new PermissionModeRegistry(
      createEmptyToolPermissionContext({ mode: "plan", prePlanMode: "default" }),
    );
    const registry = buildToolRegistry({
      workspaceRoot: "/tmp",
      workflowController: {
        getPermissionModeRegistry: () => permissionRegistry,
        syncPermissionContext: async () => {},
        getPlanFilePath: () => "/tmp/agenc/plans/plan.md",
        readPlan: () => "# Plan\n\nInitial.",
        writePlan: async () => {},
      },
    });
    recordExitPlanModeApproval("exit-revise", {
      action: "revise",
      feedback: "Add rollback steps.",
    });

    const result = await registry.dispatch({
      id: "exit-revise",
      name: "ExitPlanMode",
      arguments: "{}",
    });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Add rollback steps.");
    expect(permissionRegistry.current().mode).toBe("plan");
    expect(result.metadata).toMatchObject({
      planRejected: true,
      feedback: "Add rollback steps.",
    });
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
