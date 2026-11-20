import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  captureBaseState,
  checkBaseMovement,
  cleanupAfterEvidence,
  discardCancelledWorktree,
  exportPatchArtifacts,
  mintCancelledRunProof,
  mintSealedEvidenceProof,
  provisionWorkflowWorktree,
  workflowRunRef,
  workflowWorktreeSlug,
  type EvidenceArtifactSink,
} from "../../src/workflow/worktree-lifecycle.js";
import type {
  RunArtifactPointer,
  RunStepIdentity,
} from "../../src/contracts/run-contracts.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";
import { itOnDarwin } from "../helpers/platform-registration.js";
import {
  SandboxExecutionBroker,
  type SandboxExecutionBrokerLike,
} from "../../src/sandbox/execution-broker.js";
import { runSupervisedProcess } from "../../src/utils/supervisedProcess.js";

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
    const head = git(handle.path, "rev-parse", "HEAD").trim();
    await cleanupAfterEvidence({
      proof: mintSealedEvidenceProof({
        runId: spec.runId,
        sealDigest: `sha256:${"d".repeat(64)}`,
      }),
      handle,
      headCommit: head,
      broker,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(checkoutFingerprint(repo)).toBe(before);
    const { existsSync } = await import("node:fs");
    expect(existsSync(handle.path)).toBe(false);
  });

  it("cleanup after a finished run takes back the .agenc-worktrees folder its worktree step made", async () => {
    const repo = join(tempWork(), "repo");
    const base = initRepo(repo);
    const finished = { runId: "conv-m5done01", repoPath: repo, baseCommit: base };
    const handle = await provisionWorkflowWorktree(finished, broker);
    expect(handle.createdWorkspaceRoot).toBe(join(repo, ".agenc-worktrees"));
    const before = checkoutFingerprint(repo);
    const warnings: string[] = [];
    await cleanupAfterEvidence({
      proof: mintSealedEvidenceProof({ runId: finished.runId, sealDigest: `sha256:${"e".repeat(64)}` }),
      handle,
      headCommit: git(handle.path, "rev-parse", "HEAD").trim(),
      broker,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(existsSync(join(repo, ".agenc-worktrees"))).toBe(false);
    expect(checkoutFingerprint(repo)).toBe(before);
    expect(git(repo, "status", "--porcelain=v1")).toBe("");

    const cancelled = { runId: "conv-m5stop01", repoPath: repo, baseCommit: base };
    const stopped = await provisionWorkflowWorktree(cancelled, broker);
    await discardCancelledWorktree({
      proof: mintCancelledRunProof({ runId: cancelled.runId }),
      handle: stopped,
      broker,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(existsSync(join(repo, ".agenc-worktrees"))).toBe(false);
  });

  it("cleanup keeps a .agenc-worktrees folder that was there before the run, and one still in use", async () => {
    const repo = join(tempWork(), "repo");
    const base = initRepo(repo);
    mkdirSync(join(repo, ".agenc-worktrees"));
    const before = { runId: "conv-m5kept01", repoPath: repo, baseCommit: base };
    const handle = await provisionWorkflowWorktree(before, broker);
    expect(handle).not.toHaveProperty("createdWorkspaceRoot");
    const proof = (runId: string) => mintSealedEvidenceProof({ runId, sealDigest: `sha256:${"c".repeat(64)}` });
    await cleanupAfterEvidence({
      proof: proof(before.runId), handle, headCommit: git(handle.path, "rev-parse", "HEAD").trim(), broker, warn: () => {},
    });
    expect(existsSync(join(repo, ".agenc-worktrees"))).toBe(true);
    rmSync(join(repo, ".agenc-worktrees"), { recursive: true });

    const first = { runId: "conv-m5frst01", repoPath: repo, baseCommit: base };
    const second = { runId: "conv-m5scnd01", repoPath: repo, baseCommit: base };
    const made = await provisionWorkflowWorktree(first, broker);
    const sharing = await provisionWorkflowWorktree(second, broker);
    await cleanupAfterEvidence({
      proof: proof(first.runId), handle: made, headCommit: git(made.path, "rev-parse", "HEAD").trim(), broker, warn: () => {},
    });
    expect(existsSync(sharing.path)).toBe(true);
    expect(git(sharing.path, "rev-parse", "HEAD").trim()).toBe(base);
  });

  it("cleanup pins the delivered commit before deleting its only branch", async () => {
    const repo = join(tempWork(), "repo");
    const base = initRepo(repo);
    const spec = { runId: "wf-m5pin0001", repoPath: repo, baseCommit: base };
    const handle = await provisionWorkflowWorktree(spec, broker);
    // The run's product: a commit that exists on the worktree branch alone.
    writeFileSync(join(handle.path, "delivered.txt"), "the change\n");
    git(handle.path, "add", "-A");
    git(
      handle.path,
      "-c", "user.name=t", "-c", "user.email=t@t",
      "commit", "-m", "snapshot",
    );
    const head = git(handle.path, "rev-parse", "HEAD").trim();

    const warnings: string[] = [];
    await cleanupAfterEvidence({
      proof: mintSealedEvidenceProof({
        runId: spec.runId,
        sealDigest: `sha256:${"e".repeat(64)}`,
      }),
      handle,
      headCommit: head,
      broker,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);

    // The branch is gone, and the commit is still reachable — by the ref,
    // not as a dangling object one gc away from disappearing.
    const branches = git(repo, "branch", "--list");
    expect(branches).not.toContain(handle.branch);
    const pinned = git(repo, "rev-parse", workflowRunRef(spec.runId)).trim();
    expect(pinned).toBe(head);
    const reachable = git(repo, "branch", "--all", "--contains", head);
    // Not on any branch: the ref alone carries it.
    expect(reachable.trim()).toBe("");
    expect(
      git(repo, "show", `${workflowRunRef(spec.runId)}:delivered.txt`),
    ).toContain("the change");
  });

  /**
   * One sandboxed shell command on the surface model commands use. Each probe
   * prints whether it wrote: the pointer `$1`, a nested `.git` under `$2`,
   * and the ordinary file `$3`.
   */
  async function modelCommandWrites(
    commandBroker: SandboxExecutionBrokerLike,
    cwd: string,
    pointer: string,
    nestedDir: string,
    file: string,
  ): Promise<string> {
    const script = [
      `if printf 'gitdir: /tmp/planted\\n' > "$1"; then echo pointer:written; else echo pointer:refused; fi`,
      `mkdir -p "$2"`,
      `if printf 'gitdir: /tmp/planted\\n' > "$2/.git"; then echo nested:written; else echo nested:refused; fi`,
      `if printf 'export const edited = true;\\n' >> "$3"; then echo file:written; else echo file:refused; fi`,
    ].join("\n");
    const command = commandBroker.prepareSpawn("tool", {
      program: "/bin/sh",
      args: ["-c", script, "sh", pointer, nestedDir, file],
      cwd,
      env: { PATH: "/usr/bin:/bin" },
    });
    const result = await runSupervisedProcess(command, {
      timeoutMs: 20_000,
      maxOutputBytes: 64 * 1024,
    });
    return result.stdout.toString("utf8");
  }

  // Since the macOS profile refused every nested `.git`, `git worktree add`
  // died on the new worktree's own pointer and no Goal run got past its
  // worktree step on a Mac. Core's own git now names that one file; a
  // command the model runs still cannot write any `.git`.
  itOnDarwin("provisions, exports and removes a Goal worktree under the real macOS sandbox", async () => {
    const root = realpathSync(tempWork());
    const repo = join(root, "repo");
    const base = initRepo(repo);
    const sessionTemp = join(root, "session-tmp");
    mkdirSync(sessionTemp);
    const sandboxed = new SandboxExecutionBroker({
      mode: "workspace_write",
      cwd: repo,
      sessionTempRoot: sessionTemp,
      env: { ...process.env, AGENC_HOME: join(root, "agenc-home") },
    });
    expect(sandboxed.status()).toMatchObject({
      kind: "ready",
      isolationProgram: "/usr/bin/sandbox-exec",
    });
    const spec = { runId: "wf-seatbelt0001", repoPath: repo, baseCommit: base };

    const handle = await provisionWorkflowWorktree(spec, sandboxed);
    expect(handle.created).toBe(true);
    expect(readFileSync(join(handle.path, "src", "index.ts"), "utf8"))
      .toBe("export const answer = 41;\n");
    const pointer = join(handle.path, ".git");
    const pointerBytes = readFileSync(pointer, "utf8");
    expect(pointerBytes).toMatch(/^gitdir: /u);

    // The model's commands, from the checkout and from inside the worktree.
    expect(await modelCommandWrites(
      sandboxed, repo, pointer, join(repo, "nested"), join(repo, "README.md"),
    )).toBe("pointer:refused\nnested:refused\nfile:written\n");
    const confined = sandboxed.forkForCwd(handle.path, {
      worktreeConfinement: { worktree: handle.path, checkout: repo },
    });
    expect(await modelCommandWrites(
      confined, handle.path, pointer, join(handle.path, "nested"),
      join(handle.path, "src", "index.ts"),
    )).toBe("pointer:refused\nnested:refused\nfile:written\n");
    expect(readFileSync(pointer, "utf8")).toBe(pointerBytes);
    expect(existsSync(join(repo, "nested", ".git"))).toBe(false);
    expect(existsSync(join(handle.path, "nested", ".git"))).toBe(false);

    const exported = await exportPatchArtifacts({
      handle, baseCommit: base, step: STEP, sink: new MemorySink(), broker: sandboxed,
    });
    expect(new TextDecoder().decode(exported.patchBytes)).toContain("+export const edited = true;");

    const warnings: string[] = [];
    await cleanupAfterEvidence({
      proof: mintSealedEvidenceProof({
        runId: spec.runId,
        sealDigest: `sha256:${"f".repeat(64)}`,
      }),
      handle,
      headCommit: exported.headCommit,
      broker: sandboxed,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toEqual([]);
    expect(existsSync(handle.path)).toBe(false);
    expect(git(repo, "branch", "--list", handle.branch).trim()).toBe("");
    expect(git(repo, "rev-parse", workflowRunRef(spec.runId)).trim()).toBe(exported.headCommit);
  }, 60_000);
});
