import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runCommand } from "../utils/process.js";
import { WorktreeIsolationManager } from "./worktree-isolation.js";

async function initGitRepo(): Promise<{
  readonly repoRoot: string;
  readonly workspaceRoot: string;
}> {
  const repoRoot = await mkdtemp(join(tmpdir(), "agenc-worktree-test-"));
  await runCommand("git", ["init"], { cwd: repoRoot });
  await runCommand("git", ["config", "user.email", "test@example.com"], {
    cwd: repoRoot,
  });
  await runCommand("git", ["config", "user.name", "Test User"], {
    cwd: repoRoot,
  });
  await writeFile(join(repoRoot, "README.md"), "# test\n", "utf8");
  await runCommand("git", ["add", "README.md"], { cwd: repoRoot });
  await runCommand("git", ["commit", "-m", "init"], { cwd: repoRoot });
  const workspaceRoot = join(repoRoot, "src");
  await writeFile(join(repoRoot, "src.txt"), "source\n", "utf8");
  return { repoRoot, workspaceRoot };
}

describe("WorktreeIsolationManager", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      cleanupPaths.splice(0).map((path) =>
        rm(path, { recursive: true, force: true }).catch(() => undefined)
      ),
    );
  });

  it("creates a per-worker worktree and translates repo-local paths", async () => {
    const { repoRoot } = await initGitRepo();
    cleanupPaths.push(repoRoot);
    const rootDir = await mkdtemp(join(tmpdir(), "agenc-worktree-root-"));
    cleanupPaths.push(rootDir);
    const manager = new WorktreeIsolationManager({
      rootDir,
    });

    const location = await manager.prepareWorktree({
      workerId: "worker-1",
      workspaceRoot: repoRoot,
      workingDirectory: repoRoot,
    });

    expect(location.mode).toBe("worktree");
    expect(location.worktreePath).toBeDefined();
    const translatedReadme = manager.translatePath(
      join(repoRoot, "README.md"),
      location,
    );
    expect(translatedReadme).toBe(
      resolvePath(location.worktreePath!, "README.md"),
    );
    const translatedContent = await readFile(translatedReadme!, "utf8");
    expect(translatedContent).toContain("# test");
  });

  it("retains dirty worktrees and removes clean ones", async () => {
    const { repoRoot } = await initGitRepo();
    cleanupPaths.push(repoRoot);
    const rootDir = await mkdtemp(join(tmpdir(), "agenc-worktree-root-"));
    cleanupPaths.push(rootDir);
    const manager = new WorktreeIsolationManager({ rootDir });

    const dirtyLocation = await manager.prepareWorktree({
      workerId: "worker-dirty",
      workspaceRoot: repoRoot,
      workingDirectory: repoRoot,
    });
    await writeFile(
      join(dirtyLocation.worktreePath!, "dirty.txt"),
      "changed\n",
      "utf8",
    );
    const dirtyCleanup = await manager.cleanupLocation(dirtyLocation);
    expect(dirtyCleanup?.lifecycle).toBe("retained_dirty");

    const cleanLocation = await manager.prepareWorktree({
      workerId: "worker-clean",
      workspaceRoot: repoRoot,
      workingDirectory: repoRoot,
    });
    const cleanCleanup = await manager.cleanupLocation(cleanLocation);
    expect(cleanCleanup?.lifecycle).toBe("removed");
  });
});
