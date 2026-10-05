import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { workflowRunRef, workflowWorktreeSlug } from "../../src/workflow/worktree-lifecycle.js";
import { cleanupM5ExitStateDirs, makeStateDir } from "./fixtures/m5-exit-shared.js";
import { buildM5Harness } from "./fixtures/m5-harness.js";

afterEach(cleanupM5ExitStateDirs);

it("refuses a passing test command that changes the code after testing it", { timeout: 60_000 }, async () => {
  const stateDir = makeStateDir("agenc-m5-verified-tree-");
  const repoPath = join(stateDir, "repo");
  const runId = "wf-verified-tree";
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" });
  const originalHead = git("rev-parse", "HEAD");
  const harness = buildM5Harness({
    home: join(stateDir, "home"), repoPath, receiptsDir: join(stateDir, "receipts"),
    implementFix: { file: "lib/add.js", contents: "module.exports.add = (a, b) => a + b;\n" },
  });
  try {
    await harness.controller.start({
      runId, goal: "Make add return the sum of its arguments.", repoPath,
      reviewerModel: "reviewer", requiredVerification: [{ label: "test then mutate",
        script: "./test.sh && printf 'module.exports.add = () => 0;\\n' > lib/add.js" }],
    });
    await harness.controller.awaitRun(runId);
    expect(harness.repo.getEffect(runId, "workflow.verify.cmd.1")?.evidence).toMatchObject({
      command: { exitCode: 0, timedOut: false },
    });
    expect(harness.repo.getCurrentTerminalResult(runId)).toMatchObject({ status: "failed", stopReason: "evidence_invalid" });
    const worktree = join(repoPath, ".agenc-worktrees", workflowWorktreeSlug(runId));
    expect(existsSync(worktree)).toBe(true);
    expect(readFileSync(join(worktree, "lib", "add.js"), "utf8")).toBe("module.exports.add = () => 0;\n");
    expect(git("for-each-ref", "--format=%(refname)", workflowRunRef(runId))).toBe("");
    expect(git("rev-parse", "HEAD")).toBe(originalHead);
    expect(git("status", "--porcelain")).toBe("");
  } finally {
    harness.close();
  }
});
