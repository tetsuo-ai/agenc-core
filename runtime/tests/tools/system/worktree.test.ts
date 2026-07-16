/**
 * Tests for `EnterWorktree` / `ExitWorktree` — verbatim AgenC
 * port of `EnterWorktreeTool` + `ExitWorktreeTool`. Verifies session-
 * level state tracking, slug validation, and the dirty-tree refusal
 * gate.
 *
 * Tests use real `git` for the worktree create/remove operations so
 * the upstream contract is exercised end-to-end inside a tmpdir
 * sandbox.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  __resetWorktreeSessionsForTesting,
  createEnterWorktreeTool as createUnboundEnterWorktreeTool,
  createExitWorktreeTool as createUnboundExitWorktreeTool,
} from "./worktree.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";

const createEnterWorktreeTool = (
  config: Parameters<typeof createUnboundEnterWorktreeTool>[0],
) => bindExplicitDangerBoundary(createUnboundEnterWorktreeTool(config));

const createExitWorktreeTool = (
  config: Parameters<typeof createUnboundExitWorktreeTool>[0],
) => bindExplicitDangerBoundary(createUnboundExitWorktreeTool(config));

const execFileP = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileP("git", args, { cwd });
}

async function setupRepo(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "agenc-worktree-"));
  await git(root, "init", "--initial-branch=main");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Test");
  await writeFile(join(root, "README.md"), "hello\n", "utf8");
  await git(root, "add", "README.md");
  await git(root, "commit", "-m", "init");
  return {
    root,
    cleanup: async () => {
      try {
        await rm(root, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

describe("EnterWorktree / ExitWorktree (AgenC port)", () => {
  let repo: Awaited<ReturnType<typeof setupRepo>>;
  const sessionId = "test-session";

  beforeEach(async () => {
    __resetWorktreeSessionsForTesting();
    repo = await setupRepo();
  });

  afterEach(async () => {
    __resetWorktreeSessionsForTesting();
    if (repo) await repo.cleanup();
  });

  test("EnterWorktree creates a worktree and records the session", async () => {
    const enter = createEnterWorktreeTool({ cwd: repo.root });
    const result = await enter.execute({
      name: "feature.test",
      __agencSessionId: sessionId,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("Created worktree at");
    expect(result.content).toContain("feature.test");
    expect(result.content).toContain("on branch feature.test");

    const meta = result.metadata as Record<string, unknown>;
    expect(meta.worktreePath).toContain(".agenc/worktrees/feature.test");
    expect(meta.worktreeBranch).toBe("feature.test");
  });

  test("EnterWorktree rejects bad slug shapes", async () => {
    const enter = createEnterWorktreeTool({ cwd: repo.root });
    const bad = await enter.execute({
      name: "has space",
      __agencSessionId: sessionId,
    });
    expect(bad.isError).toBe(true);
    expect(String(bad.content)).toMatch(/letters, digits/);
  });

  test("EnterWorktree refuses when this session is already in a worktree", async () => {
    const enter = createEnterWorktreeTool({ cwd: repo.root });
    const first = await enter.execute({
      name: "first",
      __agencSessionId: sessionId,
    });
    expect(first.isError).toBeUndefined();

    const second = await enter.execute({
      name: "second",
      __agencSessionId: sessionId,
    });
    expect(second.isError).toBe(true);
    expect(String(second.content)).toContain("Already in a worktree session");
  });

  test('ExitWorktree no-ops with the upstream message when no session is active', async () => {
    const exitTool = createExitWorktreeTool({ cwd: repo.root });
    const result = await exitTool.execute({
      action: "remove",
      __agencSessionId: sessionId,
    });
    expect(result.isError).toBe(true);
    expect(String(result.content)).toContain("No-op");
    expect(String(result.content)).toContain(
      "no active EnterWorktree session to exit",
    );
  });

  test("ExitWorktree action=keep restores session and leaves worktree on disk", async () => {
    const enter = createEnterWorktreeTool({ cwd: repo.root });
    const exitTool = createExitWorktreeTool({ cwd: repo.root });
    await enter.execute({ name: "kept", __agencSessionId: sessionId });

    const result = await exitTool.execute({
      action: "keep",
      __agencSessionId: sessionId,
    });
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("Exited worktree");
    expect(String(result.content)).toContain("Your work is preserved at");
    expect(String(result.content)).toContain("kept");
  });

  test("ExitWorktree action=remove on a clean worktree succeeds", async () => {
    const enter = createEnterWorktreeTool({ cwd: repo.root });
    const exitTool = createExitWorktreeTool({ cwd: repo.root });
    await enter.execute({ name: "clean", __agencSessionId: sessionId });

    const result = await exitTool.execute({
      action: "remove",
      __agencSessionId: sessionId,
    });
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain(
      "Exited and removed worktree at",
    );
  });

  test("ExitWorktree action=remove refuses when worktree has uncommitted files (without discard_changes)", async () => {
    const enter = createEnterWorktreeTool({ cwd: repo.root });
    const exitTool = createExitWorktreeTool({ cwd: repo.root });
    const created = await enter.execute({
      name: "dirty",
      __agencSessionId: sessionId,
    });
    const meta = created.metadata as Record<string, unknown>;
    const worktreePath = meta.worktreePath as string;
    // Make a dirty change in the worktree.
    await writeFile(join(worktreePath, "README.md"), "modified\n", "utf8");

    const refused = await exitTool.execute({
      action: "remove",
      __agencSessionId: sessionId,
    });
    expect(refused.isError).toBe(true);
    const msg = String(refused.content);
    expect(msg).toContain("uncommitted");
    expect(msg).toContain("discard_changes: true");
    // Worktree must still exist after the refusal.
    const existsAfter = await import("node:fs/promises").then(
      async (fs) => fs.stat(worktreePath).then(
        () => true,
        () => false,
      ),
    );
    expect(existsAfter).toBe(true);
  });

  test("ExitWorktree action=remove with discard_changes=true removes a dirty worktree", async () => {
    const enter = createEnterWorktreeTool({ cwd: repo.root });
    const exitTool = createExitWorktreeTool({ cwd: repo.root });
    const created = await enter.execute({
      name: "dirty-discard",
      __agencSessionId: sessionId,
    });
    const meta = created.metadata as Record<string, unknown>;
    const worktreePath = meta.worktreePath as string;
    await writeFile(join(worktreePath, "README.md"), "modified\n", "utf8");

    const result = await exitTool.execute({
      action: "remove",
      discard_changes: true,
      __agencSessionId: sessionId,
    });
    expect(result.isError).toBeUndefined();
    expect(String(result.content)).toContain("Discarded");
    expect(String(result.content)).toContain("uncommitted");
  });

  test("Per-session isolation: session A's worktree is invisible to session B", async () => {
    const enter = createEnterWorktreeTool({ cwd: repo.root });
    const exitTool = createExitWorktreeTool({ cwd: repo.root });
    await enter.execute({
      name: "session-a-tree",
      __agencSessionId: "session-a",
    });

    // Session B has no worktree → ExitWorktree no-ops.
    const otherExit = await exitTool.execute({
      action: "keep",
      __agencSessionId: "session-b",
    });
    expect(otherExit.isError).toBe(true);
    expect(String(otherExit.content)).toContain("No-op");
  });

  test("EnterWorktree refuses when called outside a git repository", async () => {
    const nonRepo = await mkdtemp(join(tmpdir(), "agenc-no-repo-"));
    try {
      const enter = createEnterWorktreeTool({ cwd: nonRepo });
      const result = await enter.execute({
        name: "lonely",
        __agencSessionId: sessionId,
      });
      expect(result.isError).toBe(true);
      expect(String(result.content)).toContain("Not in a git repository");
    } finally {
      await rm(nonRepo, { recursive: true, force: true });
    }
  });
});
