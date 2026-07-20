import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  captureBaseState,
  checkBaseMovement,
  cleanupAfterEvidence,
  exportPatchArtifacts,
  mintSealedEvidenceProof,
  provisionWorkflowWorktree,
  workflowWorktreeSlug,
  type EvidenceArtifactSink,
} from "../../src/workflow/worktree-lifecycle.js";
import type {
  RunArtifactPointer,
  RunStepIdentity,
} from "../../src/contracts/run-contracts.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

const broker = explicitDangerBroker;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initRepo(repo: string): string {
  mkdirSync(repo, { recursive: true });
  git(repo, "init");
  git(repo, "config", "user.email", "tests@example.com");
  git(repo, "config", "user.name", "Tests");
  writeFileSync(join(repo, "README.md"), "hello\n");
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "index.ts"), "export const answer = 41;\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "init");
  return git(repo, "rev-parse", "HEAD").trim();
}

/**
 * Snapshot of the user checkout: HEAD + porcelain status. The
 * `.agenc-worktrees/` workspace dir is the worktree library's documented
 * home under the repo root — untracked, never touching tracked content —
 * so it is excluded from the "checkout untouched" fingerprint.
 */
function checkoutFingerprint(repo: string): string {
  const status = git(repo, "status", "--porcelain=v1")
    .split("\n")
    .filter((line) => line.length > 0 && !line.includes(".agenc-worktrees"))
    .join("\n");
  return git(repo, "rev-parse", "HEAD") + status;
}

class MemorySink implements EvidenceArtifactSink {
  readonly recorded: Array<{ role: string; digest: string; bytes: number }> = [];

  async recordArtifact(input: {
    step: RunStepIdentity;
    role: RunArtifactPointer["role"];
    bytes: Uint8Array;
    mediaType: string;
  }): Promise<RunArtifactPointer> {
    const hex = createHash("sha256").update(input.bytes).digest("hex");
    const pointer: RunArtifactPointer = {
      step: input.step,
      role: input.role,
      digest: `sha256:${hex}`,
      bytes: input.bytes.byteLength,
      storagePath: `cas://sha256/${hex}`,
      recordedAt: "2026-07-20T12:00:00Z",
    };
    this.recorded.push({ role: input.role, digest: pointer.digest, bytes: pointer.bytes });
    return pointer;
  }
}

const STEP: RunStepIdentity = { runId: "conv-m5test01", stepId: "workflow.finalize" };

let work: string;
const cleanups: Array<() => void> = [];

function tempWork(): string {
  work = mkdtempSync(join(tmpdir(), "agenc-m5-worktree-"));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));
  return work;
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("M5 worktree lifecycle", () => {
  it("derives a deterministic slug from the run id alone", () => {
    expect(workflowWorktreeSlug("conv-m5test01")).toBe("m5-convm5test01".slice(0, 15));
    expect(workflowWorktreeSlug("conv-m5test01")).toBe(workflowWorktreeSlug("conv-m5test01"));
    expect(workflowWorktreeSlug("run-A"),).not.toBe(workflowWorktreeSlug("run-B"));
  });

  it("captures base commit and dirty summary without touching the checkout", async () => {
    const repo = join(tempWork(), "repo");
    const base = initRepo(repo);
    writeFileSync(join(repo, "uncommitted.txt"), "dirty\n");
    const before = checkoutFingerprint(repo);

    const state = await captureBaseState(repo, broker);
    expect(state.baseCommit).toBe(base);
    expect(state.dirty).toBe(true);
    expect(state.fileCount).toBe(1);
    expect(state.summaryDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(checkoutFingerprint(repo)).toBe(before);
  });

  it("provisions at the frozen base and crash-resumes idempotently", async () => {
    const repo = join(tempWork(), "repo");
    const base = initRepo(repo);
    // The user moves forward AFTER intake froze the base.
    writeFileSync(join(repo, "later.txt"), "later\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "user moves on");
    const before = checkoutFingerprint(repo);

    const spec = { runId: "conv-m5test01", repoPath: repo, baseCommit: base };
    const first = await provisionWorkflowWorktree(spec, broker);
    expect(first.created).toBe(true);
    expect(git(first.path, "rev-parse", "HEAD").trim()).toBe(base);

    // Simulated crash between provision and effect commit: re-provision
    // resumes the SAME worktree.
    const second = await provisionWorkflowWorktree(spec, broker);
    expect(second.created).toBe(false);
    expect(second.path).toBe(first.path);
    expect(checkoutFingerprint(repo)).toBe(before);
  });

  it("exports stable patch artifacts and re-export is byte-identical", async () => {
    const repo = join(tempWork(), "repo");
    const base = initRepo(repo);
    const before = checkoutFingerprint(repo);
    const spec = { runId: "conv-m5test01", repoPath: repo, baseCommit: base };
    const handle = await provisionWorkflowWorktree(spec, broker);

    writeFileSync(join(handle.path, "src", "index.ts"), "export const answer = 42;\n");
    writeFileSync(join(handle.path, "src", "new-file.ts"), "export const created = true;\n");

    const sink = new MemorySink();
    const first = await exportPatchArtifacts({
      handle, baseCommit: base, step: STEP, sink, broker,
    });
    expect(first.patch.digest).toMatch(/^sha256:/);
    expect(first.changedFiles.digest).toMatch(/^sha256:/);
    expect(new TextDecoder().decode(first.patchBytes)).toContain("answer = 42");
    expect(first.headCommit).not.toBe(base);

    const again = await exportPatchArtifacts({
      handle, baseCommit: base, step: STEP, sink: new MemorySink(), broker,
    });
    expect(again.patch.digest).toBe(first.patch.digest);
    expect(again.changedFiles.digest).toBe(first.changedFiles.digest);
    expect(again.headCommit).toBe(first.headCommit);
    expect(checkoutFingerprint(repo)).toBe(before);

    // The exported patch applies cleanly to a fresh clone at base.
    const clone = join(work, "clone");
    git(work, "clone", repo, "clone");
    git(clone, "checkout", base);
    const patchFile = join(work, "exported.patch");
    writeFileSync(patchFile, first.patchBytes);
    execFileSync("git", ["apply", patchFile], { cwd: clone });
  });

  it("detects unmoved base", async () => {
    const repo = join(tempWork(), "repo");
    const base = initRepo(repo);
    const result = await checkBaseMovement({
      spec: { runId: "conv-m5test01", repoPath: repo, baseCommit: base },
      patchBytes: new TextEncoder().encode("anything"),
      broker,
    });
    expect(result).toEqual({ kind: "unmoved" });
  });

  it("classifies a moved base with a clean 3-way apply", async () => {
    const repo = join(tempWork(), "repo");
    const base = initRepo(repo);
    const spec = { runId: "conv-m5test01", repoPath: repo, baseCommit: base };
    const handle = await provisionWorkflowWorktree(spec, broker);
    writeFileSync(join(handle.path, "src", "index.ts"), "export const answer = 42;\n");
    const sink = new MemorySink();
    const exported = await exportPatchArtifacts({
      handle, baseCommit: base, step: STEP, sink, broker,
    });

    // Base moves in an UNRELATED file.
    writeFileSync(join(repo, "README.md"), "hello moved\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "unrelated movement");
    const before = checkoutFingerprint(repo);

    const result = await checkBaseMovement({
      spec, patchBytes: exported.patchBytes, broker,
    });
    expect(result.kind).toBe("rebase_clean");
    expect(checkoutFingerprint(repo)).toBe(before);
  });

  it("classifies a conflicting moved base with the conflicting files", async () => {
    const repo = join(tempWork(), "repo");
    const base = initRepo(repo);
    const spec = { runId: "conv-m5test01", repoPath: repo, baseCommit: base };
    const handle = await provisionWorkflowWorktree(spec, broker);
    writeFileSync(join(handle.path, "src", "index.ts"), "export const answer = 42;\n");
    const exported = await exportPatchArtifacts({
      handle, baseCommit: base, step: STEP, sink: new MemorySink(), broker,
    });

    // Base moves in the SAME line of the SAME file.
    writeFileSync(join(repo, "src", "index.ts"), "export const answer = 43;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "conflicting movement");
    const before = checkoutFingerprint(repo);

    const result = await checkBaseMovement({
      spec, patchBytes: exported.patchBytes, broker,
    });
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") {
      expect(result.conflictFiles).toContain("src/index.ts");
    }
    expect(checkoutFingerprint(repo)).toBe(before);
  });

  it("cleanup requires the sealed-evidence proof and removes only the workflow worktree", async () => {
    const repo = join(tempWork(), "repo");
    const base = initRepo(repo);
    const spec = { runId: "conv-m5test01", repoPath: repo, baseCommit: base };
    const handle = await provisionWorkflowWorktree(spec, broker);
    const before = checkoutFingerprint(repo);

    const warnings: string[] = [];
    await cleanupAfterEvidence({
      proof: mintSealedEvidenceProof({
        runId: spec.runId,
        sealDigest: `sha256:${"d".repeat(64)}`,
      }),
      handle,
      broker,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(checkoutFingerprint(repo)).toBe(before);
    const { existsSync } = await import("node:fs");
    expect(existsSync(handle.path)).toBe(false);
  });
});
