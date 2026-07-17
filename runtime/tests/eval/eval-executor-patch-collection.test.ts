import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildBaselineGitScript,
  buildCandidateCollectionScript,
} from "../../src/eval-executor/index.js";

// Revert-sensitive real-git test for the patch-collection logic. It runs the
// EXACT exported shell scripts the executor runs, against a real git repo, so
// reverting the collection to the buggy `git diff --cached` (or dropping the
// post-setup baseline) turns these red. No docker, no network.

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.invalid",
    },
  });
}

function bash(cwd: string, script: string): string {
  return execFileSync("bash", ["-c", script], { cwd, encoding: "utf8" });
}

function decodeCollected(base64: string): string {
  return Buffer.from(base64.trim(), "base64").toString("utf8");
}

describe("eval executor patch collection (real git)", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(path.join(tmpdir(), "agenc-collect-"));
    git(repo, ["init", "-q", "-b", "main"]);
    await writeFile(path.join(repo, "app.js"), "function add(a,b){return a-b}\n");
    await writeFile(path.join(repo, "keep.txt"), "unrelated\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "base"]);
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function applySetup(): Promise<void> {
    // A "setup patch" the harness applies before the agent: adds a config file.
    await writeFile(path.join(repo, "setup.cfg"), "harness=1\n");
  }

  test("candidate excludes the setup patch and captures uncommitted agent work", async () => {
    await applySetup();
    bash(repo, buildBaselineGitScript());
    // Agent edits app.js but does not commit.
    await writeFile(path.join(repo, "app.js"), "function add(a,b){return a+b}\n");

    const collected = decodeCollected(bash(repo, buildCandidateCollectionScript()));
    expect(collected).toContain("a/app.js");
    expect(collected).toContain("+function add(a,b){return a+b}");
    // Setup file must NOT appear in the candidate.
    expect(collected).not.toContain("setup.cfg");
  });

  test("candidate captures work the agent COMMITTED itself", async () => {
    // This is the case the buggy `git diff --cached` silently dropped.
    await applySetup();
    bash(repo, buildBaselineGitScript());
    await writeFile(path.join(repo, "app.js"), "function add(a,b){return a+b}\n");
    await writeFile(path.join(repo, "newfile.js"), "export const x = 1\n");
    git(repo, ["add", "-A"]);
    git(repo, ["commit", "-q", "-m", "agent fix"]);

    const collected = decodeCollected(bash(repo, buildCandidateCollectionScript()));
    expect(collected).toContain("+function add(a,b){return a+b}");
    expect(collected).toContain("newfile.js");
    expect(collected).not.toContain("setup.cfg");
  });

  test("a no-op agent yields an empty candidate", async () => {
    await applySetup();
    bash(repo, buildBaselineGitScript());
    const collected = bash(repo, buildCandidateCollectionScript());
    expect(collected.trim()).toBe("");
  });
});
