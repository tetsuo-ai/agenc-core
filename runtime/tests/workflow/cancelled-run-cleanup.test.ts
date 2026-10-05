/**
 * A Goal cancelled mid-stage retains its partial work for inspection.
 *
 * The worktree is excluded from the source checkout's git status. Cancellation
 * must preserve both its branch and edits made since the last exported patch.
 *
 * Real durable machinery through the M5 harness: a fixture repository, real
 * git worktrees, the real admission kernel (its cancelRun is the cascade
 * run.cancel drives) and the real evidence ledger. A completed run first
 * delivers a commit, pinned under refs/agenc/runs/; a second run is then
 * cancelled while its required check is running.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  workflowRunRef,
  workflowWorktreeSlug,
} from "../../src/workflow/worktree-lifecycle.js";
import { cleanupM5ExitStateDirs, makeStateDir } from "./fixtures/m5-exit-shared.js";
import { buildM5Harness } from "./fixtures/m5-harness.js";

const DELIVERED_RUN = "wf-delivered";
const CANCELLED_RUN = "wf-cancelled";
const FIX = "module.exports.add = (a, b) => a + b;\n";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

/** Wait for the check to start; a run that ends first fails with its own message. */
async function waitForCheck(
  path: string,
  ended: () => string | undefined,
): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (!existsSync(path)) {
    const terminal = ended();
    if (terminal !== undefined) {
      throw new Error(`the run ended before its check started: ${terminal}`);
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Every payload in the run's evidence ledger, as text. */
function ledgerPayloads(home: string, runId: string): string[] {
  const root = join(home, "run-evidence", runId);
  return readdirSync(root)
    .filter((entry) => entry.endsWith(".payloads"))
    .flatMap((entry) =>
      readdirSync(join(root, entry)).map((file) =>
        readFileSync(join(root, entry, file), "utf8"),
      ),
    );
}

afterEach(() => {
  cleanupM5ExitStateDirs();
});

describe("a Goal run cancelled mid-stage", () => {
  it(
    "keeps partial work, evidence and delivered commits while leaving the source checkout clean",
    { timeout: 180_000 },
    async () => {
      const stateDir = makeStateDir("agenc-m5-cancel-");
      const home = join(stateDir, "home");
      const repoPath = join(stateDir, "repo");
      const seedHead = git(repoPath, "rev-parse", "HEAD").trim();
      const harness = buildM5Harness({
        home,
        repoPath,
        receiptsDir: join(stateDir, "receipts"),
        implementFix: { file: "lib/add.js", contents: FIX },
      });
      const start = (runId: string, script: string) =>
        harness.controller.start({
          runId,
          goal: "Make add return the sum of its arguments.",
          repoPath,
          reviewerModel: "reviewer",
          requiredVerification: [{ label: "test", script }],
        });
      try {
        await start(DELIVERED_RUN, "./test.sh");
        await harness.controller.awaitRun(DELIVERED_RUN);
        expect(harness.repo.getCurrentTerminalResult(DELIVERED_RUN)?.status).toBe(
          "completed",
        );
        const delivered = git(repoPath, "rev-parse", workflowRunRef(DELIVERED_RUN)).trim();

        const checkStarted = join(stateDir, "check-started");
        const checkRelease = join(stateDir, "check-release");
        await start(
          CANCELLED_RUN,
          `touch '${checkStarted}'; while [ ! -e '${checkRelease}' ]; do sleep 0.05; done; ./test.sh`,
        );
        await waitForCheck(checkStarted, () => {
          const terminal = harness.repo.getCurrentTerminalResult(CANCELLED_RUN);
          return terminal === undefined
            ? undefined
            : `${terminal.status}: ${terminal.finalMessage}`;
        });
        const worktree = join(
          repoPath,
          ".agenc-worktrees",
          workflowWorktreeSlug(CANCELLED_RUN),
        );
        expect(existsSync(worktree)).toBe(true);
        const partialFile = join(worktree, "lib", "unfinished.txt");
        writeFileSync(partialFile, "Work that has not been exported yet.\n");
        harness.kernel.cancelRun(CANCELLED_RUN, "run.cancel");
        writeFileSync(checkRelease, "");
        await harness.controller.awaitRun(CANCELLED_RUN);

        expect(harness.repo.getCurrentTerminalResult(CANCELLED_RUN)?.status).toBe(
          "cancelled",
        );
        expect(harness.repo.getEffect(CANCELLED_RUN, "workflow.verify.cmd.1")).toMatchObject({
          outcome: "cancelled",
        });
        expect(existsSync(worktree)).toBe(true);
        expect(readFileSync(partialFile, "utf8")).toBe("Work that has not been exported yet.\n");
        expect(readFileSync(join(worktree, "lib", "add.js"), "utf8")).toBe(FIX);
        expect(git(repoPath, "branch", "--list", "worktree-*")).toContain(workflowWorktreeSlug(CANCELLED_RUN));
        expect(git(repoPath, "worktree", "list", "--porcelain")).toContain(worktree);
        expect(harness.repo.getCurrentTerminalResult(CANCELLED_RUN)?.finalMessage).toContain(`Work is preserved in ${worktree}`);
        // The user's checkout is as it was, and git has nothing to report.
        expect(git(repoPath, "rev-parse", "HEAD").trim()).toBe(seedHead);
        expect(git(repoPath, "status", "--porcelain")).toBe("");
        // The run's evidence still holds the patch it exported before the cancel.
        expect(
          ledgerPayloads(home, CANCELLED_RUN).some((text) =>
            text.includes(`+${FIX.trimEnd()}`),
          ),
        ).toBe(true);
        // The earlier run's delivered commit is still pinned.
        expect(git(repoPath, "rev-parse", workflowRunRef(DELIVERED_RUN)).trim()).toBe(
          delivered,
        );
        expect(git(repoPath, "show", `${delivered}:lib/add.js`)).toBe(FIX);
        expect(harness.warnings).toEqual([]);
      } finally {
        harness.close();
      }
    },
  );
});
