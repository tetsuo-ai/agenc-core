/**
 * M5 worktree lifecycle — checkout protection and patch integrity for the
 * verified-change workflow.
 *
 * Pure library over `agents/worktree.ts` and the sandbox execution broker.
 * Invariants it owns:
 *
 * - The user's source checkout is NEVER mutated. All agent changes happen in
 *   the workflow worktree; base-movement checks run in a separate TEMPORARY
 *   worktree; only worktrees this library created are ever removed.
 * - The worktree slug is a pure function of the run id, so a crash between
 *   provisioning and the durable effect commit is recoverable from the run
 *   id alone (idempotent re-provision fast-resumes the same worktree).
 * - Patch and changed-file artifacts are exported and content-addressed
 *   BEFORE any cleanup: `cleanupAfterEvidence` demands the branded proof
 *   token minted only by the finalize step's sealed evidence ledger, making
 *   cleanup-before-evidence a compile error, not a code-review catch.
 */

import { createHash } from "node:crypto";

import type { SandboxExecutionBrokerLike } from "../sandbox/execution-broker.js";
import type {
  RunArtifactPointer,
  RunStepIdentity,
  WorkflowSpec,
} from "../contracts/run-contracts.js";
import {
  getOrCreateWorktree,
  removeAgentWorktree,
  runGit,
  type WorktreeHandle,
} from "../agents/worktree.js";

/**
 * Narrow artifact sink the controller implements over the evidence ledger
 * (`appendEvidenceEvent` with payload bytes → CAS). Keeping the library
 * decoupled from ledger ceremony keeps it testable with an in-memory sink.
 */
export interface EvidenceArtifactSink {
  recordArtifact(input: {
    readonly step: RunStepIdentity;
    readonly role: RunArtifactPointer["role"];
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }): Promise<RunArtifactPointer>;
}

/**
 * Proof that the run's evidence ledger has been sealed. Only the finalize
 * step mints this (from `sealEvidenceLedger`); `cleanupAfterEvidence`
 * requires it.
 */
declare const sealedEvidenceProofBrand: unique symbol;
export interface SealedEvidenceProof {
  readonly runId: string;
  readonly sealDigest: string;
  readonly [sealedEvidenceProofBrand]: true;
}

/** Minted exclusively by the finalize step after a successful seal. */
export function mintSealedEvidenceProof(input: {
  readonly runId: string;
  readonly sealDigest: string;
}): SealedEvidenceProof {
  return {
    runId: input.runId,
    sealDigest: input.sealDigest,
  } as SealedEvidenceProof;
}

export interface BaseState {
  readonly baseCommit: string;
  readonly dirty: boolean;
  readonly fileCount: number;
  /** sha256 over the exact `git status --porcelain=v1 -z` output. */
  readonly summaryDigest: `sha256:${string}`;
}

export class WorkflowGitError extends Error {
  readonly operation: string;

  constructor(operation: string, detail: string) {
    super(`workflow git ${operation} failed: ${detail}`);
    this.name = "WorkflowGitError";
    this.operation = operation;
  }
}

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Deterministic worktree slug — a pure function of the run id. */
export function workflowWorktreeSlug(runId: string): string {
  const compact = runId.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 12);
  if (compact.length === 0) {
    throw new WorkflowGitError("slug", `run id yields an empty slug: ${runId}`);
  }
  return `m5-${compact}`;
}

/**
 * Record the exact state of the user's checkout before any work begins.
 * Read-only: two porcelain git reads, nothing else.
 */
export async function captureBaseState(
  gitRoot: string,
  broker: SandboxExecutionBrokerLike,
): Promise<BaseState> {
  const head = await runGit(["rev-parse", "HEAD"], gitRoot, broker);
  if (head.code !== 0) {
    throw new WorkflowGitError("rev-parse", head.stderr.trim() || "no HEAD");
  }
  const status = await runGit(
    ["status", "--porcelain=v1", "-z"],
    gitRoot,
    broker,
  );
  if (status.code !== 0) {
    throw new WorkflowGitError("status", status.stderr.trim());
  }
  const entries = status.stdout.split("\0").filter((line) => line.length > 0);
  return {
    baseCommit: head.stdout.trim(),
    dirty: entries.length > 0,
    fileCount: entries.length,
    summaryDigest: `sha256:${sha256Hex(status.stdout)}`,
  };
}

/**
 * Create (or crash-resume) the workflow worktree at the spec's frozen base
 * commit. Idempotent: the slug is derived from the run id and
 * `getOrCreateWorktree` fast-resumes an existing worktree.
 */
export async function provisionWorkflowWorktree(
  spec: Pick<WorkflowSpec, "runId" | "repoPath" | "baseCommit">,
  broker: SandboxExecutionBrokerLike,
): Promise<WorktreeHandle> {
  return getOrCreateWorktree({
    gitRoot: spec.repoPath,
    slug: workflowWorktreeSlug(spec.runId),
    base: spec.baseCommit,
    sandboxExecutionBroker: broker,
  });
}

export interface ExportedPatchArtifacts {
  readonly patch: RunArtifactPointer;
  readonly changedFiles: RunArtifactPointer;
  readonly headCommit: string;
  readonly treeHash: string;
  readonly patchBytes: Uint8Array;
}

/**
 * Commit any uncommitted worktree changes, then export the reviewable patch
 * and changed-file list into the evidence sink. Re-export of an unchanged
 * worktree yields byte-identical artifacts (stable digests).
 */
export async function exportPatchArtifacts(opts: {
  readonly handle: WorktreeHandle;
  readonly baseCommit: string;
  readonly step: RunStepIdentity;
  readonly sink: EvidenceArtifactSink;
  readonly broker: SandboxExecutionBrokerLike;
}): Promise<ExportedPatchArtifacts> {
  const { handle, baseCommit, step, sink, broker } = opts;
  const status = await runGit(["status", "--porcelain"], handle.path, broker);
  if (status.code !== 0) {
    throw new WorkflowGitError("status", status.stderr.trim());
  }
  if (status.stdout.trim().length > 0) {
    const add = await runGit(["add", "-A"], handle.path, broker);
    if (add.code !== 0) throw new WorkflowGitError("add", add.stderr.trim());
    const commit = await runGit(
      [
        "-c", "user.name=agenc-workflow",
        "-c", "user.email=workflow@agenc.invalid",
        "commit", "--no-verify", "--allow-empty-message",
        "-m", "agenc verified-change workflow snapshot",
      ],
      handle.path,
      broker,
    );
    if (commit.code !== 0) {
      throw new WorkflowGitError("commit", commit.stderr.trim());
    }
  }
  const head = await runGit(["rev-parse", "HEAD"], handle.path, broker);
  if (head.code !== 0) throw new WorkflowGitError("rev-parse", head.stderr.trim());
  const headCommit = head.stdout.trim();
  const tree = await runGit(["rev-parse", "HEAD^{tree}"], handle.path, broker);
  if (tree.code !== 0) throw new WorkflowGitError("rev-parse", tree.stderr.trim());

  // --full-index + no color/ext-diff keeps patch bytes deterministic.
  const diff = await runGit(
    ["diff", "--full-index", "--no-color", "--no-ext-diff", `${baseCommit}..HEAD`],
    handle.path,
    broker,
  );
  if (diff.code !== 0) throw new WorkflowGitError("diff", diff.stderr.trim());
  const nameStatus = await runGit(
    ["diff", "--name-status", "--no-color", `${baseCommit}..HEAD`],
    handle.path,
    broker,
  );
  if (nameStatus.code !== 0) {
    throw new WorkflowGitError("diff --name-status", nameStatus.stderr.trim());
  }

  const patchBytes = new TextEncoder().encode(diff.stdout);
  const patch = await sink.recordArtifact({
    step,
    role: "patch",
    bytes: patchBytes,
    mediaType: "text/x-patch",
  });
  const changedFiles = await sink.recordArtifact({
    step,
    role: "changed_files",
    bytes: new TextEncoder().encode(nameStatus.stdout),
    mediaType: "text/plain",
  });
  return {
    patch,
    changedFiles,
    headCommit,
    treeHash: tree.stdout.trim(),
    patchBytes,
  };
}

export type BaseMovementCheck =
  | { readonly kind: "unmoved" }
  | {
      /** Patch applies cleanly onto the moved base (3-way, temp worktree). */
      readonly kind: "rebase_clean";
      readonly newBaseCommit: string;
    }
  | {
      readonly kind: "conflict";
      readonly newBaseCommit: string;
      readonly conflictFiles: readonly string[];
    };

/**
 * Detect base movement and classify the patch against the moved base.
 * All probing happens in a TEMPORARY worktree that is always removed; the
 * user checkout and the workflow worktree are never touched.
 */
export async function checkBaseMovement(opts: {
  readonly spec: Pick<WorkflowSpec, "runId" | "repoPath" | "baseCommit">;
  readonly patchBytes: Uint8Array;
  readonly broker: SandboxExecutionBrokerLike;
}): Promise<BaseMovementCheck> {
  const { spec, patchBytes, broker } = opts;
  const head = await runGit(["rev-parse", "HEAD"], spec.repoPath, broker);
  if (head.code !== 0) {
    throw new WorkflowGitError("rev-parse", head.stderr.trim());
  }
  const newBaseCommit = head.stdout.trim();
  if (newBaseCommit === spec.baseCommit) return { kind: "unmoved" };
  if (patchBytes.byteLength === 0) return { kind: "rebase_clean", newBaseCommit };

  const probeSlug = `${workflowWorktreeSlug(spec.runId)}-rebase`;
  const probe = await getOrCreateWorktree({
    gitRoot: spec.repoPath,
    slug: probeSlug,
    base: newBaseCommit,
    sandboxExecutionBroker: broker,
  });
  try {
    const patchPath = `${probe.path}/.agenc-m5-rebase.patch`;
    const { writeFile, rm } = await import("node:fs/promises");
    await writeFile(patchPath, patchBytes, { mode: 0o600 });
    try {
      // A REAL 3-way apply in the disposable probe worktree is the only
      // honest classifier: `git apply --3way --check` reports success for
      // patches that would land with conflict markers. Exit 0 = clean;
      // anything else = conflict, with unmerged paths enumerated from the
      // index and the apply error output.
      const apply = await runGit(
        ["apply", "--3way", ".agenc-m5-rebase.patch"],
        probe.path,
        broker,
      );
      if (apply.code === 0) return { kind: "rebase_clean", newBaseCommit };
      const conflicts = new Set<string>();
      const diffFiles = await runGit(
        ["diff", "--name-only", "--diff-filter=U"],
        probe.path,
        broker,
      );
      for (const file of diffFiles.stdout.split("\n")) {
        if (file.trim().length > 0) conflicts.add(file.trim());
      }
      for (const line of apply.stderr.split("\n")) {
        const match =
          /(?:error|warning): (?:patch failed: |could not apply |applied patch to ')?([^':]+?)'?(?::\d+)?(?: does not| with conflicts|: patch does not apply|\.$)/.exec(
            line,
          );
        if (match?.[1] !== undefined && match[1].includes("/")) {
          conflicts.add(match[1].trim());
        }
      }
      return {
        kind: "conflict",
        newBaseCommit,
        conflictFiles: [...conflicts].sort(),
      };
    } finally {
      await rm(patchPath, { force: true });
    }
  } finally {
    await removeAgentWorktree({
      gitRoot: spec.repoPath,
      path: probe.path,
      branch: probe.branch,
      sandboxExecutionBroker: broker,
    });
  }
}

/**
 * Remove the workflow worktree. Only callable with the sealed-evidence
 * proof (minted by finalize) — patch and artifacts are provably exported
 * and sealed before any cleanup. Failures are surfaced to `warn`, never
 * thrown: a leftover worktree is a nuisance, a thrown cleanup after a
 * sealed run would mask success.
 */
export async function cleanupAfterEvidence(opts: {
  readonly proof: SealedEvidenceProof;
  readonly handle: WorktreeHandle;
  readonly broker: SandboxExecutionBrokerLike;
  readonly warn: (message: string) => void;
}): Promise<void> {
  try {
    await removeAgentWorktree({
      gitRoot: opts.handle.gitRoot,
      path: opts.handle.path,
      branch: opts.handle.branch,
      sandboxExecutionBroker: opts.broker,
    });
  } catch (error) {
    opts.warn(
      `workflow worktree cleanup failed after sealed evidence (${opts.proof.sealDigest}): ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
