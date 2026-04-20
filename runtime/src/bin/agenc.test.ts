/**
 * T9 integration seams for `bin/agenc.ts`:
 *   - slash-command handler (`parseSlashCommand` + `handleSlashCommand`)
 *   - `system.agent.delegate` built-in tool
 *
 * End-to-end CLI invocation is out of scope here (requires a live
 * provider + rollout on disk). These tests cover the two extracted
 * units that back the integration.
 */
import { describe, expect, it, vi } from "vitest";

import {
  handleSlashCommand,
  parseSlashCommand,
  type PendingWorktreeState,
} from "./slash.js";
import { buildDelegateTool } from "./delegate-tool.js";

function stubSession() {
  return {
    eventLog: {},
    nextInternalSubId: () => "sub-1",
  } as unknown as Parameters<typeof handleSlashCommand>[0]["session"];
}

const HANDLE = {
  path: "/repo/.agenc-worktrees/feat-x",
  branch: "worktree-feat-x",
  gitRoot: "/repo",
  created: true,
};

describe("parseSlashCommand", () => {
  it("returns null for non-slash input", () => {
    expect(parseSlashCommand("hello world")).toBeNull();
    expect(parseSlashCommand("")).toBeNull();
  });

  it("parses /enter-worktree <slug>", () => {
    const cmd = parseSlashCommand("/enter-worktree feat-x");
    expect(cmd).toEqual({ kind: "enter_worktree", slug: "feat-x" });
  });

  it("parses /exit-worktree keep", () => {
    expect(parseSlashCommand("/exit-worktree keep")).toEqual({
      kind: "exit_worktree",
      action: "keep",
      discardChanges: false,
    });
  });

  it("parses /exit-worktree remove --discard", () => {
    expect(parseSlashCommand("/exit-worktree remove --discard")).toEqual({
      kind: "exit_worktree",
      action: "remove",
      discardChanges: true,
    });
  });

  it("rejects unknown slash commands", () => {
    expect(parseSlashCommand("/unknown foo")).toBeNull();
    expect(parseSlashCommand("/enter-worktree")).toBeNull();
    expect(parseSlashCommand("/exit-worktree bogus")).toBeNull();
  });
});

describe("handleSlashCommand — enter-worktree", () => {
  it("invokes enterWorktree + returns entered pending state + new cwd", async () => {
    const enterSpy = vi.fn().mockResolvedValue({
      kind: "entered",
      handle: HANDLE,
      baseCommit: "abc123",
    });
    const exitSpy = vi.fn();
    const result = await handleSlashCommand({
      session: stubSession(),
      command: { kind: "enter_worktree", slug: "feat-x" },
      originalCwd: "/repo",
      pendingWorktree: null,
      enterWorktreeFn: enterSpy,
      exitWorktreeFn: exitSpy,
    });
    expect(enterSpy).toHaveBeenCalledWith({
      session: expect.anything(),
      slug: "feat-x",
    });
    expect(result.matched).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe(HANDLE.path);
    expect(result.pendingWorktree?.handle).toEqual(HANDLE);
    expect(result.pendingWorktree?.baseCommit).toBe("abc123");
    expect(result.pendingWorktree?.enteredFromCwd).toBe("/repo");
  });

  it("propagates rejection reason + exit code 1", async () => {
    const enterSpy = vi.fn().mockResolvedValue({
      kind: "rejected",
      reason: "not a git repo",
    });
    const result = await handleSlashCommand({
      session: stubSession(),
      command: { kind: "enter_worktree", slug: "feat-x" },
      originalCwd: "/repo",
      pendingWorktree: null,
      enterWorktreeFn: enterSpy,
      exitWorktreeFn: vi.fn(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.pendingWorktree).toBeNull();
    expect(result.message).toContain("not a git repo");
  });
});

describe("handleSlashCommand — exit-worktree", () => {
  const active: PendingWorktreeState = {
    handle: HANDLE,
    baseCommit: "abc123",
    enteredFromCwd: "/repo",
  };

  it("keep: returns kept state + stays on worktree cwd", async () => {
    const exitSpy = vi.fn().mockResolvedValue({
      kind: "kept",
      path: HANDLE.path,
      branch: HANDLE.branch,
      changedFiles: false,
      hasCommits: false,
      message: "worktree preserved",
    });
    const result = await handleSlashCommand({
      session: stubSession(),
      command: { kind: "exit_worktree", action: "keep", discardChanges: false },
      originalCwd: "/repo",
      pendingWorktree: active,
      enterWorktreeFn: vi.fn(),
      exitWorktreeFn: exitSpy,
    });
    expect(exitSpy).toHaveBeenCalledWith({
      session: expect.anything(),
      handle: HANDLE,
      baseCommit: "abc123",
      action: "keep",
    });
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe(HANDLE.path);
    expect(result.pendingWorktree).toEqual(active);
  });

  it("remove: returns removed state + restores original cwd", async () => {
    const exitSpy = vi.fn().mockResolvedValue({
      kind: "removed",
      path: HANDLE.path,
      branch: HANDLE.branch,
      discardedFiles: false,
      discardedCommits: false,
      message: "worktree removed",
    });
    const result = await handleSlashCommand({
      session: stubSession(),
      command: {
        kind: "exit_worktree",
        action: "remove",
        discardChanges: false,
      },
      originalCwd: "/home/u/project",
      pendingWorktree: {
        handle: HANDLE,
        baseCommit: "abc",
        enteredFromCwd: "/home/u/project",
      },
      enterWorktreeFn: vi.fn(),
      exitWorktreeFn: exitSpy,
    });
    expect(result.exitCode).toBe(0);
    expect(result.pendingWorktree).toBeNull();
    expect(result.cwd).toBe("/home/u/project");
  });

  it("refused: surfaces the error code", async () => {
    const exitSpy = vi.fn().mockResolvedValue({
      kind: "refused",
      reason: "has uncommitted files",
      errorCode: 2,
    });
    const result = await handleSlashCommand({
      session: stubSession(),
      command: {
        kind: "exit_worktree",
        action: "remove",
        discardChanges: false,
      },
      originalCwd: "/repo",
      pendingWorktree: active,
      enterWorktreeFn: vi.fn(),
      exitWorktreeFn: exitSpy,
    });
    expect(result.exitCode).toBe(2);
    expect(result.pendingWorktree).toEqual(active);
    expect(result.cwd).toBe(HANDLE.path);
  });

  it("no active worktree: rejects with exit code 1", async () => {
    const result = await handleSlashCommand({
      session: stubSession(),
      command: { kind: "exit_worktree", action: "keep", discardChanges: false },
      originalCwd: "/repo",
      pendingWorktree: null,
      enterWorktreeFn: vi.fn(),
      exitWorktreeFn: vi.fn(),
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain("no active worktree");
  });
});

describe("buildDelegateTool — system.agent.delegate", () => {
  const LIVE = {
    agentId: "thread-1",
    agentPath: "/root/alpha",
    nickname: "alpha",
  };

  it("exposes the T9 input schema", () => {
    const tool = buildDelegateTool({
      getSession: () => null,
      delegateFn: vi.fn(),
    });
    expect(tool.name).toBe("system.agent.delegate");
    const schema = tool.inputSchema as Record<string, unknown>;
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining([
        "taskPrompt",
        "role",
        "isolation",
        "worktreeSlug",
        "runInBackground",
      ]),
    );
    const roleSchema = props.role as { enum: string[] };
    expect(roleSchema.enum).toEqual([
      "default",
      "explorer",
      "awaiter",
      "worker",
    ]);
  });

  it("rejects invocation with missing taskPrompt", async () => {
    const delegateSpy = vi.fn();
    const tool = buildDelegateTool({
      getSession: () => stubSession() as never,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({});
    expect(result.isError).toBe(true);
    expect(delegateSpy).not.toHaveBeenCalled();
    expect(result.content).toContain("taskPrompt");
  });

  it("rejects invocation before session is wired", async () => {
    const delegateSpy = vi.fn();
    const tool = buildDelegateTool({
      getSession: () => null,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({ taskPrompt: "x" });
    expect(result.isError).toBe(true);
    expect(delegateSpy).not.toHaveBeenCalled();
  });

  it("sync_completed maps to a tool result with finalMessage + toolCallCount", async () => {
    const delegateSpy = vi.fn().mockResolvedValue({
      kind: "sync_completed",
      thread: {
        threadId: "thread-1",
        live: LIVE,
      },
      result: {
        threadId: "thread-1",
        finalMessage: "done",
        durationMs: 42,
        outcome: "completed",
        toolCallCount: 3,
      },
    });
    const tool = buildDelegateTool({
      getSession: () => stubSession() as never,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({
      taskPrompt: "scan the repo",
      role: "explorer",
    });
    expect(delegateSpy).toHaveBeenCalledTimes(1);
    const args = delegateSpy.mock.calls[0]![0];
    expect(args.role).toBe("explorer");
    expect(args.taskPrompt).toBe("scan the repo");
    expect(args.parentPath).toBe("/root");
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.kind).toBe("sync_completed");
    expect(parsed.finalMessage).toBe("done");
    expect(parsed.toolCallCount).toBe(3);
    expect(parsed.agentPath).toBe("/root/alpha");
  });

  it("async_launched maps to a tool result carrying threadId + agentPath", async () => {
    const delegateSpy = vi.fn().mockResolvedValue({
      kind: "async_launched",
      thread: { threadId: "thread-2", live: { ...LIVE, agentId: "thread-2" } },
    });
    const tool = buildDelegateTool({
      getSession: () => stubSession() as never,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({
      taskPrompt: "long running",
      runInBackground: true,
    });
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.kind).toBe("async_launched");
    expect(parsed.threadId).toBe("thread-2");
    expect(parsed.agentPath).toBe("/root/alpha");
    const args = delegateSpy.mock.calls[0]![0];
    expect(args.runInBackground).toBe(true);
  });

  it("rejected maps to isError=true tool result with reason", async () => {
    const delegateSpy = vi.fn().mockResolvedValue({
      kind: "rejected",
      reason: "worktree setup failed: not a git repo",
    });
    const tool = buildDelegateTool({
      getSession: () => stubSession() as never,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({
      taskPrompt: "do work",
      isolation: "worktree",
      worktreeSlug: "feat-x",
    });
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.kind).toBe("rejected");
    expect(parsed.error).toContain("worktree");
    const args = delegateSpy.mock.calls[0]![0];
    expect(args.isolation).toBe("worktree");
    expect(args.worktreeSlug).toBe("feat-x");
  });

  it("thrown errors are caught and surfaced as isError=true results", async () => {
    const delegateSpy = vi.fn().mockRejectedValue(new Error("boom"));
    const tool = buildDelegateTool({
      getSession: () => stubSession() as never,
      delegateFn: delegateSpy,
    });
    const result = await tool.execute({ taskPrompt: "x" });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content).error).toBe("boom");
  });
});
