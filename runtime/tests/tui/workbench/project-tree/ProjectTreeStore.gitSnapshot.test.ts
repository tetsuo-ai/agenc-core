import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectTreeStore } from "../../../../src/tui/workbench/project-tree/ProjectTreeStore.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});

describe("project tree Git refresh", () => {
  let repo: string;
  let store: ProjectTreeStore;

  function git(...args: string[]): string {
    return execFileSync(
      "git",
      [
        "-c", "user.name=Project Tree Test",
        "-c", "user.email=project-tree@example.com",
        "-c", "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "agenc-tree-git-snapshot-"));
    git("init", "-b", "main");
    await mkdir(join(repo, "src"));
    await writeFile(join(repo, "src", "modified.ts"), "original\n");
    await writeFile(join(repo, "src", "old.ts"), "rename me\n");
    git("add", ".");
    git("commit", "-m", "initial files");
    store = new ProjectTreeStore(repo, 0);
    vi.mocked(execFile).mockClear();
  });

  afterEach(async () => {
    store?.dispose();
    await rm(repo, { recursive: true, force: true });
  });

  it("publishes branch metadata and file states from one status scan per refresh", async () => {
    await writeFile(join(repo, "src", "modified.ts"), "changed\n");
    git("mv", "src/old.ts", "src/new.ts");
    await writeFile(join(repo, "src", "untracked.ts"), "new\n");

    await store.refresh();
    store.reveal("src/modified.ts");

    const snapshot = store.getSnapshot();
    expect(snapshot.git).toEqual({
      branch: "main",
      head: git("rev-parse", "HEAD").trim().slice(0, 7),
      dirtyCount: 3,
    });
    expect(
      snapshot.rows
        .filter((row) => row.kind === "file")
        .map((row) => [row.path, row.gitState]),
    ).toEqual([
      ["src/modified.ts", "modified"],
      ["src/new.ts", "renamed"],
      ["src/untracked.ts", "untracked"],
    ]);
    const statusCalls = () =>
      vi.mocked(execFile).mock.calls.filter(
        ([command, args]) =>
          command === "git" && Array.isArray(args) && args.includes("status"),
      );
    expect(statusCalls()).toHaveLength(1);
    expect(statusCalls()[0]?.[1]).toEqual([
      "status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all",
    ]);

    git("add", ".");
    git("commit", "-m", "save changes");
    git("checkout", "-b", "next");
    await store.refresh();

    expect(statusCalls()).toHaveLength(2);
    expect(store.getSnapshot().git).toEqual({
      branch: "next",
      head: git("rev-parse", "HEAD").trim().slice(0, 7),
      dirtyCount: 0,
    });
    expect(
      store.getSnapshot().rows.every((row) => row.gitState === undefined),
    ).toBe(true);
  });

  it("clears branch metadata and file states together when Git becomes unavailable", async () => {
    await writeFile(join(repo, "src", "modified.ts"), "changed\n");
    await store.refresh();
    store.reveal("src/modified.ts");
    expect(store.getSnapshot().git?.dirtyCount).toBe(1);
    expect(
      store.getSnapshot().rows.find((row) => row.path === "src/modified.ts")?.gitState,
    ).toBe("modified");

    await rm(join(repo, ".git"), { recursive: true, force: true });
    await store.refresh();

    expect(store.getSnapshot().git).toBeNull();
    expect(
      store.getSnapshot().rows.find((row) => row.path === "src/modified.ts"),
    ).toMatchObject({
      kind: "file",
      gitState: undefined,
    });
    expect(store.getSnapshot().error).toBeNull();
  });
});
