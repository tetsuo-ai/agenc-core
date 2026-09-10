import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { statusCommand } from "../../src/commands/status.js";
import { openStatusDashboard } from "../../src/commands/status-menu.js";
import type { Session } from "../../src/session/session.js";

vi.mock("../../src/commands/status-menu.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/commands/status-menu.js")>(),
  openStatusDashboard: vi.fn(() => true),
}));

let workspace: string;

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: workspace, encoding: "utf8" });
}

async function statusRow() {
  const result = await statusCommand.execute({
    session: { conversationId: "status-git-fixture", services: {}, createdAtMs: 0 } as Session,
    cwd: workspace,
    home: workspace,
    argsRaw: "",
  });
  expect(result.kind).toBe("skip");
  const snapshot = vi.mocked(openStatusDashboard).mock.lastCall?.[1];
  expect(snapshot).toBeDefined();
  const row = snapshot!.rows.find((entry) => entry.section === "git");
  expect(row).toBeDefined();
  return row!;
}

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agenc-status-git-"));
  vi.mocked(openStatusDashboard).mockClear();
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("status on real git worktrees", () => {
  it("reports an unborn empty branch as clean", async () => {
    git("init", "--quiet", "--initial-branch=main");
    expect(await statusRow()).toMatchObject({ value: "clean", state: "ok", detail: "branch main" });
  });

  it("reports staged and untracked files on an unborn branch", async () => {
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(workspace, "staged.txt"), "staged\n");
    await writeFile(join(workspace, "untracked.txt"), "untracked\n");
    git("add", "staged.txt");
    expect(await statusRow()).toMatchObject({ value: "dirty", state: "warn", detail: "branch main; 2 changed files" });
  });

  it("keeps committed clean and dirty branches accurate", async () => {
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(workspace, "tracked.txt"), "initial\n");
    git("add", "tracked.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture");
    expect(await statusRow()).toMatchObject({ value: "clean", state: "ok", detail: "branch main" });
    await writeFile(join(workspace, "tracked.txt"), "modified\n");
    expect(await statusRow()).toMatchObject({ value: "dirty", state: "warn", detail: "branch main; 1 changed files" });
  });

  it("reports detached HEAD without a branch error", async () => {
    git("init", "--quiet", "--initial-branch=main");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "fixture");
    git("checkout", "--quiet", "--detach", "HEAD");
    expect(await statusRow()).toMatchObject({ value: "clean", state: "ok", detail: "branch detached" });
  });

  it("reports a directory outside git as informational", async () => {
    expect(await statusRow()).toMatchObject({ value: "not a git repository", state: "info" });
  });

  it("does not present a bare repository as a worktree", async () => {
    git("init", "--quiet", "--bare");
    expect(await statusRow()).toMatchObject({ value: "not a git repository", state: "info" });
  });

  it("preserves a real git status failure", async () => {
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(workspace, ".git", "index"), "invalid index\n");
    const row = await statusRow();
    expect(row).toMatchObject({ value: "error", state: "error" });
    expect(row.detail).toMatch(/index/i);
    expect(row.detail).not.toMatch(/ambiguous argument.*HEAD/i);
  });

  it("preserves git configuration failures during repository discovery", async () => {
    git("init", "--quiet", "--initial-branch=main");
    await writeFile(join(workspace, ".git", "config"), "[invalid\n");
    const row = await statusRow();
    expect(row).toMatchObject({ value: "error", state: "error" });
    expect(row.detail).toMatch(/config/i);
  });
});
