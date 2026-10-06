import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { WorkflowSpec } from "../../src/contracts/run-contracts.js";
import { sha256Digest } from "../../src/eval-contract/canonical-json.js";
import { workflowRunRef } from "../../src/workflow/worktree-lifecycle.js";
import { cleanupM5ExitStateDirs, makeStateDir } from "./fixtures/m5-exit-shared.js";
import { buildM5Harness } from "./fixtures/m5-harness.js";

afterEach(cleanupM5ExitStateDirs);

const SOURCE = "wf-continue-source";
const BOUNDS = { maxCostUsd: 1, deadlineAt: "2099-01-01T00:00:00.000Z" };

it.each(["unmerged", "applied"])("continues the exact %s delivered files and exports the full patch against the checkout", { timeout: 60_000 }, async mode => {
  const stateDir = makeStateDir("agenc-continuation-");
  const repoPath = join(stateDir, "repo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
  const originalHead = git("rev-parse", "HEAD");
  const implementFix = { file: "lib/add.js", contents: "module.exports.add = (a, b) => a + b;\n" };
  const options = { home: join(stateDir, "home"), repoPath, receiptsDir: join(stateDir, "receipts"), implementFix };
  let harness = buildM5Harness(options);
  try {
    await harness.controller.start({ runId: SOURCE, repoPath, goal: "Fix add", reviewerModel: "reviewer",
      requiredVerification: [{ label: "test", script: "./test.sh" }] });
    await harness.controller.awaitRun(SOURCE);
    const sourceTerminal = harness.repo.getCurrentTerminalResult(SOURCE);
    expect(sourceTerminal?.status).toBe("completed");
    const sourceHead = git("rev-parse", workflowRunRef(SOURCE));
    if (mode === "applied") git("reset", "--hard", sourceHead);
    const checkoutHead = git("rev-parse", "HEAD");
    implementFix.file = "lib/multiply.js";
    implementFix.contents = "const { add } = require('./add'); module.exports.multiply = (a, b) => Array.from({length: b}).reduce(total => add(total, a), 0);\n";
    const request = { repoPath, goal: "Add multiplication using the existing add function", reviewerModel: "reviewer",
      budget: BOUNDS, continuation: { sourceRunId: SOURCE, requestId: `multiply-${mode}` },
      requiredVerification: [{ label: "test", script: "./test.sh && node -e \"if (require('./lib/multiply').multiply(2, 3) !== 6) process.exit(1)\"" }] };
    const started = await harness.controller.start(request);
    await harness.controller.awaitRun(started.runId);
    expect(harness.repo.getCurrentTerminalResult(started.runId)).toMatchObject({ status: "completed" });
    expect(harness.repo.getCurrentTerminalResult(SOURCE)).toEqual(sourceTerminal);
    const nextHead = git("rev-parse", workflowRunRef(started.runId));
    expect(git("show", `${nextHead}:lib/add.js`)).toContain("a + b");
    expect(git("show", `${nextHead}:lib/multiply.js`)).toContain("require('./add')");
    const combinedPatch = execFileSync("git", ["diff", "--full-index", "--no-color", "--no-ext-diff", `${checkoutHead}..${nextHead}`], { cwd: repoPath, encoding: "utf8" });
    expect(combinedPatch).toContain("lib/multiply.js");
    if (mode === "unmerged") expect(combinedPatch).toContain("lib/add.js");
    const finalize = harness.repo.getEffect(started.runId, "workflow.finalize")!.evidence as { artifacts: { role: string; digest: string }[] };
    expect(finalize.artifacts.find(artifact => artifact.role === "patch")?.digest).toBe(sha256Digest(combinedPatch));
    const spec = (harness.repo.getEffect(started.runId, "workflow.intake")!.evidence as { spec: WorkflowSpec }).spec;
    expect(spec).toMatchObject({ baseCommit: checkoutHead, continuationOf: { sourceRunId: SOURCE, sourceHeadCommit: sourceHead,
      sourceBaseCommit: originalHead, previousCostUsd: 0 } });
    expect(git("rev-parse", "HEAD")).toBe(checkoutHead);
    expect(git("status", "--porcelain")).toBe("");
    const receipts = readFileSync(join(stateDir, "receipts", "implement-attempts.jsonl"), "utf8");
    // Reconstruct the controller over the same durable state, then replay.
    harness.close();
    harness = buildM5Harness(options);
    expect(await harness.controller.start(request)).toMatchObject({ runId: started.runId, replayed: true });
    expect(readFileSync(join(stateDir, "receipts", "implement-attempts.jsonl"), "utf8")).toBe(receipts);
    expect(harness.spawnKinds).toEqual([]);
  } finally { harness.close(); }
});

it.each(["missing_ref", "changed_ref", "changed_recorded_patch", "changed_recorded_tree", "missing_seal", "advanced_checkout", "dirty_checkout"])("refuses %s without changing the source or dispatching new work", { timeout: 60_000 }, async mutation => {
  const stateDir = makeStateDir("agenc-continuation-invalid-");
  const repoPath = join(stateDir, "repo");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repoPath, encoding: "utf8" }).trim();
  const harness = buildM5Harness({ home: join(stateDir, "home"), repoPath, receiptsDir: join(stateDir, "receipts"),
    implementFix: { file: "lib/add.js", contents: "module.exports.add = (a, b) => a + b;\n" } });
  try {
    await harness.controller.start({ runId: SOURCE, repoPath, goal: "Fix add", reviewerModel: "reviewer",
      requiredVerification: [{ label: "test", script: "./test.sh" }] });
    await harness.controller.awaitRun(SOURCE);
    const source = harness.repo.getCurrentTerminalResult(SOURCE);
    expect(source?.status).toBe("completed");
    if (mutation === "missing_ref") git("update-ref", "-d", workflowRunRef(SOURCE));
    else if (mutation === "changed_ref") git("update-ref", workflowRunRef(SOURCE), "HEAD");
    else if (mutation === "changed_recorded_patch" || mutation === "changed_recorded_tree" || mutation === "missing_seal") {
      const getEffect = harness.repo.getEffect.bind(harness.repo);
      vi.spyOn(harness.repo, "getEffect").mockImplementation((runId, stepId) => {
        const effect = getEffect(runId, stepId);
        if (runId !== SOURCE || stepId !== "workflow.finalize" || effect === undefined) return effect;
        const evidence = effect.evidence as { finalize: Record<string, unknown>; artifacts: { role: string; digest: string }[] };
        return { ...effect, evidence: { ...evidence,
          finalize: { ...evidence.finalize,
            ...(mutation === "changed_recorded_tree" ? { treeHash: "0".repeat(40) } : {}),
            ...(mutation === "missing_seal" ? { sealDigest: undefined } : {}) },
          artifacts: evidence.artifacts.map(artifact => mutation === "changed_recorded_patch" && artifact.role === "patch"
            ? { ...artifact, digest: `sha256:${"0".repeat(64)}` } : artifact),
        } };
      });
    }
    else {
      writeFileSync(join(repoPath, "new-file.txt"), "user work\n");
      if (mutation === "advanced_checkout") {
        git("add", "new-file.txt");
        git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "--no-verify", "-m", "advance checkout");
      }
    }
    const unchanged = git("status", "--porcelain");
    const calls = harness.spawnKinds.length;
    await expect(harness.controller.start({ repoPath, goal: "Add multiplication", reviewerModel: "reviewer", budget: BOUNDS,
      continuation: { sourceRunId: SOURCE, requestId: mutation }, requiredVerification: [{ label: "test", script: "./test.sh" }] }))
      .rejects.toThrow(/checkout changed|delivered ref|verified snapshot/u);
    expect(harness.spawnKinds).toHaveLength(calls);
    expect(harness.repo.getCurrentTerminalResult(SOURCE)).toEqual(source);
    expect(git("status", "--porcelain")).toBe(unchanged);
  } finally { harness.close(); }
});
