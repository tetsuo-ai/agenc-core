import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToolRouter } from "../../src/tools/router.js";
import { executeToolDispatch } from "../../src/tools/execution.js";
import type { Tool } from "../../src/tools/types.js";
import type { ToolInvocation } from "../../src/tools/context.js";
import { EventLog } from "../../src/session/event-log.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { createExecCommandTool } from "../../src/tools/system/exec-command.js";
import { createBashTool } from "../../src/tools/system/bash.js";
import { createWriteStdinTool } from "../../src/tools/system/write-stdin.js";
import { classifyShellWorkspaceWritePolicy } from "../../src/llm/shell-write-policy.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";

let workspace = "";
beforeEach(async () => { workspace = await mkdtemp(join(tmpdir(), "agenc-shell-preflight-")); });
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

function shellTool(name: string, command: string): { tool: Tool; args: Record<string, unknown> } {
  if (name === "system.bash") {
    return { tool: createBashTool({ cwd: workspace, unrestricted: true }), args: { command } };
  }
  if (name === "write_stdin") {
    return { tool: createWriteStdinTool({ cwd: workspace }), args: { session_id: 17, chars: command } };
  }
  return { tool: createExecCommandTool({ cwd: workspace }), args: { cmd: command } };
}

function dispatchFixture(tool: Tool, args: Record<string, unknown>) {
  const execute = vi.spyOn(tool, "execute");
  const session = {
    eventLog: new EventLog(),
    services: { admissionRequired: false, runtimeOptions: resolveAgentRuntimeOptions({}) },
  } as unknown as ToolInvocation["session"];
  const turn = { subId: "shell-preflight", cwd: workspace } as ToolInvocation["turn"];
  const resolver = { request: vi.fn(async (): Promise<ReviewDecision> => ({ kind: "denied" })) };
  const canUseTool = vi.fn(async () => ({ behavior: "ask" as const, message: "approval required" }));
  const options = {
    session, turn,
    tracker: { appendFileDiff: () => {}, snapshot: () => [], clear: () => {} },
    approvalPolicy: "untrusted" as const,
    sandboxMode: "workspace_write" as const,
    approvalResolver: resolver, canUseTool, permissionContext: {} as never,
  };
  const rawArgs = JSON.stringify(args);
  const invocation: ToolInvocation = {
    ...options, callId: "shell-policy-call", toolName: { name: tool.name },
    payload: { kind: "function", arguments: rawArgs }, source: "direct",
  };
  const router = new ToolRouter([{ tool, supportsParallelToolCalls: false }]);
  return { execute, resolver, canUseTool, options, rawArgs, invocation, router };
}

describe("shell policy before approval", () => {
  const blockedCommands = [
    "git commit -m \"$(cat <<'EOF'\naudit commit\nEOF\n)\"",
    "printf changed > src.js",
    "rm -rf .git",
  ];
  for (const name of ["exec_command", "system.bash", "write_stdin"]) {
    for (const route of ["model", "direct", "executor"]) {
      test.each(blockedCommands)(`${name} ${route} rejects %s without asking`, async (command) => {
        const { tool, args } = shellTool(name, command);
        const fixture = dispatchFixture(tool, args);
        const result = route === "model"
          ? await fixture.router.dispatchModelToolCall({ id: "shell-policy-call", name, arguments: fixture.rawArgs }, fixture.options)
          : route === "direct"
            ? await fixture.router.dispatchToolCall(fixture.invocation, args, fixture.options)
            : await executeToolDispatch({ tool, currentTurnId: "shell-preflight", rawArgs: fixture.rawArgs, invocation: fixture.invocation, approvalResolver: fixture.resolver });
        expect(result.isError).toBe(true);
        expect(result.content).toContain("shell_workspace_");
        expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
        expect(fixture.resolver.request).not.toHaveBeenCalled();
        expect(fixture.canUseTool).not.toHaveBeenCalled();
        expect(fixture.execute).not.toHaveBeenCalled();
      });
    }
    test.each(["rm src.js", "mv src.js renamed.js", "git status", "node --test"])(`${name} leaves authorizable %s to permission evaluation`, (command) => {
      const { tool, args } = shellTool(name, command);
      expect(tool.preflight?.(args)).toBeNull();
    });
  }

  test("model hook rewrites are checked before approval", async () => {
    const { tool, args } = shellTool("exec_command", "git status");
    const fixture = dispatchFixture(tool, args);
    const result = await fixture.router.dispatchModelToolCall({ id: "rewritten-shell", name: tool.name, arguments: fixture.rawArgs }, {
      ...fixture.options,
      preHooks: [async () => ({ kind: "continue", args: { cmd: "printf changed > src.js" } })],
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("shell_workspace_");
    expect(fixture.resolver.request).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  test("direct argv validation runs before approval without weakening its policy", () => {
    const tool = createBashTool({ cwd: workspace, unrestricted: true });
    expect(tool.preflight?.({ command: "git", args: ["commit", "-m", "$(literal message)"] })?.message).toContain("Invalid direct-mode args");
    expect(tool.preflight?.({ command: "git", args: ["commit", "-m", "literal message"] })).toBeNull();
  });

  test("empty stdin polling has no shell policy rejection", () => {
    const { tool, args } = shellTool("write_stdin", "");
    expect(tool.preflight?.(args)).toBeNull();
  });

  test("normal interactive shells retain their existing execution path", () => {
    const { tool } = shellTool("exec_command", "bash");
    expect(tool.preflight?.({ cmd: "bash", tty: true })).toBeNull();
  });

  test.each(["exec_command", "system.bash", "write_stdin"])("%s preflight cannot grant deletion authority", (name) => {
    const decision = classifyShellWorkspaceWritePolicy({
      toolName: name, args: { command: "rm src.js" }, workspaceRoot: workspace,
      validationPhase: "preflight",
    });
    expect(decision.blocked).toBe(false);
    expect(decision.deletionTargets).toEqual([]);
    const execution = classifyShellWorkspaceWritePolicy({
      toolName: name, args: { command: "rm src.js" }, workspaceRoot: workspace,
    });
    expect(execution.blocked).toBe(true);
    expect(execution.message).toContain("requires_approval");
    expect(classifyShellWorkspaceWritePolicy({
      toolName: name, args: { command: "rm src.js" }, workspaceRoot: workspace,
      allowWorkspaceDeletions: true,
    }).blocked).toBe(false);
  });

  test("workdir outside the captured scope is refused before approval", async () => {
    const { tool } = shellTool("exec_command", "git status");
    const args = { cmd: "git status", workdir: join(workspace, "..") };
    const fixture = dispatchFixture(tool, args);
    const result = await fixture.router.dispatchModelToolCall({ id: "outside-workspace", name: tool.name, arguments: fixture.rawArgs }, fixture.options);
    expect(result.content).toContain("outside allowed workspace paths");
    expect(fixture.resolver.request).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  test("workdir identity is checked again when its symlink changes", async () => {
    const link = join(workspace, "inspection");
    await symlink(workspace, link, "dir");
    const { tool } = shellTool("exec_command", "git status");
    const args = { cmd: "git status", workdir: link };
    expect(tool.preflight?.(args)).toBeNull();
    await rm(link);
    await symlink(join(workspace, ".."), link, "dir");
    expect(tool.preflight?.(args)?.code).toBe("workdir-validation");
    const result = await tool.execute(args);
    expect(result.isError).toBe(true);
    expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
  });

  test("approval cannot authorize a changed working-directory identity", async () => {
    const link = join(workspace, "inspection");
    await symlink(workspace, link, "dir");
    const { tool } = shellTool("exec_command", "git status");
    const fixture = dispatchFixture(tool, { cmd: "git status", workdir: link });
    fixture.execute.mockResolvedValue({ content: "must not execute" });
    fixture.resolver.request.mockImplementationOnce(async () => {
      await rm(link);
      await symlink(join(workspace, ".."), link, "dir");
      return { kind: "approved" };
    });
    const result = await fixture.router.dispatchModelToolCall({ id: "shell-policy-call", name: tool.name, arguments: fixture.rawArgs }, {
      ...fixture.options, sandboxMode: "danger_full_access",
    });
    expect(fixture.resolver.request).toHaveBeenCalledOnce();
    expect(result.content).toContain("outside allowed workspace paths");
    expect(result.effectDisposition?.disposition).toBe("confirmed_no_effect");
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  test("missing workdir cannot hide traversal behind a workspace prefix", () => {
    const { tool } = shellTool("exec_command", "git status");
    expect(tool.preflight?.({ cmd: "git status", workdir: `${workspace}/../missing-outside` })?.code).toBe("workdir-validation");
  });

  test("system.bash rejects a missing working directory before approval", () => {
    const { tool } = shellTool("system.bash", "git status");
    expect(tool.preflight?.({ command: "git status", cwd: join(workspace, "missing") })?.message).toContain("does not exist");
  });

  test("MCP placeholders are refused before approval", async () => {
    const { tool, args } = shellTool("exec_command", "mcp.server.tool");
    const fixture = dispatchFixture(tool, args);
    const result = await fixture.router.dispatchModelToolCall({ id: "mcp-placeholder", name: tool.name, arguments: fixture.rawArgs }, fixture.options);
    expect(result.content).toContain("MCP tools are not shell commands");
    expect(fixture.resolver.request).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();
  });
});
