import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { ControlResponse } from "./types.js";
import type { ApprovalEngine } from "./approvals.js";
import { ApprovalEngine as ApprovalEngineImpl } from "./approvals.js";
import { createEffectApprovalPolicy } from "./effect-approval-policy.js";
import {
  DelegationPolicyEngine,
  SubAgentLifecycleEmitter,
} from "./delegation-runtime.js";
import type { SubAgentResult } from "./sub-agent.js";
import { createSessionToolHandler } from "./tool-handler-factory.js";
import { SessionCredentialBroker } from "../policy/session-credentials.js";
import {
  SESSION_ALLOWED_ROOTS_ARG,
  SESSION_ID_ARG,
} from "../tools/system/filesystem.js";
import {
  createTaskTrackerTools,
  TASK_LIST_ARG,
  TaskStore,
} from "../tools/system/task-tracker.js";
import { createMockMemoryBackend } from "../memory/test-utils.js";
import { EffectLedger } from "../workflow/effect-ledger.js";

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function waitForPendingApproval(
  approvalEngine: ApprovalEngineImpl,
  timeoutMs = 1_000,
): Promise<void> {
  const startedAt = Date.now();
  while (approvalEngine.getPending().length === 0) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error("Timed out waiting for pending approval request");
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function makeCompletedChildResult(
  result: Omit<SubAgentResult, "completionState" | "stopReason">,
): SubAgentResult {
  return {
    ...result,
    completionState: "completed",
    stopReason: "completed",
  };
}

describe("createSessionToolHandler", () => {

  it("marks non-zero exitCode tool results as isError in client and subagent lifecycle events", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const lifecycleEvents: Array<Record<string, unknown>> = [];
    const lifecycleEmitter = {
      emit: vi.fn((event: Record<string, unknown>) => {
        lifecycleEvents.push(event);
      }),
    };

    const handler = createSessionToolHandler({
      sessionId: "subagent:test-session",
      baseHandler: vi.fn(async () =>
        JSON.stringify({ stdout: "", stderr: "build failed", exitCode: 1 })
      ),
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: null,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: lifecycleEmitter as any,
      }),
    });

    await handler("system.bash", {
      command: "npm",
      args: ["run", "build"],
    });

    const resultPayload = sentMessages.find((msg) => msg.type === "tools.result")
      ?.payload as
      | { isError?: boolean; toolName?: string }
      | undefined;
    expect(resultPayload).toMatchObject({
      toolName: "system.bash",
      isError: true,
    });

    const lifecyclePayload = lifecycleEvents.find(
      (event) => event.type === "subagents.tool.result",
    )?.payload as
      | { isError?: boolean; toolCallId?: string }
      | undefined;
    expect(lifecyclePayload?.isError).toBe(true);
    expect(lifecyclePayload?.toolCallId).toBeDefined();
  });

  it("does not block duplicate same-turn tool launches after a successful start", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () =>
      JSON.stringify({ status: "running" }),
    );
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    const firstResult = await handler("mcp.example.start", {
      scenario: "defend_the_center",
    });
    const secondResult = await handler("mcp.example.start", {
      scenario: "defend_the_center",
    });

    expect(JSON.parse(firstResult)).toEqual({ status: "running" });
    expect(JSON.parse(secondResult)).toEqual({ status: "running" });
    expect(baseHandler).toHaveBeenCalledTimes(2);
    expect(sentMessages.at(-1)).toMatchObject({
      type: "tools.result",
      payload: {
        toolName: "mcp.example.start",
      },
    });
  });

  it("reuses a single toolCallId for tool start/result and callbacks", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const baseHandler = vi.fn(async () => "result-value");
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      onToolStart,
      onToolEnd,
    });

    const result = await handler("system.health", { check: true });

    const executing = sentMessages.find((msg) => msg.type === "tools.executing");
    const toolResult = sentMessages.find((msg) => msg.type === "tools.result");

    expect(result).toBe("result-value");
    expect(baseHandler).toHaveBeenCalledWith("system.health", { check: true });
    expect(executing).toBeDefined();
    expect(toolResult).toBeDefined();

    const toolCallId = (executing!.payload as { toolCallId?: string }).toolCallId;
    const resultToolCallId = (toolResult!.payload as { toolCallId?: string }).toolCallId;

    expect(toolCallId).toBeDefined();
    expect(toolCallId).toBe(resultToolCallId);
    expect(onToolStart).toHaveBeenCalledWith("system.health", { check: true }, toolCallId);
    expect(onToolEnd).toHaveBeenCalledWith(
      "system.health",
      "result-value",
      expect.any(Number),
      toolCallId,
    );
  });

  it("attaches hook metadata and toolCallId to tool hook payloads", async () => {
    const send = vi.fn();
    const hooks = {
      dispatch: vi
        .fn()
        .mockResolvedValueOnce({ completed: true, payload: {} })
        .mockResolvedValueOnce({ completed: true, payload: {} }),
    } as any;

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler: vi.fn(async () => '{"ok":true}'),
      routerId: "router-a",
      send,
      hooks,
      hookMetadata: { backgroundRunId: "bg-run-1" },
    });

    await handler("system.writeFile", {
      path: "/tmp/output.txt",
      content: "hello",
    });

    expect(hooks.dispatch).toHaveBeenNthCalledWith(
      1,
      "tool:before",
      expect.objectContaining({
        sessionId: "session-1",
        toolName: "system.writeFile",
        backgroundRunId: "bg-run-1",
      }),
    );
    expect(hooks.dispatch).toHaveBeenNthCalledWith(
      2,
      "tool:after",
      expect.objectContaining({
        sessionId: "session-1",
        toolName: "system.writeFile",
        backgroundRunId: "bg-run-1",
        toolCallId: expect.any(String),
      }),
    );
  });

  it("rebases relative filesystem tool paths under the delegated working directory", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const baseHandler = vi.fn(async () => '{"ok":true}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      defaultWorkingDirectory: "/tmp/project-root",
    });

    await handler("system.writeFile", {
      path: "src/grid.ts",
      content: "export const grid = true;\n",
    });

    expect(baseHandler).toHaveBeenCalledWith("system.writeFile", {
      path: "/tmp/project-root/src/grid.ts",
      content: "export const grid = true;\n",
      [SESSION_ALLOWED_ROOTS_ARG]: ["/tmp/project-root"],
      [SESSION_ID_ARG]: "session-1",
    });
    expect(sentMessages[0]).toMatchObject({
      type: "tools.executing",
      payload: {
        toolName: "system.writeFile",
        args: {
          path: "/tmp/project-root/src/grid.ts",
          content: "export const grid = true;\n",
        },
      },
    });
  });

  it("resolves workspace context per call and injects the session root only into path-gated tool executions", async () => {
    const sessionWorkspaceRoot = createTempDir("agenc-tool-handler-session-root-");
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const baseHandler = vi.fn(async () => '{"ok":true}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      defaultWorkingDirectory: "/tmp/daemon-root",
      resolveWorkspaceContext: async () => ({
        defaultWorkingDirectory: sessionWorkspaceRoot,
        workspaceAliasRoot: sessionWorkspaceRoot,
        scopedFilesystemRoot: sessionWorkspaceRoot,
        additionalAllowedPaths: [sessionWorkspaceRoot],
      }),
    });

    try {
      await handler("system.writeFile", {
        path: "src/session.ts",
        content: "export const sessionScoped = true;\n",
      });
    } finally {
      rmSync(sessionWorkspaceRoot, { recursive: true, force: true });
    }

    expect(baseHandler).toHaveBeenCalledWith("system.writeFile", {
      path: `${sessionWorkspaceRoot}/src/session.ts`,
      content: "export const sessionScoped = true;\n",
      [SESSION_ALLOWED_ROOTS_ARG]: [sessionWorkspaceRoot],
      [SESSION_ID_ARG]: "session-1",
    });
    expect(sentMessages[0]).toMatchObject({
      type: "tools.executing",
      payload: {
        toolName: "system.writeFile",
        args: {
          path: `${sessionWorkspaceRoot}/src/session.ts`,
          content: "export const sessionScoped = true;\n",
        },
      },
    });
    expect((sentMessages[0]?.payload as Record<string, unknown>)).not.toHaveProperty(
      SESSION_ALLOWED_ROOTS_ARG,
    );
  });

  it("injects the delegated cwd as an allowed filesystem root even without an explicit workspace context callback", async () => {
    const workspaceRoot = createTempDir("agenc-tool-handler-delegated-root-");
    const baseHandler = vi.fn(async () => '{"ok":true}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspaceRoot,
      scopedFilesystemRoot: workspaceRoot,
    });

    try {
      await handler("system.readFile", {
        path: "PLAN.md",
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }

    expect(baseHandler).toHaveBeenCalledWith("system.readFile", {
      path: `${workspaceRoot}/PLAN.md`,
      [SESSION_ALLOWED_ROOTS_ARG]: [workspaceRoot],
      [SESSION_ID_ARG]: "session-1",
    });
  });

  it("strips spoofed internal allowed-root args from caller-controlled input", async () => {
    const workspaceRoot = createTempDir("agenc-tool-handler-spoofed-root-");
    const baseHandler = vi.fn(async () => '{"ok":true}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspaceRoot,
    });

    try {
      await handler("system.writeFile", {
        path: "src/index.ts",
        content: "export const safe = true;\n",
        [SESSION_ALLOWED_ROOTS_ARG]: ["/tmp/evil-root"],
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }

    expect(baseHandler).toHaveBeenCalledWith("system.writeFile", {
      path: `${workspaceRoot}/src/index.ts`,
      content: "export const safe = true;\n",
      [SESSION_ALLOWED_ROOTS_ARG]: [workspaceRoot],
      [SESSION_ID_ARG]: "session-1",
    });
  });

  it("injects session task-list ids on the gateway path and strips spoofed internal args", async () => {
    const taskStore = new TaskStore();
    const taskTools = new Map(
      createTaskTrackerTools(taskStore).map((tool) => [tool.name, tool]),
    );
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const baseHandler = vi.fn(
      async (toolName: string, args: Record<string, unknown>) => {
        const tool = taskTools.get(toolName);
        if (!tool) {
          throw new Error(`Unexpected tool: ${toolName}`);
        }
        const result = await tool.execute(args);
        return result.content;
      },
    );

    const sessionAHandler = createSessionToolHandler({
      sessionId: "session-a",
      baseHandler,
      routerId: "router-a",
      send,
    });
    const sessionBHandler = createSessionToolHandler({
      sessionId: "session-b",
      baseHandler,
      routerId: "router-a",
      send,
    });

    await sessionAHandler("task.create", {
      subject: "Session A task",
      description: "Created through the gateway handler",
      [TASK_LIST_ARG]: "spoofed-a",
    });
    await sessionBHandler("task.create", {
      subject: "Session B task",
      description: "Created through the gateway handler",
      [TASK_LIST_ARG]: "spoofed-b",
    });
    const sessionATasks = JSON.parse(await sessionAHandler("task.list", {})) as {
      count: number;
      tasks: Array<{ subject: string }>;
    };
    const sessionBTasks = JSON.parse(await sessionBHandler("task.list", {})) as {
      count: number;
      tasks: Array<{ subject: string }>;
    };

    expect(baseHandler).toHaveBeenNthCalledWith(1, "task.create", {
      subject: "Session A task",
      description: "Created through the gateway handler",
      [TASK_LIST_ARG]: "session-a",
    });
    expect(baseHandler).toHaveBeenNthCalledWith(2, "task.create", {
      subject: "Session B task",
      description: "Created through the gateway handler",
      [TASK_LIST_ARG]: "session-b",
    });
    expect(baseHandler).toHaveBeenNthCalledWith(3, "task.list", {
      [TASK_LIST_ARG]: "session-a",
    });
    expect(baseHandler).toHaveBeenNthCalledWith(4, "task.list", {
      [TASK_LIST_ARG]: "session-b",
    });

    const executingMessages = sentMessages.filter(
      (msg) => msg.type === "tools.executing",
    );
    expect(executingMessages).toHaveLength(4);
    expect(executingMessages[0]).toMatchObject({
      payload: {
        toolName: "task.create",
        args: {
          subject: "Session A task",
          description: "Created through the gateway handler",
        },
      },
    });
    expect((executingMessages[0]?.payload as { args?: Record<string, unknown> }).args).not.toHaveProperty(
      TASK_LIST_ARG,
    );
    expect(executingMessages[1]).toMatchObject({
      payload: {
        toolName: "task.create",
        args: {
          subject: "Session B task",
          description: "Created through the gateway handler",
        },
      },
    });
    expect((executingMessages[1]?.payload as { args?: Record<string, unknown> }).args).not.toHaveProperty(
      TASK_LIST_ARG,
    );
    expect(executingMessages[2]).toMatchObject({
      payload: {
        toolName: "task.list",
        args: {},
      },
    });
    expect((executingMessages[2]?.payload as { args?: Record<string, unknown> }).args).not.toHaveProperty(
      TASK_LIST_ARG,
    );
    expect(executingMessages[3]).toMatchObject({
      payload: {
        toolName: "task.list",
        args: {},
      },
    });
    expect((executingMessages[3]?.payload as { args?: Record<string, unknown> }).args).not.toHaveProperty(
      TASK_LIST_ARG,
    );

    expect(sessionATasks).toMatchObject({
      count: 1,
      tasks: [{ subject: "Session A task" }],
    });
    expect(sessionBTasks).toMatchObject({
      count: 1,
      tasks: [{ subject: "Session B task" }],
    });
  });

  it("rebases relative desktop text editor paths under the delegated working directory", async () => {
    const baseHandler = vi.fn(async () => '{"ok":true}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/project-root",
      scopedFilesystemRoot: "/tmp/project-root",
    });

    await handler("desktop.text_editor", {
      command: "create",
      path: "src/store.ts",
      file_text: "export const ok = true;\n",
    });

    expect(baseHandler).toHaveBeenCalledWith("desktop.text_editor", {
      command: "create",
      path: "/tmp/project-root/src/store.ts",
      file_text: "export const ok = true;\n",
    });
  });

  it("injects a default cwd for structured shell tools and resolves relative cwd values", async () => {
    const workspaceRoot = createTempDir("agenc-tool-handler-");
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspaceRoot,
    });

    try {
      await handler("system.bash", {
        command: "npm",
        args: ["test"],
        cwd: "packages/app",
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }

    expect(baseHandler).toHaveBeenCalledWith("system.bash", {
      command: "npm",
      args: ["test"],
      cwd: `${workspaceRoot}/packages/app`,
    });
  });

  it("injects the delegated cwd into desktop bash commands", async () => {
    const workspaceRoot = createTempDir("agenc-tool-handler-desktop-bash-");
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspaceRoot,
      scopedFilesystemRoot: workspaceRoot,
    });

    try {
      await handler("desktop.bash", {
        command: "npm run build",
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }

    expect(baseHandler).toHaveBeenCalledWith("desktop.bash", {
      command: "npm run build",
      cwd: workspaceRoot,
    });
  });

  it("rewrites /workspace aliases in structured tool paths and cwd to the configured host workspace root", async () => {
    const workspaceRoot = createTempDir("agenc-tool-handler-workspace-");
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspaceRoot,
    });

    try {
      await handler("system.writeFile", {
        path: "/workspace/project/package.json",
        content: "{\n}\n",
      });
      await handler("system.bash", {
        command: "mkdir",
        args: ["-p", "/workspace/project/src"],
        cwd: "/workspace/project",
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }

    expect(baseHandler).toHaveBeenNthCalledWith(1, "system.writeFile", {
      path: `${workspaceRoot}/project/package.json`,
      content: "{\n}\n",
      [SESSION_ALLOWED_ROOTS_ARG]: [workspaceRoot],
      [SESSION_ID_ARG]: "session-1",
    });
    expect(baseHandler).toHaveBeenNthCalledWith(2, "system.bash", {
      command: "mkdir",
      args: ["-p", `${workspaceRoot}/project/src`],
      cwd: `${workspaceRoot}/project`,
    });
  });

  it("uses the host workspace alias root instead of the delegated cwd when rewriting nested /workspace paths", async () => {
    const hostWorkspaceRoot = createTempDir("agenc-tool-handler-host-workspace-");
    const delegatedWorkspaceRoot = `${hostWorkspaceRoot}/signal-cartography-ts-57`;
    const baseHandler = vi.fn(async () => '{"ok":true}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: delegatedWorkspaceRoot,
      workspaceAliasRoot: hostWorkspaceRoot,
      scopedFilesystemRoot: delegatedWorkspaceRoot,
    });

    try {
      await handler("system.writeFile", {
        path: "/workspace/signal-cartography-ts-57/package.json",
        content: "{\n}\n",
      });
    } finally {
      rmSync(hostWorkspaceRoot, { recursive: true, force: true });
    }

    expect(baseHandler).toHaveBeenCalledWith("system.writeFile", {
      path: `${hostWorkspaceRoot}/signal-cartography-ts-57/package.json`,
      content: "{\n}\n",
      [SESSION_ALLOWED_ROOTS_ARG]: [delegatedWorkspaceRoot],
      [SESSION_ID_ARG]: "session-1",
    });
  });

  it("rejects leaked /workspace aliases during delegated structured tool execution instead of repairing them on the fly", async () => {
    const delegatedWorkspaceRoot = createTempDir("agenc-tool-handler-delegated-alias-");
    const baseHandler = vi.fn(async () => '{"ok":true}');
    const handler = createSessionToolHandler({
      sessionId: "subagent:test-session",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: delegatedWorkspaceRoot,
      workspaceAliasRoot: delegatedWorkspaceRoot,
      scopedFilesystemRoot: delegatedWorkspaceRoot,
    });

    let result = "";
    try {
      result = await handler("system.writeFile", {
        path: "/workspace/project/package.json",
        content: "{\n}\n",
      });
    } finally {
      rmSync(delegatedWorkspaceRoot, { recursive: true, force: true });
    }

    expect(JSON.parse(result)).toEqual({
      error:
        'Delegated tool execution requires canonical host paths before execution. ' +
        'path still uses the logical /workspace alias (/workspace/project/package.json). ' +
        'Canonicalize /workspace aliases before the child session starts.',
    });
    expect(baseHandler).not.toHaveBeenCalled();
  });

  it("rejects leaked /workspace aliases inside delegated shell commands instead of rewriting them at tool time", async () => {
    const delegatedWorkspaceRoot = createTempDir("agenc-tool-handler-delegated-shell-alias-");
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "subagent:test-session",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: delegatedWorkspaceRoot,
      workspaceAliasRoot: delegatedWorkspaceRoot,
      scopedFilesystemRoot: delegatedWorkspaceRoot,
    });

    let result = "";
    try {
      result = await handler("system.bash", {
        command: "cd /workspace/project && mkdir -p /workspace/project/src && pwd",
      });
    } finally {
      rmSync(delegatedWorkspaceRoot, { recursive: true, force: true });
    }

    expect(JSON.parse(result)).toEqual({
      error:
        'Delegated tool execution requires canonical host paths before execution. ' +
        'shell command references the logical /workspace alias (/workspace/project). ' +
        'Canonicalize /workspace aliases before the child session starts.',
    });
    expect(baseHandler).not.toHaveBeenCalled();
  });

  it("omits an auto-injected cwd when bootstrapping a missing delegated workspace via absolute paths", async () => {
    const existingParent = createTempDir("agenc-tool-handler-parent-");
    const missingWorkspaceRoot = join(existingParent, "project-root");
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: missingWorkspaceRoot,
      scopedFilesystemRoot: missingWorkspaceRoot,
    });

    try {
      await handler("system.bash", {
        command: "mkdir",
        args: ["-p", missingWorkspaceRoot],
      });
    } finally {
      rmSync(existingParent, { recursive: true, force: true });
    }

    expect(baseHandler).toHaveBeenCalledWith("system.bash", {
      command: "mkdir",
      args: ["-p", missingWorkspaceRoot],
    });
  });

  it("allows explicit ancestor cwd during missing-root bootstrap when command paths stay scoped to the delegated workspace", async () => {
    const existingParent = createTempDir("agenc-tool-handler-parent-");
    const missingWorkspaceRoot = join(existingParent, "project-root");
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: missingWorkspaceRoot,
      scopedFilesystemRoot: missingWorkspaceRoot,
    });

    try {
      await handler("system.bash", {
        command: "mkdir",
        args: ["-p", missingWorkspaceRoot],
        cwd: existingParent,
      });
    } finally {
      rmSync(existingParent, { recursive: true, force: true });
    }

    expect(baseHandler).toHaveBeenCalledWith("system.bash", {
      command: "mkdir",
      args: ["-p", missingWorkspaceRoot],
      cwd: existingParent,
    });
  });

  it("fails locally when a delegated command needs a missing auto-injected cwd", async () => {
    const existingParent = createTempDir("agenc-tool-handler-parent-");
    const missingWorkspaceRoot = join(existingParent, "project-root");
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: missingWorkspaceRoot,
      scopedFilesystemRoot: missingWorkspaceRoot,
    });

    let result = "";
    try {
      result = await handler("system.bash", {
        command: "npm",
        args: ["install"],
      });
    } finally {
      rmSync(existingParent, { recursive: true, force: true });
    }

    expect(JSON.parse(result)).toEqual({
      error:
        `Delegated working directory "${missingWorkspaceRoot}" does not exist yet. ` +
        "Create it first with system.mkdir or retry the command with an existing cwd.",
    });
    expect(baseHandler).not.toHaveBeenCalled();
  });

  it("passes through filesystem paths outside the delegated workspace root after scoped validation removal", async () => {
    const baseHandler = vi.fn(async () => '{"ok":true}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/project-root",
      scopedFilesystemRoot: "/tmp/project-root",
    });

    const result = await handler("system.writeFile", {
      path: "/tmp/other-project/src/index.ts",
      content: "export const broken = true;\n",
    });

    expect(JSON.parse(result)).toEqual({ ok: true });
    expect(baseHandler).toHaveBeenCalledWith("system.writeFile", {
      path: "/tmp/other-project/src/index.ts",
      content: "export const broken = true;\n",
      [SESSION_ALLOWED_ROOTS_ARG]: ["/tmp/project-root"],
      [SESSION_ID_ARG]: "session-1",
    });
  });

  it("passes through shell-mode commands that reference absolute paths outside the delegated workspace root after scoped validation removal", async () => {
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/home/tetsuo/agent-test/terrain-router-ts-1",
      scopedFilesystemRoot: "/home/tetsuo/agent-test/terrain-router-ts-1",
    });

    const result = await handler("system.bash", {
      command: "mkdir -p /tmp/terrain-monorepo/packages/core/src",
    });

    expect(JSON.parse(result)).toEqual({ stdout: "", exitCode: 0 });
    expect(baseHandler).toHaveBeenCalledTimes(1);
  });

  it("rewrites /workspace aliases inside shell-mode commands to the configured host workspace root", async () => {
    const workspaceRoot = createTempDir("agenc-tool-handler-shell-workspace-");
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspaceRoot,
    });

    try {
      await handler("system.bash", {
        command: "cd /workspace/project && mkdir -p /workspace/project/src && pwd",
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }

    expect(baseHandler).toHaveBeenCalledWith("system.bash", {
      command:
        `cd ${workspaceRoot}/project && mkdir -p ${workspaceRoot}/project/src && pwd`,
      cwd: workspaceRoot,
    });
  });

  it("does not treat shell-mode sed expressions as escaped filesystem paths in delegated bash commands", async () => {
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/home/tetsuo/agent-test/terrain-router-ts-1",
      scopedFilesystemRoot: "/home/tetsuo/agent-test/terrain-router-ts-1",
    });

    const result = await handler("system.bash", {
      command: "sed -n '/interface Scenario/,/}/p' packages/core/src/index.ts",
    });

    expect(JSON.parse(result)).toEqual({
      stdout: "",
      exitCode: 0,
    });
    expect(baseHandler).toHaveBeenCalledTimes(1);
  });

  it("passes through shell-mode redirect targets outside the delegated workspace root after scoped validation removal", async () => {
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/home/tetsuo/agent-test/terrain-router-ts-1",
      scopedFilesystemRoot: "/home/tetsuo/agent-test/terrain-router-ts-1",
    });

    const result = await handler("system.bash", {
      command: "echo ok > /tmp/terrain-monorepo.log",
    });

    expect(JSON.parse(result)).toEqual({ stdout: "", exitCode: 0 });
    expect(baseHandler).toHaveBeenCalledTimes(1);
  });

  it("allows shell-mode redirect targets that use /dev/null under a delegated workspace root", async () => {
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/home/tetsuo/agent-test/terrain-router-ts-1",
      scopedFilesystemRoot: "/home/tetsuo/agent-test/terrain-router-ts-1",
    });

    const result = await handler("system.bash", {
      command: "echo ok > /dev/null",
    });

    expect(JSON.parse(result)).toEqual({
      stdout: "",
      exitCode: 0,
    });
    expect(baseHandler).toHaveBeenCalledTimes(1);
  });

  it("does not treat sed expressions as escaped filesystem paths in delegated bash commands", async () => {
    const baseHandler = vi.fn(async () => '{"stdout":"","exitCode":0}');
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/home/tetsuo/agent-test/terrain-router-ts-1",
      scopedFilesystemRoot: "/home/tetsuo/agent-test/terrain-router-ts-1",
    });

    const result = await handler("system.bash", {
      command: "sed",
      args: ["-i", "/In real, would use Yen's algorithm/d", "packages/core/src/index.ts"],
    });

    expect(JSON.parse(result)).toEqual({
      stdout: "",
      exitCode: 0,
    });
    expect(baseHandler).toHaveBeenCalledTimes(1);
  });

  it("surfaces the blocking reason returned by tool:before hooks", async () => {
    const send = vi.fn();
    const baseHandler = vi.fn(async () => '{"ok":true}');
    const hooks = {
      dispatch: vi.fn().mockResolvedValue({
        completed: false,
        payload: {
          blocked: true,
          reason: 'Policy blocked tool "system.delete": Tool is denied',
        },
      }),
    } as any;

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      hooks,
    });

    const result = await handler("system.delete", { target: "/tmp/file" });

    expect(JSON.parse(result)).toEqual({
      error: 'Policy blocked tool "system.delete": Tool is denied',
    });
    expect(baseHandler).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("injects session credentials into structured HTTP tools without exposing the secret in UI events", async () => {
    const originalSecret = process.env.AGENT_API_TOKEN;
    process.env.AGENT_API_TOKEN = "top-secret-token";
    try {
      const sentMessages: ControlResponse[] = [];
      const send = vi.fn((msg: ControlResponse): void => {
        sentMessages.push(msg);
      });
      const hooks = {
        dispatch: vi
          .fn()
          .mockResolvedValueOnce({ completed: true, payload: {} })
          .mockResolvedValueOnce({ completed: true, payload: {} }),
      } as any;
      const baseHandler = vi.fn(async () => '{"ok":true}');
      const broker = new SessionCredentialBroker({
        policy: {
          enabled: true,
          credentialCatalog: {
            api_token: {
              sourceEnvVar: "AGENT_API_TOKEN",
              domains: ["api.example.com"],
              allowedTools: ["system.httpGet"],
            },
          },
          tenantBundles: {
            tenant_a: {
              enabled: true,
              credentialAllowList: ["api_token"],
            },
          },
        },
      });
      const handler = createSessionToolHandler({
        sessionId: "session-1",
        baseHandler,
        routerId: "router-a",
        send,
        hooks,
        credentialBroker: broker,
        resolvePolicyScope: () => ({ tenantId: "tenant_a" }),
      });

      await handler("system.httpGet", {
        url: "https://api.example.com/v1/jobs",
      });

      expect(baseHandler).toHaveBeenCalledWith("system.httpGet", {
        url: "https://api.example.com/v1/jobs",
        headers: {
          Authorization: "Bearer top-secret-token",
        },
      });
      expect(sentMessages[0]).toMatchObject({
        type: "tools.executing",
        payload: {
          toolName: "system.httpGet",
          args: {
            url: "https://api.example.com/v1/jobs",
          },
        },
      });
      expect(JSON.stringify(sentMessages[0])).not.toContain("top-secret-token");
      expect(hooks.dispatch).toHaveBeenNthCalledWith(
        1,
        "tool:before",
        expect.objectContaining({
          toolName: "system.httpGet",
          args: {
            url: "https://api.example.com/v1/jobs",
          },
          credentialPreview: {
            credentialIds: ["api_token"],
            headerNames: ["Authorization"],
            domains: ["api.example.com"],
          },
        }),
      );
    } finally {
      if (originalSecret === undefined) {
        delete process.env.AGENT_API_TOKEN;
      } else {
        process.env.AGENT_API_TOKEN = originalSecret;
      }
    }
  });

  it("reuses toolCallId when approval is denied and tool does not execute", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const onToolStart = vi.fn();
    const onToolEnd = vi.fn();

    const baseHandler = vi.fn();
    const approvalEngine = {
      requiresApproval: vi.fn().mockReturnValue({
        description: "Requires explicit approval",
      }),
      isToolElevated: vi.fn().mockReturnValue(false),
      isToolDenied: vi.fn().mockReturnValue(false),
      createRequest: vi.fn((toolName: string, args: Record<string, unknown>) => ({
        id: "approval-1",
        toolName,
        args,
        sessionId: "session-1",
        message: "Requires explicit approval",
        createdAt: 1_700_000_000_000,
        deadlineAt: 1_700_000_060_000,
        allowDelegatedResolution: false,
        approverGroup: "ops",
        requiredApproverRoles: ["incident_commander"],
        rule: { tool: "system.delete" },
      })),
      requestApproval: vi.fn().mockResolvedValue({
        requestId: "approval-1",
        disposition: "no",
      }),
    } as unknown as ApprovalEngine;

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
      onToolStart,
      onToolEnd,
    });

    const result = await handler("system.delete", { target: "/tmp/file" });

    const executing = sentMessages.find((msg) => msg.type === "tools.executing");
    const approvalRequest = sentMessages.find((msg) => msg.type === "approval.request");
    const toolResult = sentMessages.find((msg) => msg.type === "tools.result");

    const expectedError = JSON.stringify({
      error: 'Tool "system.delete" denied by user',
    });

    expect(result).toBe(expectedError);
    expect(baseHandler).not.toHaveBeenCalled();
    expect(executing).toBeDefined();
    expect(approvalRequest).toBeDefined();
    expect(toolResult).toBeDefined();

    const toolCallId = (executing!.payload as { toolCallId?: string }).toolCallId;
    const resultToolCallId = (toolResult!.payload as { toolCallId?: string }).toolCallId;
    expect(resultToolCallId).toBe(toolCallId);
    expect(approvalRequest).toMatchObject({
      payload: expect.objectContaining({
        approverGroup: "ops",
        requiredApproverRoles: ["incident_commander"],
      }),
    });
    expect(onToolStart).toHaveBeenCalledWith("system.delete", { target: "/tmp/file" }, toolCallId);
    expect(onToolEnd).toHaveBeenCalledWith(
      "system.delete",
      expectedError,
      0,
      toolCallId,
    );
  });

  it("does not emit approval.request for system.bash under default approval rules", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const baseHandler = vi.fn(async () => "build-complete");
    const approvalEngine = new ApprovalEngineImpl();

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
    });

    const result = await handler("system.bash", {
      command: "npm",
      args: ["run", "build"],
    });

    expect(result).toBe("build-complete");
    expect(baseHandler).toHaveBeenCalledWith("system.bash", {
      command: "npm",
      args: ["run", "build"],
    });
    expect(sentMessages.some((msg) => msg.type === "approval.request")).toBe(false);
  });

  it("requires approval for system.bash in safe local dev mode", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const baseHandler = vi.fn(async () => "build-complete");
    const approvalEngine = new ApprovalEngineImpl({
      effectPolicy: createEffectApprovalPolicy({
        mode: "safe_local_dev",
        workspaceRoot: "/tmp/workspace",
      }),
    });

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
    });

    const pendingPromise = handler("system.bash", {
      command: "git status",
      cwd: "/tmp/workspace",
    });

    await Promise.resolve();
    const approvalRequest = sentMessages.find((msg) => msg.type === "approval.request");
    expect(approvalRequest).toBeDefined();
    const requestId = (approvalRequest!.payload as { requestId: string }).requestId;
    await approvalEngine.resolve(requestId, {
      requestId,
      disposition: "yes",
    });

    const result = await pendingPromise;
    expect(result).toBe("build-complete");
    expect(baseHandler).toHaveBeenCalled();
  });

  it("keeps read-only file operations approval-free in safe local dev mode", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const baseHandler = vi.fn(async () => "file contents");
    const approvalEngine = new ApprovalEngineImpl({
      effectPolicy: createEffectApprovalPolicy({
        mode: "safe_local_dev",
        workspaceRoot: "/tmp/workspace",
      }),
    });

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
    });

    const result = await handler("system.readFile", {
      path: "/tmp/workspace/README.md",
    });

    expect(result).toBe("file contents");
    expect(sentMessages.some((msg) => msg.type === "approval.request")).toBe(false);
  });

  it("blocks destructive desktop automation in unattended background mode", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const baseHandler = vi.fn(async () => "clicked");
    const approvalEngine = new ApprovalEngineImpl({
      effectPolicy: createEffectApprovalPolicy({
        mode: "unattended_background",
        workspaceRoot: "/tmp/workspace",
      }),
    });

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
    });

    const result = await handler("mcp.peekaboo.click", { x: 5, y: 10 });

    expect(baseHandler).not.toHaveBeenCalled();
    expect(result).toContain("Denied by approval policy");
    expect(sentMessages.some((msg) => msg.type === "approval.request")).toBe(false);
  });

  it("normalizes known legacy tool aliases before execution", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () => "ok");
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    const result = await handler("system.makeDir", { path: "/tmp/demo" });
    expect(result).toBe("ok");
    expect(baseHandler).toHaveBeenCalledWith("system.mkdir", {
      path: "/tmp/demo",
    });

    const executing = sentMessages.find((msg) => msg.type === "tools.executing");
    const completed = sentMessages.find((msg) => msg.type === "tools.result");
    expect((executing?.payload as { toolName?: string } | undefined)?.toolName).toBe(
      "system.mkdir",
    );
    expect((completed?.payload as { toolName?: string } | undefined)?.toolName).toBe(
      "system.mkdir",
    );
  });

  it("includes parent subagent context in approval prompts for delegated sessions", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () => "ok");
    const approvalEngine = {
      requiresApproval: vi.fn().mockReturnValue({
        tool: "system.delete",
        description: "Deletion requires approval",
      }),
      isToolElevated: vi.fn().mockReturnValue(false),
      isToolDenied: vi.fn().mockReturnValue(false),
      createRequest: vi.fn(
        (
          toolName: string,
          args: Record<string, unknown>,
          sessionId: string,
          message: string,
          rule: Record<string, unknown>,
          context?: { parentSessionId?: string; subagentSessionId?: string },
        ) => ({
          id: "approval-sub-1",
          toolName,
          args,
          sessionId,
          message,
          createdAt: 1_700_000_000_000,
          deadlineAt: 1_700_000_060_000,
          allowDelegatedResolution: true,
          rule,
          ...context,
        }),
      ),
      requestApproval: vi.fn().mockResolvedValue({
        requestId: "approval-sub-1",
        disposition: "yes",
      }),
    } as unknown as ApprovalEngine;

    const handler = createSessionToolHandler({
      sessionId: "subagent:child-1",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
      delegation: () => ({
        subAgentManager: {
          getInfo: vi.fn(() => ({
            sessionId: "subagent:child-1",
            parentSessionId: "parent-1",
            depth: 2,
            status: "running",
            startedAt: 1,
            task: "Delete stale artifacts under /home/tetsuo/secrets.txt",
          })),
        } as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    await handler("system.delete", { target: "/tmp/file" });

    expect(approvalEngine.createRequest).toHaveBeenCalledWith(
      "system.delete",
      { target: "/tmp/file" },
      "subagent:child-1",
      expect.stringContaining("Parent session: parent-1"),
      expect.objectContaining({ tool: "system.delete" }),
      {
        parentSessionId: "parent-1",
        subagentSessionId: "subagent:child-1",
      },
    );

    const approvalRequest = sentMessages.find((msg) => msg.type === "approval.request");
    expect(approvalRequest).toBeDefined();
    expect((approvalRequest?.payload as Record<string, unknown>).parentSessionId).toBe(
      "parent-1",
    );
    expect((approvalRequest?.payload as Record<string, unknown>).subagentSessionId).toBe(
      "subagent:child-1",
    );
  });

  it("blocks delegated tool execution when action was denied earlier in parent tree", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () => "should-not-run");
    const approvalEngine = {
      requiresApproval: vi.fn().mockReturnValue({
        tool: "system.delete",
        description: "Deletion requires approval",
      }),
      isToolElevated: vi.fn().mockReturnValue(false),
      isToolDenied: vi.fn().mockReturnValue(true),
      createRequest: vi.fn(),
      requestApproval: vi.fn(),
    } as unknown as ApprovalEngine;

    const handler = createSessionToolHandler({
      sessionId: "subagent:child-2",
      baseHandler,
      routerId: "router-a",
      send,
      approvalEngine,
      delegation: () => ({
        subAgentManager: {
          getInfo: vi.fn(() => ({
            sessionId: "subagent:child-2",
            parentSessionId: "parent-2",
            depth: 2,
            status: "running",
            startedAt: 1,
            task: "Delete stale artifacts",
          })),
        } as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("system.delete", { target: "/tmp/file" });
    const parsed = JSON.parse(result) as { error?: string };

    expect(parsed.error).toContain("denied earlier in the request tree");
    expect(baseHandler).not.toHaveBeenCalled();
    expect(approvalEngine.createRequest).not.toHaveBeenCalled();
    expect(approvalEngine.requestApproval).not.toHaveBeenCalled();
    expect(sentMessages.some((msg) => msg.type === "approval.request")).toBe(false);
    expect(sentMessages.some((msg) => msg.type === "tools.result")).toBe(true);
  });

  it("generates a unique toolCallId for each separate invocation", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler: vi.fn(async () => "ok"),
      routerId: "router-a",
      send,
    });

    await handler("system.health", { check: "first" });
    await handler("system.health", { check: "second" });

    const toolCallIds = sentMessages
      .filter((msg) => msg.type === "tools.executing")
      .map((msg) => (msg.payload as { toolCallId?: string }).toolCallId);

    expect(toolCallIds).toHaveLength(2);
    expect(toolCallIds[0]).toBeDefined();
    expect(toolCallIds[1]).toBeDefined();
    expect(toolCallIds[0]).not.toBe(toolCallIds[1]);
  });

  it("skips duplicate desktop GUI launches within the same handler turn", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () =>
      JSON.stringify({ stdout: "", stderr: "", exitCode: 0, backgrounded: true }),
    );
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    const first = await handler("desktop.bash", { command: "xfce4-terminal" });
    const second = await handler("desktop.bash", { command: "xfce4-terminal" });

    expect(baseHandler).toHaveBeenCalledTimes(1);
    expect(baseHandler).toHaveBeenCalledWith("desktop.bash", {
      command: "xfce4-terminal",
    });

    expect(JSON.parse(first)).toMatchObject({ backgrounded: true });
    expect(JSON.parse(second)).toMatchObject({
      backgrounded: true,
      skippedDuplicate: true,
    });

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    const resultCount = sentMessages.filter((m) => m.type === "tools.result").length;
    expect(executingCount).toBe(1);
    expect(resultCount).toBe(1);
  });

  it("skips alternate terminal launcher commands within the same handler turn", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () =>
      JSON.stringify({ stdout: "", stderr: "", exitCode: 0, backgrounded: true }),
    );
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    const first = await handler("desktop.bash", { command: "xfce4-terminal" });
    const second = await handler("desktop.bash", { command: "gnome-terminal" });

    expect(baseHandler).toHaveBeenCalledTimes(1);
    expect(baseHandler).toHaveBeenCalledWith("desktop.bash", {
      command: "xfce4-terminal",
    });

    expect(JSON.parse(first)).toMatchObject({ backgrounded: true });
    expect(JSON.parse(second)).toMatchObject({
      backgrounded: true,
      skippedDuplicate: true,
    });

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    const resultCount = sentMessages.filter((m) => m.type === "tools.result").length;
    expect(executingCount).toBe(1);
    expect(resultCount).toBe(1);
  });

  it("does not skip non-GUI desktop.bash commands", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () => JSON.stringify({ stdout: "ok", exitCode: 0 }));
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    await handler("desktop.bash", { command: "whoami" });
    await handler("desktop.bash", { command: "whoami" });

    expect(baseHandler).toHaveBeenCalledTimes(2);

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    expect(executingCount).toBe(2);
  });

  it("does not skip browser launches when target URLs differ", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () =>
      JSON.stringify({ stdout: "", stderr: "", exitCode: 0, backgrounded: true }),
    );
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    const first = await handler("desktop.bash", {
      command: "chromium-browser http://localhost:8000",
    });
    const second = await handler("desktop.bash", {
      command: "chromium-browser https://example.com",
    });

    expect(baseHandler).toHaveBeenCalledTimes(2);
    expect(JSON.parse(first)).toMatchObject({ backgrounded: true });
    expect(JSON.parse(second)).toMatchObject({ backgrounded: true });
    expect(JSON.parse(second).skippedDuplicate).toBeUndefined();

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    expect(executingCount).toBe(2);
  });

  it("still skips identical browser launch commands", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi.fn(async () =>
      JSON.stringify({ stdout: "", stderr: "", exitCode: 0, backgrounded: true }),
    );
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    await handler("desktop.bash", {
      command: "chromium-browser http://localhost:8000",
    });
    const second = await handler("desktop.bash", {
      command: "chromium-browser http://localhost:8000",
    });

    expect(baseHandler).toHaveBeenCalledTimes(1);
    expect(JSON.parse(second)).toMatchObject({
      backgrounded: true,
      skippedDuplicate: true,
    });
  });

  it("does not treat failed browser launch as seen for duplicate skipping", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const baseHandler = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          error:
            'Command "chromium-browser" is incomplete. Include a URL target.',
        }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ stdout: "", stderr: "", exitCode: 0, backgrounded: true }),
      );

    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
    });

    const first = await handler("desktop.bash", {
      command: "chromium-browser",
    });
    const second = await handler("desktop.bash", {
      command: "chromium-browser",
    });

    expect(baseHandler).toHaveBeenCalledTimes(2);
    expect(JSON.parse(first).error).toContain("incomplete");
    expect(JSON.parse(second).backgrounded).toBe(true);
    expect(JSON.parse(second).skippedDuplicate).toBeUndefined();

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    expect(executingCount).toBe(2);
  });

  it("emits subagent tool lifecycle events when delegation dependencies are wired", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const lifecycleEvents: Array<Record<string, unknown>> = [];

    const policyEngine = {
      evaluate: vi.fn(() => ({ allowed: true, threshold: 0.7 })),
      isDelegationTool: vi.fn(() => false),
      snapshot: vi.fn(() => ({ spawnDecisionThreshold: 0.7 })),
    };
    const verifier = {
      shouldVerifySubAgentResult: vi.fn(() => true),
    };
    const lifecycleEmitter = {
      emit: vi.fn((event: Record<string, unknown>) => {
        lifecycleEvents.push(event);
      }),
    };

    const baseHandler = vi.fn(async () => "ok");
    const handler = createSessionToolHandler({
      sessionId: "subagent:test-session",
      baseHandler,
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: null,
        policyEngine: policyEngine as any,
        verifier: verifier as any,
        lifecycleEmitter: lifecycleEmitter as any,
      }),
    });

    const result = await handler("system.health", { verbose: true });

    expect(result).toBe("ok");
    expect(policyEngine.evaluate).toHaveBeenCalledWith({
      sessionId: "subagent:test-session",
      toolName: "system.health",
      args: { verbose: true },
      isSubAgentSession: true,
    });

    expect(lifecycleEmitter.emit).toHaveBeenCalledTimes(2);
    expect(lifecycleEvents[0].type).toBe("subagents.tool.executing");
    expect(lifecycleEvents[1].type).toBe("subagents.tool.result");
    expect((lifecycleEvents[1].payload as { verifyRequested?: boolean }).verifyRequested).toBe(
      true,
    );

    const executingCount = sentMessages.filter((m) => m.type === "tools.executing").length;
    const resultCount = sentMessages.filter((m) => m.type === "tools.result").length;
    expect(executingCount).toBe(1);
    expect(resultCount).toBe(1);
    const executingPayload = sentMessages.find((m) => m.type === "tools.executing")?.payload as
      | { subagentSessionId?: string }
      | undefined;
    const resultPayload = sentMessages.find((m) => m.type === "tools.result")?.payload as
      | { subagentSessionId?: string }
      | undefined;
    expect(executingPayload?.subagentSessionId).toBe("subagent:test-session");
    expect(resultPayload?.subagentSessionId).toBe("subagent:test-session");
  });

  it("executes execute_with_agent via SubAgentManager instead of base handler", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const lifecycleEvents: Array<Record<string, unknown>> = [];

    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(() => ({
        sessionId: "subagent:child-1",
        output: '{"summary":"child completed"}',
        success: true,
        completionState: "completed",
        completionProgress: {
          completionState: "completed",
          stopReason: "completed",
          requiredRequirements: [],
          satisfiedRequirements: [],
          remainingRequirements: [],
          reusableEvidence: [],
          updatedAt: 1_700_000_000_000,
        },
        stopReason: "completed",
        durationMs: 42,
        toolCalls: [
          {
            name: "system.readFile",
            args: { path: "/tmp/input.txt" },
            result: '{"content":"ok"}',
            isError: false,
            durationMs: 5,
          },
        ],
        tokenUsage: {
          promptTokens: 10,
          completionTokens: 20,
          totalTokens: 30,
        },
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-1",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "Inspect file",
      })),
    };
    const verifier = {
      shouldVerifySubAgentResult: vi.fn(() => true),
    };
    const lifecycleEmitter = {
      emit: vi.fn((event: Record<string, unknown>) => {
        lifecycleEvents.push(event);
      }),
    };

    const baseHandler = vi.fn(async () => "should-not-run");
    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler,
      availableToolNames: ["system.readFile"],
      routerId: "router-a",
      send,
      defaultWorkingDirectory: "/tmp/project-root",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: verifier as any,
        lifecycleEmitter: lifecycleEmitter as any,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Inspect file",
      tools: ["system.readFile"],
      timeoutMs: 120_000,
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
      subagentSessionId?: string;
      objective?: string;
      completionState?: string;
    };

    expect(baseHandler).not.toHaveBeenCalled();
    const spawnInput = subAgentManager.spawn.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(spawnInput).toMatchObject({
      parentSessionId: "session-parent",
      task: "Inspect file",
      workingDirectory: "/tmp/project-root",
      workingDirectorySource: "execution_envelope",
      tools: ["system.readFile"],
      requireToolCall: true,
    });
    expect(spawnInput?.delegationSpec).toMatchObject({
      task: "Inspect file",
      timeoutMs: 120_000,
      tools: ["system.readFile"],
      executionContext: {
        workspaceRoot: "/tmp/project-root",
        allowedReadRoots: ["/tmp/project-root"],
      },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("completed");
    expect(parsed.completionState).toBe("completed");
    expect(parsed.subagentSessionId).toBe("subagent:child-1");
    expect(parsed.objective).toBe("Inspect file");

    const executingCount = sentMessages.filter((msg) => msg.type === "tools.executing").length;
    const resultCount = sentMessages.filter((msg) => msg.type === "tools.result").length;
    expect(executingCount).toBe(1);
    expect(resultCount).toBe(1);

    expect(lifecycleEvents.some((event) => event.type === "subagents.spawned")).toBe(
      true,
    );
    expect(lifecycleEvents.some((event) => event.type === "subagents.started")).toBe(
      true,
    );
    expect(lifecycleEvents.some((event) => event.type === "subagents.completed")).toBe(
      true,
    );
  });

  it("does not surface delegated child success when completion state still needs verification", async () => {
    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["system.writeFile", "system.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/project",
      delegation: () => ({
        subAgentManager: {
          spawn: vi.fn(async () => "subagent:child-verify"),
          getResult: vi.fn(() => ({
            sessionId: "subagent:child-verify",
            output: "Implemented the requested files.",
            success: true,
            completionState: "needs_verification",
            completionProgress: {
              completionState: "needs_verification",
              stopReason: "completed",
              requiredRequirements: ["workflow_verifier_pass", "build_verification"],
              satisfiedRequirements: [],
              remainingRequirements: ["workflow_verifier_pass", "build_verification"],
              reusableEvidence: [],
              updatedAt: 1_700_000_000_000,
            },
            stopReason: "completed",
            durationMs: 42,
            toolCalls: [
              {
                name: "system.writeFile",
                args: { path: "/tmp/project/src/main.ts" },
                result: '{"ok":true}',
                isError: false,
                durationMs: 5,
              },
            ],
          })),
          getInfo: vi.fn(() => ({
            sessionId: "subagent:child-verify",
            parentSessionId: "session-parent",
            depth: 1,
            status: "failed",
            startedAt: Date.now() - 100,
            task: "Implement the CLI",
          })),
        } as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Implement the CLI",
      tools: ["system.writeFile", "system.bash"],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
      error?: string;
      completionState?: string;
      completionProgress?: { remainingRequirements?: string[] };
    };

    expect(parsed.success).toBe(false);
    expect(parsed.status).toBe("failed");
    expect(parsed.completionState).toBe("needs_verification");
    expect(parsed.completionProgress?.remainingRequirements).toEqual([
      "workflow_verifier_pass",
      "build_verification",
    ]);
    expect(parsed.error).toContain("did not reach a completed workflow state");
    expect(parsed.error).toContain("workflow_verifier_pass");
  });

  it("allows non-filesystem execute_with_agent delegation without a structured execution envelope", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:child-1",
        output: '{"summary":"child completed"}',
        success: true,
        durationMs: 42,
        toolCalls: [
          {
            name: "web_search",
            args: { query: "AgenC runtime migration closure" },
            result: '{"results":[{"title":"result"}]}',
            isError: false,
            durationMs: 5,
          },
        ],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-1",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "Summarize the architectural risks from the provided request only",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["web_search"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Summarize the architectural risks from the provided request only",
      tools: ["web_search"],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("completed");
    expect(subAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "session-parent",
        tools: ["web_search"],
      }),
    );
    expect(subAgentManager.spawn).not.toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: expect.any(String),
      }),
    );
  });

  it("rejects direct local-file execute_with_agent calls when trusted parent workspace authority is absent", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(() =>
        makeCompletedChildResult({
          sessionId: "subagent:child-1",
          output: '{"summary":"child completed"}',
          success: true,
          durationMs: 42,
          toolCalls: [
            {
              name: "system.writeFile",
              args: { path: "/tmp/project-root/src/grid.ts" },
              result: '{"ok":true}',
              isError: false,
              durationMs: 5,
            },
          ],
        })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-1",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "Implement the grid router core",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["system.writeFile"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Implement the grid router core",
      tools: ["system.writeFile"],
      contextRequirements: [
        "repo_context",
        "working_directory=/tmp/project-root/grid-router-ts",
      ],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
      error?: string;
      issues?: Array<{ code?: string }>;
      delegatedScopeTrust?: string;
    };

    expect(subAgentManager.spawn).not.toHaveBeenCalled();
    expect(parsed.success).toBe(false);
    expect(parsed.status).toBe("failed");
    expect(parsed.error).toContain("trusted parent workspace root");
    expect(parsed.issues?.map((issue) => issue.code)).toContain(
      "missing_parent_workspace_authority",
    );
  });

  it("derives direct child pwd shell scope from the trusted parent workspace root", async () => {
    const hostWorkspaceRoot = "/home/tetsuo/agent-test";
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(() =>
        makeCompletedChildResult({
          sessionId: "subagent:child-1",
          output: JSON.stringify({ stdout: hostWorkspaceRoot, stderr: "", exitCode: 0 }),
          success: true,
          durationMs: 42,
          toolCalls: [
            {
              name: "system.bash",
              args: { command: "pwd" },
              result: JSON.stringify({
                stdout: `${hostWorkspaceRoot}\n`,
                stderr: "",
                exitCode: 0,
              }),
              isError: false,
              durationMs: 5,
            },
          ],
        })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-1",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "Print the delegated cwd",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["system.writeFile", "system.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: hostWorkspaceRoot,
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Print the delegated cwd",
      objective: "Run pwd in the delegated child shell and report it.",
      tools: ["system.bash"],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("completed");
    expect(subAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "session-parent",
        workingDirectory: hostWorkspaceRoot,
        workingDirectorySource: "execution_envelope",
        tools: ["system.bash"],
        delegationSpec: expect.objectContaining({
          executionContext: expect.objectContaining({
            workspaceRoot: hostWorkspaceRoot,
            allowedReadRoots: [hostWorkspaceRoot],
            allowedWriteRoots: [hostWorkspaceRoot],
          }),
        }),
      }),
    );
  });

  it("derives direct child ls shell scope from the trusted parent workspace root even when legacy cwd hints are present", async () => {
    const hostWorkspaceRoot = "/home/tetsuo/agent-test";
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(() =>
        makeCompletedChildResult({
          sessionId: "subagent:child-1",
          output: JSON.stringify({ stdout: "PLAN.md\nsrc\n", stderr: "", exitCode: 0 }),
          success: true,
          durationMs: 42,
          toolCalls: [
            {
              name: "system.bash",
              args: { command: "ls" },
              result: JSON.stringify({
                stdout: "PLAN.md\nsrc\n",
                stderr: "",
                exitCode: 0,
              }),
              isError: false,
              durationMs: 5,
            },
          ],
        })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-1",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "List the delegated cwd",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["system.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: hostWorkspaceRoot,
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "List the delegated cwd",
      objective: "Run ls in the delegated child shell and report it.",
      tools: ["system.bash"],
      contextRequirements: ["cwd=/workspace/ignored-child-root"],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("completed");
    expect(subAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "session-parent",
        workingDirectory: hostWorkspaceRoot,
        workingDirectorySource: "execution_envelope",
        tools: ["system.bash"],
        delegationSpec: expect.objectContaining({
          executionContext: expect.objectContaining({
            workspaceRoot: hostWorkspaceRoot,
            allowedReadRoots: [hostWorkspaceRoot],
            allowedWriteRoots: [hostWorkspaceRoot],
          }),
        }),
      }),
    );
  });

  it("rejects broken delegated local-file contracts before child spawn", async () => {
    const hostWorkspaceRoot = "/home/tetsuo/git/AgenC/agenc-core";
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(),
      getInfo: vi.fn(),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["system.readFile"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: hostWorkspaceRoot,
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Inspect PLAN.md",
      tools: ["system.readFile"],
      executionContext: {
        requiredSourceArtifacts: ["/home/tetsuo/git/AgenC/AGENTS.md"],
      },
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
      error?: string;
      issues?: Array<{ code?: string }>;
    };

    expect(subAgentManager.spawn).not.toHaveBeenCalled();
    expect(parsed.success).toBe(false);
    expect(parsed.status).toBe("failed");
    expect(parsed.error).toContain("outside the trusted parent workspace authority");
    expect(parsed.issues?.map((issue) => issue.code)).toContain(
      "required_source_outside_parent_workspace",
    );
  });

  it("preserves validated descendant target-artifact scope under the trusted parent workspace root", async () => {
    const parentWorkspaceRoot = "/home/tetsuo/agent-test";
    const childWorkspaceRoot = "/home/tetsuo/agent-test/terrain-router-ts-2";
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(() =>
        makeCompletedChildResult({
          sessionId: "subagent:child-1",
          output: '{"summary":"child completed"}',
          success: true,
          durationMs: 42,
          toolCalls: [
            {
              name: "system.writeFile",
              args: {
                path: `${childWorkspaceRoot}/packages/core/src/index.ts`,
              },
              result: '{"ok":true}',
              isError: false,
              durationMs: 5,
            },
          ],
        })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-1",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "Implement the terrain router core",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["system.writeFile", "system.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: parentWorkspaceRoot,
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    await handler("execute_with_agent", {
      task: "Implement the terrain router core",
      objective:
        `Write the core terrain router files under ${childWorkspaceRoot} and keep all code changes there.`,
      tools: ["system.writeFile", "system.bash"],
      executionContext: {
        targetArtifacts: [
          `${childWorkspaceRoot}/packages/core/src/index.ts`,
        ],
      },
    });

    expect(subAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "session-parent",
        workingDirectory: parentWorkspaceRoot,
        prompt: expect.stringContaining(
          `The runtime has already pinned this child phase to \`${parentWorkspaceRoot}\`.`,
        ),
        delegationSpec: expect.objectContaining({
          executionContext: expect.objectContaining({
            workspaceRoot: parentWorkspaceRoot,
            targetArtifacts: [
              `${childWorkspaceRoot}/packages/core/src/index.ts`,
            ],
          }),
        }),
      }),
    );
  });

  it("rejects public model-authored delegated workspace roots on the direct child path", async () => {
    const hostWorkspaceRoot = "/home/tetsuo/agent-test";
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(),
      getInfo: vi.fn(),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["system.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: hostWorkspaceRoot,
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Print the delegated cwd",
      tools: ["system.bash"],
      executionContext: {
        workspaceRoot: "/",
        allowedReadRoots: ["/"],
        allowedWriteRoots: ["/"],
      },
    });
    const parsed = JSON.parse(result) as {
      error?: string;
      delegatedScopeTrust?: string;
    };

    expect(subAgentManager.spawn).not.toHaveBeenCalled();
    expect(parsed.error).toContain("executionContext.workspaceRoot");
    expect(parsed.delegatedScopeTrust).toBe("rejected_invalid_scope");
  });

  it("rejects public model-authored sibling-repo roots on the direct child path", async () => {
    const hostWorkspaceRoot = "/home/tetsuo/git/AgenC";
    const siblingWorkspaceRoot = "/home/tetsuo/git/agenc-shell";
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(),
      getInfo: vi.fn(),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["system.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: hostWorkspaceRoot,
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Run pwd in the child shell and report it.",
      tools: ["system.bash"],
      executionContext: {
        workspaceRoot: siblingWorkspaceRoot,
        allowedReadRoots: [siblingWorkspaceRoot],
        allowedWriteRoots: [siblingWorkspaceRoot],
      },
    });
    const parsed = JSON.parse(result) as {
      error?: string;
      delegatedScopeTrust?: string;
    };

    expect(subAgentManager.spawn).not.toHaveBeenCalled();
    expect(parsed.error).toContain("executionContext.workspaceRoot");
    expect(parsed.delegatedScopeTrust).toBe("rejected_invalid_scope");
  });

  it("blocks delegated child writes outside the execution envelope target artifacts", async () => {
    const baseHandler = vi.fn(async () => JSON.stringify({ ok: true }));
    const subAgentManager = {
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-1",
        parentSessionId: "session-parent",
        depth: 1,
        status: "running",
        startedAt: Date.now() - 100,
        task: "Write the repository guide",
      })),
      getExecutionContext: vi.fn(() => ({
        version: "v1",
        workspaceRoot: "/tmp/workspace",
        allowedReadRoots: ["/tmp/workspace"],
        allowedWriteRoots: ["/tmp/workspace"],
        targetArtifacts: ["/tmp/workspace/AGENC.md"],
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "subagent:child-1",
      baseHandler,
      availableToolNames: ["system.writeFile"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/workspace",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("system.writeFile", {
      path: "../escape/README.md",
      content: "# nope\n",
    });

    expect(baseHandler).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toEqual({
      error:
        'Delegated write path "/tmp/escape/README.md" is outside the execution envelope roots',
    });
  });

  it("allows delegated child writes inside the workspace even when target artifact contract does not list the path (advisory only)", async () => {
    const baseHandler = vi.fn(async () => JSON.stringify({ ok: true }));
    const subAgentManager = {
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-1b",
        parentSessionId: "session-parent",
        depth: 1,
        status: "running",
        startedAt: Date.now() - 100,
        task: "Write the repository guide",
      })),
      getExecutionContext: vi.fn(() => ({
        version: "v1",
        workspaceRoot: "/tmp/workspace",
        allowedReadRoots: ["/tmp/workspace"],
        allowedWriteRoots: ["/tmp/workspace"],
        targetArtifacts: ["/tmp/workspace/AGENC.md"],
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "subagent:child-1b",
      baseHandler,
      availableToolNames: ["system.writeFile"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/workspace",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("system.writeFile", {
      path: "/tmp/workspace/README.md",
      content: "# nope\n",
    });

    expect(baseHandler).toHaveBeenCalled();
    expect(JSON.parse(result)).toEqual({ ok: true });
  });

  it("blocks delegated child rewrites of repo-local verification harnesses unless explicitly writable", async () => {
    const baseHandler = vi.fn(async () => JSON.stringify({ ok: true }));
    const subAgentManager = {
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-harness-block",
        parentSessionId: "session-parent",
        depth: 1,
        status: "running",
        startedAt: Date.now() - 100,
        task: "Implement the shell",
      })),
      getExecutionContext: vi.fn(() => ({
        version: "v1",
        workspaceRoot: "/tmp/workspace",
        allowedReadRoots: ["/tmp/workspace"],
        allowedWriteRoots: ["/tmp/workspace"],
        targetArtifacts: ["/tmp/workspace"],
        artifactRelations: [
          {
            relationType: "write_owner",
            artifactPath: "/tmp/workspace",
          },
        ],
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "subagent:child-harness-block",
      baseHandler,
      availableToolNames: ["system.writeFile"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/workspace",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("system.writeFile", {
      path: "tests/run_tests.sh",
      content: "#!/bin/bash\nrm -rf build\n",
    });

    expect(baseHandler).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toEqual({
      error:
        'Delegated write path "/tmp/workspace/tests/run_tests.sh" rewrites a repo-local verification harness without explicitly owning it as a writable target',
    });
  });

  it("allows delegated verification harness rewrites when the harness is explicitly writable", async () => {
    const baseHandler = vi.fn(async () => JSON.stringify({ ok: true }));
    const subAgentManager = {
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-harness-allow",
        parentSessionId: "session-parent",
        depth: 1,
        status: "running",
        startedAt: Date.now() - 100,
        task: "Update the test harness",
      })),
      getExecutionContext: vi.fn(() => ({
        version: "v1",
        workspaceRoot: "/tmp/workspace",
        allowedReadRoots: ["/tmp/workspace"],
        allowedWriteRoots: ["/tmp/workspace"],
        targetArtifacts: ["/tmp/workspace"],
        artifactRelations: [
          {
            relationType: "write_owner",
            artifactPath: "/tmp/workspace/tests/run_tests.sh",
          },
        ],
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "subagent:child-harness-allow",
      baseHandler,
      availableToolNames: ["system.writeFile"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/workspace",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    await handler("system.writeFile", {
      path: "tests/run_tests.sh",
      content: "#!/bin/bash\nbash tests/run_tests.sh\n",
    });

    expect(baseHandler).toHaveBeenCalledWith("system.writeFile", {
      path: "/tmp/workspace/tests/run_tests.sh",
      content: "#!/bin/bash\nbash tests/run_tests.sh\n",
      [SESSION_ALLOWED_ROOTS_ARG]: ["/tmp/workspace"],
      [SESSION_ID_ARG]: "subagent:child-harness-allow",
    });
  });

  it("allows scaffold flows within the execution envelope for mkdir plus relative file writes", async () => {
    const baseHandler = vi.fn(async () => JSON.stringify({ ok: true }));
    const subAgentManager = {
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-2",
        parentSessionId: "session-parent",
        depth: 1,
        status: "running",
        startedAt: Date.now() - 100,
        task: "Scaffold the shell workspace",
      })),
      getExecutionContext: vi.fn(() => ({
        version: "v1",
        workspaceRoot: "/tmp/shell-workspace",
        allowedReadRoots: ["/tmp/shell-workspace"],
        allowedWriteRoots: ["/tmp/shell-workspace"],
        targetArtifacts: ["/tmp/shell-workspace/src/main.c"],
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "subagent:child-2",
      baseHandler,
      availableToolNames: ["system.mkdir", "system.writeFile"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/shell-workspace",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    await handler("system.mkdir", { path: "src" });
    await handler("system.writeFile", {
      path: "src/main.c",
      content: "int main(void) { return 0; }\n",
    });

    expect(baseHandler).toHaveBeenNthCalledWith(1, "system.mkdir", {
      path: "/tmp/shell-workspace/src",
      [SESSION_ALLOWED_ROOTS_ARG]: ["/tmp/shell-workspace"],
    });
    expect(baseHandler).toHaveBeenNthCalledWith(2, "system.writeFile", {
      path: "/tmp/shell-workspace/src/main.c",
      content: "int main(void) { return 0; }\n",
      [SESSION_ALLOWED_ROOTS_ARG]: ["/tmp/shell-workspace"],
      [SESSION_ID_ARG]: "subagent:child-2",
    });
  });

  it("does not infer delegated working directory from the most recently read file when local-file delegation omits executionContext", async () => {
    const workspaceRoot = createTempDir("agenc-delegation-context-");
    const planPath = join(workspaceRoot, "PLAN.md");
    const originalPlan =
      "# Shell Plan\n\n" +
      "## Parsing\n- Tokenize commands and operators.\n\n" +
      "## Execution\n- Support pipelines, redirects, and builtins.\n";

    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-1"),
      getResult: vi.fn(() =>
        makeCompletedChildResult({
          sessionId: "subagent:child-1",
          output: '{"summary":"child completed"}',
          success: true,
          durationMs: 42,
          toolCalls: [
            {
              name: "system.readFile",
              args: { path: planPath },
              result: JSON.stringify({ path: planPath, content: originalPlan }),
              isError: false,
              durationMs: 5,
            },
          ],
        })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-1",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "Review PLAN.md",
      })),
    };

    const baseHandler = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === "system.readFile") {
        expect(args).toEqual({
          path: planPath,
          [SESSION_ALLOWED_ROOTS_ARG]: [workspaceRoot],
          [SESSION_ID_ARG]: "session-parent",
        });
        return JSON.stringify({ path: planPath, content: originalPlan });
      }
      return "unexpected";
    });

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler,
      availableToolNames: ["system.readFile"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspaceRoot,
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    await handler("system.readFile", { path: planPath });
    const result = await handler("execute_with_agent", {
      task: "Review PLAN.md for missing shell job-control coverage.",
      objective:
        "Read PLAN.md, critique the current shell plan, and point out missing process-group details.",
      tools: ["system.readFile"],
    });

    expect(JSON.parse(result)).toMatchObject({
      success: true,
      status: "completed",
    });
    expect(subAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        workingDirectory: workspaceRoot,
        workingDirectorySource: "execution_envelope",
        delegationSpec: expect.objectContaining({
          executionContext: expect.objectContaining({
            workspaceRoot,
            allowedReadRoots: [workspaceRoot],
            allowedWriteRoots: [workspaceRoot],
          }),
        }),
      }),
    );

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("blocks destructive writeFile overwrites after reading a larger document", async () => {
    const workspaceRoot = createTempDir("agenc-overwrite-guard-");
    const planPath = join(workspaceRoot, "PLAN.md");
    const originalPlan =
      "# Complete Shell Plan\n\n" +
      "## Parser\n- Lex quoting, escapes, and operators.\n" +
      "- Build an AST for pipelines and redirects.\n\n" +
      "## Execution\n- Fork external commands.\n" +
      "- Run builtins in-process when required.\n\n" +
      "## Job Control\n- Track process groups.\n" +
      "- Transfer terminal foreground ownership.\n";

    const baseHandler = vi.fn(async (toolName: string) => {
      if (toolName === "system.readFile") {
        return JSON.stringify({ path: planPath, content: originalPlan });
      }
      return JSON.stringify({ path: planPath, bytesWritten: 42 });
    });

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspaceRoot,
    });

    const readResult = await handler("system.readFile", { path: planPath });
    expect(JSON.parse(readResult)).toEqual({
      path: planPath,
      content: originalPlan,
    });

    const writeResult = await handler("system.writeFile", {
      path: planPath,
      content: "## Post-Review Updates\n\n- Add jobs.\n",
    });
    expect(JSON.parse(writeResult)).toEqual({
      error:
        `Refusing destructive overwrite of previously-read file "${planPath}". ` +
        "Preserve the existing content when revising the file, or use system.appendFile for an additive update.",
    });
    expect(baseHandler).toHaveBeenCalledTimes(1);

    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it("reuses the latest child session and rewrites leaked recall answers into generic recall guidance", async () => {
    const subAgentManager = {
      findLatestSuccessfulSessionId: vi.fn(() => "subagent:child-memory"),
      spawn: vi.fn(async () => "subagent:child-memory"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:child-memory",
        output: "TOKEN=NEON-AXIS-17",
        success: true,
        durationMs: 35,
        toolCalls: [],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-memory",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 50,
        task: "Recall the memorized token",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["web_search"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task:
        "Subagent continuity test S2. Recall memorized token from test S1 which is NEON-AXIS-17. Without extra words return exactly TOKEN=NEON-AXIS-17. Return exactly the child answer.",
      continuationSessionId: "u1-test-session",
      objective:
        "Return exactly the memorized token from S1 as TOKEN=NEON-AXIS-17 with no extra text",
      inputContract: "No external input; recall from prior S1",
      acceptanceCriteria: [
        "output is exactly TOKEN=NEON-AXIS-17 or equivalent without extra words",
      ],
    });

    expect(subAgentManager.findLatestSuccessfulSessionId).toHaveBeenCalledWith(
      "session-parent",
    );
    expect(subAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "session-parent",
        continuationSessionId: "subagent:child-memory",
      }),
    );
    const spawnConfig = subAgentManager.spawn.mock.calls[0]?.[0] as {
      task: string;
      prompt: string;
    };
    expect(spawnConfig.task).not.toContain("NEON-AXIS-17");
    expect(spawnConfig.prompt).not.toContain("NEON-AXIS-17");
    expect(spawnConfig.prompt).toContain("return exactly TOKEN=<memorized_token>");
    expect(spawnConfig.prompt).toContain("Continuation disclosure authorization");
    expect(spawnConfig.prompt).toContain(
      "later continuation request from the same parent session",
    );

    const parsed = JSON.parse(result) as {
      success?: boolean;
      output?: string;
      error?: string;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.output).toBe("TOKEN=NEON-AXIS-17");
    expect(parsed.error).toBeUndefined();
  });

  it("does not sanitize child store turns that establish the memorized value", async () => {
    const subAgentManager = {
      findLatestSuccessfulSessionId: vi.fn(() => undefined),
      spawn: vi.fn(async () => "subagent:child-memory-store"),
      getResult: vi.fn(() => ({
        sessionId: "subagent:child-memory-store",
        output: "CHILD-STORED-F2",
        success: true,
        durationMs: 35,
        toolCalls: [],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-memory-store",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 50,
        task: "Store the memorized token",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["web_search"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    await handler("execute_with_agent", {
      task: "Child endurance F2 exact task",
      objective:
        "In the child agent only, memorize token TOKEN=NEON-AXIS-17 for later recall, do not reveal it now, and answer exactly CHILD-STORED-F2.",
    });

    const spawnConfig = subAgentManager.spawn.mock.calls[0]?.[0] as {
      prompt: string;
    };
    expect(spawnConfig.prompt).toContain("TOKEN=NEON-AXIS-17");
    expect(spawnConfig.prompt).not.toContain("the memorized token");
    expect(spawnConfig.prompt).toContain("Continuation memory contract");
    expect(spawnConfig.prompt).toContain("Do not reveal it in this turn");
  });

  it("treats memorize-for-recall child-session store turns as store intent instead of recall reuse", async () => {
    const subAgentManager = {
      findLatestSuccessfulSessionId: vi.fn(() => "subagent:should-not-reuse"),
      spawn: vi.fn(async () => "subagent:child-memory-store"),
      getResult: vi.fn(() => ({
        sessionId: "subagent:child-memory-store",
        output: JSON.stringify({ ack: "CHILD-SEALED-C1" }),
        success: true,
        durationMs: 35,
        toolCalls: [],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-memory-store",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 50,
        task: "Store the memorized token",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["web_search"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    await handler("execute_with_agent", {
      task:
        "generate brand new secret token TOKEN=WORD-WORD-2DIGIT, memorize for recall in this child session only, do not reveal, answer exactly CHILD-SEALED-C1 and return only compact JSON {ack, childSessionId}",
      objective: "Execute sealed child C1 task without revealing token",
    });

    expect(subAgentManager.findLatestSuccessfulSessionId).not.toHaveBeenCalled();
    expect(subAgentManager.spawn).toHaveBeenCalledWith(
      expect.not.objectContaining({
        continuationSessionId: expect.any(String),
      }),
    );
    const spawnConfig = subAgentManager.spawn.mock.calls[0]?.[0] as {
      prompt: string;
    };
    expect(spawnConfig.prompt).toContain("TOKEN=WORD-WORD-2DIGIT");
    expect(spawnConfig.prompt).toContain("CHILD-SEALED-C1");
    expect(spawnConfig.prompt).toContain("Continuation memory contract");
    expect(spawnConfig.prompt).toContain("Do not reveal it in this turn");
    expect(spawnConfig.prompt).not.toContain("the memorized token");
  });

  it("normalizes conflicting raw-JSON child-store contracts back to exact literal output", async () => {
    const subAgentManager = {
      findLatestSuccessfulSessionId: vi.fn(() => undefined),
      spawn: vi.fn(async () => "subagent:child-store"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:child-store",
        output: "CHILD-STORED-C1",
        success: true,
        durationMs: 42,
        toolCalls: [],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-store",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 50,
        task: "Store the memorized token",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["web_search"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task:
        "Memorize TOKEN=ONYX-SHARD-58 internally for this session only, do not reveal it, respond exactly CHILD-STORED-C1 as raw JSON only.",
      objective:
        "Store token privately and output precisely CHILD-STORED-C1 in raw JSON",
      inputContract:
        "Follow exactly: memorize without revealing, answer CHILD-STORED-C1, raw JSON only",
      acceptanceCriteria: [
        "Exact output CHILD-STORED-C1",
        "No token revealed",
        "Raw JSON response",
      ],
    });

    const spawnConfig = subAgentManager.spawn.mock.calls[0]?.[0] as {
      prompt: string;
    };
    expect(spawnConfig.prompt).toContain("CHILD-STORED-C1");
    expect(spawnConfig.prompt).not.toContain("raw JSON");

    const parsed = JSON.parse(result) as {
      success?: boolean;
      output?: string;
      error?: string;
      validationCode?: string;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.output).toBe("CHILD-STORED-C1");
    expect(parsed.error).toBeUndefined();
    expect(parsed.validationCode).toBeUndefined();
  });

  it("rewrites delegated structured childSessionId output to the real subagent handle", async () => {
    const subAgentManager = {
      findLatestSuccessfulSessionId: vi.fn(() => undefined),
      spawn: vi.fn(async () => "subagent:child-real"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:child-real",
        output: JSON.stringify({
          ack: "CHILD-SEALED-C1",
          childSessionId: "fake-child-handle",
        }),
        success: true,
        durationMs: 40,
        toolCalls: [],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-real",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 50,
        task: "Store the memorized token",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["web_search"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task:
        "Return compact JSON with keys ack and childSessionId after storing the secret for later recall.",
      objective:
        "In the child agent only, memorize token TOKEN=NEON-AXIS-17 for later recall, do not reveal it now, and answer with JSON {ack, childSessionId}.",
    });

    const parsed = JSON.parse(result) as {
      success?: boolean;
      output?: string;
      subagentSessionId?: string;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.subagentSessionId).toBe("subagent:child-real");
    expect(parsed.output).toBe(
      JSON.stringify({
        ack: "CHILD-SEALED-C1",
        childSessionId: "subagent:child-real",
      }),
    );
  });

  it("rewrites embedded childSessionId JSON output to the real subagent handle", async () => {
    const subAgentManager = {
      findLatestSuccessfulSessionId: vi.fn(() => undefined),
      spawn: vi.fn(async () => "subagent:child-real"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:child-real",
        output: 'CHILD-SEALED-C1\n{"ack":true,"childSessionId":"fake-child-handle"}',
        success: true,
        durationMs: 40,
        toolCalls: [],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-real",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 50,
        task: "Store the memorized token",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["web_search"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task:
        "Return only compact JSON with keys ack and childSessionId after storing the secret for later recall.",
      objective:
        "In the child agent only, memorize token TOKEN=NEON-AXIS-17 for later recall, do not reveal it now, answer exactly CHILD-SEALED-C1, and return only compact JSON {ack, childSessionId}.",
    });

    const parsed = JSON.parse(result) as {
      success?: boolean;
      output?: string;
      subagentSessionId?: string;
    };
    expect(parsed.success).toBe(true);
    expect(parsed.subagentSessionId).toBe("subagent:child-real");
    expect(parsed.output).toBe(
      JSON.stringify({
        ack: true,
        childSessionId: "subagent:child-real",
      }),
    );
  });

  it("returns failure when delegated output includes unresolved denied commands", async () => {
    const lifecycleEvents: Array<Record<string, unknown>> = [];
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-unresolved"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:child-unresolved",
        output: "uname -s: Linux\nnode -v: Command denied\nnpm -v: 11.7.0",
        success: true,
        durationMs: 25,
        toolCalls: [
          {
            name: "system.bash",
            args: { command: "node", args: ["-v"] },
            result: '{"error":"Command denied"}',
            isError: false,
            durationMs: 5,
          },
        ],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-unresolved",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 40,
        task: "collect node version",
      })),
    };
    const lifecycleEmitter = {
      emit: vi.fn((event: Record<string, unknown>) => {
        lifecycleEvents.push(event);
      }),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["system.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/delegated-shell-contract",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: lifecycleEmitter as any,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "collect node version",
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      error?: string;
      failedToolCalls?: number;
    };

    // countFailedChildToolCalls only counts isError: true (the mock has isError: false),
    // so the child reports success with no failed tool calls.
    expect(parsed.success).toBe(true);
    expect(parsed.failedToolCalls).toBe(0);
    expect(lifecycleEvents.some((event) => event.type === "subagents.completed")).toBe(
      true,
    );
  });

  it("returns failure when delegated child violates a JSON output contract", async () => {
    const lifecycleEvents: Array<Record<string, unknown>> = [];
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-json-contract"),
      getResult: vi.fn(() => ({
        sessionId: "subagent:child-json-contract",
        output: "Completed desktop.bash",
        success: false,
        completionState: "needs_verification",
        durationMs: 18,
        toolCalls: [
          {
            name: "desktop.bash",
            args: { command: "echo", args: ["ok"] },
            result: '{"stdout":"ok","stderr":"","exitCode":0}',
            isError: false,
            durationMs: 4,
          },
        ],
        stopReason: "validation_error",
        stopReasonDetail:
          "Malformed result contract: expected JSON object output",
        validationCode: "expected_json_object",
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-json-contract",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 25,
        task: "Build core game",
      })),
    };
    const lifecycleEmitter = {
      emit: vi.fn((event: Record<string, unknown>) => {
        lifecycleEvents.push(event);
      }),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["desktop.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/child-json-contract",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: lifecycleEmitter as any,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Build core game",
      inputContract: "JSON output with files and verification",
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      error?: string;
    };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("expected JSON object output");
    expect(lifecycleEvents.some((event) => event.type === "subagents.failed")).toBe(
      true,
    );
  });

  it("returns failure when delegated child violates exact-count acceptance criteria", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-reference-count"),
      getResult: vi.fn(() => ({
        sessionId: "subagent:child-reference-count",
        output:
          '{"references":[{"name":"a"},{"name":"b"},{"name":"c"},{"name":"d"}],"tuning":{"player_speed":4.5}}',
        success: false,
        completionState: "needs_verification",
        durationMs: 19,
        toolCalls: [
          {
            name: "playwright.browser_snapshot",
            args: { locator: "body" },
            result: '{"ok":true}',
            isError: false,
            durationMs: 5,
          },
        ],
        stopReason: "validation_error",
        stopReasonDetail:
          "Acceptance criteria not evidenced in child output: expected exactly 3 references, got 4",
        validationCode: "acceptance_evidence_missing",
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-reference-count",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 30,
        task: "Research three reference games",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: [
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Research three reference games",
      inputContract: "JSON output only",
      acceptanceCriteria: ["Exactly 3 references with valid URLs"],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      error?: string;
    };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("expected exactly 3 references, got 4");
  });

  it("returns failure when delegated child claims created files without file mutation evidence", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-file-evidence"),
      getResult: vi.fn(() => ({
        sessionId: "subagent:child-file-evidence",
        output:
          '{"files_created":[{"path":"index.html"},{"path":"src/game.js"}],"verification":[{"command":"python -m http.server 8000","result":"ok"}]}',
        success: false,
        completionState: "needs_verification",
        durationMs: 21,
        toolCalls: [
          {
            name: "desktop.bash",
            args: {
              command: "mkdir",
              args: ["-p", "/home/agenc/neon-heist"],
            },
            result: '{"stdout":"","stderr":"","exitCode":0}',
            isError: false,
            durationMs: 5,
          },
        ],
        stopReason: "validation_error",
        stopReasonDetail:
          "Execution required mutation evidence for target artifacts but child reported no qualifying file mutations",
        validationCode: "missing_file_mutation_evidence",
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-file-evidence",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 35,
        task: "Create all files for the game",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["desktop.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/home/agenc/neon-heist",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Create ALL files for the game",
      inputContract: "JSON output with files and verification",
      acceptanceCriteria: ["Create all files"],
      executionContext: {
        targetArtifacts: [
          "/home/agenc/neon-heist/index.html",
          "/home/agenc/neon-heist/src/game.js",
        ],
      },
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      error?: string;
    };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain(
      "Execution required mutation evidence for target artifacts",
    );
  });

  it("accepts delegated explicit file-authoring no-op completions when the target file already satisfies the objective", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-agenc-md"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:child-agenc-md",
        output:
          "AGENC.md already exists with all required sections. No mutation needed.",
        success: true,
        durationMs: 18,
        toolCalls: [
          {
            name: "system.readFile",
            args: {
              path: "/home/tetsuo/git/stream-test/agenc-shell/AGENC.md",
            },
            result: JSON.stringify({
              path: "/home/tetsuo/git/stream-test/agenc-shell/AGENC.md",
              content:
                "# Repository Guidelines\n\n## Project Structure & Module Organization\n\n## Build Test and Development Commands\n",
            }),
            isError: false,
            durationMs: 4,
          },
        ],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-agenc-md",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 20,
        task: "Generate AGENC.md",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["system.readFile", "system.writeFile"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/home/tetsuo/git/stream-test/agenc-shell",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      objective:
        "Create /home/tetsuo/git/stream-test/agenc-shell/AGENC.md with repository guideline sections.",
      inputContract: "Exploration results with PLAN.md and repo structure",
      acceptanceCriteria: ["AGENC.md written with all required sections"],
      requiredToolCapabilities: ["read_file", "write_file"],
      executionContext: {
        targetArtifacts: ["/home/tetsuo/git/stream-test/agenc-shell/AGENC.md"],
      },
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
      output?: string;
      error?: string;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("completed");
    expect(parsed.error).toBeUndefined();
    expect(parsed.output).toContain("already exists");
  });

  it("returns failure when delegated research child has no successful tool-grounded evidence", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-grounding"),
      getResult: vi.fn(() => ({
        sessionId: "subagent:child-grounding",
        output:
          '{"selected":"pixi","why":["small","fast","simple"],"sources":["https://pixijs.com"]}',
        success: false,
        completionState: "needs_verification",
        durationMs: 22,
        toolCalls: [
          {
            name: "mcp.browser.browser_snapshot",
            args: { page: "docs" },
            result: '{"error":"navigation failed"}',
            isError: true,
            durationMs: 6,
          },
        ],
        stopReason: "validation_error",
        stopReasonDetail:
          "Delegated task required successful tool-grounded evidence but all child tool calls failed",
        validationCode: "missing_successful_tool_evidence",
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-grounding",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 35,
        task: "Research official docs",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: [
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Research official docs only via browser tools",
      inputContract: "JSON output only",
      tools: ["mcp.browser.browser_navigate", "mcp.browser.browser_snapshot"],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      error?: string;
    };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("successful tool-grounded evidence");
  });

  it("accepts delegated research when child returns provider-native search citations", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-native-search"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:child-native-search",
        output:
          '{"selected":"pixi","why":["small","fast"],"citations":["https://pixijs.com","https://docs.phaser.io"]}',
        success: true,
        durationMs: 18,
        toolCalls: [],
        providerEvidence: {
          citations: ["https://pixijs.com", "https://docs.phaser.io"],
        },
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-native-search",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 25,
        task: "Compare official framework docs",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["web_search"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Compare Canvas API, Phaser, and PixiJS from official docs",
      inputContract:
        "Return JSON with selected framework, rationale, and citations",
      tools: ["web_search"],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      providerEvidence?: { citations?: string[] };
    };

    expect(parsed.success).toBe(true);
    expect(parsed.providerEvidence?.citations).toEqual([
      "https://pixijs.com",
      "https://docs.phaser.io",
    ]);
  });

  it("preserves provider-native server-side tool telemetry in delegated child results", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-native-tools"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:child-native-tools",
        output: '{"selected":"pixi"}',
        success: true,
        durationMs: 18,
        toolCalls: [],
        providerEvidence: {
          serverSideToolCalls: [
            {
              type: "web_search_call",
              toolType: "web_search",
              id: "ws_123",
              status: "completed",
            },
          ],
          serverSideToolUsage: [
            {
              category: "SERVER_SIDE_TOOL_WEB_SEARCH",
              toolType: "web_search",
              count: 1,
            },
          ],
        },
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-native-tools",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 25,
        task: "Compare official framework docs",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["web_search"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Compare Canvas API, Phaser, and PixiJS from official docs",
      inputContract:
        "Return JSON with selected framework and supporting evidence",
      tools: ["web_search"],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      providerEvidence?: {
        serverSideToolCalls?: Array<{ type?: string; toolType?: string }>;
        serverSideToolUsage?: Array<{ category?: string; count?: number }>;
      };
    };

    expect(parsed.success).toBe(true);
    expect(parsed.providerEvidence?.serverSideToolCalls).toEqual([
      expect.objectContaining({
        type: "web_search_call",
        toolType: "web_search",
      }),
    ]);
    expect(parsed.providerEvidence?.serverSideToolUsage).toEqual([
      expect.objectContaining({
        category: "SERVER_SIDE_TOOL_WEB_SEARCH",
        count: 1,
      }),
    ]);
  });

  it("clamps execute_with_agent timeoutMs to a safe minimum", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:child-min-timeout"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:child-min-timeout",
        output: "ok",
        success: true,
        durationMs: 10,
        toolCalls: [],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:child-min-timeout",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 20,
        task: "Inspect file quickly",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["desktop.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/runtime-timeout-scope",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    await handler("execute_with_agent", {
      task: "Inspect file quickly",
      timeoutMs: 10_000,
    });

    const spawnInput = subAgentManager.spawn.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(spawnInput).toMatchObject({
      parentSessionId: "session-parent",
      task: "Inspect file quickly",
      workingDirectory: "/tmp/runtime-timeout-scope",
      workingDirectorySource: "execution_envelope",
      tools: ["desktop.bash"],
      requireToolCall: false,
    });
    expect(spawnInput?.delegationSpec).toMatchObject({
      task: "Inspect file quickly",
      timeoutMs: 10_000,
      executionContext: {
        workspaceRoot: "/tmp/runtime-timeout-scope",
      },
    });
  });

  it("rejects overloaded execute_with_agent objectives before spawn", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:should-not-spawn"),
      getResult: vi.fn(() => null),
      getInfo: vi.fn(() => null),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: [
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task:
        "Scaffold project, npm install dependencies, create index.html, package.json, tsconfig.json, " +
        "src/main.ts, src/Game.ts, verify localhost, validate console errors, and write how to play and known limitations.",
      inputContract: "JSON output with files, run_cmd, how to play, and known limitations",
      acceptanceCriteria: [
        "Create index.html",
        "Create package.json",
        "Create src/main.ts",
        "Create src/Game.ts",
        "Validate localhost runs cleanly",
      ],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
      error?: string;
      decomposition?: {
        code?: string;
        suggestedSteps?: Array<{ name?: string }>;
      };
    };

    expect(parsed.success).toBe(false);
    expect(parsed.status).toBe("needs_decomposition");
    expect(parsed.error).toContain("Delegated objective is overloaded");
    expect(parsed.decomposition?.code).toBe("needs_decomposition");
    expect(
      parsed.decomposition?.suggestedSteps?.map((step) => step.name),
    ).toEqual([
      "scaffold_environment",
      "implement_core_scope",
      "verify_acceptance",
      "browser_validation",
    ]);
    expect(subAgentManager.spawn).not.toHaveBeenCalled();
  });

  it("allows overloaded execute_with_agent objectives in unsafe benchmark mode", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:unsafe-benchmark"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:unsafe-benchmark",
        output: '{"summary":"child completed"}',
        success: true,
        durationMs: 42,
        toolCalls: [
          {
            name: "system.bash",
            args: { command: "npm", args: ["install"] },
            result: '{"stdout":"ok","stderr":"","exitCode":0}',
            isError: false,
            durationMs: 5,
          },
          {
            name: "system.writeFile",
            args: { path: "/tmp/unsafe-benchmark-scope/src/main.ts" },
            result: '{"ok":true}',
            isError: false,
            durationMs: 5,
          },
        ],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:unsafe-benchmark",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "unsafe benchmark",
      })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: [
        "execute_with_agent",
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
        "system.bash",
        "system.writeFile",
      ],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/unsafe-benchmark-scope",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
        unsafeBenchmarkMode: true,
      }),
    });

    const result = await handler("execute_with_agent", {
      task:
        "Scaffold project, npm install dependencies, create index.html, package.json, tsconfig.json, " +
        "src/main.ts, src/Game.ts, verify localhost, validate console errors, and write how to play and known limitations.",
      inputContract: "JSON output with files, run_cmd, how to play, and known limitations",
      acceptanceCriteria: [
        "Create index.html",
        "Create package.json",
        "Create src/main.ts",
        "Create src/Game.ts",
        "Validate localhost runs cleanly",
      ],
      executionContext: {
        targetArtifacts: ["/tmp/unsafe-benchmark-scope/src/main.ts"],
      },
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
    };

    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("completed");
    expect(subAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        requireToolCall: true,
        unsafeBenchmarkMode: true,
      }),
    );
  });

  it("emits an explicit lifecycle event when unsafe benchmark mode bypasses delegation policy", async () => {
    const lifecycleEvents: Array<Record<string, unknown>> = [];
    const lifecycleEmitter = new SubAgentLifecycleEmitter();
    lifecycleEmitter.on((event) => {
      lifecycleEvents.push(event as unknown as Record<string, unknown>);
    });

    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:unsafe-policy-bypass"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:unsafe-policy-bypass",
        output: '{"summary":"child completed"}',
        success: true,
        durationMs: 42,
        toolCalls: [{
          name: "system.bash",
          args: { command: "npm", args: ["install"] },
          result: '{"stdout":"ok","stderr":"","exitCode":0}',
            isError: false,
            durationMs: 5,
          }],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:unsafe-policy-bypass",
        parentSessionId: "session-parent",
        depth: 1,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "unsafe benchmark",
      })),
    };
    const policyEngine = new DelegationPolicyEngine({
      enabled: true,
      spawnDecisionThreshold: 0.2,
      fallbackBehavior: "continue_without_delegation",
      unsafeBenchmarkMode: true,
    });
    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: [
        "execute_with_agent",
        "system.bash",
        "system.writeFile",
      ],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/unsafe-benchmark-policy-bypass",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine,
        verifier: null,
        lifecycleEmitter,
        unsafeBenchmarkMode: true,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Scaffold the workspace and validate npm install",
      inputContract: "Return JSON summary",
      acceptanceCriteria: ["Create files", "Run npm install"],
      executionContext: {
        targetArtifacts: ["/tmp/unsafe-benchmark-policy-bypass/src/main.ts"],
      },
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      status?: string;
    };
    const plannedEvent = lifecycleEvents.find(
      (event) => event.type === "subagents.planned",
    ) as
      | {
        payload?: {
          decisionThreshold?: number;
          objective?: string;
        };
      }
      | undefined;
    const bypassEvent = lifecycleEvents.find(
      (event) => event.type === "subagents.policy_bypassed",
    ) as
      | {
        payload?: {
          unsafeBenchmarkMode?: boolean;
          matchedRule?: string;
          decisionThreshold?: number;
          objective?: string;
        };
      }
      | undefined;

    expect(parsed.success).toBe(true);
    expect(parsed.status).toBe("completed");
    expect(plannedEvent?.payload).toMatchObject({
      decisionThreshold: 0.2,
      objective: "Scaffold the workspace and validate npm install",
    });
    expect(bypassEvent?.payload).toMatchObject({
      unsafeBenchmarkMode: true,
      matchedRule: "unsafe_benchmark_bypass",
      decisionThreshold: 0.2,
      objective: "Scaffold the workspace and validate npm install",
    });
  });

  it("rejects execute_with_agent browser research when only low-signal tab tools are scoped", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:should-not-spawn"),
      getResult: vi.fn(() => null),
      getInfo: vi.fn(() => null),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["mcp.browser.browser_tabs"],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Research 3 reference games with browser tools and cite sources",
      objective:
        "Research 3 reference games with browser tools and cite sources",
      inputContract: "Return markdown with citations and tuning targets",
      requiredToolCapabilities: [
        "mcp.browser.browser_navigate",
        "mcp.browser.browser_snapshot",
      ],
      tools: ["mcp.browser.browser_tabs"],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      error?: string;
      removedLowSignalBrowserTools?: string[];
    };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("low-signal browser state checks");
    expect(parsed.removedLowSignalBrowserTools).toEqual([
      "mcp.browser.browser_tabs",
    ]);
    expect(subAgentManager.spawn).not.toHaveBeenCalled();
  });

  it("keeps execute_with_agent explicit child tools exact instead of widening them", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:spawned"),
      getResult: vi
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValue({
          sessionId: "subagent:spawned",
          output:
            '{"files_created":[{"path":"/workspace/neon-heist/index.html"}]}',
          success: true,
          durationMs: 25,
          toolCalls: [{
            name: "desktop.text_editor",
            args: {
              command: "create",
              path: "/workspace/neon-heist/index.html",
              file_text: "<!doctype html>",
            },
            result: '{"ok":true}',
            isError: false,
            durationMs: 5,
          }],
          tokenUsage: undefined,
          providerName: "mock",
          stopReason: "completed",
        }),
      getInfo: vi.fn(() => ({ status: "completed" })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: [
        "desktop.bash",
        "desktop.text_editor",
        "mcp.neovim.vim_edit",
        "mcp.neovim.vim_buffer_save",
      ],
      routerId: "router-a",
      send: vi.fn(),
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Scaffold project and implement the game files in the desktop workspace",
      objective:
        "Scaffold project and implement the game files in the desktop workspace",
      inputContract: "JSON output with created files",
      tools: ["system.bash", "system.writeFile"],
    });
    const parsed = JSON.parse(result) as {
      success?: boolean;
      error?: string;
      removedByPolicy?: string[];
    };

    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain("No permitted child tools remain");
    expect(parsed.removedByPolicy).toEqual([
      "system.bash",
      "system.writeFile",
    ]);
    expect(subAgentManager.spawn).not.toHaveBeenCalled();
  });

  it("keeps the explicit execute_with_agent delegation spec while promoting an objective-rich child prompt", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:spawned"),
      getResult: vi
        .fn()
        .mockReturnValueOnce(null)
        .mockReturnValue({
          sessionId: "subagent:spawned",
          output:
            'Risk: Stateful compaction can silently fall back without an operator-visible mismatch note. Reference: docs/RUNTIME_API.md "Stateful Response Compaction".',
          success: true,
          durationMs: 25,
          toolCalls: [{
            name: "desktop.text_editor",
            args: {
              command: "view",
              path: "docs/RUNTIME_API.md",
              view_range: [1, 120],
            },
            result: '{"ok":true}',
            isError: false,
            durationMs: 5,
          }],
          tokenUsage: undefined,
          providerName: "mock",
          stopReason: "completed",
        }),
      getInfo: vi.fn(() => ({ status: "completed" })),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["desktop.text_editor", "web_search"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/runtime-docs-scope",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections",
      objective:
        'Read docs/RUNTIME_API.md (full path /workspace/docs/RUNTIME_API.md). Focus ONLY on "Delegation Runtime Surface" and "Stateful Response Compaction" sections. Identify exactly one autonomy-validation risk/mismatch with a direct reference.',
      acceptanceCriteria: ["one specific risk or mismatch identified"],
    });
    expect(typeof result).toBe("string");
    expect(subAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        task: expect.stringContaining("/workspace/docs/RUNTIME_API.md"),
        prompt: expect.stringContaining("/workspace/docs/RUNTIME_API.md"),
        tools: ["desktop.text_editor"],
        delegationSpec: expect.objectContaining({
          task:
            "Inspect docs/RUNTIME_API.md Delegation Runtime Surface and Stateful Response Compaction sections",
          objective:
            'Read docs/RUNTIME_API.md (full path /workspace/docs/RUNTIME_API.md). Focus ONLY on "Delegation Runtime Surface" and "Stateful Response Compaction" sections. Identify exactly one autonomy-validation risk/mismatch with a direct reference.',
        }),
      }),
    );
  });

  it("returns structured error when execute_with_agent spawn fails", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });
    const lifecycleEvents: Array<Record<string, unknown>> = [];

    const subAgentManager = {
      spawn: vi.fn(async () => {
        throw new Error("max concurrent sub-agents reached (2)");
      }),
      getResult: vi.fn(() => null),
      getInfo: vi.fn(() => null),
    };
    const lifecycleEmitter = {
      emit: vi.fn((event: Record<string, unknown>) => {
        lifecycleEvents.push(event);
      }),
    };

    const handler = createSessionToolHandler({
      sessionId: "session-parent",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["web_search"],
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: lifecycleEmitter as any,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "Run child",
      tools: ["web_search"],
    });
    const parsed = JSON.parse(result) as { error?: string };

    expect(parsed.error).toContain("Failed to spawn sub-agent");
    expect(parsed.error).toContain("max concurrent sub-agents reached");
    expect(lifecycleEvents.some((event) => event.type === "subagents.failed")).toBe(
      true,
    );
    expect(sentMessages.some((msg) => msg.type === "tools.executing")).toBe(true);
    expect(sentMessages.some((msg) => msg.type === "tools.result")).toBe(true);
  });

  it("returns delegation policy error without executing tool when policy blocks", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const policyEngine = {
      evaluate: vi.fn(() => ({
        allowed: false,
        reason: "Delegation tool is not allowlisted",
        threshold: 0.8,
      })),
      isDelegationTool: vi.fn(() => true),
      snapshot: vi.fn(() => ({ spawnDecisionThreshold: 0.8 })),
    };

    const baseHandler = vi.fn(async () => "should-not-run");
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler,
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: null,
        policyEngine: policyEngine as any,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", { task: "run tests" });
    const parsed = JSON.parse(result) as { error?: string };

    expect(parsed.error).toContain("not allowlisted");
    expect(baseHandler).not.toHaveBeenCalled();
    expect(sentMessages.some((msg) => msg.type === "tools.executing")).toBe(false);
    expect(sentMessages.some((msg) => msg.type === "tools.result")).toBe(false);
  });

  it("blocks delegation tools from sub-agent sessions to prevent privilege expansion", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const policyEngine = new DelegationPolicyEngine({
      enabled: true,
      spawnDecisionThreshold: 0.1,
      fallbackBehavior: "continue_without_delegation",
    });
    const baseHandler = vi.fn(async () => "should-not-run");
    const handler = createSessionToolHandler({
      sessionId: "subagent:child-1",
      baseHandler,
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: null,
        policyEngine,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", { task: "expand scope" });
    const parsed = JSON.parse(result) as { error?: string };

    expect(parsed.error).toContain("cannot invoke delegation tools");
    expect(baseHandler).not.toHaveBeenCalled();
    expect(sentMessages.some((msg) => msg.type === "tools.executing")).toBe(false);
    expect(sentMessages.some((msg) => msg.type === "tools.result")).toBe(false);
  });

  it("allows nested delegation from sub-agent sessions in unsafe benchmark mode", async () => {
    const subAgentManager = {
      spawn: vi.fn(async () => "subagent:grandchild-1"),
      getResult: vi.fn(() => makeCompletedChildResult({
        sessionId: "subagent:grandchild-1",
        output: '{"summary":"grandchild completed"}',
        success: true,
        durationMs: 12,
        toolCalls: [],
      })),
      getInfo: vi.fn(() => ({
        sessionId: "subagent:grandchild-1",
        parentSessionId: "subagent:child-1",
        depth: 2,
        status: "completed",
        startedAt: Date.now() - 100,
        task: "expand scope",
      })),
    };
    const policyEngine = new DelegationPolicyEngine({
      enabled: true,
      spawnDecisionThreshold: 0.1,
      fallbackBehavior: "continue_without_delegation",
      unsafeBenchmarkMode: true,
    });
    const handler = createSessionToolHandler({
      sessionId: "subagent:child-1",
      baseHandler: vi.fn(async () => "should-not-run"),
      availableToolNames: ["execute_with_agent", "system.readFile"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: "/tmp/unsafe-benchmark-nested",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine,
        verifier: null,
        lifecycleEmitter: null,
        unsafeBenchmarkMode: true,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "expand scope",
      tools: ["system.readFile"],
    });
    const parsed = JSON.parse(result) as { success?: boolean };

    expect(parsed.success).toBe(true);
    expect(subAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "subagent:child-1",
        requireToolCall: true,
        unsafeBenchmarkMode: true,
      }),
    );
  });

  it("does not veto execute_with_agent calls just because the score is below threshold", async () => {
    const sentMessages: ControlResponse[] = [];
    const send = vi.fn((msg: ControlResponse): void => {
      sentMessages.push(msg);
    });

    const policyEngine = new DelegationPolicyEngine({
      enabled: true,
      spawnDecisionThreshold: 0.95,
      fallbackBehavior: "continue_without_delegation",
    });
    const handler = createSessionToolHandler({
      sessionId: "session-1",
      baseHandler: vi.fn(async () => "should-not-run"),
      routerId: "router-a",
      send,
      delegation: () => ({
        subAgentManager: null,
        policyEngine,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("execute_with_agent", {
      task: "inspect logs",
      spawnDecisionScore: 0.1,
    });
    const parsed = JSON.parse(result) as { error?: string };

    expect(parsed.error).toContain("Delegation runtime unavailable");
    expect(parsed.error).not.toContain("below threshold");
    expect(sentMessages.some((msg) => msg.type === "tools.executing")).toBe(true);
    expect(sentMessages.some((msg) => msg.type === "tools.result")).toBe(true);
  });

  it("records pre/post mutation state in the effect ledger for managed file writes", async () => {
    const workspace = createTempDir("agenc-effect-ledger-");
    const targetPath = join(workspace, "AGENC.md");
    writeFileSync(targetPath, "old content", "utf8");
    const sentMessages: ControlResponse[] = [];
    const ledger = EffectLedger.fromMemoryBackend(createMockMemoryBackend());

    const handler = createSessionToolHandler({
      sessionId: "session-effect-write",
      baseHandler: vi.fn(async (_toolName, args) => {
        writeFileSync(String(args.path), String(args.content), "utf8");
        return JSON.stringify({ path: args.path, written: true });
      }),
      routerId: "router-a",
      send: (message) => {
        sentMessages.push(message);
      },
      effectLedger: ledger,
      effectChannel: "test",
    });

    await handler("system.writeFile", {
      path: targetPath,
      content: "new content",
    });

    const [effect] = await ledger.listSessionEffects("session-effect-write");
    expect(effect).toBeDefined();
    expect(effect?.status).toBe("succeeded");
    expect(effect?.preExecutionSnapshots?.[0]?.utf8Text).toBe("old content");
    expect(effect?.postExecutionSnapshots?.[0]?.utf8Text).toBe("new content");
    expect(effect?.compensation.status).toBe("available");

    const executing = sentMessages.find((message) => message.type === "tools.executing");
    const result = sentMessages.find((message) => message.type === "tools.result");
    expect(executing?.payload).toMatchObject({
      effectId: effect?.id,
      effectIdempotencyKey: effect?.idempotencyKey,
    });
    expect(result?.payload).toMatchObject({
      effectId: effect?.id,
      effectIdempotencyKey: effect?.idempotencyKey,
    });

    rmSync(workspace, { recursive: true, force: true });
  });

  it("embeds effect metadata in successful shell tool results when target artifacts are tracked", async () => {
    const workspace = createTempDir("agenc-effect-shell-");
    const targetPath = join(workspace, "AGENC.md");
    writeFileSync(targetPath, "old shell content", "utf8");
    const ledger = EffectLedger.fromMemoryBackend(createMockMemoryBackend());
    const subAgentManager = {
      getInfo: vi.fn(() => ({
        sessionId: "subagent:shell-1",
        parentSessionId: "session-parent",
        depth: 1,
        status: "running",
        startedAt: Date.now() - 100,
        task: "Patch the guide with shell",
      })),
      getExecutionContext: vi.fn(() => ({
        version: "v1",
        workspaceRoot: workspace,
        allowedReadRoots: [workspace],
        allowedWriteRoots: [workspace],
        targetArtifacts: [targetPath],
        effectClass: "shell",
      })),
    };
    const handler = createSessionToolHandler({
      sessionId: "subagent:shell-1",
      baseHandler: vi.fn(async () => {
        writeFileSync(targetPath, "new shell content", "utf8");
        return JSON.stringify({ stdout: "ok", exitCode: 0 });
      }),
      availableToolNames: ["system.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspace,
      effectLedger: ledger,
      effectChannel: "test",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const result = await handler("system.bash", {
      command: `printf 'new shell content' > "${targetPath}"`,
      cwd: workspace,
    });
    const parsed = JSON.parse(result) as {
      __agencEffect?: {
        targets?: Array<{ path?: string }>;
        postExecutionSnapshots?: Array<{ path?: string; sha256?: string }>;
      };
    };

    expect(parsed.__agencEffect?.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: targetPath }),
      ]),
    );
    expect(parsed.__agencEffect?.postExecutionSnapshots).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: targetPath }),
      ]),
    );

    rmSync(workspace, { recursive: true, force: true });
  });

  it("embeds repo-local behavior verification metadata in successful test commands", async () => {
    const workspace = createTempDir("agenc-verification-shell-");
    const handler = createSessionToolHandler({
      sessionId: "session-verification",
      baseHandler: vi.fn(async () => JSON.stringify({ stdout: "3 passed", exitCode: 0 })),
      availableToolNames: ["system.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspace,
    });

    const result = await handler("system.bash", {
      command: "npm",
      args: ["test"],
      cwd: workspace,
    });
    const parsed = JSON.parse(result) as {
      __agencVerification?: {
        category?: string;
        repoLocal?: boolean;
        command?: string;
        cwd?: string;
      };
    };

    expect(parsed.__agencVerification).toMatchObject({
      category: "behavior",
      repoLocal: true,
      cwd: workspace,
      command: "npm test",
    });

    rmSync(workspace, { recursive: true, force: true });
  });

  it("marks an effect denied when approval rejects a mutating tool before execution", async () => {
    const workspace = createTempDir("agenc-effect-denied-");
    const targetPath = join(workspace, "AGENC.md");
    writeFileSync(targetPath, "old content", "utf8");
    const approvalEngine = new ApprovalEngineImpl({
      rules: [{ tool: "system.writeFile" }],
    });
    const ledger = EffectLedger.fromMemoryBackend(createMockMemoryBackend());
    const baseHandler = vi.fn(async () => JSON.stringify({ written: true }));
    const handler = createSessionToolHandler({
      sessionId: "session-effect-denied",
      baseHandler,
      routerId: "router-a",
      send: vi.fn(),
      approvalEngine,
      effectLedger: ledger,
      effectChannel: "test",
    });

    const run = handler("system.writeFile", {
      path: targetPath,
      content: "new content",
    });
    await waitForPendingApproval(approvalEngine);
    const [request] = approvalEngine.getPending();
    expect(request).toBeDefined();
    expect(request?.effect).toMatchObject({
      effectId: expect.any(String),
      effectKind: "filesystem_write",
      compensationAvailable: true,
    });
    await approvalEngine.resolve(request!.id, {
      requestId: request!.id,
      disposition: "no",
    });
    const result = await run;

    expect(baseHandler).not.toHaveBeenCalled();
    expect(JSON.parse(result)).toEqual({
      error: 'Tool "system.writeFile" denied by user',
    });
    const [effect] = await ledger.listSessionEffects("session-effect-denied");
    expect(effect?.status).toBe("denied");
    expect(effect?.approval?.requestId).toBe(request?.id);

    rmSync(workspace, { recursive: true, force: true });
  });
});
